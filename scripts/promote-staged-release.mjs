import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { isSupportedMediaKey } from "./content-versioned-media.mjs";
import { evaluateSourcePolicy, inspectSourcePolicy } from "./source-policy.mjs";

const PACKAGE_SCHEMA_VERSION = 1;
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_ROOT, "..");

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
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isInsideOrEqual(child, parent) {
  return child === parent || isInside(child, parent);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function physicalPathWithoutCreating(targetPath) {
  const unresolved = [];
  let current = path.resolve(targetPath);
  while (true) {
    try {
      return path.resolve(await fs.realpath(current), ...unresolved);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      unresolved.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function fileRecord(filePath, relativePath = null) {
  const bytes = await fs.readFile(filePath);
  return { ...(relativePath === null ? {} : { path: relativePath }), bytes: bytes.length, sha256: sha256(bytes) };
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is missing or invalid JSON: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
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
      if (stat.isSymbolicLink()) throw new Error(`Unexpected symlink in closed-world tree: ${absolutePath}`);
      if (stat.isDirectory()) await walk(absolutePath);
      else if (stat.isFile()) files.push(absolutePath);
      else throw new Error(`Unexpected non-regular entry in closed-world tree: ${absolutePath}`);
    }
  }
  await walk(root);
  return files;
}

async function treeInventory(root, excluded = new Set()) {
  const records = [];
  for (const absolutePath of await walkFiles(root)) {
    const relativePath = toPosix(path.relative(root, absolutePath));
    if (!excluded.has(relativePath)) records.push(await fileRecord(absolutePath, relativePath));
  }
  records.sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
  return { files: records, sha256: sha256(stableJson(records)) };
}

function inventoryForBuffers(files) {
  const records = Array.from(files, ([relativePath, bytes]) => ({ path: relativePath, bytes: bytes.length, sha256: sha256(bytes) })).sort((left, right) =>
    left.path.localeCompare(right.path, undefined, { numeric: true })
  );
  return { files: records, sha256: sha256(stableJson(records)) };
}

function assertExactSet(actual, expected, label) {
  const actualSorted = Array.from(actual).sort();
  const expectedSorted = Array.from(expected).sort();
  const missing = expectedSorted.filter((value) => !actualSorted.includes(value));
  const unexpected = actualSorted.filter((value) => !expectedSorted.includes(value));
  if (missing.length || unexpected.length) {
    throw new Error(`${label} is not closed-world: missing ${missing.join(", ") || "none"}; unexpected ${unexpected.join(", ") || "none"}`);
  }
}

function publicPathFromUrl(url) {
  if (typeof url !== "string" || !url.startsWith("data/") || url.includes("..") || path.isAbsolute(url)) {
    throw new Error(`Unsafe public data URL: ${url}`);
  }
  return url.slice("data/".length);
}

async function verifyStagedRun(stagingRoot) {
  const runPath = path.join(stagingRoot, "generated", "journal", "run.json");
  const completePath = path.join(stagingRoot, "generated", "journal", "complete.json");
  const descriptor = await readJson(runPath, "Staged run descriptor");
  const completion = await readJson(completePath, "Staged completion seal");
  const year = descriptor?.binding?.sourceSelection?.year;
  if (!/^\d{4}$/.test(String(year))) throw new Error("Staged run descriptor has no valid selected year");
  const receiptPath = path.join(stagingRoot, "generated", "reports", `${year}-stage-receipt.json`);
  const receipt = await readJson(receiptPath, "Staged receipt");
  if (descriptor.runId !== receipt.runId || receipt.runId !== completion.runId) throw new Error("Staged run, receipt, and completion IDs do not match");
  if (receipt.status !== "staged-complete" || completion.status !== "complete") throw new Error("Staged run is not complete");
  if (!receipt.publicationEligible || !receipt.sourcePolicy?.inventoryMatches || receipt.sourcePolicy?.unresolvedDecisions !== 0) {
    throw new Error("Staged receipt is publication-ineligible");
  }
  if (receipt.contentMediaKeyVersion !== 1 || descriptor.binding?.contentMediaKeyVersion !== 1) {
    throw new Error("Staged receipt does not use the required content-versioned media-key schema");
  }
  if (descriptor.runId !== sha256(stableJson(descriptor.binding))) throw new Error("Staged run ID does not match its recorded binding");
  if (descriptor.binding.sourceSelectionSha256 !== sha256(stableJson(descriptor.binding.sourceSelection))) {
    throw new Error("Staged source-selection digest does not match its recorded selection");
  }
  if (descriptor.binding.proposedManifestSetSha256 !== sha256(stableJson(descriptor.binding.proposedManifestSet))) {
    throw new Error("Staged manifest-set digest does not match its recorded manifests");
  }
  if (descriptor.binding?.sourceSelection?.limit !== null) throw new Error("A sampled or limited staged run is an incomplete selected year");
  if (receipt.counts?.sources !== descriptor.binding.sourceSelection.files?.length) throw new Error("Staged receipt source count is incomplete");
  if (receipt.importerCommit !== descriptor.binding.importerCommit) throw new Error("Staged importer commit binding does not match its receipt");
  if (receipt.sourceSelectionSha256 !== descriptor.binding.sourceSelectionSha256) throw new Error("Staged source-selection binding does not match its receipt");
  if (receipt.proposedManifestSetSha256 !== descriptor.binding.proposedManifestSetSha256) throw new Error("Staged manifest-set binding does not match its receipt");
  if (receipt.outputSetSha256 !== sha256(stableJson(receipt.outputChecksums || []))) throw new Error("Staged receipt output-set digest is internally inconsistent");
  const boundSources = (descriptor.binding.sourceSelection.files || []).map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }));
  if (stableJson(receipt.sourceChecksums || []) !== stableJson(boundSources)) throw new Error("Staged receipt source checksums do not match its run binding");

  const receiptRecord = await fileRecord(receiptPath);
  if (receiptRecord.sha256 !== completion.receiptSha256) throw new Error("Staged receipt changed after final sealing");
  const completeRelativePath = "generated/journal/complete.json";
  const preSeal = await treeInventory(stagingRoot, new Set([completeRelativePath]));
  if (preSeal.sha256 !== completion.closedWorldSha256 || preSeal.files.length !== completion.expectedFileCountBeforeSeal) {
    throw new Error("Staged closed-world seal no longer matches its files");
  }
  const expectedStagePaths = new Set([
    ...(receipt.outputChecksums || []).map((entry) => entry.path),
    toPosix(path.relative(stagingRoot, receiptPath)),
    "generated/journal/run.json",
    "generated/journal/progress.ndjson",
    completeRelativePath
  ]);
  const actualStagePaths = new Set((await walkFiles(stagingRoot)).map((filePath) => toPosix(path.relative(stagingRoot, filePath))));
  assertExactSet(actualStagePaths, expectedStagePaths, "Staged output set");
  for (const expected of receipt.outputChecksums || []) {
    const actual = await fileRecord(path.join(stagingRoot, expected.path));
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`Staged output checksum mismatch: ${expected.path}`);
  }

  const mediaByKey = new Map();
  for (const media of receipt.media || []) {
    if (!isSupportedMediaKey(media.key) || !media.key.includes("-cv1-")) throw new Error(`Staged receipt contains a non-versioned media key: ${media.key}`);
    if (mediaByKey.has(media.key)) throw new Error(`Duplicate staged media key: ${media.key}`);
    const relativePath = `generated/library/${media.key}`;
    const output = (receipt.outputChecksums || []).find((entry) => entry.path === relativePath);
    if (!output || output.sha256 !== media.outputSha256 || output.bytes !== media.bytes) throw new Error(`Staged media is not bound to output inventory: ${media.key}`);
    const metadata = await sharp(path.join(stagingRoot, relativePath), { failOn: "error", limitInputPixels: false }).metadata();
    if (metadata.width !== media.dimensions?.width || metadata.height !== media.dimensions?.height) throw new Error(`Staged media dimensions changed: ${media.key}`);
    mediaByKey.set(media.key, media);
  }
  if (mediaByKey.size !== receipt.counts.derivatives || mediaByKey.size !== receipt.counts.sources * 2) throw new Error("Staged derivative set is incomplete");

  const manifestPaths = new Set();
  const selectedManifestFiles = new Map();
  for (const manifestRef of receipt.manifestReferences || []) {
    const relativePath = manifestRef.path;
    if (!relativePath.startsWith(`data/${year}/albums/`) || !relativePath.endsWith(".json")) throw new Error(`Unexpected staged manifest path: ${relativePath}`);
    const stagedPath = path.join(stagingRoot, "public", relativePath);
    const bytes = await fs.readFile(stagedPath);
    if (sha256(bytes) !== manifestRef.sha256) throw new Error(`Staged album manifest changed after receipt: ${relativePath}`);
    const manifest = JSON.parse(bytes.toString("utf8"));
    const actualRefs = (manifest.photos || []).map(({ id, thumbnailKey, displayKey }) => ({ id, thumbnailKey, displayKey }));
    if (stableJson(actualRefs) !== stableJson(manifestRef.photos)) throw new Error(`Staged album manifest references differ from receipt: ${relativePath}`);
    for (const photo of actualRefs) {
      if (!mediaByKey.has(photo.thumbnailKey) || !mediaByKey.has(photo.displayKey)) throw new Error(`Staged manifest references missing media for ${photo.id}`);
    }
    manifestPaths.add(relativePath);
    selectedManifestFiles.set(relativePath.slice("data/".length), bytes);
  }
  if (manifestPaths.size !== receipt.counts.albums) throw new Error("Staged album manifest set is incomplete");
  for (const relativePath of [`data/${year}/index.json`, "data/catalog.json"]) {
    const bytes = await fs.readFile(path.join(stagingRoot, "public", relativePath));
    selectedManifestFiles.set(relativePath.slice("data/".length), bytes);
  }
  return { year, descriptor, completion, receipt, receiptPath, receiptRecord, mediaByKey, selectedManifestFiles, preSeal };
}

