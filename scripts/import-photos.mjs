import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import exifr from "exifr";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff", ".heic", ".heif"]);
const DEFAULT_CONCURRENCY = 6;
const THUMB_WIDTH = 300;
const DISPLAY_MAX_WIDTH = 640;
const DISPLAY_MAX_HEIGHT = 480;
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_ROOT, "..");
const PHOTO_SOURCE_ROOT = path.resolve(APP_ROOT, "..");
const ORIGINAL_PHOTOS_ROOT = path.join(PHOTO_SOURCE_ROOT, "original-photos");
const GENERATED_MEDIA_ROOT = path.join(PHOTO_SOURCE_ROOT, "generated", "library");
const GENERATED_REPORTS_ROOT = path.join(PHOTO_SOURCE_ROOT, "generated", "reports");
const STANDALONE_SOURCE_YEARS = new Set(["2001", "2013"]);
const NOISE_FILENAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function parseArgs(argv) {
  const args = {
    source: null,
    year: null,
    limit: null,
    output: "public",
    concurrency: DEFAULT_CONCURRENCY,
    force: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--force") {
      args.force = true;
      continue;
    }

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    index += 1;
    if (key === "source") {
      args.source = value;
    } else if (key === "year") {
      args.year = value;
    } else if (key === "limit") {
      args.limit = Number(value);
    } else if (key === "output") {
      args.output = value;
    } else if (key === "concurrency") {
      args.concurrency = Number(value);
    } else {
      throw new Error(`Unknown option --${key}`);
    }
  }

  if (!args.year || !/^\d{4}$/.test(args.year)) {
    throw new Error("Provide a valid four-digit --year, for example: npm run import:year -- --year 2001");
  }

  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }

  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }

  return args;
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function isInsideOrEqual(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function stableId(year, relativePath) {
  const digest = crypto.createHash("sha1").update(toPosixPath(relativePath)).digest("hex").slice(0, 14);
  return `${year}-${digest}`;
}

function albumId(albumPath) {
  const normalized = toPosixPath(albumPath).replace(/^\.\//, "");
  const slug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const digest = crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 8);
  return `${slug || "root"}-${digest}`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isNoiseFile(filename) {
  return NOISE_FILENAMES.has(filename) || filename.startsWith("._");
}

function leadingYear(value) {
  const match = String(value || "").match(/^(19|20)\d{2}/);
  return match ? match[0] : null;
}

function resolveMaybeRelative(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(APP_ROOT, value);
}

async function scanFiles(sourceScope) {
  const results = [];
  const skippedNoiseFiles = [];
  const skippedSymlinks = [];

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = toPosixPath(path.relative(sourceScope.sourceRoot, absolutePath));
      const stat = await fs.lstat(absolutePath);

      if (isNoiseFile(entry.name)) {
        skippedNoiseFiles.push({ relativePath, bytes: stat.size });
        continue;
      }

      if (stat.isSymbolicLink()) {
        let target = null;
        let escapesRoot = true;
        try {
          target = await fs.realpath(absolutePath);
          escapesRoot = !isInsideOrEqual(target, sourceScope.sourceRoot);
        } catch {
          target = null;
        }
        skippedSymlinks.push({
          relativePath,
          target: target ? toPosixPath(path.relative(PHOTO_SOURCE_ROOT, target)) : null,
          escapesRoot
        });
        continue;
      }

      if (stat.isDirectory()) {
        await walk(absolutePath);
      } else if (stat.isFile()) {
        results.push(absolutePath);
      }
    }
  }

  for (const scanRoot of sourceScope.scanRoots) {
    await walk(scanRoot);
  }

  results.sort((left, right) => {
    const leftPath = toPosixPath(path.relative(sourceScope.sourceRoot, left));
    const rightPath = toPosixPath(path.relative(sourceScope.sourceRoot, right));
    return leftPath.localeCompare(rightPath, undefined, { numeric: true });
  });

  return {
    files: results,
    skippedNoiseFiles,
    skippedSymlinks
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function exifDateToDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

async function readExifDate(filePath) {
  try {
    const data = await exifr.parse(filePath, {
      pick: ["DateTimeOriginal", "CreateDate", "ModifyDate", "DateTime"],
      translateValues: false,
      reviveValues: true
    });

    if (!data) {
      return null;
    }

    const entries = [
      ["DateTimeOriginal", data.DateTimeOriginal],
      ["CreateDate", data.CreateDate],
      ["ModifyDate", data.ModifyDate],
      ["DateTime", data.DateTime]
    ];

    for (const [field, value] of entries) {
      const date = exifDateToDate(value);
      if (date) {
        return { date, field };
      }
    }
  } catch {
    return null;
  }

  return null;
}

function inferDateFromFilename(filename, year) {
  const escapedYear = year.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const yearFirst = new RegExp(`(?:^|[^0-9])(${escapedYear})[-_. ]?([01][0-9])[-_. ]?([0-3][0-9])(?:[-_. ]?([0-2][0-9])[-_. ]?([0-5][0-9])[-_. ]?([0-5][0-9]))?(?:[^0-9]|$)`);
  const match = filename.match(yearFirst);
  if (!match) {
    return null;
  }

  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const hour = match[4] ? Number(match[4]) : 0;
  const minute = match[5] ? Number(match[5]) : 0;
  const second = match[6] ? Number(match[6]) : 0;
  if (hour > 23) {
    return null;
  }

  const date = new Date(Date.UTC(Number(year), month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }

  return date;
}

function yearForDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.getFullYear() : null;
}

function isConsistentWithFolderYear(date, year) {
  return yearForDate(date) === Number(year);
}

function dateDetails(date) {
  return date
    ? {
        value: date.toISOString(),
        year: yearForDate(date)
      }
    : null;
}

function displayDimensions(metadata) {
  const rawWidth = metadata.width || 0;
  const rawHeight = metadata.height || 0;
  const exifOrientation = metadata.orientation || 1;
  const shouldSwap = exifOrientation >= 5 && exifOrientation <= 8;
  const width = shouldSwap ? rawHeight : rawWidth;
  const height = shouldSwap ? rawWidth : rawHeight;
  return { width, height };
}

function resizedToWidth(width, height, maxWidth) {
  const scale = Math.min(1, maxWidth / width);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

function resizedInside(width, height, maxWidth, maxHeight) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

function orientationFor(width, height) {
  if (width === height) {
    return "square";
  }

  return width > height ? "landscape" : "portrait";
}

function chooseDate({ exifDate, filenameDate, mtimeDate, relativePath, year }) {
  const yearNumber = Number(year);
  const offYearExif =
    exifDate && exifDate.date.getFullYear() !== yearNumber
      ? {
          value: exifDate.date.toISOString(),
          field: exifDate.field
        }
      : null;

  if (exifDate && exifDate.date.getFullYear() === yearNumber) {
    return {
      captureTime: exifDate.date.toISOString(),
      captureMs: exifDate.date.getTime(),
      sortMs: exifDate.date.getTime(),
      dateSource: "exif",
      sortSource: "exif",
      sortReason: `EXIF ${exifDate.field} matches ${year}`,
      reliableCaptureTime: exifDate.date.toISOString(),
      offYearExif
    };
  }

  if (filenameDate) {
    return {
      captureTime: filenameDate.toISOString(),
      captureMs: filenameDate.getTime(),
      sortMs: filenameDate.getTime(),
      dateSource: "filename",
      sortSource: "filename",
      sortReason: `Filename date matches ${year}`,
      reliableCaptureTime: filenameDate.toISOString(),
      offYearExif
    };
  }

  if (mtimeDate) {
    return {
      captureTime: mtimeDate.toISOString(),
      captureMs: mtimeDate.getTime(),
      sortMs: mtimeDate.getTime(),
      dateSource: "mtime",
      sortSource: "mtime",
      sortReason: "Falling back to file modification time",
      reliableCaptureTime: null,
      offYearExif
    };
  }

  return {
    captureTime: null,
    captureMs: Number.POSITIVE_INFINITY,
    sortMs: Number.POSITIVE_INFINITY,
    dateSource: "path",
    sortSource: "path",
    sortReason: "No usable date; using natural source-relative path order",
    reliableCaptureTime: null,
    offYearExif,
    pathSortKey: relativePath
  };
}

function chooseArchiveDate({ exifDate, filenameDate, mtimeDate, relativePath, year }) {
  const offYearExif =
    exifDate && !isConsistentWithFolderYear(exifDate.date, year)
      ? {
          value: exifDate.date.toISOString(),
          field: exifDate.field,
          year: yearForDate(exifDate.date),
          reason: `Ignored because source folder year ${year} is authoritative`
        }
      : null;
  const rejectedDates = [];

  if (exifDate && isConsistentWithFolderYear(exifDate.date, year)) {
    return {
      captureTime: exifDate.date.toISOString(),
      captureMs: exifDate.date.getTime(),
      sortMs: exifDate.date.getTime(),
      dateSource: "exif",
      sortSource: "exif",
      sortReason: `EXIF ${exifDate.field} matches authoritative folder year ${year}`,
      reliableCaptureTime: exifDate.date.toISOString(),
      offYearExif,
      rejectedDates
    };
  }

  if (exifDate) {
    rejectedDates.push({
      source: `exif:${exifDate.field}`,
      ...dateDetails(exifDate.date),
      reason: `Year does not match authoritative folder year ${year}`
    });
  }

  if (filenameDate && isConsistentWithFolderYear(filenameDate, year)) {
    return {
      captureTime: filenameDate.toISOString(),
      captureMs: filenameDate.getTime(),
      sortMs: filenameDate.getTime(),
      dateSource: "filename",
      sortSource: "filename",
      sortReason: `Filename date matches authoritative folder year ${year}`,
      reliableCaptureTime: filenameDate.toISOString(),
      offYearExif,
      rejectedDates
    };
  }

  if (filenameDate) {
    rejectedDates.push({
      source: "filename",
      ...dateDetails(filenameDate),
      reason: `Year does not match authoritative folder year ${year}`
    });
  }

  const mtimeLooksCaptureLike = mtimeDate && isConsistentWithFolderYear(mtimeDate, year);
  if (mtimeDate && !mtimeLooksCaptureLike) {
    rejectedDates.push({
      source: "mtime",
      ...dateDetails(mtimeDate),
      reason: `Modification year does not match authoritative folder year ${year}; likely copy-operation timestamp`
    });
  }

  return {
    captureTime: mtimeLooksCaptureLike ? mtimeDate.toISOString() : null,
    captureMs: Number.POSITIVE_INFINITY,
    sortMs: Number.POSITIVE_INFINITY,
    dateSource: mtimeLooksCaptureLike ? "mtime-candidate" : "path",
    sortSource: "path",
    sortReason: mtimeLooksCaptureLike
      ? "Modification time matched the folder year, but natural source-relative path order has priority for sequence coherence"
      : "No folder-consistent EXIF or filename date; using natural source-relative path order",
    reliableCaptureTime: null,
    offYearExif,
    rejectedDates,
    pathSortKey: relativePath
  };
}

function comparePhotos(left, right) {
  const leftTime = typeof left.sortMs === "number" ? left.sortMs : typeof left.captureMs === "number" ? left.captureMs : left.sortPosition ?? Number.POSITIVE_INFINITY;
  const rightTime = typeof right.sortMs === "number" ? right.sortMs : typeof right.captureMs === "number" ? right.captureMs : right.sortPosition ?? Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftPath = left.relativePath || `${left.album || ""}/${left.filename || left.id || ""}`;
  const rightPath = right.relativePath || `${right.album || ""}/${right.filename || right.id || ""}`;
  return leftPath.localeCompare(rightPath, undefined, { numeric: true });
}

async function inspectPhoto(filePath, sourceScope, year) {
  const relativePath = toPosixPath(path.relative(sourceScope.sourceRoot, filePath));
  const stat = await fs.stat(filePath);
  const metadata = await sharp(filePath, { failOn: "none", limitInputPixels: false }).metadata();
  const { width: visualWidth, height: visualHeight } = displayDimensions(metadata);

  if (!visualWidth || !visualHeight) {
    throw new Error("Could not read image dimensions");
  }

  const exifDate = await readExifDate(filePath);
  const filenameDate = inferDateFromFilename(path.basename(filePath), year);
  const mtimeDate = stat.mtime instanceof Date && !Number.isNaN(stat.mtime.getTime()) ? stat.mtime : null;
  const chosenDate =
    sourceScope.mode === "original-archive-year"
      ? chooseArchiveDate({ exifDate, filenameDate, mtimeDate, relativePath, year })
      : chooseDate({ exifDate, filenameDate, mtimeDate, relativePath, year });
  const albumPath = toPosixPath(path.dirname(relativePath));
  const album = albumPath === "." ? year : albumPath;
  const rawWidth = metadata.width || 0;
  const rawHeight = metadata.height || 0;
  const rawOrientation = orientationFor(rawWidth, rawHeight);
  const visualOrientation = orientationFor(visualWidth, visualHeight);

  return {
    absolutePath: filePath,
    relativePath,
    id: stableId(year, relativePath),
    filename: path.basename(filePath),
    album,
    albumId: albumId(album),
    captureTime: chosenDate.captureTime,
    captureMs: chosenDate.captureMs,
    sortMs: chosenDate.sortMs,
    reliableCaptureTime: chosenDate.reliableCaptureTime,
    dateSource: chosenDate.dateSource,
    sortSource: chosenDate.sortSource,
    sortReason: chosenDate.sortReason,
    offYearExif: chosenDate.offYearExif,
    rejectedDates: chosenDate.rejectedDates || [],
    sourceMtimeMs: stat.mtimeMs,
    sourceSize: stat.size,
    rawWidth,
    rawHeight,
    rawOrientation,
    sourceWidth: visualWidth,
    sourceHeight: visualHeight,
    exifOrientation: metadata.orientation || 1,
    orientation: visualOrientation
  };
}

function groupByAlbum(photos) {
  const groups = new Map();
  for (const photo of photos) {
    if (!groups.has(photo.albumId)) {
      groups.set(photo.albumId, {
        id: photo.albumId,
        name: photo.album,
        items: []
      });
    }

    groups.get(photo.albumId).items.push(photo);
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      items: group.items.sort(comparePhotos)
    }))
    .sort((left, right) => {
      const leftTime = typeof left.items[0]?.captureMs === "number" ? left.items[0].captureMs : Number.POSITIVE_INFINITY;
      const rightTime = typeof right.items[0]?.captureMs === "number" ? right.items[0].captureMs : Number.POSITIVE_INFINITY;
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }

      return left.name.localeCompare(right.name, undefined, { numeric: true });
    });
}

