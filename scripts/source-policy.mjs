import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import exifr from "exifr";
import sharp from "sharp";

export const SOURCE_POLICY_SCHEMA_VERSION = 2;

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_ROOT, "..");
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff", ".heic", ".heif"]);
const NOISE_FILENAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const DECISION_ACTIONS = {
  "folder-year": new Set(["map-to-year"]),
  "album-label": new Set(["publish-label"]),
  "unsupported-file": new Set(["exclude-exact", "repair-exact"]),
  "unreadable-file": new Set(["exclude-exact", "repair-exact"]),
  "duplicate-content": new Set(["keep-separate", "exclude-exact-copies"]),
  "off-year-date": new Set(["use-folder-year", "map-photo-to-year", "exclude-exact"]),
  "source-move": new Set(["preserve-source-path"])
};
const GROUPABLE_DECISION_CATEGORIES = new Set(["unsupported-file", "unreadable-file", "off-year-date", "source-move"]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

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

function leadingYear(value) {
  const match = String(value || "").match(/^(19|20)\d{2}/);
  return match ? match[0] : null;
}

function yearsInName(value) {
  return Array.from(new Set(String(value || "").match(/(?:19|20)\d{2}/g) || []));
}

function stablePhotoId(year, relativePath) {
  return `${year}-${crypto.createHash("sha1").update(toPosix(relativePath)).digest("hex").slice(0, 14)}`;
}

function isNoise(filename) {
  return NOISE_FILENAMES.has(filename) || filename.startsWith("._");
}

async function fileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function walkPhysicalFiles(sourceRoot, scanRoots) {
  const files = [];
  const symlinks = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.lstat(absolutePath);
      const relativePath = toPosix(path.relative(sourceRoot, absolutePath));
      if (stat.isSymbolicLink()) {
        let target = null;
        try {
          target = await fs.realpath(absolutePath);
        } catch {
          target = null;
        }
        symlinks.push({ path: relativePath, target });
      } else if (stat.isDirectory()) {
        await walk(absolutePath);
      } else if (stat.isFile()) {
        files.push({ absolutePath, relativePath, stat });
      }
    }
  }
  for (const scanRoot of scanRoots) await walk(scanRoot);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, undefined, { numeric: true }));
  return { files, symlinks };
}

function exifDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3"));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function inspectExif(filePath) {
  try {
    const metadata = await exifr.parse(filePath, {
      pick: ["DateTimeOriginal", "CreateDate", "ModifyDate", "DateTime"],
      translateValues: false,
      reviveValues: true
    });
    for (const field of ["DateTimeOriginal", "CreateDate", "ModifyDate", "DateTime"]) {
      const date = exifDate(metadata?.[field]);
      if (date) return { field, value: date.toISOString(), year: date.getFullYear() };
    }
  } catch {
    // Decode and EXIF failures are recorded separately; missing EXIF is not itself an error.
  }
  return null;
}

async function inspectPhysicalFile(file) {
  const extension = path.extname(file.absolutePath).toLowerCase();
  const filename = path.basename(file.absolutePath);
  const parts = file.relativePath.split("/");
  const topLevelFolder = parts.length > 1 ? parts[0] : ".";
  const folderYear = leadingYear(topLevelFolder);
  const supportedImage = SUPPORTED_IMAGE_EXTENSIONS.has(extension);
  const thm = extension === ".thm";
  let decodable = false;
  let dimensions = null;
  let decodeError = null;
  let captureDate = null;
  if (supportedImage || thm) {
    try {
      const metadata = await sharp(file.absolutePath, { failOn: "error", limitInputPixels: false }).metadata();
      if (!metadata.width || !metadata.height) throw new Error("Missing image dimensions");
      if (thm) {
        await sharp(file.absolutePath, { failOn: "error", limitInputPixels: false }).resize({ width: 1 }).raw().toBuffer();
      }
      decodable = true;
      dimensions = { width: metadata.width, height: metadata.height, orientation: metadata.orientation || 1 };
      captureDate = await inspectExif(file.absolutePath);
    } catch (error) {
      decodeError = error instanceof Error ? error.message : String(error);
    }
  }
  const classification = isNoise(filename)
    ? "noise"
    : supportedImage
      ? decodable
        ? "importable-image"
        : "unreadable-image"
      : thm && decodable
        ? "decodable-unsupported-image"
        : "unsupported-file";
  return {
    path: file.relativePath,
    absolutePath: file.absolutePath,
    bytes: file.stat.size,
    sha256: await fileSha256(file.absolutePath),
    extension,
    topLevelFolder,
    folderYear,
    classification,
    decodable,
    dimensions,
    captureDate,
    decodeError
  };
}

