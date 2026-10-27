import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isSupportedMediaKey } from "./content-versioned-media.mjs";
import { canonicalMediaInventory, loadCanonicalData, verifyStagedRun } from "./promote-staged-release.mjs";

const AGGREGATE_SCHEMA_VERSION = 1;
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_ROOT, "..");
const HEX_64 = /^[a-f0-9]{64}$/;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
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

function naturalCompare(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}

function isInsideOrEqual(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is missing or invalid JSON: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fileRecord(filePath, relativePath = null) {
  const bytes = await fs.readFile(filePath);
  return { ...(relativePath === null ? {} : { path: relativePath }), bytes: bytes.length, sha256: sha256(bytes) };
}

async function mapLimit(items, limit, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker));
  return result;
}

async function walkFiles(root) {
  const files = [];
  if (!(await exists(root))) return files;
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => naturalCompare(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Unexpected symlink in closed-world tree: ${absolute}`);
      if (stat.isDirectory()) await walk(absolute);
      else if (stat.isFile()) files.push(absolute);
      else throw new Error(`Unexpected non-regular entry in closed-world tree: ${absolute}`);
    }
  }
  await walk(root);
  return files;
}

async function treeInventory(root, excluded = new Set()) {
  const records = [];
  for (const absolute of await walkFiles(root)) {
    const relative = toPosix(path.relative(root, absolute));
    if (!excluded.has(relative)) records.push(await fileRecord(absolute, relative));
  }
  records.sort((left, right) => naturalCompare(left.path, right.path));
  return { files: records, sha256: sha256(stableJson(records)) };
}

function inventoryForBuffers(files) {
  const records = Array.from(files, ([relative, bytes]) => ({ path: relative, bytes: bytes.length, sha256: sha256(bytes) }));
  records.sort((left, right) => naturalCompare(left.path, right.path));
  return { files: records, sha256: sha256(stableJson(records)) };
}

function assertExactSet(actualValues, expectedValues, label) {
  const actual = new Set(actualValues);
  const expected = new Set(expectedValues);
  const missing = Array.from(expected).filter((value) => !actual.has(value)).sort(naturalCompare);
  const extra = Array.from(actual).filter((value) => !expected.has(value)).sort(naturalCompare);
  if (missing.length || extra.length) throw new Error(`${label} is not exact: missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}`);
}

function assertYears(years, label) {
  if (!Array.isArray(years) || !years.length || years.some((year) => !/^\d{4}$/.test(String(year)))) throw new Error(`${label} must contain four-digit years`);
  const normalized = years.map(String);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicate years`);
  if (stableJson(normalized) !== stableJson([...normalized].sort())) throw new Error(`${label} must be sorted ascending`);
  return normalized;
}

function publicPathFromUrl(url) {
  if (typeof url !== "string" || !url.startsWith("data/") || url.includes("..") || path.isAbsolute(url)) throw new Error(`Unsafe public data URL: ${url}`);
  return url.slice("data/".length);
}

function importerIdentity(stage) {
  const binding = stage.descriptor.binding;
  return {
    importerCommit: binding.importerCommit,
    importerScriptSha256: binding.importerScriptSha256,
    sharpVersion: binding.sharpVersion,
    derivativeRecipeSha256: sha256(stableJson(binding.derivativeRecipe)),
    contentMediaKeyVersion: binding.contentMediaKeyVersion
  };
}

async function inspectFreshInventory(stage, concurrency) {
  const recorded = stage.descriptor.binding?.sourcePolicy?.freshInventory;
  if (!recorded?.sourceRoot || !Array.isArray(recorded.scanRoots) || !Array.isArray(recorded.files)) throw new Error(`${stage.year}: stage lacks an exact source inventory`);
  const sourceRoot = path.resolve(recorded.sourceRoot);
  const sourceStat = await fs.lstat(sourceRoot);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error(`${stage.year}: physical master root is a symlink or not a directory`);
  if (path.resolve(await fs.realpath(sourceRoot)) !== sourceRoot) throw new Error(`${stage.year}: physical master root does not resolve exactly`);
  const files = [];
  const symlinks = [];
  const seen = new Set();
  for (const rawScanRoot of recorded.scanRoots) {
    const scanRoot = path.resolve(rawScanRoot);
    if (!isInsideOrEqual(scanRoot, sourceRoot)) throw new Error(`${stage.year}: source scan root escapes the physical master`);
    const scanStat = await fs.lstat(scanRoot);
    if (scanStat.isSymbolicLink() || !scanStat.isDirectory() || path.resolve(await fs.realpath(scanRoot)) !== scanRoot) throw new Error(`${stage.year}: source scan root is indirect or invalid`);
    async function walk(directory) {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => naturalCompare(left.name, right.name));
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        const relative = toPosix(path.relative(sourceRoot, absolute));
        if (seen.has(relative)) throw new Error(`${stage.year}: overlapping source roots select ${relative} more than once`);
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) {
          seen.add(relative);
          symlinks.push(relative);
        } else if (stat.isDirectory()) await walk(absolute);
        else if (stat.isFile()) {
          seen.add(relative);
          files.push({ absolute, path: relative });
        } else throw new Error(`${stage.year}: unsupported source entry ${relative}`);
      }
    }
    await walk(scanRoot);
  }
  const signatures = await mapLimit(files, concurrency, async (file) => ({ path: file.path, ...(await fileRecord(file.absolute)) }));
  signatures.sort((left, right) => naturalCompare(left.path, right.path));
  symlinks.sort(naturalCompare);
  const identity = { sourceRoot: recorded.sourceRoot, scanRoots: recorded.scanRoots, selectedYear: recorded.selectedYear, files: signatures, symlinks };
  const actual = {
    ...identity,
    fileCount: signatures.length,
    totalBytes: signatures.reduce((sum, file) => sum + file.bytes, 0),
    inventorySha256: sha256(stableJson(identity))
  };
  if (stableJson(actual) !== stableJson(recorded)) throw new Error(`${stage.year}: staged source inventory is stale`);
  return { physicalSourceRoot: sourceRoot, inventory: actual };
}