async function verifyFreshPolicy(stage, policyPath, canonicalDataRoot, concurrency) {
  const inventory = stage.descriptor.binding?.sourcePolicy?.freshInventory;
  if (!inventory?.sourceRoot || !Array.isArray(inventory.scanRoots)) throw new Error("Staged run lacks its exact source inventory selection");
  const inspection = await inspectSourcePolicy({
    sourceRoot: inventory.sourceRoot,
    scanRoots: inventory.scanRoots,
    selectedYear: stage.year,
    concurrency,
    publicDataRoot: path.dirname(canonicalDataRoot)
  });
  const policy = await readJson(policyPath, "Reviewed source policy");
  const eligibility = evaluateSourcePolicy(inspection, policy);
  if (!eligibility.publicationEligible || !eligibility.inventoryMatches || eligibility.counts.unresolved !== 0) {
    throw new Error("Fresh source policy is missing, stale, unresolved, or incompatible");
  }
  if (eligibility.policySha256 !== stage.receipt.sourcePolicy.policySha256 || eligibility.policySha256 !== stage.descriptor.binding.sourcePolicy.policySha256) {
    throw new Error("Reviewed source policy changed after staging");
  }
  if (
    eligibility.freshInventorySha256 !== stage.receipt.sourcePolicy.freshInventorySha256 ||
    eligibility.freshInventorySha256 !== inventory.inventorySha256
  ) {
    throw new Error("Physical source inventory changed after staging");
  }
  return { inspection, eligibility };
}

