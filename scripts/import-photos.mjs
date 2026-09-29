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
const STANDALONE_SOURCE_YEARS = new Set(["2001", "2013"]);
const NOISE_FILENAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function workspacePaths(appRoot = APP_ROOT) {
  const root = path.resolve(appRoot);
  return {
    appRoot: root,
    photoSourceRoot: root,
    originalPhotosRoot: path.join(root, "original-photos"),
    canonicalOutputs: {
      data: path.join(root, "public"),
      media: path.join(root, "generated", "library"),
      reports: path.join(root, "generated", "reports"),
      cache: path.join(root, "generated", "inventory-cache"),
      journal: path.join(root, "generated", "journal")
    },
    blockedSourceRoots: [".git", "dist", "generated", "node_modules", "public", "scripts", "src"].map((name) => path.join(root, name))
  };
}

function parseArgs(argv) {
  const args = {
    source: null,
    year: null,
    limit: null,
    output: null,
    dataRoot: null,
    mediaRoot: null,
    reportsRoot: null,
    cacheRoot: null,
    journalRoot: null,
    stagingRoot: null,
    concurrency: DEFAULT_CONCURRENCY,
    force: false,
    plan: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--force" || token === "--plan") {
      args[token.slice(2)] = true;
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
    } else if (key === "data-root") {
      args.dataRoot = value;
    } else if (key === "media-root") {
      args.mediaRoot = value;
    } else if (key === "reports-root") {
      args.reportsRoot = value;
    } else if (key === "cache-root") {
      args.cacheRoot = value;
    } else if (key === "journal-root") {
      args.journalRoot = value;
    } else if (key === "staging-root") {
      args.stagingRoot = value;
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

  if (args.output && args.dataRoot) {
    throw new Error("Use either legacy --output or --data-root, not both");
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

function resolveMaybeRelative(value, appRoot = APP_ROOT) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(appRoot, value);
}

async function physicalPathWithoutCreating(targetPath) {
  const unresolved = [];
  let current = path.resolve(targetPath);

  while (true) {
    try {
      const real = await fs.realpath(current);
      return path.resolve(real, ...unresolved);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      unresolved.unshift(path.basename(current));
      current = parent;
    }
  }
}

function outputRootValues(roots) {
  return ["data", "media", "reports", "cache", "journal"].map((name) => [name, roots[name]]);
}

async function resolveOutputConfiguration(args, workspace) {
  const canonical = {};
  for (const [name, root] of outputRootValues(workspace.canonicalOutputs)) {
    canonical[name] = await physicalPathWithoutCreating(root);
  }

  const stagingRoot = args.stagingRoot ? resolveMaybeRelative(args.stagingRoot, workspace.appRoot) : null;
  const selected = stagingRoot
    ? {
        data: path.join(stagingRoot, "public"),
        media: path.join(stagingRoot, "generated", "library"),
        reports: path.join(stagingRoot, "generated", "reports"),
        cache: path.join(stagingRoot, "generated", "inventory-cache"),
        journal: path.join(stagingRoot, "generated", "journal")
      }
    : { ...workspace.canonicalOutputs };

  const overrides = {
    data: args.dataRoot || args.output,
    media: args.mediaRoot,
    reports: args.reportsRoot,
    cache: args.cacheRoot,
    journal: args.journalRoot
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value) {
      selected[name] = resolveMaybeRelative(value, workspace.appRoot);
    }
  }

  const physical = {};
  for (const [name, root] of outputRootValues(selected)) {
    physical[name] = await physicalPathWithoutCreating(root);
  }

  return {
    roots: Object.fromEntries(outputRootValues(selected).map(([name, root]) => [name, path.resolve(root)])),
    physical,
    canonical,
    stagingRoot: stagingRoot ? path.resolve(stagingRoot) : null,
    physicalStagingRoot: stagingRoot ? await physicalPathWithoutCreating(stagingRoot) : null,
    explicit: Boolean(stagingRoot || Object.values(overrides).some(Boolean)),
    individuallyConfigured: outputRootValues(overrides).filter(([, value]) => Boolean(value)).map(([name]) => name)
  };
}

function rootsOverlap(left, right) {
  return isInsideOrEqual(left, right) || isInsideOrEqual(right, left);
}

async function validateOutputConfiguration(args, outputConfig, sourceScope) {
  const selected = outputRootValues(outputConfig.physical);

  for (let leftIndex = 0; leftIndex < selected.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < selected.length; rightIndex += 1) {
      const [leftName, leftRoot] = selected[leftIndex];
      const [rightName, rightRoot] = selected[rightIndex];
      if (rootsOverlap(leftRoot, rightRoot)) {
        throw new Error(`Output roots must be independent: ${leftName} overlaps ${rightName}`);
      }
    }
  }

  const physicalSourceRoot = await physicalPathWithoutCreating(sourceScope.sourceRoot);
  for (const [name, root] of selected) {
    if (rootsOverlap(root, physicalSourceRoot)) {
      throw new Error(`${name} output root must not overlap the read-only source root`);
    }
  }

  if (!args.plan && outputConfig.explicit && !outputConfig.stagingRoot && outputConfig.individuallyConfigured.length !== 5) {
    throw new Error("A non-plan isolated import must use --staging-root or configure all five output roots");
  }

  if (!args.plan && outputConfig.explicit) {
    for (const [name, root] of selected) {
      for (const [canonicalName, canonicalRoot] of outputRootValues(outputConfig.canonical)) {
        if (rootsOverlap(root, canonicalRoot)) {
          throw new Error(`${name} staging root aliases or overlaps canonical ${canonicalName} output`);
        }
      }
    }
  }

  if (outputConfig.stagingRoot) {
    for (const [name, root] of selected) {
      if (!isInside(root, outputConfig.physicalStagingRoot)) {
        throw new Error(`${name} output root must stay inside --staging-root`);
      }
    }
    for (const [canonicalName, canonicalRoot] of outputRootValues(outputConfig.canonical)) {
      if (rootsOverlap(outputConfig.physicalStagingRoot, canonicalRoot)) {
        throw new Error(`Staging root aliases or overlaps canonical ${canonicalName} output`);
      }
    }
  }
}

