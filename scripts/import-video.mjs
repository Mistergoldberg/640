import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { runImporter } from "./import-photos.mjs";
import { runVideoImport, validateFrameDirectory } from "./video-to-source-photos.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_ROOT, "..");
const STAGE_2A_CANDIDATE = "c4bdb8407f207b18912264bd640f2321356b9997";
const STAGE_2B_SCHEMA_VERSION = 1;
const PROHIBITED_PUBLIC_FIELDS = new Set([
  "sourceType",
  "sourceFilename",
  "sourceDuration",
  "sourceDurationSeconds",
  "sourceSecond",
  "videoCodec"
]);

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

async function writePrivateJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporaryPath, jsonBytes(value), { flag: "wx", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${filePath}: ${error.message}`);
  }
}

function naturalCompare(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}

function validateYear(year) {
  if (!/^(19|20)\d{2}$/.test(String(year || ""))) {
    throw new Error("--year must be a four-digit year from 1900 through 2099");
  }
  return String(year);
}

function validateAlbumTitle(albumTitle) {
  if (typeof albumTitle !== "string" || !albumTitle.length) throw new Error("--album-title must not be empty");
  if (albumTitle !== albumTitle.trim()) throw new Error("--album-title must not have leading or trailing whitespace");
  if (albumTitle === "." || albumTitle === "..") throw new Error("--album-title is a reserved path name");
  if (albumTitle.length > 120) throw new Error("--album-title must be at most 120 characters");
  if (/[\\/\0]/.test(albumTitle)) throw new Error("--album-title must not contain path separators or NUL bytes");
  if (/[\u0000-\u001f\u007f]/.test(albumTitle)) throw new Error("--album-title must not contain control characters");
  return albumTitle;
}

function isInsideOrEqual(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function inventoriesMatch(left, right) {
  if (!left || !right || left.inventorySha256 !== right.inventorySha256 || left.frameCount !== right.frameCount) return false;
  if (left.frames.length !== right.frames.length) return false;
  return left.frames.every((frame, index) => {
    const other = right.frames[index];
    return frame.filename === other?.filename && frame.bytes === other.bytes && frame.sha256 === other.sha256;
  });
}

function inventorySummary(validation) {
  return {
    frameCount: validation.frameCount,
    firstFrame: validation.firstFrame,
    lastFrame: validation.lastFrame,
    width: validation.width,
    height: validation.height,
    inventorySha256: validation.inventorySha256,
    frames: validation.frames.map(({ filename, bytes, sha256 }) => ({ filename, bytes, sha256 }))
  };
}

async function verifyStage2AResult(stage2AResult) {
  const validation = await validateFrameDirectory(stage2AResult.sourcePhotoDirectory, {
    expectedCount: stage2AResult.report.actualFrameCount
  });
  const inventory = inventorySummary(validation);
  const recorded = {
    frameCount: stage2AResult.report.actualFrameCount,
    inventorySha256: stage2AResult.report.validation.inventorySha256,
    frames: stage2AResult.report.validation.frames.map(({ filename, bytes, sha256 }) => ({ filename, bytes, sha256 }))
  };
  if (!inventoriesMatch(inventory, recorded)) {
    throw new Error("Stage 2A extracted frame inventory changed after validation");
  }
  return { validation, inventory };
}

async function copyVerifiedFrames(sourceDirectory, installingDirectory, inventory, injectFault) {
  await fs.mkdir(installingDirectory, { mode: 0o700 });
  for (const frame of inventory.frames) {
    await fs.copyFile(
      path.join(sourceDirectory, frame.filename),
      path.join(installingDirectory, frame.filename),
      fsConstants.COPYFILE_EXCL
    );
  }
  await injectFault?.("after-install-copy", { installingDirectory });
  const installedValidation = await validateFrameDirectory(installingDirectory, { expectedCount: inventory.frameCount });
  const installedInventory = inventorySummary(installedValidation);
  if (!inventoriesMatch(inventory, installedInventory)) {
    throw new Error("Installing source album does not match the Stage 2A frame inventory");
  }
  const sourceValidation = await validateFrameDirectory(sourceDirectory, { expectedCount: inventory.frameCount });
  if (!inventoriesMatch(inventory, inventorySummary(sourceValidation))) {
    throw new Error("Stage 2A frame source changed during durable installation");
  }
  return installedInventory;
}

async function installDurableSourceAlbum({
  stage2AResult,
  sourceRoot,
  albumDirectoryName,
  inventory,
  reportPath,
  reuseExisting,
  injectFault
}) {
  const sourceAlbumPath = path.join(sourceRoot, albumDirectoryName);
  if (!isInsideOrEqual(sourceAlbumPath, sourceRoot) || sourceAlbumPath === sourceRoot) {
    throw new Error("Constructed source album path escapes the authoritative source root");
  }
  const installingDirectory = path.join(
    sourceRoot,
    `.${albumDirectoryName}.installing-${inventory.inventorySha256.slice(0, 16)}`
  );
  if (await exists(installingDirectory)) {
    throw new Error(`Incomplete durable source installation requires operator review: ${installingDirectory}`);
  }

  if (await exists(sourceAlbumPath)) {
    let existingInventory;
    try {
      existingInventory = inventorySummary(await validateFrameDirectory(sourceAlbumPath, { expectedCount: inventory.frameCount }));
    } catch (error) {
      throw new Error(`Existing source album conflicts with the video import: ${sourceAlbumPath}: ${error.message}`);
    }
    if (!inventoriesMatch(inventory, existingInventory)) {
      throw new Error(`Existing source album differs from the Stage 2A frame inventory: ${sourceAlbumPath}`);
    }
    if (!(await exists(reportPath))) {
      throw new Error(`Existing byte-identical album has no matching private provenance record: ${sourceAlbumPath}`);
    }
    const priorReport = await readJson(reportPath, "Stage 2B provenance report");
    const sameJob =
      priorReport.sourceVideoSha256 === stage2AResult.report.sourceSha256 &&
      priorReport.sourceInventorySha256 === inventory.inventorySha256 &&
      path.resolve(priorReport.sourceAlbumPath || "") === sourceAlbumPath;
    if (!sameJob) throw new Error(`Existing source album belongs to a different import job: ${sourceAlbumPath}`);
    if (!reuseExisting) {
      throw new Error(`Durable source album already exists and is verified; rerun with --reuse-existing: ${sourceAlbumPath}`);
    }
    return {
      sourceAlbumPath,
      installingDirectory,
      inventory: existingInventory,
      reused: true,
      installedAt: priorReport.sourceAlbumInstalledAt || null
    };
  }

  const installedInventory = await copyVerifiedFrames(
    stage2AResult.sourcePhotoDirectory,
    installingDirectory,
    inventory,
    injectFault
  );
  if (await exists(sourceAlbumPath)) {
    throw new Error(`Source album appeared during installation; refusing to overwrite: ${sourceAlbumPath}`);
  }
  await injectFault?.("before-install-rename", { installingDirectory, sourceAlbumPath });
  await fs.rename(installingDirectory, sourceAlbumPath);
  return {
    sourceAlbumPath,
    installingDirectory,
    inventory: installedInventory,
    reused: false,
    installedAt: new Date().toISOString()
  };
}

async function listAuthoritativeYearFolders(sourceRoot, year) {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  const folders = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(year)) continue;
    const entryPath = path.join(sourceRoot, entry.name);
    const stat = await fs.lstat(entryPath);
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) {
      throw new Error(`Authoritative year source entry is not a directory: ${entryPath}`);
    }
    folders.push(entry.name);
  }
  return folders.sort(naturalCompare);
}

function importerArgs({ year, stagingRoot, sourcePolicyPath, plan }) {
  return [
    ...(plan ? ["--plan"] : []),
    "--year", year,
    "--staging-root", stagingRoot,
    ...(sourcePolicyPath ? ["--source-policy", sourcePolicyPath] : [])
  ];
}

function assertFullYearPlan(plan, expectedFolders, albumDirectoryName, inventory) {
  if (plan.observedFacts.sourceMode !== "original-archive-year") {
    throw new Error(`Full-year staging requires original-archive-year mode, found ${plan.observedFacts.sourceMode}`);
  }
  const plannedFolders = plan.observedFacts.sourceFolders.map((folder) => folder.relativePath).sort(naturalCompare);
  if (JSON.stringify(plannedFolders) !== JSON.stringify(expectedFolders)) {
    throw new Error(`Full-year source scope mismatch: expected ${expectedFolders.join(", ")}; planned ${plannedFolders.join(", ")}`);
  }
  if (!plannedFolders.includes(albumDirectoryName)) {
    throw new Error(`Full-year source scope omitted the installed video album: ${albumDirectoryName}`);
  }
  const videoPhotos = plan.observedFacts.photos.filter((photo) => photo.relativePath.startsWith(`${albumDirectoryName}/`));
  if (videoPhotos.length !== inventory.frameCount) {
    throw new Error(`Plan found ${videoPhotos.length} video frames, expected ${inventory.frameCount}`);
  }
  const expectedRelativePaths = inventory.frames.map((frame) => `${albumDirectoryName}/${frame.filename}`);
  const plannedRelativePaths = videoPhotos.map((photo) => photo.relativePath);
  if (JSON.stringify(plannedRelativePaths) !== JSON.stringify(expectedRelativePaths)) {
    throw new Error("Planned video-frame order does not match the Stage 2A sequence");
  }
  const allPhotoIds = plan.observedFacts.photos.map((photo) => photo.proposedPhotoId);
  if (new Set(allPhotoIds).size !== allPhotoIds.length) {
    throw new Error("Full-year plan contains colliding photo IDs");
  }
  return { videoPhotos, plannedFolders };
}

function assertNoVideoFields(value, currentPath = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoVideoFields(child, `${currentPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PROHIBITED_PUBLIC_FIELDS.has(key)) throw new Error(`Video-specific field leaked into public data at ${currentPath}.${key}`);
    assertNoVideoFields(child, `${currentPath}.${key}`);
  }
}