function parseAndValidateYear(files, year) {
  const indexPath = `${year}/index.json`;
  const indexBytes = files.get(indexPath);
  if (!indexBytes) throw new Error(`Missing year index: ${indexPath}`);
  const index = JSON.parse(indexBytes.toString("utf8"));
  if (String(index.year) !== year) throw new Error(`Year index identity mismatch: ${indexPath}`);
  const manifestMap = new Map();
  const expectedFiles = new Set([indexPath]);
  const ids = new Set();
  const sequence = index.sequence || [];
  const sequenceIds = sequence.map((entry) => entry.id);
  if (new Set(sequenceIds).size !== sequenceIds.length) throw new Error(`Duplicate IDs in ${indexPath} sequence`);
  for (const album of index.albums || []) {
    const manifestPath = publicPathFromUrl(album.manifestUrl);
    if (!manifestPath.startsWith(`${year}/albums/`) || !manifestPath.endsWith(".json")) throw new Error(`Unexpected manifest reference in ${indexPath}: ${album.manifestUrl}`);
    const bytes = files.get(manifestPath);
    if (!bytes) throw new Error(`Missing referenced album manifest: ${manifestPath}`);
    expectedFiles.add(manifestPath);
    const manifest = JSON.parse(bytes.toString("utf8"));
    if ((manifest.photos || []).length !== album.count) throw new Error(`Album count mismatch: ${manifestPath}`);
    for (const photo of manifest.photos || []) {
      if (ids.has(photo.id)) throw new Error(`Duplicate photo ID in candidate data: ${photo.id}`);
      ids.add(photo.id);
      if (photo.albumId !== album.id) throw new Error(`Photo album ID mismatch for ${photo.id}`);
      if (!photo.thumbnailKey || !photo.displayKey) throw new Error(`Missing media reference for ${photo.id}`);
    }
    manifestMap.set(manifestPath, manifest);
  }
  const manifestIds = Array.from(manifestMap.values()).flatMap((manifest) => manifest.photos || []).map((photo) => photo.id);
  if (manifestIds.length !== sequenceIds.length || new Set([...manifestIds, ...sequenceIds]).size !== ids.size) throw new Error(`Incomplete sequence or manifest set for ${year}`);
  for (const id of sequenceIds) if (!ids.has(id)) throw new Error(`Sequence references missing photo ID ${id}`);
  const actualYearFiles = new Set(Array.from(files.keys()).filter((filePath) => filePath.startsWith(`${year}/`)));
  assertExactSet(actualYearFiles, expectedFiles, `Public data for ${year}`);
  return { index, manifestMap, ids, expectedFiles };
}

