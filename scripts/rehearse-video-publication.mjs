import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { runVideoSourceAlbumImport } from "./import-video.mjs";
import { buildPromotionPackage, verifyPromotionPackage } from "./promote-staged-release.mjs";
import {
  createFilesystemObjectStore,
  createPublicationPlan,
  executePublication,
  verifyPublicationPackage
} from "./package-media-publication.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_ROOT, "..");
const STAGE_2C_SCHEMA_VERSION = 1;
const ALLOWED_FILESYSTEM_OPERATIONS = new Set(["list", "inspect", "put-if-absent"]);
const PROHIBITED_PUBLIC_FIELDS = new Set([
  "sourceType",
  "sourceFilename",
  "sourceDuration",
  "sourceDurationSeconds",
  "sourceSecond",
  "videoCodec",
  "samplingIntervalSeconds"
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${filePath}: ${error.message}`);
  }
}

async function writePrivateJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporaryPath, jsonBytes(value), { flag: "wx", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function walkFiles(root) {
  const files = [];
  if (!(await exists(root))) return files;
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) throw new Error(`Unexpected symlink in rehearsal tree: ${absolutePath}`);
      if (stat.isDirectory()) await walk(absolutePath);
      else if (stat.isFile()) files.push(absolutePath);
      else throw new Error(`Unexpected non-regular rehearsal entry: ${absolutePath}`);
    }
  }
  await walk(root);
  return files;
}

async function treeInventory(root) {
  const files = [];
  for (const filePath of await walkFiles(root)) {
    const bytes = await fs.readFile(filePath);
    files.push({
      path: path.relative(root, filePath).split(path.sep).join("/"),
      bytes: bytes.length,
      sha256: sha256(bytes)
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
  return { files, sha256: sha256(stableJson(files)) };
}

function assertNoVideoFields(value, currentPath) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoVideoFields(child, `${currentPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PROHIBITED_PUBLIC_FIELDS.has(key)) throw new Error(`Video-specific field leaked into package public data at ${currentPath}.${key}`);
    assertNoVideoFields(child, `${currentPath}.${key}`);
  }
}

export function resolveControlledFixturePolicy(template) {
  const policy = structuredClone(template);
  for (const decision of policy.decisions || []) {
    decision.status = "resolved";
    if (decision.category === "folder-year") {
      decision.action = "map-to-year";
      decision.year = decision.subject.importerYear;
    } else if (decision.category === "album-label") {
      decision.action = "publish-label";
      decision.publicLabel = decision.subject.proposedPublicLabel;
    } else if (decision.category === "unsupported-file" || decision.category === "unreadable-file") {
      decision.action = "exclude-exact";
    } else if (decision.category === "duplicate-content") {
      decision.action = "keep-separate";
    } else if (decision.category === "off-year-date") {
      decision.action = "use-folder-year";
    } else if (decision.category === "source-move") {
      decision.action = "preserve-source-path";
    } else {
      throw new Error(`Controlled fixture cannot resolve unknown source-policy category: ${decision.category}`);
    }
  }
  return policy;
}