async function validateStagedAlbum({ stageResult, plan, stageRoot, year, albumDirectoryName, inventory }) {
  const album = plan.observedFacts.proposedAlbums.find((candidate) => candidate.name === albumDirectoryName);
  if (!album) throw new Error(`Staged plan does not contain expected album ${albumDirectoryName}`);
  if (album.count !== inventory.frameCount) throw new Error("Planned album count does not match installed frame count");
  const manifestPath = path.join(stageRoot, "public", "data", year, "albums", `${album.id}.json`);
  const indexPath = path.join(stageRoot, "public", "data", year, "index.json");
  const catalogPath = path.join(stageRoot, "public", "data", "catalog.json");
  const completionPath = path.join(stageRoot, "generated", "journal", "complete.json");
  const [manifest, index, catalog, completion] = await Promise.all([
    readJson(manifestPath, "staged album manifest"),
    readJson(indexPath, "staged year index"),
    readJson(catalogPath, "staged catalog candidate"),
    readJson(completionPath, "staged closed-world completion marker")
  ]);
  assertNoVideoFields(manifest);
  assertNoVideoFields(index, "yearIndex");
  assertNoVideoFields(catalog, "catalog");
  const plannedPhotos = plan.observedFacts.photos.filter((photo) => photo.album.id === album.id);
  const plannedIds = plannedPhotos.map((photo) => photo.proposedPhotoId);
  const manifestIds = manifest.photos.map((photo) => photo.id);
  if (JSON.stringify(manifestIds) !== JSON.stringify(plannedIds)) {
    throw new Error("Staged manifest order differs from natural frame source order");
  }
  if (new Set(manifestIds).size !== manifestIds.length || manifestIds.length !== inventory.frameCount) {
    throw new Error("Staged video album has duplicate or missing photo IDs");
  }
  for (let indexValue = 0; indexValue < manifest.photos.length; indexValue += 1) {
    const photo = manifest.photos[indexValue];
    if (photo.albumSortPosition !== indexValue) throw new Error(`Incorrect albumSortPosition for ${photo.id}`);
    if (!Number.isInteger(photo.sortPosition)) throw new Error(`Missing sortPosition for ${photo.id}`);
    if (photo.albumId !== album.id) throw new Error(`Incorrect album ID for ${photo.id}`);
    if (!/-cv1-[a-f0-9]{64}\.jpg$/.test(photo.thumbnailKey) || !/-cv1-[a-f0-9]{64}\.jpg$/.test(photo.displayKey)) {
      throw new Error(`Photo does not use content-versioned media keys: ${photo.id}`);
    }
    const thumbnailPath = path.join(stageRoot, "generated", "library", photo.thumbnailKey);
    const displayPath = path.join(stageRoot, "generated", "library", photo.displayKey);
    const [thumbnail, display] = await Promise.all([
      sharp(thumbnailPath, { failOn: "error" }).metadata(),
      sharp(displayPath, { failOn: "error" }).metadata()
    ]);
    if (!thumbnail.width || !thumbnail.height || thumbnail.format !== "jpeg") throw new Error(`Invalid thumbnail for ${photo.id}`);
    if (!display.width || !display.height || display.format !== "jpeg") throw new Error(`Invalid display derivative for ${photo.id}`);
    const thumbnailScale = Math.min(1, 300 / inventory.width);
    const displayScale = Math.min(1, 640 / inventory.width, 480 / inventory.height);
    const expectedThumbnail = [Math.max(1, Math.round(inventory.width * thumbnailScale)), Math.max(1, Math.round(inventory.height * thumbnailScale))];
    const expectedDisplay = [Math.max(1, Math.round(inventory.width * displayScale)), Math.max(1, Math.round(inventory.height * displayScale))];
    if (thumbnail.width !== expectedThumbnail[0] || thumbnail.height !== expectedThumbnail[1]) {
      throw new Error(`Thumbnail dimensions do not match the ordinary importer recipe for ${photo.id}`);
    }
    if (display.width !== expectedDisplay[0] || display.height !== expectedDisplay[1]) {
      throw new Error(`Display dimensions do not match the ordinary importer recipe for ${photo.id}`);
    }
    if (display.width !== photo.width || display.height !== photo.height) throw new Error(`Manifest dimensions differ for ${photo.id}`);
    const orientation = display.width === display.height ? "square" : display.width > display.height ? "landscape" : "portrait";
    if (photo.orientation !== orientation) throw new Error(`Manifest orientation differs for ${photo.id}`);
  }
  const indexedAlbum = index.albums.find((candidate) => candidate.id === album.id);
  if (!indexedAlbum || indexedAlbum.count !== inventory.frameCount || indexedAlbum.name !== albumDirectoryName) {
    throw new Error("Staged year index does not contain the complete video album");
  }
  const indexedTargetIds = index.sequence.map((entry) => entry.id).filter((id) => manifestIds.includes(id));
  if (JSON.stringify(indexedTargetIds) !== JSON.stringify(manifestIds)) throw new Error("Year sequence changed video frame order");
  if (!catalog.years.some((entry) => entry.year === year && entry.indexUrl === `data/${year}/index.json`)) {
    throw new Error("Staged catalog candidate does not reference the selected year");
  }
  if (completion.status !== "complete" || completion.runId !== stageResult.receipt.runId || !completion.closedWorldSha256) {
    throw new Error("Staged completion marker does not match the importer receipt");
  }

  const plannedChecksums = new Map(plan.observedFacts.photos.map((photo) => [photo.selectedPath, photo.sourceSha256]));
  const stagedChecksums = new Map(stageResult.receipt.sourceChecksums.map((entry) => [entry.path, entry.sha256]));
  if (plannedChecksums.size !== stagedChecksums.size) throw new Error("Staged source count differs from the full-year plan");
  for (const [sourcePath, sha256] of plannedChecksums) {
    if (stagedChecksums.get(sourcePath) !== sha256) throw new Error(`Staged source set differs from the full-year plan: ${sourcePath}`);
  }
  if (stageResult.receipt.counts.sources !== plan.observedFacts.importablePhotos) {
    throw new Error("Staged source count differs from the complete planned source set");
  }

  return {
    albumId: album.id,
    albumName: album.name,
    albumManifestPath: manifestPath,
    yearIndexPath: indexPath,
    catalogPath,
    stagedAlbumPhotoCount: manifest.photos.length,
    firstPhotoId: manifestIds[0],
    lastPhotoId: manifestIds.at(-1),
    photoIds: manifestIds,
    thumbnailCount: manifest.photos.length,
    displayCount: manifest.photos.length,
    orientations: Object.fromEntries([...new Set(manifest.photos.map((photo) => photo.orientation))].map((value) => [value, manifest.photos.filter((photo) => photo.orientation === value).length])),
    fullYearPhotoCount: stageResult.receipt.counts.sources,
    fullYearAlbumCount: stageResult.receipt.counts.albums,
    closedWorldSha256: completion.closedWorldSha256,
    closedWorldFileCount: completion.expectedFileCountBeforeSeal + 1,
    runId: stageResult.receipt.runId,
    publicationEligible: stageResult.receipt.publicationEligible,
    publicationApproved: stageResult.receipt.publicationApproved
  };
}