async function loadCanonicalData(canonicalDataRoot) {
  const files = new Map();
  for (const absolutePath of await walkFiles(canonicalDataRoot)) {
    const relativePath = toPosix(path.relative(canonicalDataRoot, absolutePath));
    files.set(relativePath, await fs.readFile(absolutePath));
  }
  const catalogBytes = files.get("catalog.json");
  if (!catalogBytes) throw new Error("Canonical public data has no catalogue");
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  const years = new Map();
  const expectedFiles = new Set(["catalog.json"]);
  for (const entry of catalog.years || []) {
    const year = String(entry.year);
    if (years.has(year)) throw new Error(`Duplicate catalogue year: ${year}`);
    if (publicPathFromUrl(entry.indexUrl) !== `${year}/index.json`) throw new Error(`Unexpected index URL for ${year}`);
    const model = parseAndValidateYear(files, year);
    years.set(year, { entry, ...model });
    for (const filePath of model.expectedFiles) expectedFiles.add(filePath);
  }
  assertExactSet(files.keys(), expectedFiles, "Canonical public-data tree");
  return { files, catalog, years, inventory: inventoryForBuffers(files) };
}

function buildCandidateFiles(canonical, stage) {
  const files = new Map(canonical.files);
  for (const key of Array.from(files.keys())) if (key.startsWith(`${stage.year}/`)) files.delete(key);
  for (const [relativePath, bytes] of stage.selectedManifestFiles) {
    if (relativePath !== "catalog.json") files.set(relativePath, bytes);
  }
  const stagedCatalog = JSON.parse(stage.selectedManifestFiles.get("catalog.json").toString("utf8"));
  const stagedEntry = (stagedCatalog.years || []).find((entry) => String(entry.year) === stage.year) || { year: stage.year, indexUrl: `data/${stage.year}/index.json` };
  const years = [];
  let replaced = false;
  for (const entry of canonical.catalog.years || []) {
    if (String(entry.year) === stage.year) {
      years.push(stagedEntry);
      replaced = true;
    } else years.push(entry);
  }
  if (!replaced) years.push(stagedEntry);
  years.sort((left, right) => Number(right.year) - Number(left.year));
  files.set("catalog.json", jsonBytes({ years }));
  const catalogue = JSON.parse(files.get("catalog.json").toString("utf8"));
  const models = new Map();
  const globalIds = new Map();
  const expected = new Set(["catalog.json"]);
  for (const entry of catalogue.years) {
    const year = String(entry.year);
    if (publicPathFromUrl(entry.indexUrl) !== `${year}/index.json`) throw new Error(`Candidate catalogue index mismatch for ${year}`);
    const model = parseAndValidateYear(files, year);
    models.set(year, { entry, ...model });
    for (const id of model.ids) {
      if (globalIds.has(id)) throw new Error(`Duplicate photo ID across candidate years: ${id}`);
      globalIds.set(id, year);
    }
    for (const filePath of model.expectedFiles) expected.add(filePath);
  }
  assertExactSet(files.keys(), expected, "Candidate public-data tree");
  return { files, catalogue, years: models, inventory: inventoryForBuffers(files) };
}