function stageContractFact(stage, freshInventory) {
  return {
    year: stage.year,
    runId: stage.receipt.runId,
    receiptSha256: stage.receiptRecord.sha256,
    closedWorldSha256: stage.completion.closedWorldSha256,
    sourceInventorySha256: freshInventory.inventory.inventorySha256,
    sourceInventoryFileCount: freshInventory.inventory.fileCount,
    sourceInventoryTotalBytes: freshInventory.inventory.totalBytes,
    sourceSelectionSha256: stage.receipt.sourceSelectionSha256,
    proposedManifestSetSha256: stage.receipt.proposedManifestSetSha256,
    outputSetSha256: stage.receipt.outputSetSha256,
    policySha256: stage.receipt.sourcePolicy.policySha256,
    decisionSetSha256: stage.descriptor.binding.sourcePolicy.decisionSetSha256,
    importerIdentity: importerIdentity(stage)
  };
}

function canonicalPhotoMap(canonical) {
  const photos = new Map();
  for (const [year, model] of canonical.years) {
    for (const manifest of model.manifestMap.values()) {
      for (const photo of manifest.photos || []) {
        if (photos.has(photo.id)) throw new Error(`Duplicate photo ID in previous release: ${photo.id}`);
        photos.set(photo.id, { year, ...photo });
      }
    }
  }
  return photos;
}

function mediaInventoryRecords(media) {
  return Array.from(media.values(), ({ key, bytes, sha256: digest }) => ({ key, bytes, sha256: digest })).sort((left, right) => naturalCompare(left.key, right.key));
}

export async function inspectAggregateInputs(options) {
  if (!Array.isArray(options.stagingRoots) || !options.stagingRoots.length) throw new Error("Provide at least one stage root");
  const concurrency = options.concurrency || 8;
  const resolvedStageRoots = options.stagingRoots.map((root) => path.resolve(root));
  if (new Set(resolvedStageRoots).size !== resolvedStageRoots.length) throw new Error("Duplicate stage root supplied");
  const stages = [];
  const years = new Set();
  for (const stagingRoot of resolvedStageRoots) {
    const stage = await verifyStagedRun(stagingRoot);
    if (years.has(stage.year)) throw new Error(`Duplicate stage for year ${stage.year}`);
    years.add(stage.year);
    const freshInventory = await inspectFreshInventory(stage, concurrency);
    stages.push({ ...stage, stagingRoot, freshInventory });
  }
  stages.sort((left, right) => left.year.localeCompare(right.year));
  const sourceRoots = new Set(stages.map((stage) => stage.freshInventory.physicalSourceRoot));
  if (sourceRoots.size !== 1) throw new Error("Mixed physical source roots are forbidden");
  const identities = new Set(stages.map((stage) => stableJson(importerIdentity(stage))));
  if (identities.size !== 1) throw new Error("Mixed importer or derivative-recipe identities are forbidden");

  const canonicalDataRoot = path.resolve(options.canonicalDataRoot || path.join(APP_ROOT, "public", "data"));
  const canonicalMediaRoot = path.resolve(options.canonicalMediaRoot || path.join(APP_ROOT, "generated", "library"));
  const [canonical, canonicalMedia] = await Promise.all([loadCanonicalData(canonicalDataRoot), canonicalMediaInventory(canonicalMediaRoot)]);
  const previousPhotos = canonicalPhotoMap(canonical);
  const rollbackMedia = mediaInventoryRecords(canonicalMedia);
  const facts = {
    intendedYears: stages.map((stage) => stage.year),
    physicalSourceRoot: Array.from(sourceRoots)[0],
    importerIdentity: importerIdentity(stages[0]),
    stages: stages.map((stage) => stageContractFact(stage, stage.freshInventory)),
    previousRelease: {
      publicDataSha256: canonical.inventory.sha256,
      publicDataFileCount: canonical.inventory.files.length,
      mediaInventorySha256: sha256(stableJson(rollbackMedia)),
      mediaObjectCount: rollbackMedia.length,
      publishedPhotoCount: previousPhotos.size
    }
  };
  return { stages, canonical, canonicalMedia, previousPhotos, rollbackMedia, canonicalDataRoot, canonicalMediaRoot, facts };
}

