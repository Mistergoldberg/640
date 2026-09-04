import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import exifr from "exifr";
import sharp from "sharp";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_ROOT, "..");
const ARCHIVE_ROOT = path.resolve(APP_ROOT, "..");
const REPO_ROOT = path.resolve(ARCHIVE_ROOT, "..");
const DEFAULT_SOURCE_ROOT = path.resolve(APP_ROOT, "../original-photos");
const REPORT_ROOT = path.join(ARCHIVE_ROOT, "generated", "reports");
const CACHE_ROOT = path.join(ARCHIVE_ROOT, "generated", "inventory-cache");
const JSON_REPORT_PATH = path.join(REPORT_ROOT, "archive-inventory.json");
const MD_REPORT_PATH = path.join(REPORT_ROOT, "archive-inventory.md");
const CACHE_PATH = path.join(CACHE_ROOT, "archive-inventory-cache-v1.json");
const PUBLIC_DATA_ROOT = path.join(APP_ROOT, "public", "data");
const GENERATED_LIBRARY_ROOT = path.join(ARCHIVE_ROOT, "generated", "library");
const EXISTING_SOURCE_YEARS = ["2001", "2013"];
const CURRENT_REFERENCE = {
  processedPhotographs: 10882,
  generatedDerivatives: 21764,
  generatedMediaBytes: 576004810
};
const CACHE_VERSION = 1;
const PROGRESS_INTERVAL_MS = 10000;
const PROGRESS_EVERY_FILES = 1000;
const HEADER_BYTES = 4100;
const CURRENT_YEAR = new Date().getFullYear();
const LOW_SIZE_FACTOR = 0.72;
const HIGH_SIZE_FACTOR = 1.45;

const NOISE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".jpe",
  ".png",
  ".tif",
  ".tiff",
  ".webp"
]);
const IDENTIFYING_EXIF_FIELDS = [
  "Artist",
  "BodySerialNumber",
  "CameraOwnerName",
  "Copyright",
  "HostComputer",
  "ImageUniqueID",
  "LensSerialNumber",
  "OwnerName",
  "SerialNumber",
  "Software"
];

function parseArgs(argv) {
  const args = {
    source: DEFAULT_SOURCE_ROOT,
    concurrency: Math.max(2, Math.min(8, os.cpus().length || 4)),
    noCache: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--source requires a path");
      }
      args.source = path.resolve(APP_ROOT, value);
      index += 1;
    } else if (arg === "--concurrency") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 32) {
        throw new Error("--concurrency must be an integer from 1 to 32");
      }
      args.concurrency = value;
      index += 1;
    } else if (arg === "--no-cache") {
      args.noCache = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: npm run archive:inventory -- [--source ../original-photos] [--concurrency 6] [--no-cache]",
          "",
          "Scans source photographs read-only and writes private reports under ../generated/."
        ].join("\n") + "\n"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function repoRelative(absolutePath) {
  return toPosix(path.relative(REPO_ROOT, absolutePath));
}