async function scanFiles(sourceScope, workspace) {
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
          target: target ? toPosixPath(path.relative(workspace.photoSourceRoot, target)) : null,
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

async function inspectPhoto(filePath, sourceScope, year, includeContentHash = false) {
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
  const sha256 = includeContentHash ? crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex") : null;

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
    sha256,
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

async function resolveSourceScope(args, workspace) {
  if (args.source) {
    const sourceRoot = resolveMaybeRelative(args.source, workspace.appRoot);
    if (!isInsideOrEqual(sourceRoot, workspace.photoSourceRoot)) {
      throw new Error("Source folder must be inside the pixilation.org archive workspace");
    }
    if (workspace.blockedSourceRoots.some((blockedRoot) => isInsideOrEqual(sourceRoot, blockedRoot))) {
      throw new Error("Source folder must not be inside app code, generated output, or dependency directories");
    }
    if (sourceRoot === workspace.photoSourceRoot || sourceRoot === workspace.originalPhotosRoot) {
      throw new Error("Use the default year resolver instead of scanning the entire archive root");
    }
    if (path.basename(sourceRoot) !== args.year && leadingYear(path.basename(sourceRoot)) !== args.year) {
      throw new Error(`Source folder must match or start with --year (${args.year})`);
    }

    return {
      mode: isInsideOrEqual(sourceRoot, workspace.originalPhotosRoot) ? "original-archive-year" : "standalone-year",
      sourceRoot: isInsideOrEqual(sourceRoot, workspace.originalPhotosRoot) ? workspace.originalPhotosRoot : sourceRoot,
      scanRoots: [sourceRoot],
      sourceFolders: [isInsideOrEqual(sourceRoot, workspace.originalPhotosRoot) ? toPosixPath(path.relative(workspace.originalPhotosRoot, sourceRoot)) : "."]
    };
  }

  const standaloneRoot = path.join(workspace.photoSourceRoot, args.year);
  if (STANDALONE_SOURCE_YEARS.has(args.year) && (await exists(standaloneRoot))) {
    return {
      mode: "standalone-year",
      sourceRoot: standaloneRoot,
      scanRoots: [standaloneRoot],
      sourceFolders: ["."]
    };
  }

  if (!(await exists(workspace.originalPhotosRoot))) {
    throw new Error(`Original archive folder does not exist: ${toPosixPath(path.relative(workspace.photoSourceRoot, workspace.originalPhotosRoot))}`);
  }

  const archiveEntries = await fs.readdir(workspace.originalPhotosRoot, { withFileTypes: true });
  const scanRoots = [];
  for (const entry of archiveEntries) {
    const absolutePath = path.join(workspace.originalPhotosRoot, entry.name);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if ((stat.isDirectory() || stat.isFile()) && leadingYear(entry.name) === args.year) {
      scanRoots.push(absolutePath);
    }
  }
  scanRoots.sort((left, right) =>
    toPosixPath(path.relative(workspace.originalPhotosRoot, left)).localeCompare(toPosixPath(path.relative(workspace.originalPhotosRoot, right)), undefined, { numeric: true })
  );

  if (!scanRoots.length) {
    throw new Error(`No original-photos source folders found for ${args.year}`);
  }

  return {
    mode: "original-archive-year",
    sourceRoot: workspace.originalPhotosRoot,
    scanRoots,
    sourceFolders: scanRoots.map((folder) => toPosixPath(path.relative(workspace.originalPhotosRoot, folder)))
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

async function readArchiveInventory(reportsRoot) {
  try {
    const reportPath = path.join(reportsRoot, "archive-inventory.json");
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

function summarizeSourceSelection({ args, sourceScope, scanned, inspectedPhotos, albumSummaries, inventorySelection, workspace }) {
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
    sourceRoot: toPosixPath(path.relative(workspace.photoSourceRoot, sourceScope.sourceRoot)),
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

async function writeSourceSelectionReport(reportsRoot, year, sourceSelection) {
  await writeJson(path.join(reportsRoot, `${year}-source-selection-report.json`), sourceSelection);
}

function projectedAssets(photo, mediaRoot, year) {
  const thumbnailKey = `${year}/thumbs/${photo.id}.jpg`;
  const displayKey = `${year}/display/${photo.id}.jpg`;
  return {
    thumbnail: {
      key: thumbnailKey,
      path: path.join(mediaRoot, thumbnailKey),
      dimensions: resizedToWidth(photo.sourceWidth, photo.sourceHeight, THUMB_WIDTH)
    },
    display: {
      key: displayKey,
      path: path.join(mediaRoot, displayKey),
      dimensions: resizedInside(photo.sourceWidth, photo.sourceHeight, DISPLAY_MAX_WIDTH, DISPLAY_MAX_HEIGHT)
    }
  };
}

async function inspectExistingAsset(asset, photo, force) {
  let stat = null;
  try {
    stat = await fs.stat(asset.path);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const reusable = Boolean(stat) && !force && (await shouldReuseAsset(asset.path, photo.sourceMtimeMs, asset.dimensions));
  return {
    key: asset.key,
    path: asset.path,
    exists: Boolean(stat),
    existingBytes: stat?.size ?? null,
    reusable,
    proposedAction: reusable ? "reuse" : "generate",
    existingKeyConflict: Boolean(stat) && !reusable
  };
}

async function findStaleAlbumManifests(dataRoot, year, expectedManifestNames) {
  const albumsRoot = path.join(dataRoot, "data", year, "albums");
  if (!(await exists(albumsRoot))) {
    return [];
  }
  const entries = await fs.readdir(albumsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !expectedManifestNames.has(entry.name))
    .map((entry) => path.join(albumsRoot, entry.name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

async function readPublishedYearIndex(dataRoot, year) {
  try {
    return JSON.parse(await fs.readFile(path.join(dataRoot, "data", year, "index.json"), "utf8"));
  } catch {
    return null;
  }
}

function exactDuplicateGroups(photos, physicalSourceRoot) {
  const groups = new Map();
  for (const photo of photos) {
    if (!groups.has(photo.sha256)) {
      groups.set(photo.sha256, []);
    }
    groups.get(photo.sha256).push(photo);
  }
  return Array.from(groups.entries())
    .filter(([, group]) => group.length > 1)
    .map(([sha256, group]) => ({
      sha256,
      bytesEach: group[0].sourceSize,
      paths: group
        .map((photo) => path.join(physicalSourceRoot, photo.relativePath))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true })),
      selectedPaths: group.map((photo) => photo.absolutePath).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    }))
    .sort((left, right) => right.paths.length - left.paths.length || left.paths[0].localeCompare(right.paths[0], undefined, { numeric: true }));
}

async function buildPlanReport({ args, workspace, outputConfig, sourceScope, scanned, report, selectedPhotos, albums, startedAt }) {
  const physicalSourceRoot = await fs.realpath(sourceScope.sourceRoot);
  const yearDataRoot = path.join(outputConfig.roots.data, "data", args.year);
  const expectedAssetKeys = new Set();
  const assetInspection = await mapWithConcurrency(selectedPhotos, args.concurrency, async (photo) => {
    const assets = projectedAssets(photo, outputConfig.roots.media, args.year);
    expectedAssetKeys.add(assets.thumbnail.key);
    expectedAssetKeys.add(assets.display.key);
    return {
      photo,
      thumbnail: await inspectExistingAsset(assets.thumbnail, photo, args.force),
      display: await inspectExistingAsset(assets.display, photo, args.force)
    };
  });
  const albumSummaries = albums.map((album) => ({
    id: album.id,
    name: album.name,
    count: album.items.length,
    manifestPath: path.join(yearDataRoot, "albums", `${album.id}.json`),
    manifestUrl: `data/${args.year}/albums/${album.id}.json`
  }));
  const expectedManifestNames = new Set(albumSummaries.map((album) => `${album.id}.json`));
  const staleMediaKeys = await findStaleGeneratedAssets(outputConfig.roots.media, args.year, expectedAssetKeys);
  const staleManifestPaths = await findStaleAlbumManifests(outputConfig.roots.data, args.year, expectedManifestNames);
  const publishedIndex = await readPublishedYearIndex(outputConfig.roots.data, args.year);
  const publishedAlbumIds = new Set((publishedIndex?.albums || []).map((album) => album.id));
  const duplicateGroups = exactDuplicateGroups(selectedPhotos, physicalSourceRoot);
  const offYearDates = selectedPhotos
    .filter((photo) => photo.offYearExif)
    .map((photo) => ({
      sourcePath: path.join(physicalSourceRoot, photo.relativePath),
      selectedPath: photo.absolutePath,
      relativePath: photo.relativePath,
      exifTime: photo.offYearExif.value,
      exifYear: photo.offYearExif.year ?? yearForDate(new Date(photo.offYearExif.value)),
      field: photo.offYearExif.field,
      reason: photo.offYearExif.reason || `EXIF year differs from selected year ${args.year}`
    }));
  const sourceFolders = sourceScope.sourceFolders.map((folder) => {
    const prefix = folder === "." ? "" : `${folder}/`;
    const photos = selectedPhotos.filter((photo) => folder === "." || photo.relativePath === folder || photo.relativePath.startsWith(prefix));
    return {
      path: path.join(physicalSourceRoot, folder === "." ? "" : folder),
      selectedPath: path.join(sourceScope.sourceRoot, folder === "." ? "" : folder),
      relativePath: folder,
      inferredYear: leadingYear(folder === "." ? path.basename(sourceScope.sourceRoot) : folder) || args.year,
      importablePhotos: photos.length,
      proposedAlbums: Array.from(new Set(photos.map((photo) => photo.album))).sort((left, right) => left.localeCompare(right, undefined, { numeric: true })),
      representedByPublishedAlbumId: photos.some((photo) => publishedAlbumIds.has(photo.albumId))
    };
  });
  const unsupportedFiles = report.unsupportedFiles.map((file) => ({
    ...file,
    sourcePath: path.join(physicalSourceRoot, file.relativePath),
    selectedPath: path.join(sourceScope.sourceRoot, file.relativePath)
  }));
  const unreadableFiles = report.unreadableFiles.map((file) => ({
    ...file,
    sourcePath: path.join(physicalSourceRoot, file.relativePath),
    selectedPath: path.join(sourceScope.sourceRoot, file.relativePath)
  }));
  const photos = assetInspection.map(({ photo, thumbnail, display }) => ({
    sourcePath: path.join(physicalSourceRoot, photo.relativePath),
    selectedPath: photo.absolutePath,
    relativePath: photo.relativePath,
    sourceBytes: photo.sourceSize,
    sourceSha256: photo.sha256,
    inferredYear: leadingYear(photo.relativePath) || args.year,
    album: { id: photo.albumId, name: photo.album },
    proposedPhotoId: photo.id,
    proposedOutputs: {
      albumManifestPath: path.join(yearDataRoot, "albums", `${photo.albumId}.json`),
      thumbnail,
      display
    },
    captureTime: photo.captureTime,
    dateSource: photo.dateSource,
    offYearExif: photo.offYearExif
  }));
  const existingKeyConflicts = photos.flatMap((photo) =>
    [photo.proposedOutputs.thumbnail, photo.proposedOutputs.display]
      .filter((asset) => asset.existingKeyConflict)
      .map((asset) => ({ sourcePath: photo.sourcePath, photoId: photo.proposedPhotoId, ...asset }))
  );
  const existingKeys = photos.flatMap((photo) =>
    [photo.proposedOutputs.thumbnail, photo.proposedOutputs.display]
      .filter((asset) => asset.exists)
      .map((asset) => ({ sourcePath: photo.sourcePath, photoId: photo.proposedPhotoId, ...asset }))
  );
  const unresolvedCuratorialDecisions = [];
  const unpublishedFolders = sourceFolders.filter((folder) => !folder.representedByPublishedAlbumId);
  if (unpublishedFolders.length) {
    unresolvedCuratorialDecisions.push({
      decision: "Approve source folders and album labels before publication",
      paths: unpublishedFolders.map((folder) => folder.path),
      note: "Selection by year prefix is an observed importer behavior, not publication approval. In particular, 2002 New remains unapproved."
    });
  }
  if (offYearDates.length) {
    unresolvedCuratorialDecisions.push({ decision: "Confirm treatment of off-year EXIF dates", count: offYearDates.length });
  }
  if (duplicateGroups.length) {
    unresolvedCuratorialDecisions.push({ decision: "Confirm whether byte-identical source files should remain separate photos", count: duplicateGroups.length });
  }
  if (unsupportedFiles.length || unreadableFiles.length) {
    unresolvedCuratorialDecisions.push({
      decision: "Classify or remove unsupported and unreadable source files",
      unsupported: unsupportedFiles.length,
      unreadable: unreadableFiles.length
    });
  }

  return {
    schemaVersion: 1,
    mode: "plan",
    zeroWrite: true,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    configuration: {
      workspaceRoot: workspace.appRoot,
      sourceRoot: sourceScope.sourceRoot,
      physicalSourceRoot,
      scanRoots: sourceScope.scanRoots,
      outputRoots: outputConfig.roots,
      canonicalOutputRoots: workspace.canonicalOutputs,
      stagingRoot: outputConfig.stagingRoot,
      year: args.year,
      limit: args.limit,
      force: args.force,
      concurrency: args.concurrency
    },
    observedFacts: {
      selectionPolicy:
        sourceScope.mode === "original-archive-year"
          ? "All top-level original-photos entries whose names begin with the requested year."
          : "The explicitly selected or standalone year folder.",
      sourceMode: sourceScope.mode,
      sourceFolders,
      filesScanned: scanned.files.length,
      skippedNoiseFiles: scanned.skippedNoiseFiles,
      skippedSymlinks: scanned.skippedSymlinks,
      importablePhotos: selectedPhotos.length,
      proposedAlbums: albumSummaries,
      unsupportedFiles,
      unreadableFiles,
      duplicateContentGroups: duplicateGroups,
      offYearDates,
      existingKeys,
      existingKeyConflicts,
      outputsThatWouldBecomeStale: {
        mediaKeys: staleMediaKeys,
        albumManifestPaths: staleManifestPaths
      },
      proposedSharedOutputs: {
        catalogPath: path.join(outputConfig.roots.data, "data", "catalog.json"),
        yearIndexPath: path.join(yearDataRoot, "index.json"),
        sourceSelectionReportPath: path.join(outputConfig.roots.reports, `${args.year}-source-selection-report.json`),
        importReportPath: path.join(outputConfig.roots.reports, `${args.year}-import-report.json`),
        cacheRoot: outputConfig.roots.cache,
        journalRoot: outputConfig.roots.journal,
        note: "Cache and journal roots are isolated and reserved; this importer version does not write cache or journal entries."
      },
      photos
    },
    unresolvedCuratorialDecisions
  };
}

async function runImporter(argv = process.argv.slice(2), runtime = {}) {
  const startedAt = Date.now();
  const writeStdout = runtime.writeStdout || ((value) => process.stdout.write(value));
  const workspace = workspacePaths(runtime.appRoot || APP_ROOT);
  const args = parseArgs(argv);
  const outputConfig = await resolveOutputConfiguration(args, workspace);
  const sourceScope = await resolveSourceScope(args, workspace);
  await validateOutputConfiguration(args, outputConfig, sourceScope);
  const dataOutputRoot = outputConfig.roots.data;
  const mediaOutputRoot = outputConfig.roots.media;
  const reportsOutputRoot = outputConfig.roots.reports;
  const yearDataRoot = path.join(dataOutputRoot, "data", args.year);
  const albumsDataRoot = path.join(yearDataRoot, "albums");
  const importMode = args.limit === null ? "complete" : "sample";

  if (!(await exists(sourceScope.sourceRoot))) {
    throw new Error(`Source folder does not exist: ${toPosixPath(path.relative(workspace.photoSourceRoot, sourceScope.sourceRoot))}`);
  }

  const scanned = await scanFiles(sourceScope, workspace);
  const scannedFiles = scanned.files;
  const report = {
    generatedAt: new Date().toISOString(),
    year: args.year,
    sourceRootName: path.basename(sourceScope.sourceRoot),
    sourceMode: sourceScope.mode,
    sourceRoot: toPosixPath(path.relative(workspace.photoSourceRoot, sourceScope.sourceRoot)),
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
      const photo = await inspectPhoto(filePath, sourceScope, args.year, args.plan);
      inspectedCount += 1;
      if (!args.plan && (inspectedCount % 500 === 0 || inspectedCount === scannedFiles.length - report.unsupported)) {
        writeStdout(`Inspected ${inspectedCount}/${scannedFiles.length - report.unsupported}\n`);
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
  const archiveInventory = await readArchiveInventory(outputConfig.canonical.reports);
  const inventorySelection = selectedInventoryFiles(archiveInventory, sourceScope);
  report.sourceSelection = summarizeSourceSelection({
    args,
    sourceScope,
    scanned,
    inspectedPhotos: selectedPhotos,
    albumSummaries: preliminaryAlbumSummaries,
    inventorySelection,
    workspace
  });
  report.sourceSelection.importerUnsupportedFiles = report.unsupportedFiles;
  report.sourceSelection.importerUnreadableFiles = report.unreadableFiles;
  report.sourceSelection.corruptOrUnreadableFiles = report.unreadableFiles;
  report.sourceSelection.zeroByteFiles = [
    ...report.sourceSelection.zeroByteFiles,
    ...report.unreadableFiles.filter((file) => file.bytes === 0)
  ];
  if (args.plan) {
    const planReport = await buildPlanReport({
      args,
      workspace,
      outputConfig,
      sourceScope,
      scanned,
      report,
      selectedPhotos,
      albums: preliminaryAlbums,
      startedAt
    });
    writeStdout(`${JSON.stringify(planReport, null, 2)}\n`);
    return planReport;
  }

  await writeSourceSelectionReport(reportsOutputRoot, args.year, report.sourceSelection);

  let processedAssets = 0;
  const assetResults = await mapWithConcurrency(selectedPhotos, args.concurrency, async (photo, index) => {
    const assets = await writePhotoAsset(photo, mediaOutputRoot, args.year, args.force);
    processedAssets += 1;
    if (processedAssets % 250 === 0 || processedAssets === selectedPhotos.length) {
      writeStdout(`Assets ${processedAssets}/${selectedPhotos.length}\n`);
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
  await writeJson(path.join(reportsOutputRoot, `${args.year}-import-report.json`), report);
  await fs.rm(path.join(yearDataRoot, "import-report.json"), { force: true });

  writeStdout(
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
  return report;
}

export { parseArgs, resolveOutputConfiguration, runImporter, validateOutputConfiguration, workspacePaths };

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  runImporter().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