function validateContract(contract, facts) {
  if (contract?.schemaVersion !== AGGREGATE_SCHEMA_VERSION) throw new Error(`Aggregate contract schemaVersion must be ${AGGREGATE_SCHEMA_VERSION}`);
  if (contract.status !== "approved" || typeof contract.approvalId !== "string" || !contract.approvalId.trim()) throw new Error("Aggregate contract is not explicitly approved");
  const intendedYears = assertYears(contract.intendedYears, "intended-year contract");
  assertExactSet(facts.intendedYears, intendedYears, "Stage years versus intended-year contract");
  if (contract.physicalSourceRoot !== facts.physicalSourceRoot) throw new Error("Contract physical master root does not match the stages");
  if (stableJson(contract.importerIdentity) !== stableJson(facts.importerIdentity)) throw new Error("Contract importer or recipe identity does not match the stages");
  if (!Array.isArray(contract.stages)) throw new Error("Contract must bind every exact stage");
  assertExactSet(contract.stages.map((stage) => String(stage.year)), intendedYears, "Contract stage bindings");
  const actualStages = new Map(facts.stages.map((stage) => [stage.year, stage]));
  for (const expected of contract.stages) {
    const actual = actualStages.get(String(expected.year));
    if (stableJson(expected) !== stableJson(actual)) throw new Error(`${expected.year}: stage binding differs from the exact contract`);
  }
  const release = contract.previousRelease;
  if (!release || typeof release.releaseId !== "string" || !release.releaseId.trim()) throw new Error("Contract must identify the immutable previous release");
  for (const key of ["publicDataSha256", "mediaInventorySha256"]) if (!HEX_64.test(release[key] || "")) throw new Error(`Contract previousRelease.${key} must be a SHA-256 digest`);
  const expectedRelease = { ...facts.previousRelease, releaseId: release.releaseId };
  if (stableJson(release) !== stableJson(expectedRelease)) throw new Error("Rollback release inventory is missing, stale, or incomplete");
  if (contract.expectedPublishedPhotoCount !== facts.previousRelease.publishedPhotoCount) throw new Error("Published-photo transition count does not match the previous release");
  return { intendedYears, contractSha256: sha256(stableJson(contract)) };
}

function stagedCatalogueEntry(stage) {
  const catalogBytes = stage.selectedManifestFiles.get("catalog.json");
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  if (!Array.isArray(catalog.years) || catalog.years.length !== 1 || String(catalog.years[0].year) !== stage.year) throw new Error(`${stage.year}: staged catalogue is not closed to its selected year`);
  return catalog.years[0];
}

export function validateAggregateCandidateFiles(files, intendedYears) {
  const expectedYears = assertYears(intendedYears, "candidate intended years");
  const catalogBytes = files.get("catalog.json");
  if (!catalogBytes) throw new Error("Aggregate candidate has no catalogue");
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  const catalogYears = (catalog.years || []).map((entry) => String(entry.year));
  assertExactSet(catalogYears, expectedYears, "Candidate catalogue years");
  const expectedCatalogOrder = [...expectedYears].sort((left, right) => Number(right) - Number(left));
  if (stableJson(catalogYears) !== stableJson(expectedCatalogOrder)) throw new Error("Candidate catalogue years are not ordered newest first");
  const expectedFiles = new Set(["catalog.json"]);
  const globalPhotoIds = new Map();
  const globalAlbumIds = new Map();
  const photos = new Map();
  const years = new Map();
  for (const entry of catalog.years) {
    const year = String(entry.year);
    const indexPath = `${year}/index.json`;
    if (publicPathFromUrl(entry.indexUrl) !== indexPath) throw new Error(`${year}: catalogue index URL is invalid`);
    const indexBytes = files.get(indexPath);
    if (!indexBytes) throw new Error(`${year}: candidate year index is missing`);
    expectedFiles.add(indexPath);
    const index = JSON.parse(indexBytes.toString("utf8"));
    if (String(index.year) !== year) throw new Error(`${year}: year index identity mismatch`);
    const albums = new Map();
    const orderedPhotoIds = [];
    for (const album of index.albums || []) {
      if (albums.has(album.id)) throw new Error(`${year}: duplicate album ID ${album.id}`);
      if (globalAlbumIds.has(album.id)) throw new Error(`Duplicate album ID across candidate years: ${album.id}`);
      const manifestPath = publicPathFromUrl(album.manifestUrl);
      if (!manifestPath.startsWith(`${year}/albums/`) || !manifestPath.endsWith(".json")) throw new Error(`${year}: invalid album manifest path ${manifestPath}`);
      const manifestBytes = files.get(manifestPath);
      if (!manifestBytes) throw new Error(`${year}: referenced album manifest is missing: ${manifestPath}`);
      expectedFiles.add(manifestPath);
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      if ((manifest.photos || []).length !== album.count) throw new Error(`${year}: album count mismatch for ${album.id}`);
      for (let albumPosition = 0; albumPosition < (manifest.photos || []).length; albumPosition += 1) {
        const photo = manifest.photos[albumPosition];
        if (globalPhotoIds.has(photo.id)) throw new Error(`Duplicate photo ID across candidate years: ${photo.id}`);
        if (photo.albumId !== album.id) throw new Error(`${year}: photo ${photo.id} has the wrong album ID`);
        if (photo.albumSortPosition !== albumPosition || photo.sortPosition !== orderedPhotoIds.length) throw new Error(`${year}: photo ordering is not exact for ${photo.id}`);
        if (!isSupportedMediaKey(photo.thumbnailKey) || !isSupportedMediaKey(photo.displayKey)) throw new Error(`${year}: photo ${photo.id} has an invalid media key`);
        globalPhotoIds.set(photo.id, year);
        photos.set(photo.id, { year, ...photo });
        orderedPhotoIds.push(photo.id);
      }
      albums.set(album.id, { album, manifestPath, manifest });
      globalAlbumIds.set(album.id, year);
    }
    const sequence = (index.sequence || []).map((item) => item.id);
    if (stableJson(sequence) !== stableJson(orderedPhotoIds)) throw new Error(`${year}: year sequence does not exactly match album ordering`);
    years.set(year, { entry, index, albums });
  }
  assertExactSet(files.keys(), expectedFiles, "Aggregate candidate public-data tree");
  return { catalog, years, photos, photoCount: photos.size, albumCount: globalAlbumIds.size };
}