function allocateQuotas(groups, limit) {
  const quotas = new Map(groups.map((group) => [group.id, 0]));
  let remaining = Math.min(
    limit,
    groups.reduce((sum, group) => sum + group.items.length, 0)
  );

  while (remaining > 0) {
    let assignedThisPass = 0;

    for (const group of groups) {
      if (remaining <= 0) {
        break;
      }

      const current = quotas.get(group.id) || 0;
      if (current >= group.items.length) {
        continue;
      }

      quotas.set(group.id, current + 1);
      remaining -= 1;
      assignedThisPass += 1;
    }

    if (assignedThisPass === 0) {
      break;
    }
  }

  return quotas;
}

function selectEvenlySpaced(items, count) {
  if (count >= items.length) {
    return items;
  }

  if (count === 1) {
    return [items[Math.floor((items.length - 1) / 2)]];
  }

  const selected = [];
  const usedIndexes = new Set();

  for (let index = 0; index < count; index += 1) {
    const idealIndex = Math.round((index * (items.length - 1)) / (count - 1));
    let selectedIndex = idealIndex;

    while (usedIndexes.has(selectedIndex) && selectedIndex < items.length - 1) {
      selectedIndex += 1;
    }

    while (usedIndexes.has(selectedIndex) && selectedIndex > 0) {
      selectedIndex -= 1;
    }

    usedIndexes.add(selectedIndex);
    selected.push(items[selectedIndex]);
  }

  return selected.sort(comparePhotos);
}