async function readPublishedPhotoIds(publicDataRoot) {
  const ids = new Set();
  if (!publicDataRoot) return ids;
  let catalogText;
  try {
    catalogText = await fs.readFile(path.join(publicDataRoot, "data", "catalog.json"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return ids;
    throw error;
  }
  const catalog = JSON.parse(catalogText);
  for (const year of catalog.years || []) {
    const index = JSON.parse(await fs.readFile(path.join(publicDataRoot, year.indexUrl), "utf8"));
    for (const album of index.albums || []) {
      const manifest = JSON.parse(await fs.readFile(path.join(publicDataRoot, album.manifestUrl), "utf8"));
      for (const photo of manifest.photos || []) if (photo?.id) ids.add(photo.id);
    }
  }
  return ids;
}

function fileSignature(file) {
  return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
}

function scopeSha256(files) {
  return sha256(stableJson(files.map(fileSignature).sort((left, right) => left.path.localeCompare(right.path))));
}

function decisionId(category, key) {
  return `${category}:${sha256(`${category}\0${key}`).slice(0, 16)}`;
}

function unresolvedDecision(category, key, subject, files) {
  const exactFiles = files.map(fileSignature).sort((left, right) => left.path.localeCompare(right.path));
  return {
    id: decisionId(category, key),
    category,
    key,
    status: "unresolved",
    action: null,
    subject,
    files: exactFiles,
    scopeSha256: sha256(stableJson(exactFiles)),
    allowedActions: Array.from(DECISION_ACTIONS[category] || []).sort(),
    note: null
  };
}

function decisionGroupKey(decision) {
  if (!GROUPABLE_DECISION_CATEGORIES.has(decision.category)) return null;
  if (decision.category === "unsupported-file") return `${decision.category}:${decision.subject.classification}`;
  return `${decision.category}:all`;
}

function decisionGroupScope(decisionIds, files) {
  return sha256(stableJson({ decisionIds, files }));
}

function createDecisionGroups(decisions) {
  const buckets = groupBy(
    decisions.filter((decision) => decisionGroupKey(decision)),
    decisionGroupKey
  );
  const groups = [];
  for (const [key, members] of buckets) {
    const category = members[0].category;
    const decisionIds = members.map((decision) => decision.id).sort();
    const files = members
      .flatMap((decision) => decision.files)
      .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
    groups.push({
      id: `decision-group:${sha256(key).slice(0, 16)}`,
      category,
      key,
      status: "unresolved",
      action: null,
      decisionIds,
      files,
      scopeSha256: decisionGroupScope(decisionIds, files),
      allowedActions: Array.from(DECISION_ACTIONS[category] || []).sort(),
      exceptions: [],
      note: "This group is an exact enumerated set, not a folder or pattern. Exceptions must repeat one member's exact path, bytes, and SHA-256."
    });
  }
  return groups.sort((left, right) => left.key.localeCompare(right.key));
}

function groupBy(items, selector) {
  const result = new Map();
  for (const item of items) {
    const key = selector(item);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(item);
  }
  return result;
}

function buildDecisions(files, publishedPhotoIds, selectedYear = null) {
  const decisions = [];
  const byFolder = groupBy(files, (file) => file.topLevelFolder);
  for (const [folder, folderFiles] of byFolder) {
    const tokens = yearsInName(folder);
    decisions.push(
      unresolvedDecision(
        "folder-year",
        folder,
        {
          folder,
          proposedYear: leadingYear(folder),
          importerYear: selectedYear || leadingYear(folder),
          yearTokens: tokens,
          ambiguous: tokens.length !== 1
        },
        folderFiles
      )
    );
  }

  const importable = files.filter((file) => file.classification === "importable-image");
  const byAlbum = groupBy(importable, (file) => toPosix(path.dirname(file.path)));
  for (const [album, albumFiles] of byAlbum) {
    decisions.push(
      unresolvedDecision(
        "album-label",
        album,
        { sourceAlbum: album, proposedPublicLabel: album },
        albumFiles
      )
    );
  }

  for (const file of files.filter((entry) => entry.classification === "unsupported-file" || entry.classification === "noise" || entry.classification === "decodable-unsupported-image")) {
    decisions.push(
      unresolvedDecision(
        "unsupported-file",
        file.path,
        {
          path: file.path,
          classification: file.classification,
          decodable: file.decodable,
          extension: file.extension
        },
        [file]
      )
    );
  }

  for (const file of files.filter((entry) => entry.classification === "unreadable-image")) {
    decisions.push(
      unresolvedDecision(
        "unreadable-file",
        file.path,
        { path: file.path, extension: file.extension, decodeError: file.decodeError },
        [file]
      )
    );
  }

  const duplicateGroups = Array.from(groupBy(importable, (file) => file.sha256).entries()).filter(([, group]) => group.length > 1);
  for (const [contentSha256, group] of duplicateGroups) {
    decisions.push(
      unresolvedDecision(
        "duplicate-content",
        contentSha256,
        { contentSha256, paths: group.map((file) => file.path).sort() },
        group
      )
    );
  }

  for (const file of importable.filter((entry) => entry.captureDate && entry.folderYear && String(entry.captureDate.year) !== entry.folderYear)) {
    decisions.push(
      unresolvedDecision(
        "off-year-date",
        file.path,
        { path: file.path, folderYear: file.folderYear, exif: file.captureDate },
        [file]
      )
    );
  }

  const matchedPublishedIds = new Set();
  const matchedPublishedYears = new Set();
  for (const file of importable) {
    const idYear = selectedYear || file.folderYear;
    if (!idYear) continue;
    const id = stablePhotoId(idYear, file.path);
    if (!publishedPhotoIds.has(id)) continue;
    matchedPublishedIds.add(id);
    matchedPublishedYears.add(idYear);
    decisions.push(
      unresolvedDecision(
        "source-move",
        id,
        { photoId: id, currentPath: file.path, year: idYear, movingOrRenamingChangesPhotoId: true },
        [file]
      )
    );
  }

  decisions.sort((left, right) => left.category.localeCompare(right.category) || left.key.localeCompare(right.key, undefined, { numeric: true }));
  return {
    decisions,
    // A source selection can intentionally cover only one year. Do not compare it
    // with unrelated published years; once a published year is represented by at
    // least one exact path-derived ID, require that year's published set in full.
    missingPublishedPhotoIds: Array.from(publishedPhotoIds)
      .filter((id) => (selectedYear ? id.startsWith(`${selectedYear}-`) : matchedPublishedYears.has(id.slice(0, 4))) && !matchedPublishedIds.has(id))
      .sort()
  };
}

function summarizeSpecialFindings(files, decisions, symlinks, missingPublishedPhotoIds) {
  const decisionsByCategory = groupBy(decisions, (decision) => decision.category);
  const new2002Files = files.filter((file) => file.path === "2002 New" || file.path.startsWith("2002 New/"));
  const new2002Albums = Array.from(
    new Set(new2002Files.filter((file) => file.classification === "importable-image").map((file) => toPosix(path.dirname(file.path))))
  ).sort();
  const ambiguousYearFolders = (decisionsByCategory.get("folder-year") || [])
    .filter((decision) => decision.subject.ambiguous)
    .map((decision) => ({ folder: decision.key, files: decision.files.length, paths: decision.files.map((file) => file.path), yearTokens: decision.subject.yearTokens }));
  const offYearDates = (decisionsByCategory.get("off-year-date") || []).map((decision) => ({
    path: decision.subject.path,
    folderYear: decision.subject.folderYear,
    exifYear: decision.subject.exif.year,
    exifValue: decision.subject.exif.value,
    bytes: decision.files[0].bytes,
    sha256: decision.files[0].sha256
  }));
  const duplicateContentGroups = (decisionsByCategory.get("duplicate-content") || []).map((decision) => ({
    sha256: decision.subject.contentSha256,
    count: decision.files.length,
    paths: decision.subject.paths
  }));
  const decodableThmFiles = files
    .filter((file) => file.extension === ".thm" && file.decodable)
    .map(fileSignature);
  const corrupt2010Jpegs = files
    .filter((file) => /^2010(?:[-/]|$)/.test(file.path) && [".jpg", ".jpeg"].includes(file.extension) && file.classification === "unreadable-image")
    .map((file) => ({ ...fileSignature(file), decodeError: file.decodeError }));
  const unsupported2012Jpegs = files
    .filter((file) => /^2012(?:[-/]|$)/.test(file.path) && [".jpg", ".jpeg"].includes(file.extension) && file.classification === "unreadable-image")
    .map((file) => ({ ...fileSignature(file), decodeError: file.decodeError }));
  const sourceMoves = (decisionsByCategory.get("source-move") || []).map((decision) => ({
    photoId: decision.subject.photoId,
    currentPath: decision.subject.currentPath,
    bytes: decision.files[0]?.bytes ?? null,
    sha256: decision.files[0]?.sha256 ?? null
  }));
  return {
    new2002: {
      present: new2002Files.length > 0,
      path: new2002Files.length ? "2002 New" : null,
      physicalFiles: new2002Files.length,
      importablePhotos: new2002Files.filter((file) => file.classification === "importable-image").length,
      proposedAlbums: new2002Albums,
      proposedAlbumDetails: new2002Albums.map((album) => {
        const albumFiles = new2002Files.filter((file) => toPosix(path.dirname(file.path)) === album);
        return {
          path: album,
          physicalFiles: albumFiles.length,
          importablePhotos: albumFiles.filter((file) => file.classification === "importable-image").length,
          files: albumFiles.map(fileSignature)
        };
      }),
      files: new2002Files.map(fileSignature)
    },
    offYearDates,
    ambiguousYearFolders,
    duplicateContentGroups,
    decodableThmFiles,
    corrupt2010Jpegs,
    unsupported2012Jpegs,
    sourceMoves,
    missingPublishedPhotoIds,
    symlinks
  };
}

function inventoryLedger(sourceRoot, scanRoots, selectedYear, files, symlinks) {
  const signatures = files.map(fileSignature).sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
  const identity = { sourceRoot, scanRoots, selectedYear, files: signatures, symlinks };
  return {
    ...identity,
    fileCount: signatures.length,
    totalBytes: signatures.reduce((sum, file) => sum + file.bytes, 0),
    inventorySha256: sha256(stableJson(identity))
  };
}

export async function inspectSourcePolicy({ sourceRoot, scanRoots = null, selectedYear = null, concurrency = 6, publicDataRoot = null }) {
  const physicalSourceRoot = await fs.realpath(path.resolve(sourceRoot));
  const selectedRoots = (scanRoots?.length ? scanRoots : [physicalSourceRoot]).map((root) => path.resolve(root));
  const physicalScanRoots = [];
  for (const root of selectedRoots) {
    const physical = await fs.realpath(root);
    const relative = path.relative(physicalSourceRoot, physical);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Scan root escapes physical source root: ${root}`);
    physicalScanRoots.push(physical);
  }
  const walked = await walkPhysicalFiles(physicalSourceRoot, physicalScanRoots);
  const files = await mapConcurrent(walked.files, concurrency, inspectPhysicalFile);
  const publishedPhotoIds = await readPublishedPhotoIds(publicDataRoot ? path.resolve(publicDataRoot) : null);
  const { decisions, missingPublishedPhotoIds } = buildDecisions(files, publishedPhotoIds, selectedYear);
  const inventory = inventoryLedger(physicalSourceRoot, physicalScanRoots, selectedYear, files, walked.symlinks);
  const findings = summarizeSpecialFindings(files, decisions, walked.symlinks, missingPublishedPhotoIds);
  return {
    schemaVersion: SOURCE_POLICY_SCHEMA_VERSION,
    inventory,
    files,
    decisions,
    findings,
    decisionSetSha256: sha256(stableJson(decisions.map((decision) => ({ id: decision.id, scopeSha256: decision.scopeSha256, subject: decision.subject }))))
  };
}

export function createSourcePolicyTemplate(inspection) {
  return {
    schemaVersion: SOURCE_POLICY_SCHEMA_VERSION,
    policyId: sha256(`${inspection.inventory.sourceRoot}\0${inspection.inventory.inventorySha256}`).slice(0, 24),
    inventory: inspection.inventory,
    decisions: inspection.decisions,
    decisionGroups: createDecisionGroups(inspection.decisions),
    note: "Every decision is unresolved by default. A policy file records human decisions; it does not infer approval from names, decoding, staging, or old reports."
  };
}

function inventoryChanges(recordedInventory, freshInventory) {
  const recorded = new Map((recordedInventory?.files || []).map((file) => [file.path, file]));
  const fresh = new Map((freshInventory?.files || []).map((file) => [file.path, file]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [filePath, file] of fresh) {
    const prior = recorded.get(filePath);
    if (!prior) added.push(file);
    else if (prior.bytes !== file.bytes || prior.sha256 !== file.sha256) changed.push({ path: filePath, recorded: prior, fresh: file });
  }
  for (const [filePath, file] of recorded) if (!fresh.has(filePath)) removed.push(file);
  return { added, removed, changed };
}

function containsBroadPattern(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (/pattern|glob|regex/i.test(key)) return true;
    if (containsBroadPattern(child)) return true;
  }
  return false;
}

function validResolvedAction(decision) {
  if (decision.status !== "resolved") return false;
  if (!DECISION_ACTIONS[decision.category]?.has(decision.action)) return false;
  if (decision.category === "folder-year") return /^\d{4}$/.test(String(decision.year || ""));
  if (decision.category === "album-label") return typeof decision.publicLabel === "string" && decision.publicLabel.trim().length > 0;
  if (decision.category === "off-year-date" && decision.action === "map-photo-to-year") return /^\d{4}$/.test(String(decision.year || ""));
  if (decision.category === "duplicate-content" && decision.action === "exclude-exact-copies") {
    const available = new Set((decision.files || []).map((file) => file.path));
    return Array.isArray(decision.excludedPaths) && decision.excludedPaths.length > 0 && decision.excludedPaths.every((filePath) => available.has(filePath));
  }
  return true;
}

function matchesCurrentImporterBehavior(decision) {
  if (decision.category === "folder-year") return decision.year === decision.subject.importerYear;
  if (decision.category === "album-label") return decision.publicLabel === decision.subject.proposedPublicLabel;
  if (decision.category === "unsupported-file" || decision.category === "unreadable-file") return decision.action === "exclude-exact";
  if (decision.category === "duplicate-content") return decision.action === "keep-separate";
  if (decision.category === "off-year-date") return decision.action === "use-folder-year";
  if (decision.category === "source-move") return decision.action === "preserve-source-path";
  return false;
}

function exactDecisionIdentity(recorded, current) {
  return (
    recorded.id === current.id &&
    recorded.category === current.category &&
    recorded.key === current.key &&
    stableJson(recorded.subject) === stableJson(current.subject) &&
    recorded.scopeSha256 === current.scopeSha256 &&
    stableJson(recorded.files || []) === stableJson(current.files)
  );
}

function exactDecisionGroupIdentity(recorded, current) {
  return (
    recorded.id === current.id &&
    recorded.category === current.category &&
    recorded.key === current.key &&
    stableJson(recorded.decisionIds || []) === stableJson(current.decisionIds) &&
    stableJson(recorded.files || []) === stableJson(current.files) &&
    recorded.scopeSha256 === current.scopeSha256
  );
}

function decisionFromGroup(current, group) {
  const currentFiles = new Map(current.files.map((file) => [file.path, file]));
  const exceptions = group.exceptions || [];
  const matchingExceptions = exceptions.filter((exception) => currentFiles.has(exception.path));
  const chosen = matchingExceptions.length ? matchingExceptions[0] : group;
  return {
    ...current,
    status: chosen.status,
    action: chosen.action,
    year: chosen.year,
    publicLabel: chosen.publicLabel,
    excludedPaths: chosen.excludedPaths
  };
}

function validateRecordedGroup(recorded, current) {
  const errors = [];
  if (!exactDecisionGroupIdentity(recorded, current)) errors.push("group-scope-or-identity-changed");
  if (!Array.isArray(recorded.exceptions)) errors.push("group-exceptions-must-be-an-array");
  const available = new Map(current.files.map((file) => [file.path, file]));
  const seen = new Set();
  for (const exception of recorded.exceptions || []) {
    const expected = available.get(exception.path);
    if (!expected || expected.bytes !== exception.bytes || expected.sha256 !== exception.sha256) errors.push(`invalid-exact-exception:${exception.path || "missing-path"}`);
    if (seen.has(exception.path)) errors.push(`duplicate-exact-exception:${exception.path}`);
    seen.add(exception.path);
  }
  return errors;
}

export function evaluateSourcePolicy(inspection, policy = null) {
  const effectivePolicy = policy || createSourcePolicyTemplate(inspection);
  const schemaErrors = [];
  if (effectivePolicy.schemaVersion !== SOURCE_POLICY_SCHEMA_VERSION) schemaErrors.push("Unsupported source-policy schemaVersion");
  if (!effectivePolicy.inventory || !Array.isArray(effectivePolicy.inventory.files)) schemaErrors.push("Policy inventory must contain an exact files array");
  if (!Array.isArray(effectivePolicy.decisions)) schemaErrors.push("Policy decisions must be an array");
  if (!Array.isArray(effectivePolicy.decisionGroups)) schemaErrors.push("Policy decisionGroups must be an array");
  if (containsBroadPattern(effectivePolicy.decisions) || containsBroadPattern(effectivePolicy.decisionGroups)) schemaErrors.push("Broad pattern, glob, or regex decisions are forbidden");
  const changes = inventoryChanges(effectivePolicy.inventory, inspection.inventory);
  const inventoryMatches =
    schemaErrors.length === 0 &&
    effectivePolicy.inventory.sourceRoot === inspection.inventory.sourceRoot &&
    stableJson(effectivePolicy.inventory.scanRoots) === stableJson(inspection.inventory.scanRoots) &&
    effectivePolicy.inventory.selectedYear === inspection.inventory.selectedYear &&
    effectivePolicy.inventory.fileCount === inspection.inventory.fileCount &&
    effectivePolicy.inventory.totalBytes === inspection.inventory.totalBytes &&
    stableJson(effectivePolicy.inventory.symlinks) === stableJson(inspection.inventory.symlinks) &&
    effectivePolicy.inventory.inventorySha256 === inspection.inventory.inventorySha256 &&
    changes.added.length === 0 &&
    changes.removed.length === 0 &&
    changes.changed.length === 0;
  const policyDecisions = new Map((effectivePolicy.decisions || []).map((decision) => [decision.id, decision]));
  const currentDecisions = new Map(inspection.decisions.map((decision) => [decision.id, decision]));
  if (policyDecisions.size !== (effectivePolicy.decisions || []).length) schemaErrors.push("Policy contains duplicate decision IDs");
  for (const current of inspection.decisions) {
    const recorded = policyDecisions.get(current.id);
    if (!recorded) schemaErrors.push(`Policy is missing exact decision ${current.id}`);
    else if (!exactDecisionIdentity(recorded, current)) schemaErrors.push(`Policy decision identity changed ${current.id}`);
  }
  for (const recorded of effectivePolicy.decisions || []) {
    if (!currentDecisions.has(recorded.id)) schemaErrors.push(`Recorded decision no longer exists ${recorded.id}`);
  }
  const currentGroups = createDecisionGroups(inspection.decisions);
  const policyGroups = new Map((effectivePolicy.decisionGroups || []).map((group) => [group.id, group]));
  if (policyGroups.size !== (effectivePolicy.decisionGroups || []).length) schemaErrors.push("Policy contains duplicate decision-group IDs");
  const groupByDecisionId = new Map();
  const groupResults = [];
  for (const currentGroup of currentGroups) {
    const recordedGroup = policyGroups.get(currentGroup.id);
    const errors = recordedGroup ? validateRecordedGroup(recordedGroup, currentGroup) : ["group-not-recorded"];
    groupResults.push({
      id: currentGroup.id,
      category: currentGroup.category,
      key: currentGroup.key,
      status: errors.length ? "invalid" : recordedGroup.status,
      errors,
      affectedFileCount: currentGroup.files.length,
      affectedPaths: currentGroup.files.map((file) => file.path),
      exceptionPaths: (recordedGroup?.exceptions || []).map((exception) => exception.path)
    });
    if (recordedGroup && errors.length === 0) {
      for (const decisionId of currentGroup.decisionIds) groupByDecisionId.set(decisionId, recordedGroup);
    }
  }
  for (const recordedGroup of effectivePolicy.decisionGroups || []) {
    if (!currentGroups.some((group) => group.id === recordedGroup.id)) {
      groupResults.push({
        id: recordedGroup.id,
        category: recordedGroup.category,
        key: recordedGroup.key,
        status: "invalid",
        errors: ["recorded-group-no-longer-matches-current-sources"],
        affectedFileCount: (recordedGroup.files || []).length,
        affectedPaths: (recordedGroup.files || []).map((file) => file.path),
        exceptionPaths: (recordedGroup.exceptions || []).map((exception) => exception.path)
      });
    }
  }
  const invalidGroups = groupResults.filter((group) => group.errors.length);
  if (invalidGroups.length) schemaErrors.push(...invalidGroups.map((group) => `Invalid decision group ${group.id}: ${group.errors.join(",")}`));
  const decisionResults = [];
  for (const current of inspection.decisions) {
    const recorded = policyDecisions.get(current.id);
    const recordedGroup = groupByDecisionId.get(current.id);
    let status = "unresolved";
    let reason = "decision-not-recorded";
    let action = recorded?.action ?? null;
    if (recorded?.status === "resolved") {
      if (!exactDecisionIdentity(recorded, current)) reason = "decision-scope-or-identity-changed";
      else if (!validResolvedAction(recorded)) reason = "invalid-or-incomplete-action";
      else if (!matchesCurrentImporterBehavior(recorded)) reason = "action-not-implemented-by-current-importer";
      else {
        status = "resolved";
        reason = "exact-decision-recorded";
      }
    } else if (recordedGroup) {
      const groupedDecision = decisionFromGroup(current, recordedGroup);
      action = groupedDecision.action ?? null;
      const exception = (recordedGroup.exceptions || []).find((item) => current.files.some((file) => file.path === item.path));
      if (groupedDecision.status !== "resolved") reason = exception ? "exact-group-exception-unresolved" : "decision-group-unresolved";
      else if (!validResolvedAction(groupedDecision)) reason = "invalid-or-incomplete-group-action";
      else if (!matchesCurrentImporterBehavior(groupedDecision)) reason = "group-action-not-implemented-by-current-importer";
      else {
        status = "resolved";
        reason = exception ? "exact-group-exception-recorded" : "exact-group-decision-recorded";
      }
    } else if (recorded) {
      if (!exactDecisionIdentity(recorded, current)) reason = "decision-scope-or-identity-changed";
      else reason = "decision-unresolved";
    }
    decisionResults.push({
      id: current.id,
      category: current.category,
      key: current.key,
      status,
      reason,
      affectedFileCount: current.files.length,
      affectedPaths: current.files.map((file) => file.path),
      action
    });
  }
  for (const recorded of effectivePolicy.decisions || []) {
    if (!currentDecisions.has(recorded.id)) {
      decisionResults.push({
        id: recorded.id,
        category: recorded.category,
        key: recorded.key,
        status: "unresolved",
        reason: "recorded-decision-no-longer-matches-current-sources",
        affectedFileCount: (recorded.files || []).length,
        affectedPaths: (recorded.files || []).map((file) => file.path),
        action: recorded.action ?? null
      });
    }
  }
  const unresolved = decisionResults.filter((decision) => decision.status !== "resolved");
  const publicationEligible = schemaErrors.length === 0 && inventoryMatches && unresolved.length === 0 && inspection.findings.missingPublishedPhotoIds.length === 0;
  return {
    schemaVersion: SOURCE_POLICY_SCHEMA_VERSION,
    publicationEligible,
    policyProvided: Boolean(policy),
    inventoryMatches,
    freshInventorySha256: inspection.inventory.inventorySha256,
    recordedInventorySha256: effectivePolicy.inventory?.inventorySha256 || null,
    schemaErrors,
    inventoryChanges: changes,
    counts: {
      files: inspection.inventory.fileCount,
      bytes: inspection.inventory.totalBytes,
      decisions: decisionResults.length,
      resolved: decisionResults.length - unresolved.length,
      unresolved: unresolved.length,
      added: changes.added.length,
      removed: changes.removed.length,
      changed: changes.changed.length
    },
    decisionResults,
    groupResults,
    unresolvedDecisionIds: unresolved.map((decision) => decision.id),
    policySha256: sha256(stableJson(effectivePolicy)),
    decisionSetSha256: inspection.decisionSetSha256
  };
}

function markdownPathList(items, selector, empty = "None") {
  if (!items.length) return `- ${empty}`;
  return items.map((item) => `- ${selector(item)}`).join("\n");
}

export function renderDecisionReport(inspection, eligibility) {
  const findings = inspection.findings;
  const lines = [
    "# Pixilation source-policy decision report",
    "",
    `- Physical source root: \`${inspection.inventory.sourceRoot}\``,
    `- Selected publication year: ${inspection.inventory.selectedYear || "not constrained"}`,
    `- Fresh inventory: ${inspection.inventory.fileCount.toLocaleString()} files, ${inspection.inventory.totalBytes.toLocaleString()} bytes`,
    `- Inventory SHA-256: \`${inspection.inventory.inventorySha256}\``,
    `- Publication eligible: **${eligibility.publicationEligible ? "YES" : "NO"}**`,
    `- Decisions: ${eligibility.counts.resolved} resolved; ${eligibility.counts.unresolved} unresolved`,
    "",
    "## 2002 New",
    "",
    `- Present: ${findings.new2002.present ? "yes" : "no"}`,
    `- Physical files: ${findings.new2002.physicalFiles}`,
    `- Importable photos: ${findings.new2002.importablePhotos}`,
    `- Proposed albums: ${findings.new2002.proposedAlbums.length}`,
    markdownPathList(findings.new2002.proposedAlbumDetails, (album) => `\`${album.path}\`: ${album.importablePhotos} importable of ${album.physicalFiles} physical files`),
    "- Exact files:",
    markdownPathList(findings.new2002.files, (item) => `\`${item.path}\` (${item.bytes} bytes, \`${item.sha256}\`)`),
    "- Publication approval: unresolved unless an exact policy decision says otherwise.",
    "",
    "## Off-year EXIF dates",
    "",
    `- Count: ${findings.offYearDates.length}`,
    markdownPathList(findings.offYearDates, (item) => `\`${item.path}\`: folder ${item.folderYear}, EXIF ${item.exifYear}, SHA-256 \`${item.sha256}\``),
    "",
    "## Ambiguous year folders",
    "",
    markdownPathList(findings.ambiguousYearFolders, (item) => `\`${item.folder}\`: ${item.files} files; year tokens ${item.yearTokens.join(", ") || "none"}; paths ${item.paths.map((p) => `\`${p}\``).join(", ")}`),
    "",
    "## Duplicate-content groups",
    "",
    `- Groups: ${findings.duplicateContentGroups.length}`,
    markdownPathList(findings.duplicateContentGroups, (item) => `${item.count} files, SHA-256 \`${item.sha256}\`: ${item.paths.map((p) => `\`${p}\``).join(", ")}`),
    "",
    "## Decodable unsupported .thm files",
    "",
    `- Count: ${findings.decodableThmFiles.length}`,
    markdownPathList(findings.decodableThmFiles, (item) => `\`${item.path}\` (${item.bytes} bytes, \`${item.sha256}\`)`),
    "",
    "## Corrupt 2010 JPEG files",
    "",
    `- Count: ${findings.corrupt2010Jpegs.length}`,
    markdownPathList(findings.corrupt2010Jpegs, (item) => `\`${item.path}\` (${item.bytes} bytes, \`${item.sha256}\`)`),
    "",
    "## Unsupported or unreadable 2012 JPEG files",
    "",
    `- Count: ${findings.unsupported2012Jpegs.length}`,
    markdownPathList(findings.unsupported2012Jpegs, (item) => `\`${item.path}\` (${item.bytes} bytes, \`${item.sha256}\`)`),
    "",
    "## Published source paths that must remain stable",
    "",
    `- Matched published IDs: ${findings.sourceMoves.length}`,
    markdownPathList(findings.sourceMoves, (item) => `\`${item.photoId}\` ← \`${item.currentPath}\` (${item.bytes} bytes, \`${item.sha256}\`)`),
    `- Published IDs missing from this selected source: ${findings.missingPublishedPhotoIds.length}`,
    markdownPathList(findings.missingPublishedPhotoIds, (id) => `\`${id}\``),
    "",
    "## Exact grouped decisions",
    "",
    ...eligibility.groupResults.flatMap((group) => [
      `### ${group.key}`,
      "",
      `- Status: ${group.status}`,
      `- Exact members: ${group.affectedFileCount}`,
      `- Exceptions: ${group.exceptionPaths.length}`,
      markdownPathList(group.affectedPaths, (item) => `\`${item}\``),
      ""
    ]),
    "## Inventory drift",
    "",
    `- Added: ${eligibility.inventoryChanges.added.length}`,
    `- Removed: ${eligibility.inventoryChanges.removed.length}`,
    `- Changed at the same path: ${eligibility.inventoryChanges.changed.length}`,
    "",
    "## Eligibility",
    "",
    eligibility.publicationEligible
      ? "All exact decisions and the fresh inventory match. This is eligibility, not publication authorization."
      : "Fail closed: the fresh inventory and every exact decision must match before publication eligibility can pass."
  ];
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { source: "original-photos", scanRoots: [], year: null, policy: null, publicDataRoot: "public", concurrency: 6, format: "json", templateOnly: false, requireEligible: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--template-only") args.templateOnly = true;
    else if (token === "--require-eligible") args.requireEligible = true;
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
      index += 1;
      if (token === "--source") args.source = value;
      else if (token === "--scan-root") args.scanRoots.push(value);
      else if (token === "--year") args.year = value;
      else if (token === "--policy") args.policy = value;
      else if (token === "--public-data-root") args.publicDataRoot = value;
      else if (token === "--concurrency") args.concurrency = Number(value);
      else if (token === "--format") args.format = value;
      else throw new Error(`Unknown option ${token}`);
    }
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error("--concurrency must be a positive integer");
  if (args.year && !/^\d{4}$/.test(args.year)) throw new Error("--year must be four digits");
  if (!new Set(["json", "markdown"]).has(args.format)) throw new Error("--format must be json or markdown");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(APP_ROOT, args.source);
  const inspection = await inspectSourcePolicy({
    sourceRoot,
    scanRoots: args.scanRoots.map((root) => path.resolve(APP_ROOT, root)),
    selectedYear: args.year,
    concurrency: args.concurrency,
    publicDataRoot: args.publicDataRoot ? path.resolve(APP_ROOT, args.publicDataRoot) : null
  });
  const policy = args.policy ? JSON.parse(await fs.readFile(path.resolve(APP_ROOT, args.policy), "utf8")) : null;
  const eligibility = evaluateSourcePolicy(inspection, policy);
  const policyTemplate = createSourcePolicyTemplate(inspection);
  const decisionReportMarkdown = renderDecisionReport(inspection, eligibility);
  if (args.templateOnly) process.stdout.write(`${JSON.stringify(policyTemplate, null, 2)}\n`);
  else if (args.format === "markdown") process.stdout.write(`${decisionReportMarkdown}\n`);
  else {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: SOURCE_POLICY_SCHEMA_VERSION, inventory: inspection.inventory, findings: inspection.findings, eligibility, policyTemplate, decisionReportMarkdown }, null, 2)}\n`
    );
  }
  if (args.requireEligible && !eligibility.publicationEligible) process.exitCode = 2;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