function buildCandidate(stages, intendedYears) {
  const files = new Map();
  const entries = [];
  for (const stage of stages) {
    entries.push(stagedCatalogueEntry(stage));
    for (const [relative, bytes] of stage.selectedManifestFiles) {
      if (relative === "catalog.json") continue;
      if (!relative.startsWith(`${stage.year}/`)) throw new Error(`${stage.year}: staged public data leaks another year: ${relative}`);
      if (files.has(relative)) throw new Error(`Candidate public-data path collision: ${relative}`);
      files.set(relative, bytes);
    }
  }
  entries.sort((left, right) => Number(right.year) - Number(left.year));
  files.set("catalog.json", jsonBytes({ years: entries }));
  const model = validateAggregateCandidateFiles(files, intendedYears);
  return { files, model, inventory: inventoryForBuffers(files) };
}

function buildManifestMap(candidate) {
  const manifests = [];
  for (const [year, model] of candidate.model.years) {
    for (const { manifestPath, manifest } of model.albums.values()) {
      const record = candidate.inventory.files.find((file) => file.path === manifestPath);
      manifests.push({
        year,
        manifestPath,
        manifestSha256: record.sha256,
        photos: manifest.photos.map(({ id, thumbnailKey, displayKey }) => ({ id, thumbnailKey, displayKey }))
      });
    }
  }
  manifests.sort((left, right) => naturalCompare(left.manifestPath, right.manifestPath));
  return { schemaVersion: AGGREGATE_SCHEMA_VERSION, manifests, sha256: sha256(stableJson(manifests)) };
}

function candidateMediaKeysByYear(candidate) {
  const result = new Map();
  for (const [year, model] of candidate.model.years) {
    const keys = new Set();
    for (const { manifest } of model.albums.values()) {
      for (const photo of manifest.photos) {
        keys.add(photo.thumbnailKey);
        keys.add(photo.displayKey);
      }
    }
    result.set(year, keys);
  }
  return result;
}

function buildCandidateMedia({ candidate, stages, canonicalMedia }) {
  const expectedByYear = candidateMediaKeysByYear(candidate);
  const stagedMedia = new Map();
  const mediaSources = new Map();
  for (const stage of stages) {
    const expected = expectedByYear.get(stage.year) || new Set();
    assertExactSet(stage.mediaByKey.keys(), expected, `${stage.year}: staged media versus candidate references`);
    for (const [key, media] of stage.mediaByKey) {
      if (stagedMedia.has(key)) throw new Error(`Duplicate media key across candidate years: ${key}`);
      stagedMedia.set(key, { key, bytes: media.bytes, sha256: media.outputSha256, year: stage.year });
      mediaSources.set(key, path.join(stage.stagingRoot, "generated", "library", key));
    }
  }
  const expectedMedia = [];
  const newVersionedKeys = [];
  const existingVersionedKeys = [];
  for (const record of Array.from(stagedMedia.values()).sort((left, right) => naturalCompare(left.key, right.key))) {
    const canonical = canonicalMedia.get(record.key);
    if (canonical && (canonical.bytes !== record.bytes || canonical.sha256 !== record.sha256)) throw new Error(`Candidate media key conflicts with canonical bytes: ${record.key}`);
    const bound = { ...record, source: canonical ? "canonical-identical" : "staged-new" };
    expectedMedia.push(bound);
    if (canonical) existingVersionedKeys.push(bound);
    else newVersionedKeys.push(bound);
  }
  const inventory = {
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    expectedMedia,
    expectedMediaSha256: sha256(stableJson(expectedMedia)),
    newVersionedKeys,
    existingVersionedKeys,
    proposedDeletes: []
  };
  return { inventory, sha256: sha256(stableJson(inventory)), mediaSources };
}

