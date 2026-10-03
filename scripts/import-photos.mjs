import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import exifr from "exifr";
import { classifySourceImage, createSourcePolicyTemplate, evaluateSourcePolicy, inspectSourcePolicy, renderDecisionReport } from "./source-policy.mjs";
import { CONTENT_MEDIA_KEY_VERSION, contentVersionedMediaAsset } from "./content-versioned-media.mjs";

const DEFAULT_CONCURRENCY = 6;
const THUMB_WIDTH = 300;
const DISPLAY_MAX_WIDTH = 640;
const DISPLAY_MAX_HEIGHT = 480;
const execFileAsync = promisify(execFile);
const STAGED_RUN_SCHEMA_VERSION = 2;
const STAGED_RECIPE = Object.freeze({
  version: 1,
  thumbnail: { width: THUMB_WIDTH, withoutEnlargement: true, format: "jpeg", quality: 76, mozjpeg: true, autoOrient: true },
  display: {
    width: DISPLAY_MAX_WIDTH,
    height: DISPLAY_MAX_HEIGHT,
    fit: "inside",
    withoutEnlargement: true,
    format: "jpeg",
    quality: 84,
    mozjpeg: true,
    autoOrient: true
  },
  json: { indentation: 2, trailingNewline: true }
});
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
    sourcePolicy: null,
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
    } else if (key === "source-policy") {
      args.sourcePolicy = value;
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
      if (unresolved.length) {
        const stat = await fs.stat(real);
        if (!stat.isDirectory()) {
          throw new Error(`Path has a non-directory ancestor: ${targetPath}`);
        }
      }
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

  if (!args.plan && outputConfig.explicit && !outputConfig.stagingRoot) {
    throw new Error("A non-plan isolated import must use --staging-root; individual root overrides are allowed only inside it");
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

async function inspectPhoto(filePath, sourceScope, year, includeContentHash = false, decodedMetadata = null) {
  const relativePath = toPosixPath(path.relative(sourceScope.sourceRoot, filePath));
  const stat = await fs.stat(filePath);
  const metadata = decodedMetadata || (await sharp(filePath, { failOn: "none", limitInputPixels: false }).metadata());
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

function projectedVersionedAssets(photo, mediaRoot, year, recipe, sharpVersion) {
  const thumbnailIdentity = contentVersionedMediaAsset({
    year,
    photoId: photo.id,
    sourceSha256: photo.sha256,
    derivativeType: "thumbnail",
    recipe,
    sharpVersion
  });
  const displayIdentity = contentVersionedMediaAsset({
    year,
    photoId: photo.id,
    sourceSha256: photo.sha256,
    derivativeType: "display",
    recipe,
    sharpVersion
  });
  return {
    thumbnail: {
      ...thumbnailIdentity,
      path: path.join(mediaRoot, thumbnailIdentity.key),
      dimensions: resizedToWidth(photo.sourceWidth, photo.sourceHeight, THUMB_WIDTH),
      derivativeType: "thumbnail",
      sourceIdentity: { photoId: photo.id, sourceSha256: photo.sha256 }
    },
    display: {
      ...displayIdentity,
      path: path.join(mediaRoot, displayIdentity.key),
      dimensions: resizedInside(photo.sourceWidth, photo.sourceHeight, DISPLAY_MAX_WIDTH, DISPLAY_MAX_HEIGHT),
      derivativeType: "display",
      sourceIdentity: { photoId: photo.id, sourceSha256: photo.sha256 }
    }
  };
}

async function inspectExistingVersionedAsset(asset) {
  let stat = null;
  try {
    stat = await fs.lstat(asset.path);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const verification = stat?.isFile() ? await verifyDerivative(asset.path, asset.dimensions) : null;
  return {
    key: asset.key,
    path: asset.path,
    exists: Boolean(stat),
    existingBytes: stat?.size ?? null,
    existingSha256: verification?.sha256 || null,
    dimensionsValid: Boolean(verification),
    reusable: false,
    proposedAction: stat ? "fail-unless-bound-by-this-run-journal" : "generate",
    existingKeyConflict: Boolean(stat),
    keyIdentitySha256: asset.keyIdentitySha256,
    recipeIdentitySha256: asset.recipeIdentitySha256,
    derivativeType: asset.derivativeType,
    note: stat
      ? "A filename match alone is not provenance. Reuse requires this run journal's exact source, recipe, checksum, and dimensions."
      : "New immutable content-versioned key."
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

async function readPublishedMediaReferences(dataRoot, year) {
  const index = await readPublishedYearIndex(dataRoot, year);
  const byPhotoId = new Map();
  const manifestPaths = [];
  for (const album of index?.albums || []) {
    if (!album?.manifestUrl) continue;
    const manifestPath = path.resolve(dataRoot, album.manifestUrl);
    if (!isInside(manifestPath, path.resolve(dataRoot))) {
      throw new Error(`Published album manifest escapes the public data root: ${album.manifestUrl}`);
    }
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot inspect published album manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    manifestPaths.push(manifestPath);
    for (const photo of manifest.photos || []) {
      if (!photo?.id || !photo.thumbnailKey || !photo.displayKey) continue;
      byPhotoId.set(photo.id, {
        photoId: photo.id,
        thumbnailKey: photo.thumbnailKey,
        displayKey: photo.displayKey,
        manifestPath
      });
    }
  }
  return { index, byPhotoId, manifestPaths };
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

function stableJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableJsonValue(value));
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function fileDigest(filePath) {
  const bytes = await fs.readFile(filePath);
  return { bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

async function syncPath(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  let handle = null;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR", "EBADF"]).has(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function assertTargetInsideRoot(targetPath, rootPath) {
  const physicalRoot = await physicalPathWithoutCreating(rootPath);
  const physicalTarget = await physicalPathWithoutCreating(targetPath);
  if (!isInside(physicalTarget, physicalRoot)) {
    throw new Error(`Staged output escapes its selected root: ${targetPath}`);
  }
}

async function assertNoSymlinks(rootPath) {
  if (!(await exists(rootPath))) {
    return;
  }
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Staging tree contains a symlink: ${absolutePath}`);
      }
      if (stat.isDirectory()) {
        await walk(absolutePath);
      }
    }
  }
  await walk(rootPath);
}

async function walkRegularFiles(rootPath) {
  const files = [];
  if (!(await exists(rootPath))) {
    return files;
  }
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Staging tree contains a symlink: ${absolutePath}`);
      }
      if (stat.isDirectory()) {
        await walk(absolutePath);
      } else if (stat.isFile()) {
        files.push(absolutePath);
      } else {
        throw new Error(`Staging tree contains a non-regular entry: ${absolutePath}`);
      }
    }
  }
  await walk(rootPath);
  return files;
}

function temporaryName(targetPath, runId) {
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.pixilation-tmp-${runId}-${crypto.randomBytes(6).toString("hex")}`);
}

async function removeLeftoverTemporaryFiles(stagingRoot) {
  let removed = 0;
  if (!(await exists(stagingRoot))) {
    return removed;
  }
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Staging tree contains a symlink: ${absolutePath}`);
      }
      if (stat.isDirectory()) {
        await walk(absolutePath);
      } else if (stat.isFile() && entry.name.includes(".pixilation-tmp-")) {
        await fs.unlink(absolutePath);
        removed += 1;
      }
    }
  }
  await walk(stagingRoot);
  return removed;
}