function manifestReferenceMap(candidate) {
  const manifests = [];
  for (const [year, model] of candidate.years) {
    for (const [manifestPath, manifest] of model.manifestMap) {
      manifests.push({
        year,
        manifestPath,
        manifestSha256: candidate.inventory.files.find((file) => file.path === manifestPath)?.sha256,
        photos: (manifest.photos || []).map((photo) => ({ id: photo.id, thumbnailKey: photo.thumbnailKey, displayKey: photo.displayKey }))
      });
    }
  }
  manifests.sort((left, right) => left.manifestPath.localeCompare(right.manifestPath, undefined, { numeric: true }));
  return { manifests, sha256: sha256(stableJson(manifests)) };
}

function mediaReferencesByYear(dataModel) {
  const byYear = new Map();
  for (const [year, model] of dataModel.years) {
    const keys = new Set();
    for (const manifest of model.manifestMap.values()) {
      for (const photo of manifest.photos || []) {
        keys.add(photo.thumbnailKey);
        keys.add(photo.displayKey);
      }
    }
    byYear.set(year, keys);
  }
  return byYear;
}

async function canonicalMediaInventory(canonicalMediaRoot) {
  const records = new Map();
  for (const absolutePath of await walkFiles(canonicalMediaRoot)) {
    const key = toPosix(path.relative(canonicalMediaRoot, absolutePath));
    if (!isSupportedMediaKey(key)) throw new Error(`Unexpected canonical media key: ${key}`);
    records.set(key, { key, ...(await fileRecord(absolutePath)), path: absolutePath });
  }
  return records;
}