export async function runVideoSourceAlbumImport({
  inputPath,
  year,
  albumTitle,
  sourceRoot = path.join(APP_ROOT, "original-photos"),
  jobRoot,
  stagingRoot,
  sourcePolicyPath = null,
  reuseExisting = false,
  writeStdout = (value) => process.stdout.write(value),
  importerRuntime = {},
  injectFault = null
}) {
  const selectedYear = validateYear(year);
  const selectedTitle = validateAlbumTitle(albumTitle);
  if (!jobRoot) throw new Error("Provide --job-root for private video jobs");
  if (!stagingRoot) throw new Error("Provide --staging-root for isolated importer output");
  const resolvedSourceRoot = path.resolve(sourceRoot);
  if (path.basename(resolvedSourceRoot) !== "original-photos") {
    throw new Error("The authoritative --source-root must be an original-photos directory for full-year importer resolution");
  }
  const resolvedStagingRoot = path.resolve(stagingRoot);
  const resolvedJobRoot = path.resolve(jobRoot);
  if (isInsideOrEqual(resolvedStagingRoot, resolvedSourceRoot) || isInsideOrEqual(resolvedSourceRoot, resolvedStagingRoot)) {
    throw new Error("Staging root must not overlap the authoritative source root");
  }
  await fs.mkdir(resolvedSourceRoot, { recursive: true });
  const physicalSourceRoot = await fs.realpath(resolvedSourceRoot);
  const albumDirectoryName = `${selectedYear} ${selectedTitle}`;
  const sourceAlbumPath = path.join(physicalSourceRoot, albumDirectoryName);

  const stage2AResult = await runVideoImport({ inputPath, jobRoot: resolvedJobRoot, writeStdout });
  writeStdout(`\nYear: ${selectedYear}\nAlbum: ${selectedTitle}\n`);
  const reportPath = path.join(stage2AResult.jobDirectory, "reports", "stage-2b-report.json");
  const policyTemplatePath = path.join(stage2AResult.jobDirectory, "reports", "stage-2b-source-policy-template.json");
  const priorPrivateReport = await exists(reportPath) ? await readJson(reportPath, "prior Stage 2B report") : null;
  const preservePriorCompletedReport = priorPrivateReport?.completedStage2B === true && !reuseExisting;
  const startedAt = new Date().toISOString();
  let privateReport = {
    schemaVersion: STAGE_2B_SCHEMA_VERSION,
    state: "verifying-stage-2a",
    completedStage2B: false,
    startedAt,
    updatedAt: startedAt,
    stage2ACandidate: STAGE_2A_CANDIDATE,
    stage2AJobId: path.basename(stage2AResult.jobDirectory),
    stage2AJobDirectory: stage2AResult.jobDirectory,
    sourceVideoPath: stage2AResult.report.sourcePath,
    sourceVideoSha256: stage2AResult.report.sourceSha256,
    sourceVideoDurationSeconds: stage2AResult.report.sourceDurationSeconds,
    ffmpegVersion: stage2AResult.report.ffmpegVersion,
    ffprobeVersion: stage2AResult.report.ffprobeVersion,
    requestedAlbumTitle: selectedTitle,
    resultingDirectoryName: albumDirectoryName,
    year: selectedYear,
    sourceRoot: physicalSourceRoot,
    sourceAlbumPath,
    stagingRoot: resolvedStagingRoot
  };
  const updateReport = async (changes) => {
    privateReport = { ...privateReport, ...changes, updatedAt: new Date().toISOString() };
    await writePrivateJson(reportPath, privateReport);
  };

  try {
    const { inventory } = await verifyStage2AResult(stage2AResult);
    privateReport.sourceInventorySha256 = inventory.inventorySha256;
    privateReport.frameCount = inventory.frameCount;
    await injectFault?.("after-stage-2a-validation", { stage2AResult, inventory });

    writeStdout("\nPreparing durable source album...\n");
    const installation = await installDurableSourceAlbum({
      stage2AResult,
      sourceRoot: physicalSourceRoot,
      albumDirectoryName,
      inventory,
      reportPath,
      reuseExisting,
      injectFault
    });
    await updateReport({
      state: "source-installed",
      sourceAlbumInstalled: true,
      sourceAlbumReused: installation.reused,
      sourceAlbumInstalledAt: installation.installedAt,
      sourceInventorySha256: installation.inventory.inventorySha256,
      frameInventory: installation.inventory.frames
    });
    writeStdout(`PASS\n${installation.inventory.frameCount} durable source photographs\n${installation.sourceAlbumPath}\n`);

    const expectedYearFolders = await listAuthoritativeYearFolders(physicalSourceRoot, selectedYear);
    writeStdout("\nVerifying complete authoritative year scope...\n");
    const runtime = {
      ...importerRuntime,
      appRoot: path.dirname(resolvedSourceRoot),
      writeStdout: () => {}
    };
    const plan = await runImporter(importerArgs({
      year: selectedYear,
      stagingRoot: resolvedStagingRoot,
      sourcePolicyPath: sourcePolicyPath ? path.resolve(sourcePolicyPath) : null,
      plan: true
    }), runtime);
    const fullYear = assertFullYearPlan(plan, expectedYearFolders, albumDirectoryName, installation.inventory);
    if (!plan.sourcePolicy.eligibility.publicationEligible) {
      await writePrivateJson(policyTemplatePath, plan.sourcePolicy.policyTemplate);
    }
    await updateReport({
      state: "full-year-verified",
      authoritativeYearFolders: fullYear.plannedFolders,
      fullYearPlannedPhotoCount: plan.observedFacts.importablePhotos,
      fullYearPlannedAlbumCount: plan.observedFacts.proposedAlbums.length,
      sourcePolicy: {
        providedPath: sourcePolicyPath ? path.resolve(sourcePolicyPath) : null,
        publicationEligible: plan.sourcePolicy.eligibility.publicationEligible,
        inventoryMatches: plan.sourcePolicy.eligibility.inventoryMatches,
        unresolvedDecisions: plan.sourcePolicy.eligibility.counts.unresolved,
        freshInventorySha256: plan.sourcePolicy.eligibility.freshInventorySha256,
        policyTemplatePath: plan.sourcePolicy.eligibility.publicationEligible ? null : policyTemplatePath
      }
    });

    writeStdout("PASS\nRunning isolated Pixilation staged importer...\n");
    const stageResult = await runImporter(importerArgs({
      year: selectedYear,
      stagingRoot: resolvedStagingRoot,
      sourcePolicyPath: sourcePolicyPath ? path.resolve(sourcePolicyPath) : null,
      plan: false
    }), runtime);
    const stagedAlbum = await validateStagedAlbum({
      stageResult,
      plan,
      stageRoot: resolvedStagingRoot,
      year: selectedYear,
      albumDirectoryName,
      inventory: installation.inventory
    });
    await updateReport({
      state: "complete",
      completedStage2B: true,
      completedAt: new Date().toISOString(),
      albumTitle: selectedTitle,
      albumId: stagedAlbum.albumId,
      stagedImportId: stagedAlbum.runId,
      stagedAlbum,
      closedWorldValidated: true,
      publicationPerformed: false
    });
    writeStdout(
      [
        "PASS",
        "",
        `Album: ${albumDirectoryName}`,
        `Photos: ${stagedAlbum.stagedAlbumPhotoCount}`,
        `Stage: ${resolvedStagingRoot}`,
        "",
        "NO PUBLICATION PERFORMED",
        ""
      ].join("\n")
    );
    return {
      stage2AResult,
      sourceAlbumPath: installation.sourceAlbumPath,
      sourceAlbumReused: installation.reused,
      sourceInventory: installation.inventory,
      plan,
      stageResult,
      stagedAlbum,
      privateReportPath: reportPath,
      privateReport
    };
  } catch (error) {
    try {
      if (!preservePriorCompletedReport) {
        await updateReport({
          state: "failed",
          completedStage2B: false,
          failedAt: new Date().toISOString(),
          error: error.message,
          durableSourceAlbumPresent: await exists(sourceAlbumPath),
          publicationPerformed: false
        });
      }
    } catch (reportError) {
      error.message += ` (also failed to persist Stage 2B failure state: ${reportError.message})`;
    }
    throw error;
  }
}

function parseArgs(argv) {
  const args = {
    inputPath: null,
    year: null,
    albumTitle: null,
    sourceRoot: path.join(APP_ROOT, "original-photos"),
    jobRoot: null,
    stagingRoot: null,
    sourcePolicyPath: null,
    reuseExisting: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (token === "--reuse-existing") {
      args.reuseExisting = true;
      continue;
    }
    const key = {
      "--input": "inputPath",
      "--year": "year",
      "--album-title": "albumTitle",
      "--source-root": "sourceRoot",
      "--job-root": "jobRoot",
      "--staging-root": "stagingRoot",
      "--source-policy": "sourcePolicyPath"
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
  return [
    "Usage: npm run import:video -- --input /path/video.mov --year 2006 --album-title \"Shanghai Taxi\" --source-root /path/archive/original-photos --job-root /path/video-jobs --staging-root /path/import-stage",
    "",
    "Use --reuse-existing only to rerun a cryptographically matching completed source installation.",
    ""
  ].join("\n");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) process.stdout.write(usage());
    else await runVideoSourceAlbumImport(args);
  } catch (error) {
    process.stderr.write(`FAIL\n${error.message}\n`);
    process.exitCode = 1;
  }
}