async function atomicWriteArtifact({ targetPath, selectedRoot, runId, writeTemporary, verifyTemporary, noClobber = false }) {
  await assertTargetInsideRoot(targetPath, selectedRoot);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await assertTargetInsideRoot(targetPath, selectedRoot);
  const temporaryPath = temporaryName(targetPath, runId);
  await assertTargetInsideRoot(temporaryPath, selectedRoot);
  try {
    await writeTemporary(temporaryPath);
    await syncPath(temporaryPath);
    const verification = await verifyTemporary(temporaryPath);
    if (!verification) {
      throw new Error(`Temporary staged output failed verification: ${temporaryPath}`);
    }
    if (noClobber) {
      try {
        await fs.link(temporaryPath, targetPath);
        await fs.unlink(temporaryPath);
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new Error(`Content-versioned media key collision; refusing to overwrite existing bytes: ${targetPath}`);
        }
        throw error;
      }
    } else {
      await fs.rename(temporaryPath, targetPath);
    }
    await syncDirectory(path.dirname(targetPath));
    const installedVerification = await verifyTemporary(targetPath);
    if (!installedVerification) {
      throw new Error(`Atomically installed staged output failed verification: ${targetPath}`);
    }
    return installedVerification;
  } finally {
    await fs.unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function verifyDerivative(filePath, dimensions, expectedSha256 = null) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    const metadata = await assetMetadata(filePath);
    if (metadata.width !== dimensions.width || metadata.height !== dimensions.height) return null;
    const digest = await fileDigest(filePath);
    if (expectedSha256 && digest.sha256 !== expectedSha256) return null;
    return { ...digest, dimensions: metadata };
  } catch {
    return null;
  }
}

async function verifyExactJson(filePath, expectedValue, expectedSha256 = null) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.size <= 0) return null;
    const bytes = await fs.readFile(filePath);
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (stableJson(parsed) !== stableJson(expectedValue)) return null;
    const sha256 = sha256Bytes(bytes);
    if (expectedSha256 && sha256 !== expectedSha256) return null;
    if (!bytes.equals(jsonBytes(expectedValue))) return null;
    return { bytes: bytes.length, sha256 };
  } catch {
    return null;
  }
}

async function resolveImporterCommit(runtime) {
  if (runtime.importerCommit) {
    return runtime.importerCommit;
  }
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: APP_ROOT });
  return stdout.trim();
}

async function inspectSourceGate(args, sourceScope, workspace) {
  const inspection = await inspectSourcePolicy({
    sourceRoot: sourceScope.sourceRoot,
    scanRoots: sourceScope.scanRoots,
    selectedYear: args.year,
    concurrency: args.concurrency,
    publicDataRoot: workspace.canonicalOutputs.data
  });
  const policyPath = args.sourcePolicy ? resolveMaybeRelative(args.sourcePolicy, workspace.appRoot) : null;
  const policy = policyPath ? JSON.parse(await fs.readFile(policyPath, "utf8")) : null;
  const eligibility = evaluateSourcePolicy(inspection, policy);
  return {
    policyPath,
    inspection,
    policyTemplate: createSourcePolicyTemplate(inspection),
    eligibility,
    decisionReportMarkdown: renderDecisionReport(inspection, eligibility)
  };
}

function assertCanonicalSourceEligibility(sourceGate) {
  const eligibility = sourceGate.eligibility;
  if (eligibility.publicationEligible) return;
  const changes = eligibility.inventoryChanges;
  throw new Error(
    [
      "Canonical import blocked by source-policy eligibility gate.",
      `Inventory match: ${eligibility.inventoryMatches}.`,
      `Unresolved decisions: ${eligibility.counts.unresolved}.`,
      `Added: ${changes.added.length}; removed: ${changes.removed.length}; changed: ${changes.changed.length}.`,
      eligibility.schemaErrors.length ? `Policy errors: ${eligibility.schemaErrors.join(" | ")}.` : null
    ]
      .filter(Boolean)
      .join(" ")
  );
}

async function invokeFault(runtime, point, details = {}) {
  if (runtime.injectFault) {
    await runtime.injectFault(point, details);
  }
}