function selectDistributedSample(photos, limit) {
  const groups = groupByAlbum(photos);
  const quotas = allocateQuotas(groups, limit);
  const selected = [];

  for (const group of groups) {
    const quota = quotas.get(group.id) || 0;
    selected.push(...selectEvenlySpaced(group.items, quota));
  }

  return selected.sort(comparePhotos).slice(0, limit);
}

async function assetMetadata(assetPath) {
  const metadata = await sharp(assetPath, { failOn: "none", limitInputPixels: false }).metadata();
  return {
    width: metadata.width || 0,
    height: metadata.height || 0
  };
}

async function shouldReuseAsset(assetPath, sourceMtimeMs, expectedDimensions) {
  try {
    const stat = await fs.stat(assetPath);
    if (stat.size <= 0 || stat.mtimeMs < sourceMtimeMs) {
      return false;
    }

    const dimensions = await assetMetadata(assetPath);
    return Math.abs(dimensions.width - expectedDimensions.width) <= 1 && Math.abs(dimensions.height - expectedDimensions.height) <= 1;
  } catch {
    return false;
  }
}

async function writePhotoAsset(photo, mediaRoot, year, force) {
  const thumbnailKey = `${year}/thumbs/${photo.id}.jpg`;
  const displayKey = `${year}/display/${photo.id}.jpg`;
  const thumbnailPath = path.join(mediaRoot, thumbnailKey);
  const displayPath = path.join(mediaRoot, displayKey);
  const expectedThumbnail = resizedToWidth(photo.sourceWidth, photo.sourceHeight, THUMB_WIDTH);
  const expectedDisplay = resizedInside(photo.sourceWidth, photo.sourceHeight, DISPLAY_MAX_WIDTH, DISPLAY_MAX_HEIGHT);

  await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
  await fs.mkdir(path.dirname(displayPath), { recursive: true });

  const thumbnailReusable = !force && (await shouldReuseAsset(thumbnailPath, photo.sourceMtimeMs, expectedThumbnail));
  const displayReusable = !force && (await shouldReuseAsset(displayPath, photo.sourceMtimeMs, expectedDisplay));
  let generatedAssets = 0;
  let reusedAssets = 0;

  if (thumbnailReusable) {
    reusedAssets += 1;
  } else {
    await sharp(photo.absolutePath, { failOn: "none", limitInputPixels: false })
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 76, mozjpeg: true })
      .toFile(thumbnailPath);
    generatedAssets += 1;
  }

  if (displayReusable) {
    reusedAssets += 1;
  } else {
    await sharp(photo.absolutePath, { failOn: "none", limitInputPixels: false })
      .rotate()
      .resize({ width: DISPLAY_MAX_WIDTH, height: DISPLAY_MAX_HEIGHT, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 84, mozjpeg: true })
      .toFile(displayPath);
    generatedAssets += 1;
  }

  const thumbnailDimensions = await assetMetadata(thumbnailPath);
  const displayDimensions = await assetMetadata(displayPath);

  return {
    thumbnailKey,
    thumbnailWidth: thumbnailDimensions.width,
    thumbnailHeight: thumbnailDimensions.height,
    displayKey,
    displayWidth: displayDimensions.width,
    displayHeight: displayDimensions.height,
    generatedAssets,
    reusedAssets
  };
}