async function readPublicationEvents(journalPath) {
  const events = [];
  const text = await fs.readFile(journalPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  for (const line of text.split("\n")) if (line) events.push(JSON.parse(line));
  return events;
}

async function validatePackageCandidate({ packageRoot, canonicalDataRoot, selectedYear, stage2BResult, verifiedPackage }) {
  const candidateDataRoot = path.join(packageRoot, "candidate", "public", "data");
  for (const filePath of await walkFiles(candidateDataRoot)) {
    if (path.extname(filePath).toLowerCase() === ".json") {
      assertNoVideoFields(await readJson(filePath, "packaged public JSON"), path.relative(candidateDataRoot, filePath));
    }
  }

  const stagedYearRoot = path.join(stage2BResult.stageResult.receipt.stagedPaths.data, "data", selectedYear);
  const packagedYearRoot = path.join(candidateDataRoot, selectedYear);
  const [stagedYear, packagedYear] = await Promise.all([treeInventory(stagedYearRoot), treeInventory(packagedYearRoot)]);
  if (stableJson(stagedYear) !== stableJson(packagedYear)) {
    throw new Error("Packaged selected year differs from the sealed staged year");
  }

  const canonicalCatalog = await readJson(path.join(canonicalDataRoot, "catalog.json"), "canonical fixture catalog");
  for (const entry of canonicalCatalog.years || []) {
    const year = String(entry.year);
    if (year === selectedYear) continue;
    const [canonicalYear, candidateYear] = await Promise.all([
      treeInventory(path.join(canonicalDataRoot, year)),
      treeInventory(path.join(candidateDataRoot, year))
    ]);
    if (stableJson(canonicalYear) !== stableJson(candidateYear)) {
      throw new Error(`Unrelated canonical year changed in the package candidate: ${year}`);
    }
  }

  const targetManifest = verifiedPackage.manifestMap.manifests.find((manifest) =>
    manifest.manifestPath.endsWith(`/${stage2BResult.stagedAlbum.albumId}.json`)
  );
  if (!targetManifest || targetManifest.photos.length !== stage2BResult.sourceInventory.frameCount) {
    throw new Error("Promotion package omitted or truncated the video-derived album");
  }
  const keys = targetManifest.photos.flatMap((photo) => [photo.thumbnailKey, photo.displayKey]);
  if (new Set(keys).size !== keys.length) throw new Error("Video-derived package media keys are not unique");
  for (const key of keys) {
    if (!verifiedPackage.expectedByKey.has(key) || !verifiedPackage.newByKey.has(key)) {
      throw new Error(`Video-derived package media is not bound as approved new media: ${key}`);
    }
    const mediaPath = path.join(packageRoot, "media", "new", ...key.split("/"));
    const metadata = await sharp(mediaPath, { failOn: "error" }).metadata();
    if (metadata.format !== "jpeg" || !metadata.width || !metadata.height) throw new Error(`Packaged media is not a valid JPEG: ${key}`);
  }
  const displayKeys = targetManifest.photos.map((photo) => photo.displayKey);
  const orientations = {};
  for (const key of displayKeys) {
    const metadata = await sharp(path.join(packageRoot, "media", "new", ...key.split("/"))).metadata();
    const orientation = metadata.width === metadata.height ? "square" : metadata.width > metadata.height ? "landscape" : "portrait";
    orientations[orientation] = (orientations[orientation] || 0) + 1;
  }
  return {
    targetManifestPath: targetManifest.manifestPath,
    videoPhotoCount: targetManifest.photos.length,
    thumbnailCount: targetManifest.photos.length,
    displayCount: targetManifest.photos.length,
    videoMediaCount: keys.length,
    orientations,
    selectedYearInventorySha256: packagedYear.sha256,
    publicDataFileCount: verifiedPackage.publicInventory.files.length,
    expectedMediaCount: verifiedPackage.expectedByKey.size,
    newMediaCount: verifiedPackage.newByKey.size
  };
}

function ensureControlledPaths(rehearsalRoot, paths) {
  const resolvedRoot = path.resolve(rehearsalRoot);
  for (const [name, value] of Object.entries(paths)) {
    const resolved = path.resolve(value);
    if (!isInside(resolved, resolvedRoot)) throw new Error(`${name} must stay inside --rehearsal-root`);
  }
  const values = Object.entries(paths).map(([name, value]) => [name, path.resolve(value)]);
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      const [leftName, leftPath] = values[left];
      const [rightName, rightPath] = values[right];
      const relativeLeft = path.relative(leftPath, rightPath);
      const relativeRight = path.relative(rightPath, leftPath);
      if (relativeLeft === "" || (!relativeLeft.startsWith("..") && !path.isAbsolute(relativeLeft)) || (!relativeRight.startsWith("..") && !path.isAbsolute(relativeRight))) {
        throw new Error(`${leftName} must not overlap ${rightName}`);
      }
    }
  }
  return resolvedRoot;
}