function mediaRecordMap(records) {
  const result = new Map();
  for (const record of records) {
    if (result.has(record.key)) throw new Error(`Duplicate media inventory key: ${record.key}`);
    result.set(record.key, record);
  }
  return result;
}

function validateTransitions({ transitionRecord, contract, previousPhotos, candidatePhotos, rollbackMedia, candidateMedia }) {
  if (transitionRecord?.schemaVersion !== AGGREGATE_SCHEMA_VERSION) throw new Error("ID-transition schema version is invalid");
  if (transitionRecord.previousReleaseId !== contract.previousRelease.releaseId) throw new Error("ID transitions name the wrong previous release");
  if (!Array.isArray(transitionRecord.transitions)) throw new Error("ID transitions must be an array");
  const byOldId = new Map();
  for (const transition of transitionRecord.transitions) {
    if (!transition || typeof transition.oldPhotoId !== "string") throw new Error("ID transition lacks oldPhotoId");
    if (byOldId.has(transition.oldPhotoId)) throw new Error(`Conflicting or duplicate ID transitions for ${transition.oldPhotoId}`);
    byOldId.set(transition.oldPhotoId, transition);
  }
  assertExactSet(byOldId.keys(), previousPhotos.keys(), "Published-ID transition coverage");
  if (byOldId.size !== contract.expectedPublishedPhotoCount) throw new Error("ID-transition count is incomplete");
  const oldMedia = mediaRecordMap(rollbackMedia);
  const newMedia = mediaRecordMap(candidateMedia.expectedMedia);
  let aliases = 0;
  let retired = 0;
  for (const [oldPhotoId, transition] of byOldId) {
    if (transition.status !== "approved") throw new Error(`${oldPhotoId}: ID transition is not explicitly approved`);
    if (transition.outcome === "retired-no-successor") {
      if (typeof transition.decisionId !== "string" || !transition.decisionId.trim() || typeof transition.reason !== "string" || !transition.reason.trim()) {
        throw new Error(`${oldPhotoId}: retired transition lacks an explicit decision and reason`);
      }
      if (transition.newPhotoId !== undefined) throw new Error(`${oldPhotoId}: retired transition cannot name a successor`);
      retired += 1;
      continue;
    }
    if (transition.outcome !== "alias") throw new Error(`${oldPhotoId}: unsupported ID-transition outcome`);
    const candidate = candidatePhotos.get(transition.newPhotoId);
    if (!candidate) throw new Error(`${oldPhotoId}: alias successor is absent from the candidate`);
    const previous = previousPhotos.get(oldPhotoId);
    const evidence = transition.evidence;
    if (evidence?.kind === "display-media-sha256-equality") {
      if (evidence.oldMediaKey !== previous.displayKey || evidence.newMediaKey !== candidate.displayKey) throw new Error(`${oldPhotoId}: alias evidence names the wrong media keys`);
      const oldRecord = oldMedia.get(evidence.oldMediaKey);
      const newRecord = newMedia.get(evidence.newMediaKey);
      if (!oldRecord || !newRecord || evidence.oldSha256 !== oldRecord.sha256 || evidence.newSha256 !== newRecord.sha256 || oldRecord.sha256 !== newRecord.sha256) {
        throw new Error(`${oldPhotoId}: alias evidence does not prove equal media content`);
      }
    } else throw new Error(`${oldPhotoId}: alias lacks supported verification evidence`);
    aliases += 1;
  }
  return { schemaVersion: AGGREGATE_SCHEMA_VERSION, previousPhotoCount: byOldId.size, aliases, retired, unresolved: 0, sha256: sha256(stableJson(transitionRecord)) };
}

function rollbackInventory(inputs, contract) {
  const referencedKeys = new Set();
  for (const photo of inputs.previousPhotos.values()) {
    referencedKeys.add(photo.thumbnailKey);
    referencedKeys.add(photo.displayKey);
  }
  const mediaMap = mediaRecordMap(inputs.rollbackMedia);
  for (const key of referencedKeys) if (!mediaMap.has(key)) throw new Error(`Rollback release references missing media: ${key}`);
  return {
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    releaseId: contract.previousRelease.releaseId,
    publicData: inputs.canonical.inventory,
    media: inputs.rollbackMedia,
    mediaInventorySha256: sha256(stableJson(inputs.rollbackMedia)),
    referencedMediaKeys: Array.from(referencedKeys).sort(naturalCompare),
    proposedDeletes: []
  };
}