async function buildMediaInventory({ canonical, candidate, stage, canonicalMediaRoot, stagingRoot }) {
  const canonicalMedia = await canonicalMediaInventory(canonicalMediaRoot);
  const previousByYear = mediaReferencesByYear(canonical);
  const candidateByYear = mediaReferencesByYear(candidate);
  const previousKeys = new Set(Array.from(previousByYear.values()).flatMap((keys) => Array.from(keys)));
  const expectedKeys = new Set(Array.from(candidateByYear.values()).flatMap((keys) => Array.from(keys)));
  const selectedKeys = candidateByYear.get(stage.year) || new Set();
  const stageKeys = new Set(stage.mediaByKey.keys());
  assertExactSet(selectedKeys, stageKeys, "Selected-year staged media references");

  const conflicts = [];
  const newVersionedKeys = [];
  const existingVersionedKeys = [];
  const existingLegacyKeysRetained = [];
  const expectedMedia = [];
  const newMediaSources = new Map();
  for (const key of Array.from(expectedKeys).sort()) {
    if (selectedKeys.has(key)) {
      const staged = stage.mediaByKey.get(key);
      const canonicalRecord = canonicalMedia.get(key);
      if (canonicalRecord && (canonicalRecord.bytes !== staged.bytes || canonicalRecord.sha256 !== staged.outputSha256)) {
        conflicts.push({ key, canonical: { bytes: canonicalRecord.bytes, sha256: canonicalRecord.sha256 }, staged: { bytes: staged.bytes, sha256: staged.outputSha256 } });
        continue;
      }
      const record = { key, bytes: staged.bytes, sha256: staged.outputSha256, source: canonicalRecord ? "canonical-versioned" : "staged-new" };
      expectedMedia.push(record);
      if (canonicalRecord) existingVersionedKeys.push(record);
      else {
        newVersionedKeys.push(record);
        newMediaSources.set(key, path.join(stagingRoot, "generated", "library", key));
      }
    } else {
      const canonicalRecord = canonicalMedia.get(key);
      if (!canonicalRecord) throw new Error(`Candidate manifest references missing canonical media: ${key}`);
      const record = { key, bytes: canonicalRecord.bytes, sha256: canonicalRecord.sha256, source: "canonical-legacy" };
      expectedMedia.push(record);
    }
  }
  if (conflicts.length) throw new Error(`Media-key conflict with different bytes: ${conflicts.map((entry) => entry.key).join(", ")}`);

  const rollbackKeys = [];
  for (const key of Array.from(previousKeys).sort()) {
    const record = canonicalMedia.get(key);
    if (!record) throw new Error(`Previous manifest rollback reference is missing media: ${key}`);
    rollbackKeys.push({ key, bytes: record.bytes, sha256: record.sha256 });
    if (!key.includes("-cv")) {
      existingLegacyKeysRetained.push({
        key,
        bytes: record.bytes,
        sha256: record.sha256,
        retainedFor: expectedKeys.has(key) ? "candidate-unaffected-year" : "previous-manifest-rollback"
      });
    }
  }
  const obsoleteButRetainedKeys = Array.from(canonicalMedia.values())
    .filter((record) => !expectedKeys.has(record.key))
    .map(({ key, bytes, sha256: digest }) => ({ key, bytes, sha256: digest, reason: previousKeys.has(key) ? "previous-manifest-rollback" : "unreferenced-canonical-object" }))
    .sort((left, right) => left.key.localeCompare(right.key));
  expectedMedia.sort((left, right) => left.key.localeCompare(right.key));
  const inventory = {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    expectedMedia,
    expectedMediaSha256: sha256(stableJson(expectedMedia)),
    newVersionedKeys,
    existingVersionedKeys,
    existingLegacyKeysRetained,
    obsoleteButRetainedKeys,
    rollbackKeys,
    conflicts: []
  };
  return { inventory, sha256: sha256(stableJson(inventory)), newMediaSources };
}