export async function runVideoPublicationRehearsal({
  inputPath,
  year,
  albumTitle,
  rehearsalRoot,
  sourceRoot = path.join(rehearsalRoot || "", "original-photos"),
  jobRoot = path.join(rehearsalRoot || "", "video-jobs"),
  stagingRoot = path.join(rehearsalRoot || "", "eligible-stage"),
  packageRoot = path.join(rehearsalRoot || "", "promotion-package"),
  objectRoot = path.join(rehearsalRoot || "", "filesystem-object-store"),
  journalRoot = path.join(rehearsalRoot || "", "publication-journal"),
  canonicalDataRoot = path.join(rehearsalRoot || "", "public", "data"),
  canonicalMediaRoot = path.join(rehearsalRoot || "", "generated", "library"),
  allowPreexistingObjects = false,
  writeStdout = (value) => process.stdout.write(value),
  importerRuntime = {}
}) {
  if (!rehearsalRoot) throw new Error("Provide --rehearsal-root; Stage 2C is restricted to a controlled local fixture");
  if (!inputPath) throw new Error("Provide --input with a generated fixture video inside --rehearsal-root");
  const unreviewedStageRoot = path.join(rehearsalRoot, "unreviewed-stage");
  const resolvedRehearsalRoot = ensureControlledPaths(rehearsalRoot, {
    inputPath,
    sourceRoot,
    jobRoot,
    unreviewedStageRoot,
    stagingRoot,
    packageRoot,
    objectRoot,
    journalRoot,
    canonicalDataRoot,
    canonicalMediaRoot
  });
  if (!(await exists(canonicalDataRoot)) || !(await exists(path.join(canonicalDataRoot, "catalog.json")))) {
    throw new Error("Controlled rehearsal requires a valid local canonical public-data fixture");
  }
  if (!(await exists(canonicalMediaRoot))) throw new Error("Controlled rehearsal requires a local canonical media fixture root");
  if (await exists(packageRoot)) throw new Error(`Promotion package path already exists: ${packageRoot}`);
  if (!allowPreexistingObjects && await exists(objectRoot) && (await walkFiles(objectRoot)).length) {
    throw new Error("Filesystem publication destination must begin empty for this rehearsal");
  }
  const [canonicalDataBefore, canonicalMediaBefore] = await Promise.all([
    treeInventory(canonicalDataRoot),
    treeInventory(canonicalMediaRoot)
  ]);

  writeStdout("Building unapproved Stage 2B fixture stage...\n");
  const initialStage = await runVideoSourceAlbumImport({
    inputPath,
    year,
    albumTitle,
    sourceRoot,
    jobRoot,
    stagingRoot: unreviewedStageRoot,
    writeStdout,
    importerRuntime
  });
  if (initialStage.stageResult.receipt.publicationEligible) {
    throw new Error("Initial controlled fixture unexpectedly bypassed unresolved source-policy state");
  }

  const reportsRoot = path.join(initialStage.stage2AResult.jobDirectory, "reports");
  const templatePath = path.join(reportsRoot, "stage-2b-source-policy-template.json");
  const controlledPolicyPath = path.join(reportsRoot, "stage-2c-controlled-fixture-policy.json");
  const stage2CReportPath = path.join(reportsRoot, "stage-2c-report.json");
  const template = await readJson(templatePath, "Stage 2B controlled source-policy template");
  await writePrivateJson(controlledPolicyPath, resolveControlledFixturePolicy(template));

  writeStdout("Building fixture-only eligible sealed stage...\n");
  const eligibleStage = await runVideoSourceAlbumImport({
    inputPath,
    year,
    albumTitle,
    sourceRoot,
    jobRoot,
    stagingRoot,
    sourcePolicyPath: controlledPolicyPath,
    reuseExisting: true,
    writeStdout,
    importerRuntime
  });
  if (!eligibleStage.stageResult.receipt.publicationEligible || eligibleStage.stageResult.receipt.publicationApproved) {
    throw new Error("Controlled stage did not produce the required eligible-but-unapproved technical fixture");
  }

  writeStdout("Building and verifying promotion package...\n");
  const packageResult = await buildPromotionPackage({
    stagingRoot,
    packageRoot,
    policyPath: controlledPolicyPath,
    canonicalDataRoot,
    canonicalMediaRoot
  });
  const promotionVerification = await verifyPromotionPackage(packageRoot);
  const publicationVerification = await verifyPublicationPackage(packageRoot);
  const packageValidation = await validatePackageCandidate({
    packageRoot,
    canonicalDataRoot,
    selectedYear: String(year),
    stage2BResult: eligibleStage,
    verifiedPackage: publicationVerification
  });

  const operations = [];
  const adapter = await createFilesystemObjectStore(objectRoot, {
    onOperation(event) {
      if (!ALLOWED_FILESYSTEM_OPERATIONS.has(event.operation)) throw new Error(`Unexpected filesystem-adapter operation: ${event.operation}`);
      operations.push(event);
    }
  });
  if (adapter.identity.type !== "filesystem-fixture") throw new Error("Stage 2C requires the explicit filesystem-fixture adapter");
  const plan = await createPublicationPlan({ packageRoot, adapter });
  if (
    !plan.executable ||
    plan.counts.missingApprovedNewKeys !== plan.counts.approvedNewKeys ||
    plan.counts.missingRequiredUnavailable !== 0 ||
    plan.counts.byteConflicts !== 0 ||
    plan.counts.unexpectedRemoteKeys !== 0
  ) {
    throw new Error("Filesystem publication plan is not exactly the package-bound publishable set");
  }

  writeStdout("Publishing package media to local filesystem fixture...\n");
  const publication = await executePublication({ packageRoot, adapter, journalRoot });
  const events = await readPublicationEvents(publication.journalPath);
  const verificationEvents = events.filter((event) => event.type === "object-verified");
  const createdObjects = verificationEvents.filter((event) => event.created).length;
  const reusedObjects = plan.counts.matchingExistingKeys + verificationEvents.filter((event) => !event.created).length;
  if (createdObjects !== plan.counts.missingApprovedNewKeys || publication.receipt.status !== "PASS") {
    throw new Error("Filesystem publication receipt does not prove the complete package object set");
  }
  const objectInventory = await treeInventory(objectRoot);
  if (objectInventory.files.length < publication.receipt.counts.required) {
    throw new Error("Filesystem object inventory is smaller than the publication receipt's required set");
  }

  const receiptBytes = await fs.readFile(publication.receiptPath);
  const repeated = await executePublication({ packageRoot, adapter, journalRoot });
  const secondPlan = await createPublicationPlan({ packageRoot, adapter });
  if (
    repeated.receipt.receiptSha256 !== publication.receipt.receiptSha256 ||
    !(await fs.readFile(repeated.receiptPath)).equals(receiptBytes) ||
    secondPlan.counts.matchingExistingKeys !== secondPlan.counts.requiredKeys ||
    secondPlan.counts.missingApprovedNewKeys !== 0
  ) {
    throw new Error("Second filesystem publication run was not idempotent");
  }
  const [canonicalDataAfter, canonicalMediaAfter] = await Promise.all([
    treeInventory(canonicalDataRoot),
    treeInventory(canonicalMediaRoot)
  ]);
  if (stableJson(canonicalDataBefore) !== stableJson(canonicalDataAfter) || stableJson(canonicalMediaBefore) !== stableJson(canonicalMediaAfter)) {
    throw new Error("Stage 2C rehearsal mutated canonical public data or canonical media");
  }

  const report = {
    schemaVersion: STAGE_2C_SCHEMA_VERSION,
    status: "PASS",
    technicalPackagePublicationRehearsal: true,
    realProductionPublicationEligibilityGranted: false,
    controlledFixturePolicyPath: controlledPolicyPath,
    rehearsalRoot: resolvedRehearsalRoot,
    sourceVideoSha256: eligibleStage.stage2AResult.report.sourceSha256,
    frameCount: eligibleStage.sourceInventory.frameCount,
    sourceAlbumPath: eligibleStage.sourceAlbumPath,
    sourceAlbumId: eligibleStage.stagedAlbum.albumId,
    stagedAlbumId: eligibleStage.stagedAlbum.albumId,
    photoCount: eligibleStage.stagedAlbum.stagedAlbumPhotoCount,
    derivativeCount: eligibleStage.stageResult.receipt.counts.derivatives,
    stagedRunId: eligibleStage.stageResult.receipt.runId,
    stagedClosedWorldSha256: eligibleStage.stagedAlbum.closedWorldSha256,
    packageRoot: path.resolve(packageRoot),
    packageId: packageResult.packageId,
    packageClosedWorldSha256: promotionVerification.completion.closedWorldSha256,
    packagePublicationId: publicationVerification.publicationId,
    packageValidation,
    publication: {
      adapter: adapter.identity,
      objectRoot: path.resolve(objectRoot),
      planCounts: plan.counts,
      createdObjects,
      reusedObjects,
      receiptPath: publication.receiptPath,
      receiptSha256: publication.receipt.receiptSha256,
      requiredObjects: publication.receipt.counts.required,
      objectInventorySha256: objectInventory.sha256,
      secondRunReceiptUnchanged: true,
      secondRunMatchingObjects: secondPlan.counts.matchingExistingKeys
    },
    safety: {
      filesystemAdapterOnly: true,
      networkPublicationWrites: false,
      r2Invoked: false,
      cloudflareInvoked: false,
      qaInvoked: false,
      productionInvoked: false,
      liveManifestActivation: false,
      canonicalDataMutation: false,
      frontendOrPlayerMutation: false
    },
    completedAt: new Date().toISOString()
  };
  await writePrivateJson(stage2CReportPath, report);
  writeStdout(
    `PASS\nPackage ${report.packageId}\nPublished ${createdObjects} local objects\nReceipt ${report.publication.receiptSha256}\n\nNO R2 OR LIVE ACTIVATION PERFORMED\n`
  );
  return {
    initialStage,
    eligibleStage,
    controlledPolicyPath,
    packageResult,
    promotionVerification,
    publicationVerification,
    packageValidation,
    adapter,
    plan,
    publication,
    repeated,
    secondPlan,
    operations,
    report,
    reportPath: stage2CReportPath
  };
}

function parseArgs(argv) {
  const args = { inputPath: null, year: null, albumTitle: null, rehearsalRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    const key = {
      "--input": "inputPath",
      "--year": "year",
      "--album-title": "albumTitle",
      "--rehearsal-root": "rehearsalRoot"
    }[token];
    if (!key) throw new Error(`Unknown option: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function usage() {
  return "Usage: npm run rehearse:video:publication -- --input /path/video.mov --year 2080 --album-title \"Fixture Video\" --rehearsal-root /tmp/video-publication-rehearsal\n";
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) process.stdout.write(usage());
    else await runVideoPublicationRehearsal(args);
  } catch (error) {
    process.stderr.write(`FAIL\n${error.message}\n`);
    process.exitCode = 1;
  }
}