function photoToClientPhoto(photo, assets, sortPosition, albumSortPosition) {
  return {
    id: photo.id,
    thumbnailKey: assets.thumbnailKey,
    displayKey: assets.displayKey,
    albumId: photo.albumId,
    width: assets.displayWidth,
    height: assets.displayHeight,
    orientation: orientationFor(assets.displayWidth, assets.displayHeight),
    sortPosition,
    albumSortPosition
  };
}

async function listGeneratedAssets(directory) {
  const assets = [];

  async function walk(currentDirectory) {
    if (!(await exists(currentDirectory))) {
      return;
    }

    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        assets.push(absolutePath);
      }
    }
  }

  await walk(directory);
  return assets;
}

async function findStaleGeneratedAssets(mediaOutputRoot, year, expectedAssetKeys) {
  const yearMediaRoot = path.join(mediaOutputRoot, year);
  if (!isInside(yearMediaRoot, mediaOutputRoot)) {
    throw new Error("Generated media root is outside the app-owned media folder");
  }

  const assets = await listGeneratedAssets(yearMediaRoot);
  return assets
    .map((assetPath) => toPosixPath(path.relative(mediaOutputRoot, assetPath)))
    .filter((assetKey) => !expectedAssetKeys.has(assetKey))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function summarizeDates(photos, reliableOnly) {
  const values = photos
    .filter((photo) => (reliableOnly ? Boolean(photo.reliableCaptureTime) : Boolean(photo.captureTime)))
    .map((photo) => ({
      time: new Date(reliableOnly ? photo.reliableCaptureTime : photo.captureTime).getTime(),
      source: photo.dateSource,
      value: reliableOnly ? photo.reliableCaptureTime : photo.captureTime
    }))
    .filter((entry) => !Number.isNaN(entry.time))
    .sort((left, right) => left.time - right.time);

  return {
    earliest: values[0]?.value || null,
    latest: values.at(-1)?.value || null,
    sources: Array.from(new Set(values.map((entry) => entry.source))).sort()
  };
}

function summarizeOrientation(photos) {
  const summary = {
    raw: {},
    visual: {},
    exifOrientation: {},
    rawVisualMismatch: 0,
    exifRotated: 0,
    examples: []
  };

  for (const photo of photos) {
    summary.raw[photo.rawOrientation] = (summary.raw[photo.rawOrientation] || 0) + 1;
    summary.visual[photo.orientation] = (summary.visual[photo.orientation] || 0) + 1;
    summary.exifOrientation[String(photo.exifOrientation)] = (summary.exifOrientation[String(photo.exifOrientation)] || 0) + 1;
    if (photo.rawOrientation !== photo.orientation) {
      summary.rawVisualMismatch += 1;
    }
    if (photo.exifOrientation !== 1) {
      summary.exifRotated += 1;
    }
    if ((photo.rawOrientation !== photo.orientation || photo.orientation === "portrait" || photo.exifOrientation !== 1) && summary.examples.length < 25) {
      summary.examples.push({
        relativePath: photo.relativePath,
        raw: [photo.rawWidth, photo.rawHeight],
        exifOrientation: photo.exifOrientation,
        visual: [photo.sourceWidth, photo.sourceHeight],
        visualOrientation: photo.orientation
      });
    }
  }

  return summary;
}

function summarizeDateSources(photos) {
  const counts = {};
  let offYearExifCount = 0;
  const offYearExifSamples = [];

  for (const photo of photos) {
    counts[photo.dateSource] = (counts[photo.dateSource] || 0) + 1;
    if (photo.offYearExif) {
      offYearExifCount += 1;
      if (offYearExifSamples.length < 25) {
        offYearExifSamples.push({
          relativePath: photo.relativePath,
          exifTime: photo.offYearExif.value,
          exifField: photo.offYearExif.field,
          chosenSource: photo.dateSource,
          chosenTime: photo.captureTime
        });
      }
    }
  }

  return {
    counts,
    offYearExifCount,
    offYearExifSamples
  };
}

async function readExistingCatalog(catalogPath) {
  try {
    return JSON.parse(await fs.readFile(catalogPath, "utf8"));
  } catch {
    return { generatedAt: null, years: [] };
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function publicUrlForYear(year) {
  return `data/${year}/index.json`;
}

async function resolveSourceScope(args) {
  if (args.source) {
    const sourceRoot = resolveMaybeRelative(args.source);
    if (!isInsideOrEqual(sourceRoot, PHOTO_SOURCE_ROOT)) {
      throw new Error("Source folder must be inside the 640 archive workspace");
    }
    if (isInsideOrEqual(sourceRoot, APP_ROOT)) {
      throw new Error("Source folder must not be inside the app workspace");
    }
    if (sourceRoot === PHOTO_SOURCE_ROOT || sourceRoot === ORIGINAL_PHOTOS_ROOT) {
      throw new Error("Use the default year resolver instead of scanning the entire archive root");
    }
    if (path.basename(sourceRoot) !== args.year && leadingYear(path.basename(sourceRoot)) !== args.year) {
      throw new Error(`Source folder must match or start with --year (${args.year})`);
    }

    return {
      mode: isInsideOrEqual(sourceRoot, ORIGINAL_PHOTOS_ROOT) ? "original-archive-year" : "standalone-year",
      sourceRoot: isInsideOrEqual(sourceRoot, ORIGINAL_PHOTOS_ROOT) ? ORIGINAL_PHOTOS_ROOT : sourceRoot,
      scanRoots: [sourceRoot],
      sourceFolders: [isInsideOrEqual(sourceRoot, ORIGINAL_PHOTOS_ROOT) ? toPosixPath(path.relative(ORIGINAL_PHOTOS_ROOT, sourceRoot)) : "."]
    };
  }

  const standaloneRoot = path.join(PHOTO_SOURCE_ROOT, args.year);
  if (STANDALONE_SOURCE_YEARS.has(args.year) && (await exists(standaloneRoot))) {
    return {
      mode: "standalone-year",
      sourceRoot: standaloneRoot,
      scanRoots: [standaloneRoot],
      sourceFolders: ["."]
    };
  }

  if (!(await exists(ORIGINAL_PHOTOS_ROOT))) {
    throw new Error(`Original archive folder does not exist: ${toPosixPath(path.relative(PHOTO_SOURCE_ROOT, ORIGINAL_PHOTOS_ROOT))}`);
  }

  const archiveEntries = await fs.readdir(ORIGINAL_PHOTOS_ROOT, { withFileTypes: true });
  const scanRoots = [];
  for (const entry of archiveEntries) {
    const absolutePath = path.join(ORIGINAL_PHOTOS_ROOT, entry.name);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if ((stat.isDirectory() || stat.isFile()) && leadingYear(entry.name) === args.year) {
      scanRoots.push(absolutePath);
    }
  }
  scanRoots.sort((left, right) =>
    toPosixPath(path.relative(ORIGINAL_PHOTOS_ROOT, left)).localeCompare(toPosixPath(path.relative(ORIGINAL_PHOTOS_ROOT, right)), undefined, { numeric: true })
  );

  if (!scanRoots.length) {
    throw new Error(`No original-photos source folders found for ${args.year}`);
  }

  return {
    mode: "original-archive-year",
    sourceRoot: ORIGINAL_PHOTOS_ROOT,
    scanRoots,
    sourceFolders: scanRoots.map((folder) => toPosixPath(path.relative(ORIGINAL_PHOTOS_ROOT, folder)))
  };
}

function auditAlbumLabel(label) {
  const reasons = [];
  if (/[\\/]/.test(label)) reasons.push("contains path separator");
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(label)) reasons.push("contains email-like text");
  if (/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/.test(label)) reasons.push("contains phone-like text");
  if (/\b(?:street|st\.|road|rd\.|avenue|ave\.|boulevard|blvd\.|drive|dr\.|lane|ln\.|court|ct\.|suite|apt|unit)\b/i.test(label)) {
    reasons.push("contains address-like text");
  }
  if (/^[A-Za-z]:\\|^\/(?:Users|home|Volumes)\//.test(label)) reasons.push("looks like a filesystem path");
  return reasons;
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function entryBytes(entry) {
  return Number.isFinite(entry?.bytes) ? entry.bytes : Number.isFinite(entry?.size) ? entry.size : 0;
}

function sourceScopeContains(sourceScope, relativePath) {
  return sourceScope.sourceFolders.some((folder) => folder === "." || relativePath === folder || relativePath.startsWith(`${folder}/`));
}

async function readArchiveInventory() {
  try {
    const reportPath = path.join(GENERATED_REPORTS_ROOT, "archive-inventory.json");
    return JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch {
    return null;
  }
}

function selectedInventoryFiles(inventory, sourceScope) {
  if (!inventory || sourceScope.mode !== "original-archive-year") {
    return { photos: [], unsupportedFiles: [], nonPhotoFiles: [], unreadableFiles: [], noiseFiles: [] };
  }

  const withinScope = (entry) => {
    const relativePath = entry.sourceRelativePath || entry.file || entry.path || "";
    return sourceScopeContains(sourceScope, relativePath);
  };

  return {
    photos: (inventory.archive?.photos || []).filter(withinScope),
    unsupportedFiles: (inventory.archive?.unsupportedFiles || []).filter(withinScope),
    nonPhotoFiles: (inventory.archive?.nonPhotoFiles || []).filter(withinScope),
    unreadableFiles: (inventory.archive?.unreadableFiles || []).filter(withinScope),
    noiseFiles: (inventory.archive?.noiseFiles || []).filter(withinScope)
  };
}

function duplicateSummaryFromPhotos(photos) {
  const byHash = new Map();
  for (const photo of photos) {
    if (!photo.sha256) {
      continue;
    }
    if (!byHash.has(photo.sha256)) {
      byHash.set(photo.sha256, []);
    }
    byHash.get(photo.sha256).push(photo);
  }

  const groups = Array.from(byHash.values())
    .filter((group) => group.length > 1)
    .sort((left, right) => right.length - left.length || right[0].sourceRelativePath.localeCompare(left[0].sourceRelativePath, undefined, { numeric: true }));

  return {
    duplicateGroupCount: groups.length,
    redundantCopies: groups.reduce((sum, group) => sum + group.length - 1, 0),
    samples: groups.slice(0, 25).map((group) => ({
      count: group.length,
      sha256: group[0].sha256,
      bytesEach: group[0].size,
      paths: group.map((photo) => photo.sourceRelativePath).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    }))
  };
}

function summarizeSourceSelection({ args, sourceScope, scanned, inspectedPhotos, albumSummaries, inventorySelection }) {
  const offYearExif = inspectedPhotos.filter((photo) => photo.offYearExif);
  const rejectedDates = inspectedPhotos.flatMap((photo) => photo.rejectedDates.map((date) => ({ relativePath: photo.relativePath, ...date })));
  const selectedAlbumLabels = albumSummaries.map((album) => ({
    id: album.id,
    name: album.name,
    count: album.count,
    labelFlags: auditAlbumLabel(album.name)
  }));
  const questionableAlbumLabels = selectedAlbumLabels
    .filter((album) => album.labelFlags.length)
    .map((album) => ({ id: album.id, name: album.name, reasons: album.labelFlags }));
  const inventoryDuplicates = duplicateSummaryFromPhotos(inventorySelection.photos);

  return {
    year: args.year,
    sourceMode: sourceScope.mode,
    sourceRoot: toPosixPath(path.relative(PHOTO_SOURCE_ROOT, sourceScope.sourceRoot)),
    sourceFolders: sourceScope.sourceFolders,
    selectionPolicy:
      sourceScope.mode === "original-archive-year"
        ? "Top-level original-photos entries whose names start with the requested year; folder year is authoritative."
        : "Standalone imported-year source folder.",
    proposedAlbums: selectedAlbumLabels,
    questionableAlbumLabels,
    filesScanned: scanned.files.length,
    skippedNoiseFiles: scanned.skippedNoiseFiles,
    skippedSymlinks: scanned.skippedSymlinks,
    photographCount: inspectedPhotos.length,
    totalPhotoBytes: inspectedPhotos.reduce((sum, photo) => sum + photo.sourceSize, 0),
    inventoryPhotographCount: inventorySelection.photos.length,
    inventoryPhotoBytes: inventorySelection.photos.reduce((sum, photo) => sum + entryBytes(photo), 0),
    orientation: countBy(inspectedPhotos, (photo) => photo.orientation),
    dateSources: countBy(inspectedPhotos, (photo) => photo.dateSource),
    sortSources: countBy(inspectedPhotos, (photo) => photo.sortSource),
    validFolderConsistentDates: inspectedPhotos.filter((photo) => photo.dateSource === "exif" || photo.dateSource === "filename").length,
    invalidOrRejectedDateValues: rejectedDates.length,
    rejectedDateSamples: rejectedDates.slice(0, 50),
    offYearExifCount: offYearExif.length,
    offYearExifSamples: offYearExif.slice(0, 50).map((photo) => ({
      relativePath: photo.relativePath,
      exifTime: photo.offYearExif.value,
      exifYear: photo.offYearExif.year,
      chosenSortSource: photo.sortSource,
      reason: photo.offYearExif.reason
    })),
    exactDuplicateGroups: inventoryDuplicates,
    inventoryUnsupportedFiles: inventorySelection.unsupportedFiles,
    inventoryNonPhotoFiles: inventorySelection.nonPhotoFiles,
    inventoryUnreadableFiles: inventorySelection.unreadableFiles,
    inventoryNoiseFiles: inventorySelection.noiseFiles,
    inventoryUnsupportedCount: inventorySelection.unsupportedFiles.length,
    inventoryNonPhotoCount: inventorySelection.nonPhotoFiles.length,
    inventoryUnreadableCount: inventorySelection.unreadableFiles.length,
    inventoryNoiseCount: inventorySelection.noiseFiles.length,
    inventoryNonPhotoBytes: inventorySelection.nonPhotoFiles.reduce((sum, file) => sum + entryBytes(file), 0),
    corruptOrUnreadableFiles: [],
    zeroByteFiles: inventorySelection.unsupportedFiles.filter((file) => entryBytes(file) === 0),
    verifiedAgainstArchiveInventory: Boolean(inventorySelection.photos.length)
  };
}

async function writeSourceSelectionReport(year, sourceSelection) {
  await writeJson(path.join(GENERATED_REPORTS_ROOT, `${year}-source-selection-report.json`), sourceSelection);
}

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const sourceScope = await resolveSourceScope(args);
  const dataOutputRoot = path.resolve(APP_ROOT, args.output);
  const mediaOutputRoot = GENERATED_MEDIA_ROOT;
  const yearDataRoot = path.join(dataOutputRoot, "data", args.year);
  const albumsDataRoot = path.join(yearDataRoot, "albums");
  const importMode = args.limit === null ? "complete" : "sample";

  if (!(await exists(sourceScope.sourceRoot))) {
    throw new Error(`Source folder does not exist: ${toPosixPath(path.relative(PHOTO_SOURCE_ROOT, sourceScope.sourceRoot))}`);
  }

  if (isInsideOrEqual(dataOutputRoot, sourceScope.sourceRoot)) {
    throw new Error("Data output folder must not be inside the read-only source folder");
  }

  if (isInsideOrEqual(mediaOutputRoot, sourceScope.sourceRoot)) {
    throw new Error("Generated media folder must not be inside the read-only source folder");
  }

  const scanned = await scanFiles(sourceScope);
  const scannedFiles = scanned.files;
  const report = {
    generatedAt: new Date().toISOString(),
    year: args.year,
    sourceRootName: path.basename(sourceScope.sourceRoot),
    sourceMode: sourceScope.mode,
    sourceRoot: toPosixPath(path.relative(PHOTO_SOURCE_ROOT, sourceScope.sourceRoot)),
    sourceFolders: sourceScope.sourceFolders,
    mode: importMode,
    limit: args.limit,
    filesScanned: scannedFiles.length,
    skippedNoiseFiles: scanned.skippedNoiseFiles,
    skippedSymlinks: scanned.skippedSymlinks,
    successfullyImported: 0,
    newlyGenerated: 0,
    reusedUnchanged: 0,
    unsupported: 0,
    unreadable: 0,
    duplicate: 0,
    duplicateIdCollision: 0,
    albumsFound: 0,
    totalProcessingTimeMs: 0,
    orientation: null,
    dateSources: null,
    sortSources: null,
    captureDateRange: null,
    sortDateRange: null,
    sourceSelection: null,
    orderingAudit: [],
    staleGeneratedAssets: {
      count: 0,
      samples: []
    },
    unsupportedFiles: [],
    unreadableFiles: [],
    duplicateFiles: []
  };

  let inspectedCount = 0;
  const inspectedResults = await mapWithConcurrency(scannedFiles, args.concurrency, async (filePath) => {
    const relativePath = toPosixPath(path.relative(sourceScope.sourceRoot, filePath));
    const extension = path.extname(filePath).toLowerCase();
    if (extension && !IMAGE_EXTENSIONS.has(extension)) {
      report.unsupported += 1;
      report.unsupportedFiles.push({ relativePath, reason: "Unsupported file extension" });
      return null;
    }

    try {
      const photo = await inspectPhoto(filePath, sourceScope, args.year);
      inspectedCount += 1;
      if (inspectedCount % 500 === 0 || inspectedCount === scannedFiles.length - report.unsupported) {
        process.stdout.write(`Inspected ${inspectedCount}/${scannedFiles.length - report.unsupported}\n`);
      }
      return { photo };
    } catch (error) {
      if (extension) {
        report.unreadable += 1;
        report.unreadableFiles.push({
          relativePath,
          reason: error instanceof Error ? error.message : "Unreadable image"
        });
      } else {
        report.unsupported += 1;
        report.unsupportedFiles.push({
          relativePath,
          reason: error instanceof Error ? `Unsupported extensionless file: ${error.message}` : "Unsupported extensionless file"
        });
      }
      return null;
    }
  });

  const seenIds = new Set();
  const photos = [];
  for (const result of inspectedResults) {
    if (!result?.photo) {
      continue;
    }

    if (seenIds.has(result.photo.id)) {
      report.duplicate += 1;
      report.duplicateIdCollision += 1;
      report.duplicateFiles.push({
        relativePath: result.photo.relativePath,
        id: result.photo.id
      });
      continue;
    }

    seenIds.add(result.photo.id);
    photos.push(result.photo);
  }

  const sortedPhotos = photos.sort(comparePhotos);
  const selectedPhotos = args.limit === null ? sortedPhotos : selectDistributedSample(sortedPhotos, args.limit);
  report.successfullyImported = selectedPhotos.length;

  const preliminaryAlbums = groupByAlbum(selectedPhotos);
  const preliminaryAlbumSummaries = preliminaryAlbums.map((album) => ({
    id: album.id,
    name: album.name,
    count: album.items.length,
    manifestUrl: `data/${args.year}/albums/${album.id}.json`
  }));
  const archiveInventory = await readArchiveInventory();
  const inventorySelection = selectedInventoryFiles(archiveInventory, sourceScope);
  report.sourceSelection = summarizeSourceSelection({
    args,
    sourceScope,
    scanned,
    inspectedPhotos: selectedPhotos,
    albumSummaries: preliminaryAlbumSummaries,
    inventorySelection
  });
  report.sourceSelection.importerUnsupportedFiles = report.unsupportedFiles;
  report.sourceSelection.importerUnreadableFiles = report.unreadableFiles;
  report.sourceSelection.corruptOrUnreadableFiles = report.unreadableFiles;
  report.sourceSelection.zeroByteFiles = [
    ...report.sourceSelection.zeroByteFiles,
    ...report.unreadableFiles.filter((file) => file.bytes === 0)
  ];
  await writeSourceSelectionReport(args.year, report.sourceSelection);

  let processedAssets = 0;
  const assetResults = await mapWithConcurrency(selectedPhotos, args.concurrency, async (photo, index) => {
    const assets = await writePhotoAsset(photo, mediaOutputRoot, args.year, args.force);
    processedAssets += 1;
    if (processedAssets % 250 === 0 || processedAssets === selectedPhotos.length) {
      process.stdout.write(`Assets ${processedAssets}/${selectedPhotos.length}\n`);
    }

    return { photo, assets, index };
  });

  const expectedAssetKeys = new Set();
  const assetMap = new Map();
  for (const { photo, assets } of assetResults) {
    report.newlyGenerated += assets.generatedAssets;
    report.reusedUnchanged += assets.reusedAssets;
    expectedAssetKeys.add(assets.thumbnailKey);
    expectedAssetKeys.add(assets.displayKey);
    assetMap.set(photo.id, assets);
  }

  const albums = groupByAlbum(selectedPhotos);
  report.albumsFound = albums.length;

  const albumSummaries = albums.map((album) => ({
    id: album.id,
    name: album.name,
    count: album.items.length,
    manifestUrl: `data/${args.year}/albums/${album.id}.json`
  }));

  const sequencePhotos = albums
    .flatMap((album) =>
      album.items.map((photo, albumSortPosition) => ({
        photo,
        albumSortPosition
      }))
    )
    .map(({ photo, albumSortPosition }, sortPosition) => ({
      photo,
      clientPhoto: photoToClientPhoto(photo, assetMap.get(photo.id), sortPosition, albumSortPosition)
    }));

  const sequence = sequencePhotos.map(({ clientPhoto }) => ({
    id: clientPhoto.id
  }));
  report.orderingAudit = sequencePhotos.map(({ photo, clientPhoto }) => ({
    id: photo.id,
    relativePath: photo.relativePath,
    albumId: photo.albumId,
    albumName: photo.album,
    sortPosition: clientPhoto.sortPosition,
    albumSortPosition: clientPhoto.albumSortPosition,
    dateSource: photo.dateSource,
    sortSource: photo.sortSource,
    sortReason: photo.sortReason,
    captureTime: photo.captureTime,
    reliableCaptureTime: photo.reliableCaptureTime,
    offYearExif: photo.offYearExif,
    rejectedDates: photo.rejectedDates
  }));

  const photosByAlbum = new Map();
  for (const { clientPhoto } of sequencePhotos) {
    if (!photosByAlbum.has(clientPhoto.albumId)) {
      photosByAlbum.set(clientPhoto.albumId, []);
    }

    photosByAlbum.get(clientPhoto.albumId).push(clientPhoto);
  }

  await fs.mkdir(albumsDataRoot, { recursive: true });
  await Promise.all(
    albumSummaries.map((album) =>
      writeJson(path.join(albumsDataRoot, `${album.id}.json`), {
        photos: (photosByAlbum.get(album.id) || []).sort((left, right) => left.albumSortPosition - right.albumSortPosition)
      })
    )
  );

  report.orientation = summarizeOrientation(selectedPhotos);
  report.dateSources = summarizeDateSources(selectedPhotos);
  report.sortSources = countBy(selectedPhotos, (photo) => photo.sortSource);
  report.captureDateRange = summarizeDates(selectedPhotos, true);
  report.sortDateRange = summarizeDates(selectedPhotos, false);

  const index = {
    year: args.year,
    scannedCount: scannedFiles.length,
    albums: albumSummaries,
    sequence
  };

  const catalogPath = path.join(dataOutputRoot, "data", "catalog.json");
  const existingCatalog = await readExistingCatalog(catalogPath);
  const updatedYear = {
    year: args.year,
    indexUrl: publicUrlForYear(args.year)
  };
  const yearsByYear = new Map();
  for (const year of existingCatalog.years || []) {
    if (year?.year) {
      yearsByYear.set(year.year, year);
    }
  }
  yearsByYear.set(args.year, updatedYear);

  const catalog = {
    years: Array.from(yearsByYear.values()).sort((left, right) => Number(right.year) - Number(left.year))
  };

  const staleAssets = await findStaleGeneratedAssets(mediaOutputRoot, args.year, expectedAssetKeys);
  report.staleGeneratedAssets = {
    count: staleAssets.length,
    samples: staleAssets.slice(0, 25)
  };
  report.totalProcessingTimeMs = Date.now() - startedAt;

  await writeJson(catalogPath, catalog);
  await writeJson(path.join(yearDataRoot, "index.json"), index);
  await writeJson(path.join(GENERATED_REPORTS_ROOT, `${args.year}-import-report.json`), report);
  await fs.rm(path.join(yearDataRoot, "import-report.json"), { force: true });

  process.stdout.write(
    [
      `Done in ${(report.totalProcessingTimeMs / 1000).toFixed(1)}s.`,
      `Scanned ${report.filesScanned}.`,
      `Imported ${report.successfullyImported}.`,
      `Generated ${report.newlyGenerated} assets.`,
      `Reused ${report.reusedUnchanged} assets.`,
      `Unsupported ${report.unsupported}.`,
      `Unreadable ${report.unreadable}.`,
      `Duplicate ${report.duplicate}.`,
      `Albums ${report.albumsFound}.`,
      `Stale generated assets ${report.staleGeneratedAssets.count}.`
    ].join(" ") + "\n"
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