function isInsideOrEqual(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureSafeRoot(sourceRoot) {
  const home = os.homedir();
  const broadRoots = new Set([
    path.resolve("/"),
    path.resolve(home),
    path.resolve(REPO_ROOT),
    path.resolve(ARCHIVE_ROOT),
    path.resolve(APP_ROOT),
    path.resolve(REPORT_ROOT),
    path.resolve(CACHE_ROOT),
    path.resolve(GENERATED_LIBRARY_ROOT),
    path.resolve(ARCHIVE_ROOT, "2001"),
    path.resolve(ARCHIVE_ROOT, "2013"),
    path.resolve(ARCHIVE_ROOT, "dev-01")
  ]);

  if (broadRoots.has(sourceRoot)) {
    throw new Error(`Refusing dangerously broad source root: ${repoRelative(sourceRoot)}`);
  }

  if (!isInsideOrEqual(sourceRoot, ARCHIVE_ROOT)) {
    throw new Error("Refusing source root outside the 640 archive directory");
  }

  if (isInsideOrEqual(REPORT_ROOT, sourceRoot) || isInsideOrEqual(CACHE_ROOT, sourceRoot)) {
    throw new Error("Report/cache output would be inside the source root");
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isNoiseFile(name) {
  return NOISE_NAMES.has(name) || name.startsWith("._");
}

function extensionFor(name) {
  return path.extname(name).toLowerCase();
}

function detectFormat(header) {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { format: "jpeg", mime: "image/jpeg" };
  }
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { format: "png", mime: "image/png" };
  }
  if (header.length >= 6 && (header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { format: "gif", mime: "image/gif" };
  }
  if (header.length >= 12 && header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") {
    return { format: "webp", mime: "image/webp" };
  }
  if (header.length >= 4) {
    const firstFour = header.subarray(0, 4).toString("binary");
    if (firstFour === "II*\u0000" || firstFour === "MM\u0000*") {
      return { format: "tiff", mime: "image/tiff" };
    }
  }
  if (header.length >= 16 && header.subarray(4, 8).toString("ascii") === "ftyp") {
    const brands = header.subarray(8, Math.min(header.length, 40)).toString("ascii");
    if (/heic|heix|hevc|hevx/.test(brands)) {
      return { format: "heic", mime: "image/heic" };
    }
    if (/heif|mif1|msf1/.test(brands)) {
      return { format: "heif", mime: "image/heif" };
    }
    if (/avif|avis/.test(brands)) {
      return { format: "avif", mime: "image/avif" };
    }
  }
  return null;
}

async function readHeader(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function loadCache() {
  try {
    const cache = JSON.parse(await fs.readFile(CACHE_PATH, "utf8"));
    if (cache.version === CACHE_VERSION && cache.entries && typeof cache.entries === "object") {
      return cache;
    }
  } catch {
    // A missing or unreadable cache is a normal first-run state.
  }
  return { version: CACHE_VERSION, entries: {} };
}

async function saveCache(cache) {
  await fs.mkdir(CACHE_ROOT, { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

function cacheKey(rootLabel, relativePath) {
  return `${rootLabel}:${relativePath}`;
}

function canReuseHash(cacheEntry, stat) {
  return cacheEntry && cacheEntry.size === stat.size && cacheEntry.mtimeMs === stat.mtimeMs && typeof cacheEntry.sha256 === "string";
}

async function getHash(file, cache, options) {
  const key = cacheKey(file.rootLabel, file.relativePath);
  const cached = cache.entries[key];
  if (!options.noCache && canReuseHash(cached, file.stat)) {
    return { sha256: cached.sha256, hashSource: "cache" };
  }

  const sha256 = await sha256File(file.absolutePath);
  cache.entries[key] = {
    size: file.stat.size,
    mtimeMs: file.stat.mtimeMs,
    sha256
  };
  return { sha256, hashSource: "fresh" };
}

function addCount(map, key, count = 1) {
  const safeKey = key || "unknown";
  map[safeKey] = (map[safeKey] || 0) + count;
}

function makeCounter() {
  return {};
}

function samplePush(list, value, limit = 25) {
  if (list.length < limit) {
    list.push(value);
  }
}

async function walkSource(rootLabel, rootPath) {
  const files = [];
  const directories = [];
  const symlinks = [];
  const nonRegularEntries = [];
  const noiseFiles = [];
  const unreadableEntries = [];

  async function walk(currentPath) {
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      unreadableEntries.push({
        path: toPosix(path.relative(rootPath, currentPath)) || ".",
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = toPosix(path.relative(rootPath, absolutePath));
      let stat;
      try {
        stat = await fs.lstat(absolutePath);
      } catch (error) {
        unreadableEntries.push({
          path: relativePath,
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      if (entry.isSymbolicLink()) {
        let target = null;
        let escapesRoot = true;
        try {
          target = await fs.realpath(absolutePath);
          escapesRoot = !isInsideOrEqual(target, rootPath);
        } catch {
          target = null;
        }
        symlinks.push({
          path: relativePath,
          target: target ? repoRelative(target) : null,
          escapesRoot
        });
        continue;
      }

      if (entry.isDirectory()) {
        directories.push(relativePath);
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        nonRegularEntries.push({ path: relativePath, type: "other" });
        continue;
      }

      const file = {
        rootLabel,
        absolutePath,
        relativePath,
        filename: entry.name,
        extension: extensionFor(entry.name),
        stat: {
          size: stat.size,
          mtimeMs: Math.round(stat.mtimeMs),
          mtimeIso: stat.mtime.toISOString()
        }
      };

      if (isNoiseFile(entry.name)) {
        noiseFiles.push({
          path: relativePath,
          bytes: stat.size,
          kind: entry.name.startsWith("._") ? "apple-resource-fork" : entry.name
        });
        continue;
      }

      files.push(file);
    }
  }

  await walk(rootPath);
  return { rootLabel, rootPath, files, directories, symlinks, nonRegularEntries, noiseFiles, unreadableEntries };
}

function sourceFingerprint(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(file.stat.size));
    hash.update("\0");
    hash.update(String(file.stat.mtimeMs));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function parentFolder(relativePath) {
  return toPosix(path.dirname(relativePath));
}

function topLevelFolder(relativePath) {
  return relativePath.split("/")[0] || ".";
}

function projectedAlbumFolder(relativePath) {
  const parts = relativePath.split("/");
  const topLevel = parts[0] || ".";
  if (/^(19|20)\d{2}$/.test(topLevel) && parts.length > 2) {
    return `${topLevel}/${parts[1]}`;
  }
  return topLevel;
}

function leadingYear(value) {
  const match = String(value || "").match(/^(19|20)\d{2}/);
  return match ? match[0] : null;
}

function likelyYearFromFolder(rootLabel, relativePath) {
  const rootYear = leadingYear(rootLabel);
  if (rootYear) {
    return rootYear;
  }
  return leadingYear(topLevelFolder(relativePath));
}

function inferFilenameDate(filename) {
  const base = path.basename(filename, path.extname(filename));
  const patterns = [
    /(?<!\d)((?:19|20)\d{2})[-_. ]?([01]\d)[-_. ]?([0-3]\d)(?!\d)/,
    /(?<!\d)([01]\d)[-_. ]?([0-3]\d)[-_. ]?((?:19|20)\d{2})(?!\d)/
  ];

  for (const pattern of patterns) {
    const match = base.match(pattern);
    if (!match) {
      continue;
    }

    const year = pattern === patterns[0] ? Number(match[1]) : Number(match[3]);
    const month = pattern === patterns[0] ? Number(match[2]) : Number(match[1]);
    const day = pattern === patterns[0] ? Number(match[3]) : Number(match[2]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return date.toISOString();
    }
  }

  return null;
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function dateYear(iso) {
  if (!iso) {
    return null;
  }
  const year = Number(String(iso).slice(0, 4));
  return Number.isInteger(year) ? String(year) : null;
}

function isPlausibleDate(iso) {
  const year = dateYear(iso);
  return Boolean(year && Number(year) >= 1990 && Number(year) <= CURRENT_YEAR + 1);
}

function chooseBestDate(exifDate, filenameDate, mtimeIso) {
  if (isPlausibleDate(exifDate)) {
    return { iso: exifDate, source: "exif" };
  }
  if (isPlausibleDate(filenameDate)) {
    return { iso: filenameDate, source: "filename" };
  }
  if (isPlausibleDate(mtimeIso)) {
    return { iso: mtimeIso, source: "mtime" };
  }
  return { iso: null, source: "none" };
}

function visualDimensions(metadata) {
  const width = metadata.width || null;
  const height = metadata.height || null;
  const orientation = metadata.orientation || null;
  const swap = [5, 6, 7, 8].includes(orientation);
  return {
    rawWidth: width,
    rawHeight: height,
    visualWidth: width && height && swap ? height : width,
    visualHeight: width && height && swap ? width : height,
    exifOrientation: orientation
  };
}

function orientationFor(width, height) {
  if (!width || !height) {
    return "unknown";
  }
  if (width > height) {
    return "landscape";
  }
  if (height > width) {
    return "portrait";
  }
  return "square";
}

function pickExifDate(tags) {
  if (!tags) {
    return null;
  }
  for (const key of ["DateTimeOriginal", "CreateDate", "DateTimeDigitized", "ModifyDate", "DateCreated"]) {
    const date = normalizeDate(tags[key]);
    if (date) {
      return date;
    }
  }
  return null;
}

function gpsExists(tags) {
  if (!tags) {
    return false;
  }
  return ["latitude", "longitude", "GPSLatitude", "GPSLongitude", "GPSPosition"].some((key) => tags[key] !== undefined && tags[key] !== null);
}

function identifyingExifFields(tags) {
  if (!tags) {
    return [];
  }
  return IDENTIFYING_EXIF_FIELDS.filter((key) => tags[key] !== undefined && tags[key] !== null && String(tags[key]).trim() !== "");
}

async function identifyWithSharp(filePath) {
  try {
    const metadata = await sharp(filePath, { failOn: "none", limitInputPixels: false }).metadata();
    return metadata.format ? { format: metadata.format, mime: `image/${metadata.format === "jpg" ? "jpeg" : metadata.format}` } : null;
  } catch {
    return null;
  }
}

async function decodeImage(filePath) {
  try {
    await sharp(filePath, { failOn: "none", limitInputPixels: false }).rotate().resize({ width: 1, height: 1, fit: "inside" }).toBuffer();
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function analyzePhotoFile(file, cache, options) {
  let header;
  try {
    header = await readHeader(file.absolutePath);
  } catch (error) {
    return {
      kind: "unreadable",
      file: file.relativePath,
      filename: file.filename,
      extension: file.extension,
      bytes: file.stat.size,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  let detected = detectFormat(header);
  if (!detected && IMAGE_EXTENSIONS.has(file.extension)) {
    detected = await identifyWithSharp(file.absolutePath);
  }
  if (!detected) {
    return {
      kind: IMAGE_EXTENSIONS.has(file.extension) ? "unsupported-image-like" : "non-photo",
      file: file.relativePath,
      filename: file.filename,
      extension: file.extension,
      bytes: file.stat.size
    };
  }

  const hash = await getHash(file, cache, options);
  let metadata = null;
  let metadataError = null;
  try {
    metadata = await sharp(file.absolutePath, { failOn: "none", limitInputPixels: false }).metadata();
  } catch (error) {
    metadataError = error instanceof Error ? error.message : String(error);
  }

  let exifTags = null;
  let exifError = null;
  try {
    exifTags = await exifr.parse(file.absolutePath, {
      tiff: true,
      exif: true,
      gps: true,
      ifd0: true,
      ifd1: false,
      xmp: false,
      iptc: false,
      reviveValues: true,
      translateValues: false
    });
  } catch (error) {
    exifError = error instanceof Error ? error.message : String(error);
  }

  const decode = await decodeImage(file.absolutePath);
  const dimensions = metadata ? visualDimensions(metadata) : { rawWidth: null, rawHeight: null, visualWidth: null, visualHeight: null, exifOrientation: null };
  const exifCaptureDate = pickExifDate(exifTags);
  const filenameDate = inferFilenameDate(file.filename);
  const bestDate = chooseBestDate(exifCaptureDate, filenameDate, file.stat.mtimeIso);
  const folderYear = likelyYearFromFolder(file.rootLabel, file.relativePath);
  const exifYear = dateYear(exifCaptureDate);
  const filenameYear = dateYear(filenameDate);
  const mtimeYear = dateYear(file.stat.mtimeIso);
  const bestYear = dateYear(bestDate.iso);

  return {
    kind: "photo",
    photo: {
      root: file.rootLabel,
      sourceRelativePath: file.relativePath,
      filename: file.filename,
      extension: file.extension,
      detectedFormat: detected.format,
      detectedMime: detected.mime,
      size: file.stat.size,
      sha256: hash.sha256,
      hashSource: hash.hashSource,
      rawWidth: dimensions.rawWidth,
      rawHeight: dimensions.rawHeight,
      exifOrientation: dimensions.exifOrientation,
      visualWidth: dimensions.visualWidth,
      visualHeight: dimensions.visualHeight,
      orientation: orientationFor(dimensions.visualWidth, dimensions.visualHeight),
      exifCaptureDate,
      filenameDate,
      fileModificationTime: file.stat.mtimeIso,
      parentFolder: parentFolder(file.relativePath),
      topLevelFolder: topLevelFolder(file.relativePath),
      likelyYearFromFolder: folderYear,
      likelyYearFromBestDate: bestYear,
      bestDateSource: bestDate.source,
      decodesSuccessfully: decode.ok,
      decodeError: decode.error,
      metadataError,
      exifError,
      gpsDataExists: gpsExists(exifTags),
      identifyingExifFields: identifyingExifFields(exifTags),
      years: {
        folder: folderYear,
        exif: exifYear,
        filename: filenameYear,
        modificationTime: mtimeYear,
        best: bestYear
      }
    }
  };
}

async function runPool(items, concurrency, worker, progress) {
  let next = 0;
  let completed = 0;
  let lastProgressAt = Date.now();
  const results = new Array(items.length);

  async function runWorker() {
    while (next < items.length) {
      const current = next;
      next += 1;
      results[current] = await worker(items[current], current);
      completed += 1;
      const now = Date.now();
      if (progress && (completed % PROGRESS_EVERY_FILES === 0 || now - lastProgressAt >= PROGRESS_INTERVAL_MS || completed === items.length)) {
        lastProgressAt = now;
        progress(completed, items.length);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => runWorker()));
  return results;
}

async function scanRoot(rootLabel, rootPath, cache, options) {
  const listed = await walkSource(rootLabel, rootPath);
  const beforeFingerprint = sourceFingerprint(listed.files);
  const startedAt = Date.now();
  process.stdout.write(`Scanning ${rootLabel}: ${listed.files.length} candidate files, ${listed.noiseFiles.length} noise files, ${listed.symlinks.length} symlinks.\n`);

  const results = await runPool(
    listed.files,
    options.concurrency,
    (file) => analyzePhotoFile(file, cache, options),
    (completed, total) => process.stdout.write(`Inventory ${rootLabel}: ${completed}/${total}\n`)
  );

  const photos = [];
  const nonPhotoFiles = [];
  const unsupportedFiles = [];
  const unreadableFiles = [];
  for (const result of results) {
    if (result.kind === "photo") {
      photos.push(result.photo);
    } else if (result.kind === "non-photo") {
      nonPhotoFiles.push(result);
    } else if (result.kind === "unsupported-image-like") {
      unsupportedFiles.push(result);
    } else {
      unreadableFiles.push(result);
    }
  }

  const afterListed = await walkSource(rootLabel, rootPath);
  const photoPaths = new Set(photos.map((photo) => photo.sourceRelativePath));
  const beforePhotoFiles = listed.files.filter((file) => photoPaths.has(file.relativePath));
  const afterPhotoFiles = afterListed.files.filter((file) => photoPaths.has(file.relativePath));
  const afterPhotoByPath = new Map(afterPhotoFiles.map((file) => [file.relativePath, file]));
  const changedPhotographicFiles = [];
  for (const before of beforePhotoFiles) {
    const after = afterPhotoByPath.get(before.relativePath);
    if (!after) {
      changedPhotographicFiles.push({ path: before.relativePath, change: "removed" });
    } else if (after.stat.size !== before.stat.size || after.stat.mtimeMs !== before.stat.mtimeMs) {
      changedPhotographicFiles.push({
        path: before.relativePath,
        change: "stat-changed",
        before: before.stat,
        after: after.stat
      });
    }
  }
  for (const after of afterPhotoFiles) {
    if (!photoPaths.has(after.relativePath)) {
      changedPhotographicFiles.push({ path: after.relativePath, change: "added" });
    }
  }

  return {
    root: {
      label: rootLabel,
      relativePath: repoRelative(rootPath)
    },
    durationMs: Date.now() - startedAt,
    fileCount: listed.files.length,
    directoryCount: listed.directories.length,
    totalCandidateBytes: listed.files.reduce((sum, file) => sum + file.stat.size, 0),
    beforeFingerprint,
    afterFingerprint: sourceFingerprint(afterListed.files),
    photographicBeforeFingerprint: sourceFingerprint(beforePhotoFiles),
    photographicAfterFingerprint: sourceFingerprint(afterPhotoFiles),
    changedPhotographicFiles,
    noiseFiles: listed.noiseFiles,
    symlinks: listed.symlinks,
    nonRegularEntries: listed.nonRegularEntries,
    unreadableEntries: listed.unreadableEntries,
    nonPhotoFiles,
    unsupportedFiles,
    unreadableFiles,
    photos
  };
}

function summarizePhotos(photos) {
  const byFormat = makeCounter();
  const byOrientation = makeCounter();
  const byTopLevelFolder = makeCounter();
  const byProjectedAlbumFolder = makeCounter();
  const byLikelyFolderYear = makeCounter();
  const byBestYear = makeCounter();
  const byExifYear = makeCounter();
  const byDateSource = makeCounter();
  const byExtension = makeCounter();
  let totalBytes = 0;
  let missingReliableDates = 0;
  let noUsableDate = 0;
  let gpsCount = 0;
  let identifyingExifCount = 0;
  let decodeFailures = 0;
  let implausibleDateCount = 0;
  let likelyCopyMtimeCount = 0;
  const folderExifDisagreements = [];
  const folderBestDateDisagreements = [];
  const implausibleDates = [];
  const likelyCopyMtimes = [];

  for (const photo of photos) {
    totalBytes += photo.size;
    addCount(byFormat, photo.detectedFormat);
    addCount(byOrientation, photo.orientation);
    addCount(byTopLevelFolder, photo.topLevelFolder);
    addCount(byProjectedAlbumFolder, projectedAlbumFolder(photo.sourceRelativePath));
    addCount(byLikelyFolderYear, photo.likelyYearFromFolder);
    addCount(byBestYear, photo.likelyYearFromBestDate);
    addCount(byExifYear, photo.years.exif || "none");
    addCount(byDateSource, photo.bestDateSource);
    addCount(byExtension, photo.extension || "none");

    if (!photo.exifCaptureDate && !photo.filenameDate) {
      missingReliableDates += 1;
    }
    if (photo.bestDateSource === "none") {
      noUsableDate += 1;
    }
    if (photo.gpsDataExists) {
      gpsCount += 1;
    }
    if (photo.identifyingExifFields.length) {
      identifyingExifCount += 1;
    }
    if (!photo.decodesSuccessfully) {
      decodeFailures += 1;
    }

    if (photo.years.folder && photo.years.exif && photo.years.folder !== photo.years.exif) {
      samplePush(folderExifDisagreements, {
        path: photo.sourceRelativePath,
        folderYear: photo.years.folder,
        exifYear: photo.years.exif,
        exifCaptureDate: photo.exifCaptureDate
      }, 100);
    }
    if (photo.years.folder && photo.years.best && photo.years.folder !== photo.years.best) {
      samplePush(folderBestDateDisagreements, {
        path: photo.sourceRelativePath,
        folderYear: photo.years.folder,
        bestYear: photo.years.best,
        bestDateSource: photo.bestDateSource
      }, 100);
    }
    for (const [source, iso] of [
      ["exif", photo.exifCaptureDate],
      ["filename", photo.filenameDate],
      ["mtime", photo.fileModificationTime]
    ]) {
      if (iso && !isPlausibleDate(iso)) {
        implausibleDateCount += 1;
        samplePush(implausibleDates, {
          path: photo.sourceRelativePath,
          source,
          value: iso
        }, 100);
      }
    }
    if (photo.years.folder && photo.years.modificationTime && Number(photo.years.modificationTime) >= Number(photo.years.folder) + 2) {
      likelyCopyMtimeCount += 1;
      samplePush(likelyCopyMtimes, {
        path: photo.sourceRelativePath,
        folderYear: photo.years.folder,
        modificationTimeYear: photo.years.modificationTime
      }, 100);
    }
  }

  const missingDateByFolderYear = {};
  const countsByFolderYear = {};
  for (const photo of photos) {
    const year = photo.years.folder || "unknown";
    countsByFolderYear[year] = (countsByFolderYear[year] || 0) + 1;
    if (!photo.exifCaptureDate && !photo.filenameDate) {
      missingDateByFolderYear[year] = (missingDateByFolderYear[year] || 0) + 1;
    }
  }
  const missingDateRatesByFolderYear = Object.fromEntries(
    Object.entries(countsByFolderYear)
      .map(([year, count]) => [
        year,
        {
          count,
          missingReliableDates: missingDateByFolderYear[year] || 0,
          rate: count ? Number(((missingDateByFolderYear[year] || 0) / count).toFixed(4)) : 0
        }
      ])
      .sort((left, right) => left[0].localeCompare(right[0]))
  );

  return {
    totalPhotographs: photos.length,
    totalBytes,
    byFormat,
    byOrientation,
    byTopLevelFolder,
    byProjectedAlbumFolder,
    byLikelyFolderYear,
    byBestYear,
    byExifYear,
    byDateSource,
    byExtension,
    missingReliableDates,
    noUsableDate,
    gpsCount,
    identifyingExifCount,
    decodeFailures,
    folderExifDisagreementCount: photos.filter((photo) => photo.years.folder && photo.years.exif && photo.years.folder !== photo.years.exif).length,
    folderBestDateDisagreementCount: photos.filter((photo) => photo.years.folder && photo.years.best && photo.years.folder !== photo.years.best).length,
    folderExifDisagreements,
    folderBestDateDisagreements,
    implausibleDateCount,
    implausibleDates,
    likelyCopyMtimeCount,
    likelyCopyMtimes,
    missingDateRatesByFolderYear
  };
}

function duplicateAnalysis(photos) {
  const byHash = new Map();
  const byFilename = new Map();

  for (const photo of photos) {
    if (!byHash.has(photo.sha256)) {
      byHash.set(photo.sha256, []);
    }
    byHash.get(photo.sha256).push(photo);

    const filenameKey = photo.filename.toLowerCase();
    if (!byFilename.has(filenameKey)) {
      byFilename.set(filenameKey, []);
    }
    byFilename.get(filenameKey).push(photo);
  }

  const duplicateGroups = [];
  const duplicateGroupsCrossingYears = [];
  const duplicateGroupsWithinSameFolder = [];
  const differentFilenamesIdenticalContent = [];
  let redundantCopies = 0;
  let redundantBytes = 0;

  for (const [sha256, group] of byHash) {
    if (group.length <= 1) {
      continue;
    }
    const paths = group.map((photo) => photo.sourceRelativePath).sort();
    const years = new Set(group.map((photo) => photo.years.folder || "unknown"));
    const parentFolders = new Set(group.map((photo) => photo.parentFolder));
    const filenames = new Set(group.map((photo) => photo.filename));
    const redundant = group.length - 1;
    redundantCopies += redundant;
    redundantBytes += group[0].size * redundant;
    const record = {
      sha256,
      count: group.length,
      bytesEach: group[0].size,
      redundantBytes: group[0].size * redundant,
      folderYears: Array.from(years).sort(),
      parentFolders: Array.from(parentFolders).sort(),
      filenames: Array.from(filenames).sort(),
      paths
    };
    duplicateGroups.push(record);
    if (years.size > 1) {
      duplicateGroupsCrossingYears.push(record);
    }
    if (group.length > parentFolders.size) {
      duplicateGroupsWithinSameFolder.push(record);
    }
    if (filenames.size > 1) {
      differentFilenamesIdenticalContent.push(record);
    }
  }

  const sameFilenameDifferentContent = [];
  for (const [filename, group] of byFilename) {
    const hashes = new Set(group.map((photo) => photo.sha256));
    if (hashes.size > 1) {
      sameFilenameDifferentContent.push({
        filename,
        contentCount: hashes.size,
        fileCount: group.length,
        samplePaths: group.slice(0, 25).map((photo) => photo.sourceRelativePath)
      });
    }
  }

  duplicateGroups.sort((left, right) => right.count - left.count || right.redundantBytes - left.redundantBytes);
  duplicateGroupsCrossingYears.sort((left, right) => right.count - left.count || right.redundantBytes - left.redundantBytes);
  duplicateGroupsWithinSameFolder.sort((left, right) => right.count - left.count || right.redundantBytes - left.redundantBytes);
  sameFilenameDifferentContent.sort((left, right) => right.fileCount - left.fileCount || left.filename.localeCompare(right.filename));

  return {
    totalPhysicalPhotographFiles: photos.length,
    totalUniquePhotographicContents: byHash.size,
    duplicateGroupCount: duplicateGroups.length,
    redundantCopies,
    redundantBytes,
    largestDuplicateGroups: duplicateGroups.slice(0, 25),
    duplicateGroups,
    duplicateGroupsCrossingDifferentFolderYears: duplicateGroupsCrossingYears.slice(0, 100),
    duplicateGroupsCrossingDifferentFolderYearsCount: duplicateGroupsCrossingYears.length,
    duplicateGroupsWithinSameFolder: duplicateGroupsWithinSameFolder.slice(0, 100),
    duplicateGroupsWithinSameFolderCount: duplicateGroupsWithinSameFolder.length,
    sameFilenameDifferentContent: sameFilenameDifferentContent.slice(0, 100),
    sameFilenameDifferentContentCount: sameFilenameDifferentContent.length,
    differentFilenamesIdenticalContent: differentFilenamesIdenticalContent.slice(0, 100),
    differentFilenamesIdenticalContentCount: differentFilenamesIdenticalContent.length
  };
}

function compareExistingYear(year, yearPhotos, originalPhotos) {
  const originalByHash = new Map();
  const originalByFilename = new Map();
  for (const photo of originalPhotos) {
    if (!originalByHash.has(photo.sha256)) {
      originalByHash.set(photo.sha256, []);
    }
    originalByHash.get(photo.sha256).push(photo);

    const filenameKey = photo.filename.toLowerCase();
    if (!originalByFilename.has(filenameKey)) {
      originalByFilename.set(filenameKey, []);
    }
    originalByFilename.get(filenameKey).push(photo);
  }

  const unmatched = [];
  const multipleMatches = [];
  const sameNameDifferentContent = [];
  let multipleExactMatchCount = 0;
  let sameNameDifferentContentCount = 0;
  let matchedCount = 0;
  let matchedBytes = 0;

  for (const photo of yearPhotos) {
    const hashMatches = originalByHash.get(photo.sha256) || [];
    if (hashMatches.length) {
      matchedCount += 1;
      matchedBytes += photo.size;
      if (hashMatches.length > 1) {
        multipleExactMatchCount += 1;
        samplePush(multipleMatches, {
          sourcePath: photo.sourceRelativePath,
          matchCount: hashMatches.length,
          matches: hashMatches.slice(0, 25).map((match) => match.sourceRelativePath)
        }, 100);
      }
      continue;
    }

    samplePush(unmatched, {
      sourcePath: photo.sourceRelativePath,
      filename: photo.filename,
      bytes: photo.size,
      sha256: photo.sha256
    }, 200);

    const sameName = originalByFilename.get(photo.filename.toLowerCase()) || [];
    if (sameName.length) {
      sameNameDifferentContentCount += 1;
      samplePush(sameNameDifferentContent, {
        sourcePath: photo.sourceRelativePath,
        filename: photo.filename,
        originalArchiveCandidates: sameName.slice(0, 25).map((candidate) => ({
          path: candidate.sourceRelativePath,
          sha256: candidate.sha256,
          bytes: candidate.size
        }))
      }, 100);
    }
  }

  const unmatchedCount = yearPhotos.length - matchedCount;
  return {
    year,
    existingYearPhotographs: yearPhotos.length,
    exactMatchesInOriginalPhotos: matchedCount,
    withoutExactMatch: unmatchedCount,
    withMultipleExactMatches: multipleExactMatchCount,
    bytesRepresentedByMatchedFiles: matchedBytes,
    sameNameFilesWithDifferentContentCount: sameNameDifferentContentCount,
    sameNameFilesWithDifferentContent: sameNameDifferentContent,
    unmatchedPhotographs: unmatched,
    multipleExactMatches: multipleMatches,
    completeByteIdenticalSubsetOfOriginalPhotos: unmatchedCount === 0,
    deletionReadiness:
      unmatchedCount === 0 ? "POSSIBLE DUPLICATE WORKING COPY" : "NOT SAFE"
  };
}

async function directorySize(root) {
  let bytes = 0;
  let files = 0;
  if (!(await pathExists(root))) {
    return { bytes, files };
  }

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      const stat = await fs.lstat(filePath);
      if (entry.isDirectory()) {
        await walk(filePath);
      } else if (entry.isFile()) {
        files += 1;
        bytes += stat.size;
      }
    }
  }

  await walk(root);
  return { bytes, files };
}

async function publicDataStats() {
  const stats = {
    fileCount: 0,
    bytes: 0,
    largestFile: null,
    albumManifestSizes: [],
    currentPhotoCount: CURRENT_REFERENCE.processedPhotographs,
    currentAlbumCount: 0,
    currentYearCount: 0
  };

  if (!(await pathExists(PUBLIC_DATA_ROOT))) {
    return stats;
  }

  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(filePath);
        const relativePath = toPosix(path.relative(PUBLIC_DATA_ROOT, filePath));
        stats.fileCount += 1;
        stats.bytes += stat.size;
        if (!stats.largestFile || stat.size > stats.largestFile.bytes) {
          stats.largestFile = { path: relativePath, bytes: stat.size };
        }
        if (relativePath.includes("/albums/")) {
          try {
            const manifest = JSON.parse(await fs.readFile(filePath, "utf8"));
            stats.albumManifestSizes.push({ path: relativePath, bytes: stat.size, photoCount: manifest.photos?.length || 0 });
          } catch {
            stats.albumManifestSizes.push({ path: relativePath, bytes: stat.size, photoCount: null });
          }
        }
      }
    }
  }

  await walk(PUBLIC_DATA_ROOT);

  try {
    const catalog = JSON.parse(await fs.readFile(path.join(PUBLIC_DATA_ROOT, "catalog.json"), "utf8"));
    stats.currentYearCount = catalog.years?.length || 0;
  } catch {
    stats.currentYearCount = 0;
  }
  stats.currentAlbumCount = stats.albumManifestSizes.length;
  stats.albumManifestSizes.sort((left, right) => right.bytes - left.bytes);
  return stats;
}

async function generatedMediaStats() {
  const stats = await directorySize(GENERATED_LIBRARY_ROOT);
  const perPhotoBytes = new Map();

  async function walk(current) {
    if (!(await pathExists(current))) {
      return;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(filePath);
        const id = path.basename(entry.name, path.extname(entry.name));
        perPhotoBytes.set(id, (perPhotoBytes.get(id) || 0) + stat.size);
      }
    }
  }

  await walk(GENERATED_LIBRARY_ROOT);
  const totals = Array.from(perPhotoBytes.values()).sort((left, right) => left - right);
  function percentile(p) {
    if (!totals.length) {
      return 0;
    }
    const index = Math.min(totals.length - 1, Math.max(0, Math.floor((totals.length - 1) * p)));
    return totals[index];
  }

  return {
    ...stats,
    photoPairs: perPhotoBytes.size,
    averageBytesPerPhoto: CURRENT_REFERENCE.generatedMediaBytes / CURRENT_REFERENCE.processedPhotographs,
    p25BytesPerPhoto: percentile(0.25),
    p50BytesPerPhoto: percentile(0.5),
    p90BytesPerPhoto: percentile(0.9)
  };
}

function sumObjectValues(object) {
  return Object.values(object).reduce((sum, value) => sum + value, 0);
}

function largestCounterEntry(counter) {
  const entries = Object.entries(counter).sort((left, right) => right[1] - left[1]);
  return entries[0] ? { key: entries[0][0], count: entries[0][1] } : null;
}

function forecastImport(originalPhotos, existingYearScans, originalDuplicates, mediaStats, dataStats) {
  const existingPhotos = existingYearScans.flatMap((scan) => scan.photos);
  const existingHashes = new Set(existingPhotos.map((photo) => photo.sha256));
  const originalHashes = new Set(originalPhotos.map((photo) => photo.sha256));
  const originalPhotosNotAlreadyImported = originalPhotos.filter((photo) => !existingHashes.has(photo.sha256));
  const originalUniqueNotAlreadyImported = Array.from(originalHashes).filter((sha256) => !existingHashes.has(sha256)).length;
  const existingUnique = new Set(existingPhotos.map((photo) => photo.sha256)).size;
  const currentGeneratedAvg = mediaStats.averageBytesPerPhoto || CURRENT_REFERENCE.generatedMediaBytes / CURRENT_REFERENCE.processedPhotographs;
  const finalPhysicalPreservingEveryFile = CURRENT_REFERENCE.processedPhotographs + originalPhotosNotAlreadyImported.length;
  const finalUniqueExcludingByteDuplicates = existingUnique + originalUniqueNotAlreadyImported;
  const additionalPreserving = originalPhotosNotAlreadyImported.length;
  const additionalUnique = originalUniqueNotAlreadyImported;
  const largestProjectedYear = largestCounterEntry(summarizePhotos(originalPhotos).byLikelyFolderYear);
  const originalSummary = summarizePhotos(originalPhotos);
  const projectedOriginalAlbumCount = Object.keys(originalSummary.byProjectedAlbumFolder).length;
  const projectedAlbumCount = dataStats.currentAlbumCount + projectedOriginalAlbumCount;
  const publicBytesPerPhoto = dataStats.currentPhotoCount ? dataStats.bytes / dataStats.currentPhotoCount : 0;
  const reportBytesPerPhoto = 900;

  function makeScenario(photoCount, additionalPhotoCount) {
    const generatedBytes = Math.round(photoCount * currentGeneratedAvg);
    return {
      finalPhotoCount: photoCount,
      estimatedAdditionalPhotosRemaining: additionalPhotoCount,
      expectedThumbnailCount: photoCount,
      expectedDisplayImageCount: photoCount,
      expectedGeneratedObjectCount: photoCount * 2,
      estimatedGeneratedMediaBytes: generatedBytes,
      estimatedGeneratedMediaSizeLowBytes: Math.round(generatedBytes * LOW_SIZE_FACTOR),
      estimatedGeneratedMediaSizeHighBytes: Math.round(generatedBytes * HIGH_SIZE_FACTOR),
      estimatedAdditionalGeneratedMediaBytes: Math.round(additionalPhotoCount * currentGeneratedAvg),
      estimatedPrivateManifestBytes: Math.round(photoCount * reportBytesPerPhoto),
      estimatedPublicManifestBytes: Math.round(photoCount * publicBytesPerPhoto),
      requiredLocalFreeSpaceHeadroomBytes: Math.round(generatedBytes * 1.25)
    };
  }

  return {
    measuredInputs: {
      originalPhysicalPhotographs: originalPhotos.length,
      originalUniquePhotographicContents: originalDuplicates.totalUniquePhotographicContents,
      currentProcessedPhotographs: CURRENT_REFERENCE.processedPhotographs,
      currentGeneratedDerivativeObjects: CURRENT_REFERENCE.generatedDerivatives,
      currentGeneratedMediaBytes: CURRENT_REFERENCE.generatedMediaBytes,
      currentGeneratedAverageBytesPerPhoto: currentGeneratedAvg,
      currentPublicManifestBytes: dataStats.bytes,
      currentPublicManifestBytesPerPhoto: publicBytesPerPhoto
    },
    preservingEveryPhysicalPhotograph: makeScenario(finalPhysicalPreservingEveryFile, additionalPreserving),
    excludingOnlyByteIdenticalDuplicateCopies: makeScenario(finalUniqueExcludingByteDuplicates, additionalUnique),
    largestProjectedYear,
    expectedAlbumCount: projectedAlbumCount,
    originalTopLevelFolderCount: new Set(originalPhotos.map((photo) => photo.topLevelFolder)).size,
    projectedOriginalAlbumCount,
    approximateInitialR2Upload: {
      preservingEveryPhysicalPhotograph: {
        objects: finalPhysicalPreservingEveryFile * 2,
        bytes: Math.round(finalPhysicalPreservingEveryFile * currentGeneratedAvg)
      },
      excludingOnlyByteIdenticalDuplicateCopies: {
        objects: finalUniqueExcludingByteDuplicates * 2,
        bytes: Math.round(finalUniqueExcludingByteDuplicates * currentGeneratedAvg)
      }
    }
  };
}

function architectureAssessment(originalSummary, forecast, dataStats) {
  const largestCurrentManifest = dataStats.albumManifestSizes[0] || { bytes: 0, photoCount: 0, path: null };
  const publicBytesPerPhoto = dataStats.currentPhotoCount ? dataStats.bytes / dataStats.currentPhotoCount : 0;
  const largestOriginalAlbumFolder = largestCounterEntry(originalSummary.byProjectedAlbumFolder);
  const projectedLargestAlbumBytes = largestOriginalAlbumFolder ? Math.round(largestOriginalAlbumFolder.count * publicBytesPerPhoto) : 0;
  const largestLikelyYear = forecast.largestProjectedYear;
  const projectedLargestYearBytes = largestLikelyYear ? Math.round(largestLikelyYear.count * publicBytesPerPhoto) : 0;
  const recommendations = [];

  if (projectedLargestAlbumBytes > 5 * 1024 * 1024) {
    recommendations.push("Shard album manifests once any single album approaches 5 MiB or about 12000 photos.");
  }
  if (projectedLargestYearBytes > 8 * 1024 * 1024) {
    recommendations.push("Load album manifests on viewport demand or paginate a year once a year-level selection would fetch more than about 8 MiB of JSON.");
  }
  recommendations.push("Keep the top-level catalogue summary-only and continue loading years separately.");
  recommendations.push("Before preserving exact duplicates as distinct entries, revise photo IDs so same-year byte-identical files cannot collapse to the same hash-based ID.");

  return {
    topLevelCatalogueSummaryOnly: true,
    yearsLoadOnDemand: true,
    albumsStoredAsSeparateManifests: true,
    currentAppLoadsAllAlbumManifestsForSelectedYearImmediately: true,
    initialPageDownloadsWholeArchive: false,
    playerRequiresEveryYearInMemory: false,
    playerRequiresSelectedYearInMemory: true,
    rowVirtualizationRemainsBounded: true,
    stableIdsDoNotCollideAcrossDifferentYears: true,
    stableIdsCanCollideForByteIdenticalFilesWithinTheSameYear: true,
    largestCurrentJsonRequest: largestCurrentManifest,
    largestProjectedAlbumFolder: largestOriginalAlbumFolder,
    projectedLargestAlbumJsonRequestBytes: projectedLargestAlbumBytes,
    projectedLargestYearJsonBytesIfAllAlbumManifestsLoadAtYearSelection: projectedLargestYearBytes,
    recommendations
  };
}

function recommendedProcessingOrder(originalSummary) {
  const disagreementCounts = {};
  for (const item of originalSummary.folderExifDisagreements) {
    disagreementCounts[item.folderYear] = (disagreementCounts[item.folderYear] || 0) + 1;
  }
  const yearEntries = Object.entries(originalSummary.byLikelyFolderYear)
    .filter(([year]) => year !== "unknown")
    .map(([year, count]) => {
      const missing = originalSummary.missingDateRatesByFolderYear[year]?.missingReliableDates || 0;
      const missingRate = originalSummary.missingDateRatesByFolderYear[year]?.rate || 0;
      const disagreementCount = disagreementCounts[year] || 0;
      return { year, count, missing, missingRate, disagreementCount };
    })
    .sort((left, right) => Number(left.year) - Number(right.year));
  const edgeCase =
    [...yearEntries]
      .filter((entry) => entry.count <= 1500)
      .sort((left, right) => right.disagreementCount - left.disagreementCount || right.missingRate - left.missingRate || left.count - right.count)[0] ||
    [...yearEntries].sort((left, right) => right.disagreementCount - left.disagreementCount || right.missingRate - left.missingRate)[0] ||
    null;
  const small = yearEntries.filter((entry) => entry.count <= 1000).sort((left, right) => left.count - right.count);
  const medium = yearEntries.filter((entry) => entry.count > 1000 && entry.count <= 4000).sort((left, right) => left.count - right.count);
  const large = yearEntries.filter((entry) => entry.count > 4000).sort((left, right) => left.count - right.count);
  const ordered = [];
  if (edgeCase) {
    ordered.push({ step: 1, year: edgeCase.year, reason: "metadata/date edge-case test before broad processing", count: edgeCase.count });
  }
  for (const entry of small) {
    if (!ordered.some((item) => item.year === entry.year)) {
      ordered.push({ step: ordered.length + 1, year: entry.year, reason: "small validation batch", count: entry.count });
    }
  }
  for (const entry of medium) {
    if (!ordered.some((item) => item.year === entry.year)) {
      ordered.push({ step: ordered.length + 1, year: entry.year, reason: "medium batch after small-year validation", count: entry.count });
    }
  }
  for (const entry of large) {
    if (!ordered.some((item) => item.year === entry.year)) {
      ordered.push({ step: ordered.length + 1, year: entry.year, reason: "large or irregular batch after process is proven", count: entry.count });
    }
  }
  ordered.push({ step: ordered.length + 1, year: null, reason: "run final complete release audit", count: null });
  ordered.push({ step: ordered.length + 1, year: null, reason: "upload generated media to R2 only after the generated collection is stable", count: null });
  return ordered;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "0 B";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = totalSeconds % 60;
  return `${minutes}m ${remaining}s`;
}

function markdownTable(headers, rows) {
  const header = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map((cell) => String(cell ?? "")).join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

function counterRows(counter, options = {}) {
  const entries = Object.entries(counter).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return entries.slice(0, options.limit || entries.length).map(([key, count]) => [key, count]);
}

function createMarkdown(report) {
  const original = report.archive.summary;
  const duplicates = report.archive.duplicates;
  const forecast = report.forecast;
  const lines = [];
  lines.push("# 640x480 Archive Inventory");
  lines.push("");
  lines.push("## Executive Summary");
  lines.push("");
  lines.push(`- Inventory source: \`${report.archive.root.relativePath}\`.`);
  lines.push(`- Total archive files scanned: ${report.archive.fileCount + report.archive.noiseFiles.length}; candidate bytes: ${formatBytes(report.archive.totalCandidateBytes)}.`);
  lines.push(`- Photographic files: ${original.totalPhotographs}; unique photographic contents: ${duplicates.totalUniquePhotographicContents}.`);
  lines.push(`- Exact duplicate groups: ${duplicates.duplicateGroupCount}; redundant copies: ${duplicates.redundantCopies}; redundant duplicate bytes: ${formatBytes(duplicates.redundantBytes)}.`);
  lines.push(`- Missing reliable EXIF/filename dates: ${original.missingReliableDates}; no usable date even after mtime fallback: ${original.noUsableDate}.`);
  lines.push(`- Folder-year vs EXIF-year disagreements: ${original.folderExifDisagreementCount}.`);
  lines.push(`- Implausible date values observed: ${original.implausibleDateCount}; likely copy-operation mtimes: ${original.likelyCopyMtimeCount}.`);
  lines.push(`- GPS metadata present in source files: ${original.gpsCount}; identifying EXIF field names present in source files: ${original.identifyingExifCount}. These stay private in this report.`);
  lines.push(`- Existing 2001 subset status: ${report.existingSourceComparison["2001"].deletionReadiness}.`);
  lines.push(`- Existing 2013 subset status: ${report.existingSourceComparison["2013"].deletionReadiness}.`);
  lines.push(`- Measured run duration: ${formatDuration(report.timings.durationMs)}. Hashes reused this run: ${report.cache.reusedHashes}; freshly hashed: ${report.cache.freshHashes}.`);
  lines.push("");

  lines.push("## Counts By Year");
  lines.push("");
  lines.push(markdownTable(["Likely folder year", "Photos"], counterRows(original.byLikelyFolderYear)));
  lines.push("");

  lines.push("## Counts By Format");
  lines.push("");
  lines.push(markdownTable(["Format", "Photos"], counterRows(original.byFormat)));
  lines.push("");

  lines.push("## Counts By Orientation");
  lines.push("");
  lines.push(markdownTable(["Orientation", "Photos"], counterRows(original.byOrientation)));
  lines.push("");

  lines.push("## Counts By Date Source");
  lines.push("");
  lines.push(markdownTable(["Best date source", "Photos"], counterRows(original.byDateSource)));
  lines.push("");

  lines.push("## Missing And Unreadable Files");
  lines.push("");
  lines.push(`- Noise files ignored: ${report.archive.noiseFiles.length}.`);
  lines.push(`- Unsupported image-like files: ${report.archive.unsupportedFiles.length}.`);
  lines.push(`- Unreadable files: ${report.archive.unreadableFiles.length}.`);
  lines.push(`- Decode failures among detected photographs: ${original.decodeFailures}.`);
  lines.push("");

  lines.push("## Exact Duplicates");
  lines.push("");
  lines.push(markdownTable(
    ["Count", "Bytes each", "Folder years", "Filenames", "Sample path"],
    duplicates.largestDuplicateGroups.slice(0, 20).map((group) => [
      group.count,
      formatBytes(group.bytesEach),
      group.folderYears.join(", "),
      group.filenames.slice(0, 3).join(", "),
      group.paths[0]
    ])
  ));
  lines.push("");
  lines.push(`- Duplicate groups crossing different folder years: ${duplicates.duplicateGroupsCrossingDifferentFolderYearsCount}.`);
  lines.push(`- Duplicate groups within the same folder: ${duplicates.duplicateGroupsWithinSameFolderCount}.`);
  lines.push(`- Same filename with different content groups: ${duplicates.sameFilenameDifferentContentCount}.`);
  lines.push(`- Different filenames with identical content groups: ${duplicates.differentFilenamesIdenticalContentCount}.`);
  lines.push("");

  lines.push("## Folder And Date Disagreements");
  lines.push("");
  lines.push(markdownTable(
    ["Path", "Folder year", "EXIF year", "EXIF date"],
    original.folderExifDisagreements.slice(0, 25).map((item) => [item.path, item.folderYear, item.exifYear, item.exifCaptureDate])
  ));
  lines.push("");

  for (const year of EXISTING_SOURCE_YEARS) {
    const comparison = report.existingSourceComparison[year];
    lines.push(`## ${year} Comparison`);
    lines.push("");
    lines.push(markdownTable(
      ["Metric", "Value"],
      [
        ["Existing year photographs", comparison.existingYearPhotographs],
        ["Exact matches in original-photos", comparison.exactMatchesInOriginalPhotos],
        ["Without exact match", comparison.withoutExactMatch],
        ["With multiple exact matches", comparison.withMultipleExactMatches],
        ["Matched bytes", formatBytes(comparison.bytesRepresentedByMatchedFiles)],
        ["Complete byte-identical subset", comparison.completeByteIdenticalSubsetOfOriginalPhotos],
        ["Deletion readiness", comparison.deletionReadiness]
      ]
    ));
    lines.push("");
  }

  lines.push("## Import-Size Forecast");
  lines.push("");
  lines.push(markdownTable(
    ["Scenario", "Final photos", "Objects", "Generated media", "Low", "High", "Public manifest", "Free-space headroom"],
    [
      [
        "Preserve every physical photograph",
        forecast.preservingEveryPhysicalPhotograph.finalPhotoCount,
        forecast.preservingEveryPhysicalPhotograph.expectedGeneratedObjectCount,
        formatBytes(forecast.preservingEveryPhysicalPhotograph.estimatedGeneratedMediaBytes),
        formatBytes(forecast.preservingEveryPhysicalPhotograph.estimatedGeneratedMediaSizeLowBytes),
        formatBytes(forecast.preservingEveryPhysicalPhotograph.estimatedGeneratedMediaSizeHighBytes),
        formatBytes(forecast.preservingEveryPhysicalPhotograph.estimatedPublicManifestBytes),
        formatBytes(forecast.preservingEveryPhysicalPhotograph.requiredLocalFreeSpaceHeadroomBytes)
      ],
      [
        "Exclude byte-identical duplicate copies",
        forecast.excludingOnlyByteIdenticalDuplicateCopies.finalPhotoCount,
        forecast.excludingOnlyByteIdenticalDuplicateCopies.expectedGeneratedObjectCount,
        formatBytes(forecast.excludingOnlyByteIdenticalDuplicateCopies.estimatedGeneratedMediaBytes),
        formatBytes(forecast.excludingOnlyByteIdenticalDuplicateCopies.estimatedGeneratedMediaSizeLowBytes),
        formatBytes(forecast.excludingOnlyByteIdenticalDuplicateCopies.estimatedGeneratedMediaSizeHighBytes),
        formatBytes(forecast.excludingOnlyByteIdenticalDuplicateCopies.estimatedPublicManifestBytes),
        formatBytes(forecast.excludingOnlyByteIdenticalDuplicateCopies.requiredLocalFreeSpaceHeadroomBytes)
      ]
    ]
  ));
  lines.push("");

  lines.push("## Catalogue Architecture");
  lines.push("");
  lines.push(`- Top-level catalogue summary-only: ${report.catalogueArchitecture.topLevelCatalogueSummaryOnly}.`);
  lines.push(`- Years load on demand: ${report.catalogueArchitecture.yearsLoadOnDemand}.`);
  lines.push(`- Album manifests are separate files: ${report.catalogueArchitecture.albumsStoredAsSeparateManifests}.`);
  lines.push(`- Current app loads all selected-year album manifests immediately: ${report.catalogueArchitecture.currentAppLoadsAllAlbumManifestsForSelectedYearImmediately}.`);
  lines.push(`- Projected largest album JSON: ${formatBytes(report.catalogueArchitecture.projectedLargestAlbumJsonRequestBytes)}.`);
  lines.push(`- Projected largest selected-year JSON if all album manifests load immediately: ${formatBytes(report.catalogueArchitecture.projectedLargestYearJsonBytesIfAllAlbumManifestsLoadAtYearSelection)}.`);
  lines.push(`- Projected original-archive album folders: ${report.forecast.projectedOriginalAlbumCount}; total expected albums including current app data: ${report.forecast.expectedAlbumCount}.`);
  for (const recommendation of report.catalogueArchitecture.recommendations) {
    lines.push(`- ${recommendation}`);
  }
  lines.push("");

  lines.push("## Recommended Processing Batches");
  lines.push("");
  lines.push(markdownTable(
    ["Step", "Year", "Photos", "Reason"],
    report.recommendedProcessingOrder.map((item) => [item.step, item.year || "", item.count ?? "", item.reason])
  ));
  lines.push("");

  lines.push("## Source Immutability");
  lines.push("");
  lines.push(markdownTable(
    ["Root", "Photographic changes after scan", "Noise files"],
    report.sourceIntegrity.map((item) => [item.root, item.changedPhotographicFiles, item.noiseFiles])
  ));
  lines.push("");

  return lines.join("\n");
}

function cacheStats(scans) {
  let reusedHashes = 0;
  let freshHashes = 0;
  for (const scan of scans) {
    for (const photo of scan.photos) {
      if (photo.hashSource === "cache") {
        reusedHashes += 1;
      } else if (photo.hashSource === "fresh") {
        freshHashes += 1;
      }
    }
  }
  return { reusedHashes, freshHashes };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(args.source);
  ensureSafeRoot(sourceRoot);

  if (!(await pathExists(sourceRoot))) {
    throw new Error(`Source root does not exist: ${repoRelative(sourceRoot)}`);
  }

  await fs.mkdir(REPORT_ROOT, { recursive: true });
  await fs.mkdir(CACHE_ROOT, { recursive: true });
  const cache = await loadCache();
  const startedAt = Date.now();

  const archiveScan = await scanRoot("original-photos", sourceRoot, cache, args);
  const existingScans = [];
  for (const year of EXISTING_SOURCE_YEARS) {
    const root = path.join(ARCHIVE_ROOT, year);
    if (await pathExists(root)) {
      existingScans.push(await scanRoot(year, root, cache, args));
    }
  }
  await saveCache(cache);

  const allScans = [archiveScan, ...existingScans];
  const originalSummary = summarizePhotos(archiveScan.photos);
  const originalDuplicates = duplicateAnalysis(archiveScan.photos);
  const existingSourceComparison = Object.fromEntries(
    existingScans.map((scan) => [scan.root.label, compareExistingYear(scan.root.label, scan.photos, archiveScan.photos)])
  );
  const mediaStats = await generatedMediaStats();
  const dataStats = await publicDataStats();
  const forecast = forecastImport(archiveScan.photos, existingScans, originalDuplicates, mediaStats, dataStats);
  const catalogue = architectureAssessment(originalSummary, forecast, dataStats);
  const processingOrder = recommendedProcessingOrder(originalSummary);
  const cacheSummary = cacheStats(allScans);

  const report = {
    generatedAt: new Date().toISOString(),
    command: {
      source: repoRelative(sourceRoot),
      concurrency: args.concurrency,
      noCache: args.noCache
    },
    timings: {
      durationMs: Date.now() - startedAt,
      archiveScanMs: archiveScan.durationMs,
      existingSourceScanMs: Object.fromEntries(existingScans.map((scan) => [scan.root.label, scan.durationMs]))
    },
    cache: cacheSummary,
    archive: {
      root: archiveScan.root,
      fileCount: archiveScan.fileCount,
      directoryCount: archiveScan.directoryCount,
      totalCandidateBytes: archiveScan.totalCandidateBytes,
      totalPhotographBytes: originalSummary.totalBytes,
      beforeFingerprint: archiveScan.beforeFingerprint,
      afterFingerprint: archiveScan.afterFingerprint,
      photographicBeforeFingerprint: archiveScan.photographicBeforeFingerprint,
      photographicAfterFingerprint: archiveScan.photographicAfterFingerprint,
      changedPhotographicFiles: archiveScan.changedPhotographicFiles,
      noiseFiles: archiveScan.noiseFiles,
      symlinks: archiveScan.symlinks,
      nonRegularEntries: archiveScan.nonRegularEntries,
      unreadableEntries: archiveScan.unreadableEntries,
      nonPhotoFiles: archiveScan.nonPhotoFiles,
      unsupportedFiles: archiveScan.unsupportedFiles,
      unreadableFiles: archiveScan.unreadableFiles,
      summary: originalSummary,
      duplicates: originalDuplicates,
      photos: archiveScan.photos
    },
    existingSourceComparison,
    existingSourceScans: Object.fromEntries(
      existingScans.map((scan) => [
        scan.root.label,
        {
          root: scan.root,
          fileCount: scan.fileCount,
          directoryCount: scan.directoryCount,
          totalCandidateBytes: scan.totalCandidateBytes,
          totalPhotographBytes: summarizePhotos(scan.photos).totalBytes,
          beforeFingerprint: scan.beforeFingerprint,
          afterFingerprint: scan.afterFingerprint,
          photographicBeforeFingerprint: scan.photographicBeforeFingerprint,
          photographicAfterFingerprint: scan.photographicAfterFingerprint,
          changedPhotographicFiles: scan.changedPhotographicFiles,
          noiseFiles: scan.noiseFiles,
          symlinks: scan.symlinks,
          nonRegularEntries: scan.nonRegularEntries,
          unreadableEntries: scan.unreadableEntries,
          nonPhotoFiles: scan.nonPhotoFiles,
          unsupportedFiles: scan.unsupportedFiles,
          unreadableFiles: scan.unreadableFiles,
          summary: summarizePhotos(scan.photos)
        }
      ])
    ),
    generatedMediaReference: mediaStats,
    publicDataReference: dataStats,
    forecast,
    catalogueArchitecture: catalogue,
    recommendedProcessingOrder: processingOrder,
    sourceIntegrity: allScans.map((scan) => ({
      root: scan.root.relativePath,
      changedPhotographicFiles: scan.changedPhotographicFiles.length,
      noiseFiles: scan.noiseFiles.length,
      symlinks: scan.symlinks.length
    })),
    notes: [
      "This is a private inventory report. Do not copy source paths, filenames, EXIF, GPS, or identifying metadata into browser-accessible manifests.",
      "Exact SHA-256 matches are byte-identical duplicates. Visually similar sequence frames are intentionally not treated as duplicates."
    ]
  };

  await fs.writeFile(JSON_REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  await fs.writeFile(MD_REPORT_PATH, createMarkdown(report) + "\n");

  process.stdout.write(
    [
      "Archive inventory complete.",
      `Photographs ${originalSummary.totalPhotographs}.`,
      `Unique ${originalDuplicates.totalUniquePhotographicContents}.`,
      `Duplicate groups ${originalDuplicates.duplicateGroupCount}.`,
      `Redundant copies ${originalDuplicates.redundantCopies}.`,
      `Fresh hashes ${cacheSummary.freshHashes}.`,
      `Reused hashes ${cacheSummary.reusedHashes}.`,
      `Duration ${formatDuration(report.timings.durationMs)}.`,
      `Reports ${repoRelative(JSON_REPORT_PATH)} and ${repoRelative(MD_REPORT_PATH)}.`
    ].join(" ") + "\n"
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