async function readRunDescriptor(runPath) {
  try {
    return JSON.parse(await fs.readFile(runPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Cannot safely read staged run descriptor: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function createInitialRunFiles({ runPath, journalPath, journalRoot, descriptor, runId }) {
  await assertTargetInsideRoot(runPath, journalRoot);
  await assertTargetInsideRoot(journalPath, journalRoot);
  await fs.mkdir(journalRoot, { recursive: true });
  await atomicWriteArtifact({
    targetPath: runPath,
    selectedRoot: journalRoot,
    runId,
    writeTemporary: async (temporaryPath) => fs.writeFile(temporaryPath, jsonBytes(descriptor), { flag: "wx" }),
    verifyTemporary: async (temporaryPath) => verifyExactJson(temporaryPath, descriptor)
  });
  const handle = await fs.open(journalPath, "wx");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(journalRoot);
}

async function loadProgressJournal(journalPath) {
  let textValue = "";
  try {
    textValue = await fs.readFile(journalPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { events: [], truncatedBytes: 0, create: true };
  }
  const finalNewline = textValue.lastIndexOf("\n");
  const completeText = finalNewline >= 0 ? textValue.slice(0, finalNewline + 1) : "";
  const remainder = finalNewline >= 0 ? textValue.slice(finalNewline + 1) : textValue;
  const events = [];
  for (const line of completeText.split("\n").filter(Boolean)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error("Progress journal contains a malformed completed record; refusing to resume");
    }
  }
  return { events, truncatedBytes: Buffer.byteLength(remainder), truncateToBytes: Buffer.byteLength(completeText), create: false };
}

function journalArtifactMap(events) {
  const artifacts = new Map();
  for (const event of events) {
    if (event?.type === "artifact-complete" && typeof event.path === "string" && typeof event.sha256 === "string") {
      artifacts.set(event.path, event);
    }
  }
  return artifacts;
}

function createProgressJournal(journalPath, initialEvents) {
  const artifacts = journalArtifactMap(initialEvents);
  let queue = Promise.resolve();
  return {
    artifacts,
    append(event) {
      queue = queue.then(async () => {
        const handle = await fs.open(journalPath, "a");
        try {
          await handle.write(`${JSON.stringify(event)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (event.type === "artifact-complete") artifacts.set(event.path, event);
      });
      return queue;
    },
    flush() {
      return queue;
    }
  };
}

function stagedRelativePath(stagingRoot, absolutePath) {
  return toPosixPath(path.relative(stagingRoot, absolutePath));
}

function artifactEvent({ stagingRoot, targetPath, kind, verification, mediaIdentity = null }) {
  return {
    type: "artifact-complete",
    path: stagedRelativePath(stagingRoot, targetPath),
    kind,
    bytes: verification.bytes,
    sha256: verification.sha256,
    ...(verification.dimensions ? { dimensions: verification.dimensions } : {}),
    ...(mediaIdentity ? { mediaIdentity } : {})
  };
}

async function ensureDerivativeArtifact({ photo, asset, kind, selectedRoot, stagingRoot, runId, journal, runtime }) {
  const relativePath = stagedRelativePath(stagingRoot, asset.path);
  const recorded = journal.artifacts.get(relativePath);
  const mediaIdentity = {
    key: asset.key,
    derivativeType: asset.derivativeType,
    sourceIdentity: asset.sourceIdentity,
    keyIdentitySha256: asset.keyIdentitySha256,
    recipeIdentitySha256: asset.recipeIdentitySha256
  };
  if (recorded?.mediaIdentity && stableJson(recorded.mediaIdentity) !== stableJson(mediaIdentity)) {
    throw new Error(`Journal media identity mismatch; refusing to reuse or overwrite ${relativePath}`);
  }
  if (recorded && !recorded.mediaIdentity) {
    throw new Error(`Journal derivative lacks content-version provenance; refusing to reuse or overwrite ${relativePath}`);
  }
  const verified = recorded ? await verifyDerivative(asset.path, asset.dimensions, recorded.sha256) : null;
  if (verified) {
    return { ...verified, generated: false, path: asset.path, key: asset.key, mediaIdentity };
  }
  if (!recorded && (await exists(asset.path))) {
    throw new Error(`Content-versioned media key collision without matching run provenance: ${asset.key}`);
  }
  const result = await atomicWriteArtifact({
    targetPath: asset.path,
    selectedRoot,
    runId,
    writeTemporary: async (temporaryPath) => {
      const pipeline = sharp(photo.absolutePath, { failOn: "none", limitInputPixels: false }).rotate();
      if (kind === "thumbnail") {
        await pipeline.resize({ width: THUMB_WIDTH, withoutEnlargement: true }).jpeg({ quality: 76, mozjpeg: true }).toFile(temporaryPath);
      } else {
        await pipeline
          .resize({ width: DISPLAY_MAX_WIDTH, height: DISPLAY_MAX_HEIGHT, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 84, mozjpeg: true })
          .toFile(temporaryPath);
      }
    },
    verifyTemporary: async (temporaryPath) => verifyDerivative(temporaryPath, asset.dimensions),
    noClobber: !recorded
  });
  const event = artifactEvent({ stagingRoot, targetPath: asset.path, kind, verification: result, mediaIdentity });
  await journal.append(event);
  await invokeFault(runtime, `${kind}-generation`, { photoId: photo.id, path: asset.path });
  return { ...result, generated: true, path: asset.path, key: asset.key, mediaIdentity };
}

async function ensureJsonArtifact({ value, targetPath, kind, selectedRoot, stagingRoot, runId, journal, runtime, faultPoint = null }) {
  const relativePath = stagedRelativePath(stagingRoot, targetPath);
  const expectedSha256 = sha256Bytes(jsonBytes(value));
  const recorded = journal.artifacts.get(relativePath);
  let verified = await verifyExactJson(targetPath, value, expectedSha256);
  let generated = false;
  if (!verified) {
    verified = await atomicWriteArtifact({
      targetPath,
      selectedRoot,
      runId,
      writeTemporary: async (temporaryPath) => fs.writeFile(temporaryPath, jsonBytes(value), { flag: "wx" }),
      verifyTemporary: async (temporaryPath) => verifyExactJson(temporaryPath, value, expectedSha256)
    });
    generated = true;
  }
  if (!recorded || recorded.sha256 !== verified.sha256 || recorded.bytes !== verified.bytes) {
    await journal.append(artifactEvent({ stagingRoot, targetPath, kind, verification: verified }));
  }
  if (generated && faultPoint) {
    await invokeFault(runtime, faultPoint, { path: targetPath });
  }
  return { ...verified, generated, path: targetPath };
}

async function requireRecordedDerivative({ asset, stagingRoot, journal }) {
  const { path: targetPath, dimensions } = asset;
  const relativePath = stagedRelativePath(stagingRoot, targetPath);
  const recorded = journal.artifacts.get(relativePath);
  if (!recorded) throw new Error(`Referenced derivative is not journaled as complete: ${relativePath}`);
  const expectedIdentity = {
    key: asset.key,
    derivativeType: asset.derivativeType,
    sourceIdentity: asset.sourceIdentity,
    keyIdentitySha256: asset.keyIdentitySha256,
    recipeIdentitySha256: asset.recipeIdentitySha256
  };
  if (stableJson(recorded.mediaIdentity) !== stableJson(expectedIdentity)) {
    throw new Error(`Referenced derivative has mismatched media identity: ${relativePath}`);
  }
  const verified = await verifyDerivative(targetPath, dimensions, recorded.sha256);
  if (!verified) throw new Error(`Referenced derivative failed sealing verification: ${relativePath}`);
  return verified;
}

async function requireRecordedJson({ targetPath, value, stagingRoot, journal }) {
  const relativePath = stagedRelativePath(stagingRoot, targetPath);
  const recorded = journal.artifacts.get(relativePath);
  if (!recorded) throw new Error(`Referenced JSON is not journaled as complete: ${relativePath}`);
  const verified = await verifyExactJson(targetPath, value, recorded.sha256);
  if (!verified) throw new Error(`Referenced JSON failed sealing verification: ${relativePath}`);
  return verified;
}

async function assertNewStagingRootIsEmpty(stagingRoot) {
  const files = await walkRegularFiles(stagingRoot);
  if (files.length) {
    throw new Error(`Staging root already contains files but has no matching run descriptor: ${files[0]}`);
  }
}

function buildStagedModel({
  args,
  outputConfig,
  sourceScope,
  scanned,
  report,
  selectedPhotos,
  albums,
  sourceGate,
  importerCommit,
  importerScriptSha256,
  sharpVersion,
  recipe,
  publishedMedia
}) {
  const stagingRoot = outputConfig.stagingRoot;
  const assetsByPhotoId = new Map();
  for (const photo of selectedPhotos) {
    assetsByPhotoId.set(photo.id, projectedVersionedAssets(photo, outputConfig.roots.media, args.year, recipe, sharpVersion));
  }
  const albumModels = albums.map((album) => ({
    id: album.id,
    name: album.name,
    items: album.items,
    manifestUrl: `data/${args.year}/albums/${album.id}.json`,
    manifestPath: path.join(outputConfig.roots.data, "data", args.year, "albums", `${album.id}.json`)
  }));
  const albumSummaries = albumModels.map((album) => ({ id: album.id, name: album.name, count: album.items.length, manifestUrl: album.manifestUrl }));
  const sequencePhotos = albumModels
    .flatMap((album) => album.items.map((photo, albumSortPosition) => ({ photo, albumSortPosition })))
    .map(({ photo, albumSortPosition }, sortPosition) => {
      const assets = assetsByPhotoId.get(photo.id);
      return {
        photo,
        clientPhoto: photoToClientPhoto(
          photo,
          {
            thumbnailKey: assets.thumbnail.key,
            displayKey: assets.display.key,
            displayWidth: assets.display.dimensions.width,
            displayHeight: assets.display.dimensions.height
          },
          sortPosition,
          albumSortPosition
        )
      };
    });
  const photosByAlbum = new Map();
  for (const { clientPhoto } of sequencePhotos) {
    if (!photosByAlbum.has(clientPhoto.albumId)) photosByAlbum.set(clientPhoto.albumId, []);
    photosByAlbum.get(clientPhoto.albumId).push(clientPhoto);
  }
  for (const album of albumModels) {
    album.manifest = { photos: (photosByAlbum.get(album.id) || []).sort((left, right) => left.albumSortPosition - right.albumSortPosition) };
  }
  const index = {
    year: args.year,
    scannedCount: scanned.files.length,
    albums: albumSummaries,
    sequence: sequencePhotos.map(({ clientPhoto }) => ({ id: clientPhoto.id }))
  };
  const catalog = { years: [{ year: args.year, indexUrl: publicUrlForYear(args.year) }] };
  const sourceSelection = {
    year: args.year,
    mode: sourceScope.mode,
    sourceRoot: sourceScope.sourceRoot,
    scanRoots: sourceScope.scanRoots,
    sourceFolders: sourceScope.sourceFolders,
    limit: args.limit,
    files: selectedPhotos.map((photo) => ({
      path: photo.absolutePath,
      relativePath: photo.relativePath,
      bytes: photo.sourceSize,
      sha256: photo.sha256,
      photoId: photo.id,
      albumId: photo.albumId,
      album: photo.album,
      sourceWidth: photo.sourceWidth,
      sourceHeight: photo.sourceHeight,
      exifOrientation: photo.exifOrientation,
      captureTime: photo.captureTime,
      dateSource: photo.dateSource,
      sortSource: photo.sortSource
    })),
    omissions: {
      unsupported: report.unsupportedFiles,
      unreadable: report.unreadableFiles,
      skippedNoise: scanned.skippedNoiseFiles,
      skippedSymlinks: scanned.skippedSymlinks
    }
  };
  const proposedManifestSet = {
    albums: albumModels.map((album) => ({
      id: album.id,
      name: album.name,
      path: `data/${args.year}/albums/${album.id}.json`,
      sha256: sha256Bytes(jsonBytes(album.manifest)),
      photos: album.manifest.photos.map((photo) => ({
        id: photo.id,
        thumbnailKey: photo.thumbnailKey,
        displayKey: photo.displayKey
      }))
    })),
    yearIndexPath: `data/${args.year}/index.json`,
    yearIndex: index,
    catalogPath: "data/catalog.json",
    catalog
  };
  const mediaKeySet = selectedPhotos.flatMap((photo) => {
    const assets = assetsByPhotoId.get(photo.id);
    return [assets.thumbnail, assets.display].map((asset) => ({
      photoId: photo.id,
      sourcePath: photo.absolutePath,
      sourceSha256: photo.sha256,
      derivativeType: asset.derivativeType,
      key: asset.key,
      keyIdentitySha256: asset.keyIdentitySha256,
      recipeIdentitySha256: asset.recipeIdentitySha256,
      dimensions: asset.dimensions
    }));
  });
  const legacyTransitions = selectedPhotos
    .map((photo) => {
      const published = publishedMedia.byPhotoId.get(photo.id);
      if (!published) return null;
      const assets = assetsByPhotoId.get(photo.id);
      return {
        photoId: photo.id,
        legacy: { thumbnailKey: published.thumbnailKey, displayKey: published.displayKey },
        staged: { thumbnailKey: assets.thumbnail.key, displayKey: assets.display.key },
        compatibility: "regenerate-versioned",
        reason: "Legacy key and bytes have no verified source-checksum and encoding-recipe provenance."
      };
    })
    .filter(Boolean);
  const binding = {
    schemaVersion: STAGED_RUN_SCHEMA_VERSION,
    importerCommit,
    importerScriptSha256,
    sharpVersion,
    derivativeRecipe: recipe,
    contentMediaKeyVersion: CONTENT_MEDIA_KEY_VERSION,
    mediaKeySet,
    sourceSelectionSha256: sha256Bytes(stableJson(sourceSelection)),
    proposedManifestSetSha256: sha256Bytes(stableJson(proposedManifestSet)),
    sourceSelection,
    proposedManifestSet,
    sourcePolicy: {
      policyPath: sourceGate.policyPath,
      policySha256: sourceGate.eligibility.policySha256,
      freshInventory: sourceGate.inspection.inventory,
      decisionSetSha256: sourceGate.inspection.decisionSetSha256,
      publicationEligible: sourceGate.eligibility.publicationEligible,
      unresolvedDecisionIds: sourceGate.eligibility.unresolvedDecisionIds
    },
    outputLayout: {
      data: "public",
      media: "generated/library",
      reports: "generated/reports",
      cache: "generated/inventory-cache",
      journal: "generated/journal"
    }
  };
  return {
    stagingRoot,
    assetsByPhotoId,
    albumModels,
    albumSummaries,
    sequencePhotos,
    index,
    catalog,
    sourceSelection,
    proposedManifestSet,
    yearIndexPath: path.join(outputConfig.roots.data, "data", args.year, "index.json"),
    catalogPath: path.join(outputConfig.roots.data, "data", "catalog.json"),
    binding,
    mediaKeySet,
    legacyTransitions,
    runId: sha256Bytes(stableJson(binding))
  };
}

async function closedWorldAudit({ stagingRoot, expectedPaths }) {
  const files = await walkRegularFiles(stagingRoot);
  const actual = files.map((filePath) => stagedRelativePath(stagingRoot, filePath)).sort();
  const expected = Array.from(expectedPaths).sort();
  const missing = expected.filter((filePath) => !actual.includes(filePath));
  const unexpected = actual.filter((filePath) => !expected.includes(filePath));
  if (missing.length || unexpected.length) {
    throw new Error(`Closed-world staged audit failed: missing ${missing.join(", ") || "none"}; unexpected ${unexpected.join(", ") || "none"}`);
  }
  const records = [];
  for (const relativePath of actual) {
    const absolutePath = path.join(stagingRoot, relativePath);
    const digest = await fileDigest(absolutePath);
    records.push({ path: relativePath, ...digest });
  }
  return { files: records, sha256: sha256Bytes(stableJson(records)) };
}

async function runStagedImport({ args, runtime, outputConfig, sourceScope, scanned, report, selectedPhotos, albums, sourceGate }) {
  const importerCommit = await resolveImporterCommit(runtime);
  const importerScriptSha256 = runtime.importerScriptSha256 || (await fileDigest(fileURLToPath(import.meta.url))).sha256;
  const sharpVersion = runtime.sharpVersion || sharp.versions.sharp;
  const recipe = runtime.derivativeRecipe || STAGED_RECIPE;
  const publishedMedia = await readPublishedMediaReferences(outputConfig.canonical.data, args.year);
  const model = buildStagedModel({
    args,
    outputConfig,
    sourceScope,
    scanned,
    report,
    selectedPhotos,
    albums,
    sourceGate,
    importerCommit,
    importerScriptSha256,
    sharpVersion,
    recipe,
    publishedMedia
  });
  const { stagingRoot, runId } = model;
  const journalRoot = outputConfig.roots.journal;
  const runPath = path.join(journalRoot, "run.json");
  const journalPath = path.join(journalRoot, "progress.ndjson");
  const completePath = path.join(journalRoot, "complete.json");
  await assertNoSymlinks(stagingRoot);
  let descriptor = await readRunDescriptor(runPath);
  if (descriptor) {
    if (descriptor.runId !== runId || stableJson(descriptor.binding) !== stableJson(model.binding)) {
      throw new Error(`Staged run identity changed; refusing to resume ${descriptor.runId || "unknown"} as ${runId}`);
    }
    if (descriptor.stagingRoot !== stagingRoot || stableJson(descriptor.stagedPaths) !== stableJson(outputConfig.roots)) {
      throw new Error("Staged run paths changed; refusing to resume from a moved or reconfigured root");
    }
  } else {
    await assertNewStagingRootIsEmpty(stagingRoot);
    descriptor = {
      schemaVersion: STAGED_RUN_SCHEMA_VERSION,
      runId,
      createdAt: new Date().toISOString(),
      binding: model.binding,
      stagingRoot,
      stagedPaths: outputConfig.roots,
      publicationApproved: false,
      note: "A completed staged run is not approval to publish, including sources under 2002 New."
    };
    await createInitialRunFiles({ runPath, journalPath, journalRoot, descriptor, runId });
  }
  const loadedJournal = await loadProgressJournal(journalPath);
  if (loadedJournal.create) {
    const handle = await fs.open(journalPath, "wx");
    await handle.close();
  }
  if (loadedJournal.truncatedBytes) {
    await fs.truncate(journalPath, loadedJournal.truncateToBytes);
    await syncPath(journalPath);
  }
  const removedTemporaryFiles = await removeLeftoverTemporaryFiles(stagingRoot);
  const journal = createProgressJournal(journalPath, loadedJournal.events);
  if (loadedJournal.truncatedBytes || removedTemporaryFiles) {
    await journal.append({ type: "recovery", truncatedJournalBytes: loadedJournal.truncatedBytes, removedTemporaryFiles });
  }
  const completionMarker = await readRunDescriptor(completePath);
  if (completionMarker && completionMarker.runId !== runId) {
    throw new Error("Completion marker belongs to a different staged run");
  }

  let generatedDerivatives = 0;
  let reusedDerivatives = 0;
  const verifiedMedia = [];
  for (const photo of selectedPhotos) {
    const assets = model.assetsByPhotoId.get(photo.id);
    const thumbnail = await ensureDerivativeArtifact({
      photo,
      asset: assets.thumbnail,
      kind: "thumbnail",
      selectedRoot: outputConfig.roots.media,
      stagingRoot,
      runId,
      journal,
      runtime
    });
    const display = await ensureDerivativeArtifact({
      photo,
      asset: assets.display,
      kind: "display",
      selectedRoot: outputConfig.roots.media,
      stagingRoot,
      runId,
      journal,
      runtime
    });
    generatedDerivatives += Number(thumbnail.generated) + Number(display.generated);
    reusedDerivatives += Number(!thumbnail.generated) + Number(!display.generated);
    verifiedMedia.push(
      {
        photoId: photo.id,
        sourcePath: photo.absolutePath,
        sourceSha256: photo.sha256,
        derivativeType: "thumbnail",
        key: assets.thumbnail.key,
        keyIdentitySha256: assets.thumbnail.keyIdentitySha256,
        recipeIdentitySha256: assets.thumbnail.recipeIdentitySha256,
        dimensions: thumbnail.dimensions,
        bytes: thumbnail.bytes,
        outputSha256: thumbnail.sha256
      },
      {
        photoId: photo.id,
        sourcePath: photo.absolutePath,
        sourceSha256: photo.sha256,
        derivativeType: "display",
        key: assets.display.key,
        keyIdentitySha256: assets.display.keyIdentitySha256,
        recipeIdentitySha256: assets.display.recipeIdentitySha256,
        dimensions: display.dimensions,
        bytes: display.bytes,
        outputSha256: display.sha256
      }
    );
  }

  for (const album of model.albumModels) {
    for (const photo of album.items) {
      const assets = model.assetsByPhotoId.get(photo.id);
      await requireRecordedDerivative({ asset: assets.thumbnail, stagingRoot, journal });
      await requireRecordedDerivative({ asset: assets.display, stagingRoot, journal });
    }
    await ensureJsonArtifact({
      value: album.manifest,
      targetPath: album.manifestPath,
      kind: "album-manifest",
      selectedRoot: outputConfig.roots.data,
      stagingRoot,
      runId,
      journal,
      runtime,
      faultPoint: "album-manifest-writing"
    });
  }
  for (const album of model.albumModels) {
    await requireRecordedJson({ targetPath: album.manifestPath, value: album.manifest, stagingRoot, journal });
  }
  const yearIndexPath = model.yearIndexPath;
  await ensureJsonArtifact({
    value: model.index,
    targetPath: yearIndexPath,
    kind: "year-index",
    selectedRoot: outputConfig.roots.data,
    stagingRoot,
    runId,
    journal,
    runtime,
    faultPoint: "year-index-writing"
  });
  for (const album of model.albumModels) {
    await requireRecordedJson({ targetPath: album.manifestPath, value: album.manifest, stagingRoot, journal });
  }
  await requireRecordedJson({ targetPath: yearIndexPath, value: model.index, stagingRoot, journal });
  const catalogPath = model.catalogPath;
  await ensureJsonArtifact({
    value: model.catalog,
    targetPath: catalogPath,
    kind: "catalog",
    selectedRoot: outputConfig.roots.data,
    stagingRoot,
    runId,
    journal,
    runtime,
    faultPoint: "catalogue-writing"
  });

  const sourceReportPath = path.join(outputConfig.roots.reports, `${args.year}-source-selection-report.json`);
  const sourceReport = {
    schemaVersion: STAGED_RUN_SCHEMA_VERSION,
    runId,
    sourceSelectionSha256: model.binding.sourceSelectionSha256,
    sourceSelection: model.sourceSelection
  };
  await ensureJsonArtifact({
    value: sourceReport,
    targetPath: sourceReportPath,
    kind: "source-report",
    selectedRoot: outputConfig.roots.reports,
    stagingRoot,
    runId,
    journal,
    runtime
  });
  const importReportPath = path.join(outputConfig.roots.reports, `${args.year}-import-report.json`);
  const stagedImportReport = {
    schemaVersion: STAGED_RUN_SCHEMA_VERSION,
    runId,
    year: args.year,
    mode: args.limit === null ? "complete" : "sample",
    sourceSelectionSha256: model.binding.sourceSelectionSha256,
    proposedManifestSetSha256: model.binding.proposedManifestSetSha256,
    photoCount: selectedPhotos.length,
    albumCount: model.albumModels.length,
    derivativeCount: selectedPhotos.length * 2,
    omissions: model.sourceSelection.omissions,
    outputLayout: model.binding.outputLayout,
    publicationEligibility: {
      eligible: sourceGate.eligibility.publicationEligible,
      freshInventorySha256: sourceGate.eligibility.freshInventorySha256,
      policySha256: sourceGate.eligibility.policySha256,
      resolved: sourceGate.eligibility.counts.resolved,
      unresolved: sourceGate.eligibility.counts.unresolved
    },
    publicationApproved: false
  };
  await ensureJsonArtifact({
    value: stagedImportReport,
    targetPath: importReportPath,
    kind: "import-report",
    selectedRoot: outputConfig.roots.reports,
    stagingRoot,
    runId,
    journal,
    runtime
  });

  const receiptPath = path.join(outputConfig.roots.reports, `${args.year}-stage-receipt.json`);
  const outputPaths = [
    ...selectedPhotos.flatMap((photo) => {
      const assets = model.assetsByPhotoId.get(photo.id);
      return [assets.thumbnail.path, assets.display.path];
    }),
    ...model.albumModels.map((album) => album.manifestPath),
    yearIndexPath,
    catalogPath,
    sourceReportPath,
    importReportPath
  ];
  const outputChecksums = [];
  for (const outputPath of outputPaths) {
    const digest = await fileDigest(outputPath);
    outputChecksums.push({ path: stagedRelativePath(stagingRoot, outputPath), ...digest });
  }
  outputChecksums.sort((left, right) => left.path.localeCompare(right.path));
  const receipt = {
    schemaVersion: STAGED_RUN_SCHEMA_VERSION,
    status: "staged-complete",
    publicationEligible: sourceGate.eligibility.publicationEligible,
    publicationApproved: false,
    runId,
    importerCommit,
    importerScriptSha256,
    sharpVersion,
    derivativeRecipe: recipe,
    contentMediaKeyVersion: CONTENT_MEDIA_KEY_VERSION,
    sourceSelectionSha256: model.binding.sourceSelectionSha256,
    proposedManifestSetSha256: model.binding.proposedManifestSetSha256,
    counts: {
      sources: selectedPhotos.length,
      albums: model.albumModels.length,
      derivatives: selectedPhotos.length * 2,
      omissions: report.unsupportedFiles.length + report.unreadableFiles.length
    },
    omissions: model.sourceSelection.omissions,
    stagedPaths: outputConfig.roots,
    sourceChecksums: model.sourceSelection.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    media: verifiedMedia.sort(
      (left, right) => left.key.localeCompare(right.key, undefined, { numeric: true }) || left.derivativeType.localeCompare(right.derivativeType)
    ),
    manifestReferences: model.proposedManifestSet.albums.map((album) => ({
      path: album.path,
      sha256: album.sha256,
      photos: album.photos
    })),
    legacyCompatibility: {
      rule: "A legacy reference may be reused only with evidence binding its exact bytes to the same source SHA-256 and encoding recipe; no such provenance is inferred from its filename.",
      reusedLegacyReferences: [],
      transitions: model.legacyTransitions,
      obsoleteButRetainedKeys: Array.from(
        new Set(model.legacyTransitions.flatMap((entry) => [entry.legacy.thumbnailKey, entry.legacy.displayKey]))
      ).sort((left, right) => left.localeCompare(right, undefined, { numeric: true })),
      deletionPlanned: false
    },
    outputChecksums,
    outputSetSha256: sha256Bytes(stableJson(outputChecksums)),
    sourcePolicy: {
      policyPath: sourceGate.policyPath,
      policySha256: sourceGate.eligibility.policySha256,
      freshInventorySha256: sourceGate.eligibility.freshInventorySha256,
      inventoryMatches: sourceGate.eligibility.inventoryMatches,
      resolvedDecisions: sourceGate.eligibility.counts.resolved,
      unresolvedDecisions: sourceGate.eligibility.counts.unresolved,
      unresolvedDecisionIds: sourceGate.eligibility.unresolvedDecisionIds
    },
    note: "This receipt verifies a local staged output set; it does not approve publication or 2002 New."
  };
  const receiptArtifact = await ensureJsonArtifact({
    value: receipt,
    targetPath: receiptPath,
    kind: "receipt",
    selectedRoot: outputConfig.roots.reports,
    stagingRoot,
    runId,
    journal,
    runtime
  });
  await journal.flush();

  const operationalPaths = [runPath, journalPath];
  const expectedWithoutComplete = new Set([...outputPaths, receiptPath, ...operationalPaths].map((filePath) => stagedRelativePath(stagingRoot, filePath)));
  if (completionMarker) {
    const expectedWithComplete = new Set([...expectedWithoutComplete, stagedRelativePath(stagingRoot, completePath)]);
    const finalAudit = await closedWorldAudit({ stagingRoot, expectedPaths: expectedWithComplete });
    const completeRelativePath = stagedRelativePath(stagingRoot, completePath);
    const preSealFiles = finalAudit.files.filter((file) => file.path !== completeRelativePath);
    const preSealSha256 = sha256Bytes(stableJson(preSealFiles));
    if (completionMarker.closedWorldSha256 !== preSealSha256 || completionMarker.receiptSha256 !== receiptArtifact.sha256) {
      throw new Error("Completed staged run no longer matches its closed-world seal");
    }
    return { receipt, receiptPath, closedWorld: finalAudit, generatedDerivatives, reusedDerivatives, resumed: true };
  }

  await invokeFault(runtime, "final-sealing", { receiptPath });
  const closedWorld = await closedWorldAudit({ stagingRoot, expectedPaths: expectedWithoutComplete });
  const completion = {
    schemaVersion: STAGED_RUN_SCHEMA_VERSION,
    runId,
    status: "complete",
    closedWorldSha256: closedWorld.sha256,
    receiptSha256: receiptArtifact.sha256,
    expectedFileCountBeforeSeal: expectedWithoutComplete.size
  };
  await atomicWriteArtifact({
    targetPath: completePath,
    selectedRoot: journalRoot,
    runId,
    writeTemporary: async (temporaryPath) => fs.writeFile(temporaryPath, jsonBytes(completion), { flag: "wx" }),
    verifyTemporary: async (temporaryPath) => verifyExactJson(temporaryPath, completion)
  });
  const finalExpected = new Set([...expectedWithoutComplete, stagedRelativePath(stagingRoot, completePath)]);
  await closedWorldAudit({ stagingRoot, expectedPaths: finalExpected });
  return { receipt, receiptPath, closedWorld, generatedDerivatives, reusedDerivatives, resumed: loadedJournal.events.length > 0 };
}

async function buildPlanReport({ args, runtime, workspace, outputConfig, sourceScope, scanned, report, selectedPhotos, albums, sourceGate, startedAt }) {
  const physicalSourceRoot = await fs.realpath(sourceScope.sourceRoot);
  const yearDataRoot = path.join(outputConfig.roots.data, "data", args.year);
  const sharpVersion = runtime.sharpVersion || sharp.versions.sharp;
  const recipe = runtime.derivativeRecipe || STAGED_RECIPE;
  const publishedMedia = await readPublishedMediaReferences(outputConfig.canonical.data, args.year);
  const expectedAssetKeys = new Set();
  const assetInspection = await mapWithConcurrency(selectedPhotos, args.concurrency, async (photo) => {
    const assets = projectedVersionedAssets(photo, outputConfig.roots.media, args.year, recipe, sharpVersion);
    expectedAssetKeys.add(assets.thumbnail.key);
    expectedAssetKeys.add(assets.display.key);
    return {
      photo,
      assets,
      thumbnail: await inspectExistingVersionedAsset(assets.thumbnail),
      display: await inspectExistingVersionedAsset(assets.display)
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
  const legacyMediaTransitions = assetInspection
    .map(({ photo, assets }) => {
      const legacy = publishedMedia.byPhotoId.get(photo.id);
      if (!legacy) return null;
      return {
        photoId: photo.id,
        sourcePath: photo.absolutePath,
        sourceSha256: photo.sha256,
        legacy: { thumbnailKey: legacy.thumbnailKey, displayKey: legacy.displayKey },
        staged: { thumbnailKey: assets.thumbnail.key, displayKey: assets.display.key },
        proposedAction: "generate-versioned-and-retain-legacy",
        reason: "The legacy filename and bytes do not prove the exact source checksum and encoding recipe."
      };
    })
    .filter(Boolean);
  const obsoleteButRetainedKeys = Array.from(
    new Set(legacyMediaTransitions.flatMap((entry) => [entry.legacy.thumbnailKey, entry.legacy.displayKey]))
  ).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
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
  if (!sourceGate.eligibility.publicationEligible) {
    unresolvedCuratorialDecisions.push({
      decision: "Resolve the exact source policy against the fresh inventory before publication",
      unresolved: sourceGate.eligibility.counts.unresolved,
      inventoryMatches: sourceGate.eligibility.inventoryMatches,
      freshInventorySha256: sourceGate.eligibility.freshInventorySha256
    });
  }

  return {
    schemaVersion: 2,
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
      concurrency: args.concurrency,
      contentVersionedMedia: {
        keyVersion: CONTENT_MEDIA_KEY_VERSION,
        sharpVersion,
        derivativeRecipe: recipe
      }
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
      legacyCompatibility: {
        rule: "Retain a legacy reference only with evidence binding its bytes to the exact source SHA-256 and recipe. Filename similarity is not evidence.",
        reusedLegacyReferences: [],
        transitions: legacyMediaTransitions,
        obsoleteButRetainedKeys,
        deletionPlanned: false
      },
      outputsThatWouldBecomeStale: {
        mediaKeys: staleMediaKeys,
        albumManifestPaths: staleManifestPaths,
        disposition: "retain; this cycle adds no deletion logic"
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
    sourcePolicy: {
      inventory: sourceGate.inspection.inventory,
      findings: sourceGate.inspection.findings,
      eligibility: sourceGate.eligibility,
      policyTemplate: sourceGate.policyTemplate,
      decisionReportMarkdown: sourceGate.decisionReportMarkdown
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
  const isStagedRun = Boolean(outputConfig.stagingRoot);
  const isCanonicalRun = !args.plan && !isStagedRun;
  const yearDataRoot = path.join(dataOutputRoot, "data", args.year);
  const albumsDataRoot = path.join(yearDataRoot, "albums");
  const importMode = args.limit === null ? "complete" : "sample";

  if (isCanonicalRun) {
    throw new Error(
      "Direct canonical photo imports are disabled. Build an isolated completed stage, then create a verified promotion package; no flag or resolved policy bypass is supported"
    );
  }

  if (!(await exists(sourceScope.sourceRoot))) {
    throw new Error(`Source folder does not exist: ${toPosixPath(path.relative(workspace.photoSourceRoot, sourceScope.sourceRoot))}`);
  }

  const sourceGate = await inspectSourceGate(args, sourceScope, workspace);
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
    const image = await classifySourceImage(filePath);
    if (image.classification === "unsupported-file") {
      report.unsupported += 1;
      report.unsupportedFiles.push({
        relativePath,
        reason: image.decodeError ? `Unsupported source content: ${image.decodeError}` : "Unsupported file extension"
      });
      return null;
    }
    if (image.classification === "unreadable-image") {
      report.unreadable += 1;
      report.unreadableFiles.push({
        relativePath,
        reason: image.decodeError || "Unreadable image"
      });
      return null;
    }

    try {
      const photo = await inspectPhoto(filePath, sourceScope, args.year, args.plan || isStagedRun, image.metadata);
      inspectedCount += 1;
      if (!args.plan && (inspectedCount % 500 === 0 || inspectedCount === scannedFiles.length - report.unsupported)) {
        writeStdout(`Inspected ${inspectedCount}/${scannedFiles.length - report.unsupported}\n`);
      }
      return { photo };
    } catch (error) {
      report.unreadable += 1;
      report.unreadableFiles.push({
        relativePath,
        reason: error instanceof Error ? error.message : "Unreadable image"
      });
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
      runtime,
      workspace,
      outputConfig,
      sourceScope,
      scanned,
      report,
      selectedPhotos,
      albums: preliminaryAlbums,
      sourceGate,
      startedAt
    });
    writeStdout(`${JSON.stringify(planReport, null, 2)}\n`);
    return planReport;
  }

  if (isStagedRun) {
    const stagedResult = await runStagedImport({
      args,
      runtime,
      outputConfig,
      sourceScope,
      scanned,
      report,
      selectedPhotos,
      albums: preliminaryAlbums,
      sourceGate
    });
    writeStdout(
      `Staged run ${stagedResult.receipt.runId} complete. Sources ${stagedResult.receipt.counts.sources}. ` +
        `Outputs ${stagedResult.receipt.outputChecksums.length}. Generated derivatives ${stagedResult.generatedDerivatives}. ` +
        `Reused verified derivatives ${stagedResult.reusedDerivatives}. Receipt ${stagedResult.receiptPath}.\n`
    );
    return stagedResult;
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