async function writePackage({ packageRoot, candidate, media, manifestMap, binding }) {
  const parent = path.dirname(packageRoot);
  await fs.mkdir(parent, { recursive: true });
  const temporaryRoot = path.join(parent, `.${path.basename(packageRoot)}.pixilation-package-${crypto.randomBytes(8).toString("hex")}`);
  await fs.mkdir(temporaryRoot, { recursive: false });
  try {
    for (const [relativePath, bytes] of candidate.files) {
      const target = path.join(temporaryRoot, "candidate", "public", "data", relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: "wx" });
    }
    for (const [key, sourcePath] of media.newMediaSources) {
      const target = path.join(temporaryRoot, "media", "new", key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(sourcePath, target, fs.constants.COPYFILE_EXCL);
    }
    const metadataFiles = new Map([
      ["inventories/public-data.json", jsonBytes({ schemaVersion: PACKAGE_SCHEMA_VERSION, ...candidate.inventory })],
      ["inventories/media.json", jsonBytes(media.inventory)],
      ["maps/manifest-media.json", jsonBytes(manifestMap)]
    ]);
    for (const [relativePath, bytes] of metadataFiles) {
      const target = path.join(temporaryRoot, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: "wx" });
    }
    const packageId = sha256(stableJson(binding));
    const packageReceipt = { schemaVersion: PACKAGE_SCHEMA_VERSION, status: "publishable-local-package", publicationEligible: true, packageId, binding };
    await fs.writeFile(path.join(temporaryRoot, "package.json"), jsonBytes(packageReceipt), { flag: "wx" });
    const preSeal = await treeInventory(temporaryRoot);
    const completion = { schemaVersion: PACKAGE_SCHEMA_VERSION, status: "complete", packageId, fileCountBeforeSeal: preSeal.files.length, closedWorldSha256: preSeal.sha256 };
    await fs.writeFile(path.join(temporaryRoot, "complete.json"), jsonBytes(completion), { flag: "wx" });
    await verifyPromotionPackage(temporaryRoot);
    await fs.rename(temporaryRoot, packageRoot);
    return { packageId, packageReceipt, completion };
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyPromotionPackage(packageRoot) {
  const receipt = await readJson(path.join(packageRoot, "package.json"), "Promotion package receipt");
  const completion = await readJson(path.join(packageRoot, "complete.json"), "Promotion package completion seal");
  if (receipt.status !== "publishable-local-package" || !receipt.publicationEligible || completion.status !== "complete") throw new Error("Promotion package is not publishable and complete");
  if (receipt.packageId !== completion.packageId || receipt.packageId !== sha256(stableJson(receipt.binding))) throw new Error("Promotion package identity does not match its binding");
  const preSeal = await treeInventory(packageRoot, new Set(["complete.json"]));
  if (preSeal.files.length !== completion.fileCountBeforeSeal || preSeal.sha256 !== completion.closedWorldSha256) throw new Error("Promotion package closed-world seal does not match");
  const publicInventory = await treeInventory(path.join(packageRoot, "candidate", "public", "data"));
  if (publicInventory.sha256 !== receipt.binding.publicDataSha256) throw new Error("Candidate public-data checksum changed");
  const media = await readJson(path.join(packageRoot, "inventories", "media.json"), "Promotion media inventory");
  if (sha256(stableJson(media)) !== receipt.binding.mediaInventorySha256) throw new Error("Promotion media inventory changed");
  for (const entry of media.newVersionedKeys || []) {
    const actual = await fileRecord(path.join(packageRoot, "media", "new", entry.key));
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error(`Packaged media checksum mismatch: ${entry.key}`);
  }
  const actualNewKeys = new Set((await walkFiles(path.join(packageRoot, "media", "new"))).map((filePath) => toPosix(path.relative(path.join(packageRoot, "media", "new"), filePath))));
  assertExactSet(actualNewKeys, new Set((media.newVersionedKeys || []).map((entry) => entry.key)), "Packaged new-media set");
  return { receipt, completion, publicInventory, media };
}

export async function buildPromotionPackage(options) {
  const stagingRoot = path.resolve(options.stagingRoot);
  const packageRoot = path.resolve(options.packageRoot);
  const policyPath = path.resolve(options.policyPath);
  const canonicalDataRoot = path.resolve(options.canonicalDataRoot || path.join(APP_ROOT, "public", "data"));
  const canonicalMediaRoot = path.resolve(options.canonicalMediaRoot || path.join(APP_ROOT, "generated", "library"));
  const concurrency = options.concurrency || 6;
  if (await exists(packageRoot)) throw new Error(`Package root must not already exist: ${packageRoot}`);
  const physical = {
    staging: await physicalPathWithoutCreating(stagingRoot),
    package: await physicalPathWithoutCreating(packageRoot),
    canonicalData: await physicalPathWithoutCreating(canonicalDataRoot),
    canonicalMedia: await physicalPathWithoutCreating(canonicalMediaRoot)
  };
  for (const [name, target] of Object.entries({ staging: physical.staging, canonicalData: physical.canonicalData, canonicalMedia: physical.canonicalMedia })) {
    if (isInsideOrEqual(physical.package, target) || isInsideOrEqual(target, physical.package)) throw new Error(`Package root overlaps ${name}: ${packageRoot}`);
  }

  const stage = await verifyStagedRun(stagingRoot);
  const sourceRoot = await physicalPathWithoutCreating(stage.descriptor.binding.sourcePolicy.freshInventory.sourceRoot);
  if (isInsideOrEqual(physical.package, sourceRoot) || isInsideOrEqual(sourceRoot, physical.package)) throw new Error("Package root overlaps the physical source archive");
  const policy = await verifyFreshPolicy(stage, policyPath, canonicalDataRoot, concurrency);
  const canonical = await loadCanonicalData(canonicalDataRoot);
  const candidate = buildCandidateFiles(canonical, stage);
  const selected = candidate.years.get(stage.year);
  if (!selected || selected.ids.size !== stage.receipt.counts.sources) throw new Error("Candidate selected year is incomplete");
  const manifestMap = manifestReferenceMap(candidate);
  const media = await buildMediaInventory({ canonical, candidate, stage, canonicalMediaRoot, stagingRoot });
  const oldSelectedManifests = new Set(canonical.years.get(stage.year)?.manifestMap.keys() || []);
  const newSelectedManifests = new Set(selected.manifestMap.keys());
  const obsoleteButRetainedManifests = Array.from(oldSelectedManifests).filter((manifestPath) => !newSelectedManifests.has(manifestPath)).sort();
  const binding = {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    selectedYear: stage.year,
    stagedRunId: stage.receipt.runId,
    stagedReceiptSha256: stage.receiptRecord.sha256,
    stagedClosedWorldSha256: stage.completion.closedWorldSha256,
    sourcePolicySha256: policy.eligibility.policySha256,
    sourceInventorySha256: policy.eligibility.freshInventorySha256,
    importerCommit: stage.receipt.importerCommit,
    previousPublicDataSha256: canonical.inventory.sha256,
    publicDataSha256: candidate.inventory.sha256,
    mediaInventorySha256: media.sha256,
    manifestReferenceMapSha256: manifestMap.sha256,
    obsoleteButRetainedManifests
  };
  const written = await writePackage({ packageRoot, candidate, media, manifestMap, binding });
  const verification = await verifyPromotionPackage(packageRoot);
  return { packageRoot, ...written, binding, publicData: candidate.inventory, media: media.inventory, manifestMap, verification };
}

function parseArgs(argv) {
  const args = { stagingRoot: null, packageRoot: null, policyPath: null, canonicalDataRoot: null, canonicalMediaRoot: null, concurrency: 6 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    index += 1;
    if (token === "--staging-root") args.stagingRoot = value;
    else if (token === "--package-root") args.packageRoot = value;
    else if (token === "--source-policy") args.policyPath = value;
    else if (token === "--canonical-data-root") args.canonicalDataRoot = value;
    else if (token === "--canonical-media-root") args.canonicalMediaRoot = value;
    else if (token === "--concurrency") args.concurrency = Number(value);
    else throw new Error(`Unknown option ${token}`);
  }
  if (!args.stagingRoot || !args.packageRoot || !args.policyPath) throw new Error("Provide --staging-root, --package-root, and --source-policy");
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error("--concurrency must be a positive integer");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildPromotionPackage(args);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "publishable-local-package",
        packageRoot: result.packageRoot,
        packageId: result.packageId,
        selectedYear: result.binding.selectedYear,
        publicDataSha256: result.binding.publicDataSha256,
        expectedMedia: result.media.expectedMedia.length,
        newVersionedKeys: result.media.newVersionedKeys.length,
        existingLegacyKeysRetained: result.media.existingLegacyKeysRetained.length,
        obsoleteButRetainedKeys: result.media.obsoleteButRetainedKeys.length
      },
      null,
      2
    )}\n`
  );
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