async function physicalPathWithoutCreating(targetPath) {
  const tail = [];
  let current = path.resolve(targetPath);
  while (true) {
    try {
      return path.resolve(await fs.realpath(current), ...tail);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function writeAggregatePackage({ packageRoot, contract, transitionRecord, inputs, candidate, candidateMedia, manifestMap, rollback, binding }) {
  const parent = path.dirname(packageRoot);
  await fs.mkdir(parent, { recursive: true });
  const temporaryRoot = path.join(parent, `.${path.basename(packageRoot)}.pixilation-aggregate-${crypto.randomBytes(8).toString("hex")}`);
  await fs.mkdir(temporaryRoot, { recursive: false });
  try {
    async function writeFiles(prefix, files) {
      for (const [relative, bytes] of files) {
        const target = path.join(temporaryRoot, prefix, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes, { flag: "wx" });
      }
    }
    await writeFiles(path.join("candidate", "public", "data"), candidate.files);
    await writeFiles(path.join("rollback", "public", "data"), inputs.canonical.files);
    for (const media of candidateMedia.inventory.newVersionedKeys) {
      const source = candidateMedia.mediaSources.get(media.key);
      const target = path.join(temporaryRoot, "media", "new", media.key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    }
    const metadata = new Map([
      ["contracts/intended-years.json", jsonBytes(contract)],
      ["inventories/candidate-public-data.json", jsonBytes({ schemaVersion: AGGREGATE_SCHEMA_VERSION, ...candidate.inventory })],
      ["inventories/candidate-media.json", jsonBytes(candidateMedia.inventory)],
      ["inventories/rollback.json", jsonBytes(rollback)],
      ["inventories/stages.json", jsonBytes({ schemaVersion: AGGREGATE_SCHEMA_VERSION, stages: inputs.facts.stages })],
      ["maps/manifest-media.json", jsonBytes(manifestMap)],
      ["maps/id-transitions.json", jsonBytes(transitionRecord)],
      ["plans/deletes.json", jsonBytes({ schemaVersion: AGGREGATE_SCHEMA_VERSION, deletes: [] })]
    ]);
    for (const [relative, bytes] of metadata) {
      const target = path.join(temporaryRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: "wx" });
    }
    const packageId = sha256(stableJson(binding));
    const receipt = { schemaVersion: AGGREGATE_SCHEMA_VERSION, status: "publishable-aggregate-local-package", publicationEligible: true, packageId, binding };
    await fs.writeFile(path.join(temporaryRoot, "package.json"), jsonBytes(receipt), { flag: "wx" });
    const preSeal = await treeInventory(temporaryRoot);
    const completion = { schemaVersion: AGGREGATE_SCHEMA_VERSION, status: "complete", packageId, fileCountBeforeSeal: preSeal.files.length, closedWorldSha256: preSeal.sha256 };
    await fs.writeFile(path.join(temporaryRoot, "complete.json"), jsonBytes(completion), { flag: "wx" });
    await verifyAggregatePackage(temporaryRoot);
    await fs.rename(temporaryRoot, packageRoot);
    return { packageId, receipt, completion };
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function filesFromInventoryRoot(root, inventory) {
  return new Map(inventory.files.map((record) => [record.path, null]));
}

async function readBufferMap(root, inventory) {
  const files = filesFromInventoryRoot(root, inventory);
  for (const relative of files.keys()) files.set(relative, await fs.readFile(path.join(root, relative)));
  return files;
}

export async function verifyAggregatePackage(packageRoot) {
  const root = path.resolve(packageRoot);
  const [receipt, completion] = await Promise.all([
    readJson(path.join(root, "package.json"), "Aggregate package receipt"),
    readJson(path.join(root, "complete.json"), "Aggregate package completion seal")
  ]);
  if (receipt.status !== "publishable-aggregate-local-package" || !receipt.publicationEligible || completion.status !== "complete") throw new Error("Aggregate package is not complete and publishable");
  if (receipt.packageId !== completion.packageId || receipt.packageId !== sha256(stableJson(receipt.binding))) throw new Error("Aggregate package identity does not match its binding");
  const preSeal = await treeInventory(root, new Set(["complete.json"]));
  if (preSeal.files.length !== completion.fileCountBeforeSeal || preSeal.sha256 !== completion.closedWorldSha256) throw new Error("Aggregate package closed-world seal does not match");
  const contract = await readJson(path.join(root, "contracts", "intended-years.json"), "Intended-year contract");
  if (sha256(stableJson(contract)) !== receipt.binding.contractSha256) throw new Error("Intended-year contract changed after packaging");
  if (contract.status !== "approved" || contract.intendedYears.join("\0") !== receipt.binding.intendedYears.join("\0") || contract.physicalSourceRoot !== receipt.binding.physicalSourceRoot || stableJson(contract.importerIdentity) !== stableJson(receipt.binding.importerIdentity)) {
    throw new Error("Aggregate contract does not match the package binding");
  }
  const stageInventory = await readJson(path.join(root, "inventories", "stages.json"), "Stage inventory");
  if (stableJson(stageInventory.stages) !== stableJson(receipt.binding.stages) || stableJson(contract.stages) !== stableJson(receipt.binding.stages)) throw new Error("Exact stage bindings changed after packaging");
  const candidatePublic = await readJson(path.join(root, "inventories", "candidate-public-data.json"), "Candidate public-data inventory");
  const candidateRoot = path.join(root, "candidate", "public", "data");
  const actualCandidate = await treeInventory(candidateRoot);
  if (actualCandidate.sha256 !== candidatePublic.sha256 || actualCandidate.sha256 !== receipt.binding.candidatePublicDataSha256) throw new Error("Candidate public-data inventory changed");
  const candidateFiles = await readBufferMap(candidateRoot, candidatePublic);
  const candidateModel = validateAggregateCandidateFiles(candidateFiles, contract.intendedYears);
  if (candidateModel.photoCount !== receipt.binding.candidatePhotoCount || candidateModel.albumCount !== receipt.binding.candidateAlbumCount) throw new Error("Candidate catalogue totals changed");
  const manifestMap = await readJson(path.join(root, "maps", "manifest-media.json"), "Manifest/media map");
  const expectedManifestMap = buildManifestMap({ files: candidateFiles, inventory: actualCandidate, model: candidateModel });
  if (stableJson(manifestMap) !== stableJson(expectedManifestMap) || manifestMap.sha256 !== receipt.binding.manifestReferenceMapSha256) throw new Error("Manifest/media map changed or is incomplete");
  const candidateMedia = await readJson(path.join(root, "inventories", "candidate-media.json"), "Candidate media inventory");
  if (sha256(stableJson(candidateMedia)) !== receipt.binding.candidateMediaInventorySha256 || candidateMedia.proposedDeletes?.length !== 0) throw new Error("Candidate media inventory or zero-delete plan changed");
  const referencedMedia = new Set(Array.from(candidateMediaKeysByYear({ model: candidateModel }).values()).flatMap((keys) => Array.from(keys)));
  assertExactSet((candidateMedia.expectedMedia || []).map((entry) => entry.key), referencedMedia, "Candidate media inventory versus manifest references");
  const newRoot = path.join(root, "media", "new");
  const actualNew = await treeInventory(newRoot);
  const expectedNew = candidateMedia.newVersionedKeys.map(({ key, bytes, sha256: digest }) => ({ path: key, bytes, sha256: digest })).sort((left, right) => naturalCompare(left.path, right.path));
  if (stableJson(actualNew.files) !== stableJson(expectedNew)) throw new Error("Packaged new-media set is incomplete or has extras");
  const rollback = await readJson(path.join(root, "inventories", "rollback.json"), "Rollback inventory");
  if (sha256(stableJson(rollback)) !== receipt.binding.rollbackInventorySha256 || rollback.proposedDeletes?.length !== 0) throw new Error("Rollback inventory or zero-delete plan changed");
  if (rollback.releaseId !== contract.previousRelease.releaseId || rollback.mediaInventorySha256 !== contract.previousRelease.mediaInventorySha256 || rollback.mediaInventorySha256 !== receipt.binding.previousMediaInventorySha256 || sha256(stableJson(rollback.media)) !== rollback.mediaInventorySha256) {
    throw new Error("Rollback release or media inventory is incomplete");
  }
  const rollbackRoot = path.join(root, "rollback", "public", "data");
  const actualRollback = await treeInventory(rollbackRoot);
  if (actualRollback.sha256 !== rollback.publicData.sha256 || actualRollback.sha256 !== receipt.binding.previousPublicDataSha256 || actualRollback.sha256 !== contract.previousRelease.publicDataSha256) throw new Error("Rollback public data is incomplete");
  const rollbackFiles = await readBufferMap(rollbackRoot, rollback.publicData);
  const rollbackCanonical = { files: rollbackFiles, years: new Map() };
  const rollbackCatalog = JSON.parse(rollbackFiles.get("catalog.json").toString("utf8"));
  for (const entry of rollbackCatalog.years || []) {
    const year = String(entry.year);
    const index = JSON.parse(rollbackFiles.get(`${year}/index.json`).toString("utf8"));
    const manifestMap = new Map();
    for (const album of index.albums || []) {
      const manifestPath = publicPathFromUrl(album.manifestUrl);
      manifestMap.set(manifestPath, JSON.parse(rollbackFiles.get(manifestPath).toString("utf8")));
    }
    rollbackCanonical.years.set(year, { manifestMap });
  }
  const transitions = await readJson(path.join(root, "maps", "id-transitions.json"), "ID transitions");
  const transitionSummary = validateTransitions({
    transitionRecord: transitions,
    contract,
    previousPhotos: canonicalPhotoMap(rollbackCanonical),
    candidatePhotos: candidateModel.photos,
    rollbackMedia: rollback.media,
    candidateMedia
  });
  if (transitionSummary.sha256 !== receipt.binding.idTransitionsSha256) throw new Error("ID transitions changed after packaging");
  const deletePlan = await readJson(path.join(root, "plans", "deletes.json"), "Delete plan");
  if (deletePlan.deletes?.length !== 0 || sha256(stableJson(deletePlan)) !== receipt.binding.deletePlanSha256) throw new Error("Aggregate package proposes deletes");
  return { receipt, completion, contract, candidatePublic, candidateMedia, rollback, transitionSummary };
}

export async function buildAggregatePackage(options) {
  const packageRoot = path.resolve(options.packageRoot);
  if (await exists(packageRoot)) throw new Error(`Package root must not already exist: ${packageRoot}`);
  const [contract, transitionRecord] = await Promise.all([
    readJson(path.resolve(options.contractPath), "Intended-year contract"),
    readJson(path.resolve(options.transitionsPath), "Published-ID transitions")
  ]);
  const inputs = await inspectAggregateInputs(options);
  const contractResult = validateContract(contract, inputs.facts);
  const physicalPackage = await physicalPathWithoutCreating(packageRoot);
  for (const target of [inputs.canonicalDataRoot, inputs.canonicalMediaRoot, inputs.facts.physicalSourceRoot, ...inputs.stages.map((stage) => stage.stagingRoot)]) {
    const physicalTarget = await physicalPathWithoutCreating(target);
    if (isInsideOrEqual(physicalPackage, physicalTarget) || isInsideOrEqual(physicalTarget, physicalPackage)) throw new Error(`Package root overlaps protected input: ${target}`);
  }
  const candidate = buildCandidate(inputs.stages, contractResult.intendedYears);
  const candidateMedia = buildCandidateMedia({ candidate, stages: inputs.stages, canonicalMedia: inputs.canonicalMedia });
  const manifestMap = buildManifestMap(candidate);
  const rollback = rollbackInventory(inputs, contract);
  const transitionSummary = validateTransitions({
    transitionRecord,
    contract,
    previousPhotos: inputs.previousPhotos,
    candidatePhotos: candidate.model.photos,
    rollbackMedia: inputs.rollbackMedia,
    candidateMedia: candidateMedia.inventory
  });
  const deletePlan = { schemaVersion: AGGREGATE_SCHEMA_VERSION, deletes: [] };
  const binding = {
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    contractSha256: contractResult.contractSha256,
    intendedYears: contractResult.intendedYears,
    physicalSourceRoot: inputs.facts.physicalSourceRoot,
    importerIdentity: inputs.facts.importerIdentity,
    stages: inputs.facts.stages,
    candidatePublicDataSha256: candidate.inventory.sha256,
    candidatePhotoCount: candidate.model.photoCount,
    candidateAlbumCount: candidate.model.albumCount,
    candidateMediaInventorySha256: candidateMedia.sha256,
    manifestReferenceMapSha256: manifestMap.sha256,
    idTransitionsSha256: transitionSummary.sha256,
    previousReleaseId: contract.previousRelease.releaseId,
    previousPublicDataSha256: inputs.canonical.inventory.sha256,
    previousMediaInventorySha256: rollback.mediaInventorySha256,
    rollbackInventorySha256: sha256(stableJson(rollback)),
    deletePlanSha256: sha256(stableJson(deletePlan)),
    proposedDeleteCount: 0
  };
  const written = await writeAggregatePackage({ packageRoot, contract, transitionRecord, inputs, candidate, candidateMedia, manifestMap, rollback, binding });
  const verification = await verifyAggregatePackage(packageRoot);
  return { packageRoot, ...written, binding, candidate, candidateMedia: candidateMedia.inventory, rollback, transitionSummary, verification };
}

function parseArgs(argv) {
  const args = { stagingRoots: [], packageRoot: null, contractPath: null, transitionsPath: null, canonicalDataRoot: null, canonicalMediaRoot: null, concurrency: 8 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    index += 1;
    if (token === "--stage-root") args.stagingRoots.push(value);
    else if (token === "--package-root") args.packageRoot = value;
    else if (token === "--contract") args.contractPath = value;
    else if (token === "--id-transitions") args.transitionsPath = value;
    else if (token === "--canonical-data-root") args.canonicalDataRoot = value;
    else if (token === "--canonical-media-root") args.canonicalMediaRoot = value;
    else if (token === "--concurrency") args.concurrency = Number(value);
    else throw new Error(`Unknown option ${token}`);
  }
  if (!args.stagingRoots.length || !args.packageRoot || !args.contractPath || !args.transitionsPath) throw new Error("Provide --stage-root for every intended year, --package-root, --contract, and --id-transitions");
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error("--concurrency must be a positive integer");
  return args;
}

async function main() {
  const result = await buildAggregatePackage(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    status: result.receipt.status,
    packageRoot: result.packageRoot,
    packageId: result.packageId,
    intendedYears: result.binding.intendedYears,
    photos: result.binding.candidatePhotoCount,
    albums: result.binding.candidateAlbumCount,
    expectedMedia: result.candidateMedia.expectedMedia.length,
    publishedIdTransitions: result.transitionSummary.previousPhotoCount,
    aliases: result.transitionSummary.aliases,
    retired: result.transitionSummary.retired,
    proposedDeletes: result.binding.proposedDeleteCount
  }, null, 2)}\n`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
