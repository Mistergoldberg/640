import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_ROOT, "..");
const ARCHIVE_ROOT = path.resolve(APP_ROOT, "..");
const MEDIA_ROOT = path.join(ARCHIVE_ROOT, "generated", "library");
const REPORT_ROOT = path.join(ARCHIVE_ROOT, "generated", "reports");
const REPORT_PATH = path.join(REPORT_ROOT, "public-release-audit.json");
const PUBLIC_DATA_ROOT = path.join(APP_ROOT, "public", "data");
const DISPLAY_MAX_WIDTH = 640;
const DISPLAY_MAX_HEIGHT = 480;
const THUMB_MAX_WIDTH = 300;
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff", ".heic", ".heif"]);
const EXPECTED_PUBLIC_FIELDS = {
  catalog: new Set(["years"]),
  catalogYear: new Set(["year", "indexUrl"]),
  index: new Set(["year", "scannedCount", "albums", "sequence"]),
  albumSummary: new Set(["id", "name", "count", "manifestUrl"]),
  sequenceItem: new Set(["id"]),
  albumManifest: new Set(["photos"]),
  photo: new Set(["id", "thumbnailKey", "displayKey", "albumId", "width", "height", "orientation", "sortPosition", "albumSortPosition"])
};
const REMOVED_PUBLIC_FIELDS = [
  "filename",
  "album",
  "captureTime",
  "dateSource",
  "sourceWidth",
  "sourceHeight",
  "rawWidth",
  "rawHeight",
  "exifOrientation",
  "thumbnailWidth",
  "thumbnailHeight",
  "generatedAt",
  "mode",
  "sampleLimit",
  "totalPhotoCount",
  "unreadableCount",
  "unsupportedCount",
  "duplicateCount",
  "captureDateRange",
  "sortDateRange"
];
const PUBLIC_PATH_PATTERNS = [
  /\/Users\//i,
  /\\Users\\/i,
  /jaredgoldberg/i,
  /Desktop\/jaredgoldberg\.ca/i,
  /file:\/\//i,
  /localhost/i,
  /127\.0\.0\.1/i,
  /app\/public\/library/i,
  /public\/library/i,
  /(?:^|\/)library\/(?:19|20)\d{2}\//i,
  /\.\.\//
];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isInsideOrEqual(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function addSample(list, value, limit = 25) {
  if (list.length < limit) {
    list.push(value);
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

async function walkEntries(root) {
  const entries = [];

  async function walk(current) {
    const children = await fs.readdir(current, { withFileTypes: true });
    for (const child of children) {
      const absolutePath = path.join(current, child.name);
      const relativePath = toPosix(path.relative(root, absolutePath));
      const stat = await fs.lstat(absolutePath);
      if (stat.isDirectory()) {
        entries.push({ absolutePath, relativePath, type: "directory", stat });
        await walk(absolutePath);
      } else if (stat.isSymbolicLink()) {
        let target = null;
        let escapesRoot = true;
        try {
          target = await fs.realpath(absolutePath);
          escapesRoot = !isInsideOrEqual(target, root);
        } catch {
          target = null;
        }
        entries.push({ absolutePath, relativePath, type: "symlink", stat, target, escapesRoot });
      } else if (stat.isFile()) {
        entries.push({ absolutePath, relativePath, type: "file", stat });
      } else {
        entries.push({ absolutePath, relativePath, type: "other", stat });
      }
    }
  }

  await walk(root);
  return entries;
}

function mimeFromBytes(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  const ascii = buffer.toString("ascii", 0, Math.min(buffer.length, 16));
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (buffer.length >= 12 && ascii.startsWith("RIFF") && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (
    buffer.length >= 4 &&
    ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a))
  ) {
    return "image/tiff";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 16);
    if (/heic|heix|hevc|hevx/.test(brand)) return "image/heic";
    if (/mif1|msf1|heif/.test(brand)) return "image/heif";
  }
  return "application/octet-stream";
}

function expectedMimeForExtension(extension) {
  const normalized = extension.toLowerCase();
  if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";
  if (normalized === ".png") return "image/png";
  if (normalized === ".webp") return "image/webp";
  if (normalized === ".gif") return "image/gif";
  if (normalized === ".tif" || normalized === ".tiff") return "image/tiff";
  if (normalized === ".heic") return "image/heic";
  if (normalized === ".heif") return "image/heif";
  return null;
}

function derivativeType(assetKey) {
  if (/\/thumbs\//.test(assetKey)) return "thumbs";
  if (/\/display\//.test(assetKey)) return "display";
  return "unknown";
}

function isSafeAssetKey(assetKey) {
  return /^(?:19|20)\d{2}\/(?:thumbs|display)\/(?:19|20)\d{2}-[a-f0-9]{14}\.(?:jpg|jpeg|png|webp|gif|tif|tiff|heic|heif)$/i.test(assetKey);
}

function inspectJpegMarkers(buffer) {
  const findings = [];
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return findings;
  }

  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xda || marker === 0xd9) {
      break;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      continue;
    }
    if (offset + 2 > buffer.length) {
      break;
    }

    const length = buffer.readUInt16BE(offset);
    const segmentStart = offset + 2;
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > buffer.length) {
      break;
    }

    const segment = buffer.subarray(segmentStart, segmentEnd);
    const prefix = segment.toString("latin1", 0, Math.min(segment.length, 80));
    if (marker === 0xe1 && prefix.startsWith("Exif")) findings.push("exif");
    if (marker === 0xe1 && prefix.includes("http://ns.adobe.com/xap/1.0/")) findings.push("xmp");
    if (marker === 0xed) findings.push("photoshop-iptc");
    if (marker === 0xfe) findings.push("comment");
    if (marker === 0xe0 && prefix.startsWith("JFXX")) findings.push("embedded-thumbnail");
    offset = segmentEnd;
  }

  return findings;
}

function hasPrivateMetadata(metadata, buffer) {
  const findings = [];
  if (metadata.exif) findings.push("exif");
  if (metadata.xmp) findings.push("xmp");
  if (metadata.iptc) findings.push("iptc");
  if (metadata.tifftagPhotoshop) findings.push("photoshop");
  if (Array.isArray(metadata.comments) && metadata.comments.length > 0) findings.push("comments");
  findings.push(...inspectJpegMarkers(buffer));
  return Array.from(new Set(findings));
}

async function decodeImage(filePath) {
  const image = sharp(filePath, { failOn: "error", limitInputPixels: false });
  const metadata = await image.metadata();
  await sharp(filePath, { failOn: "error", limitInputPixels: false }).resize({ width: 1, height: 1, fit: "inside" }).toBuffer();
  return metadata;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function unexpectedKeys(object, expected, location) {
  return Object.keys(object)
    .filter((key) => !expected.has(key))
    .map((key) => ({ location, key }));
}

function scanStrings(value, location, findings) {
  if (typeof value === "string") {
    for (const pattern of PUBLIC_PATH_PATTERNS) {
      if (pattern.test(value)) {
        addSample(findings, { location, value, pattern: String(pattern) });
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanStrings(entry, `${location}[${index}]`, findings));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      scanStrings(entry, `${location}.${key}`, findings);
    }
  }
}

function auditAlbumLabel(label, location) {
  const reasons = [];
  if (/[\\/]/.test(label)) reasons.push("contains path separator");
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(label)) reasons.push("contains email-like text");
  if (/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/.test(label)) reasons.push("contains phone-like text");
  if (/\b(?:street|st\.|road|rd\.|avenue|ave\.|boulevard|blvd\.|drive|dr\.|lane|ln\.|court|ct\.|suite|apt|unit)\b/i.test(label)) {
    reasons.push("contains address-like text");
  }
  if (/^[A-Za-z]:\\|^\/(?:Users|home|Volumes)\//.test(label)) reasons.push("looks like a filesystem path");
  return reasons.length ? { location, label, reasons } : null;
}

async function auditPublicData(report) {
  const catalogPath = path.join(PUBLIC_DATA_ROOT, "catalog.json");
  const publicFiles = await walkEntries(PUBLIC_DATA_ROOT);
  const publicImportReports = publicFiles
    .filter((entry) => entry.type === "file" && /import-report\.json$/i.test(entry.relativePath))
    .map((entry) => entry.relativePath);
  report.publicData.files = publicFiles.filter((entry) => entry.type === "file").length;
  report.publicData.publicImportReports = publicImportReports;

  const catalog = await readJson(catalogPath);
  report.publicData.unexpectedFields.push(...unexpectedKeys(catalog, EXPECTED_PUBLIC_FIELDS.catalog, "catalog"));
  scanStrings(catalog, "catalog", report.publicData.absoluteOrLocalPaths);

  const referencedKeys = new Set();
  const photoDimensionsByDisplayKey = new Map();
  const years = Array.isArray(catalog.years) ? catalog.years : [];

  for (const yearEntry of years) {
    report.publicData.unexpectedFields.push(...unexpectedKeys(yearEntry, EXPECTED_PUBLIC_FIELDS.catalogYear, `catalog.years[${yearEntry.year}]`));
    if (!/^(?:19|20)\d{2}$/.test(String(yearEntry.year))) {
      addSample(report.publicData.malformedYearEntries, yearEntry);
    }
    if (typeof yearEntry.indexUrl !== "string" || !yearEntry.indexUrl.startsWith(`data/${yearEntry.year}/`)) {
      addSample(report.publicData.malformedIndexUrls, yearEntry);
      continue;
    }

    const index = await readJson(path.join(APP_ROOT, "public", yearEntry.indexUrl));
    report.publicData.unexpectedFields.push(...unexpectedKeys(index, EXPECTED_PUBLIC_FIELDS.index, `${yearEntry.year}.index`));
    scanStrings(index, `${yearEntry.year}.index`, report.publicData.absoluteOrLocalPaths);

    const albums = Array.isArray(index.albums) ? index.albums : [];
    const sequence = Array.isArray(index.sequence) ? index.sequence : [];
    const sequenceIds = new Set();
    for (const item of sequence) {
      report.publicData.unexpectedFields.push(...unexpectedKeys(item, EXPECTED_PUBLIC_FIELDS.sequenceItem, `${yearEntry.year}.sequence`));
      if (!item.id || sequenceIds.has(item.id)) {
        addSample(report.manifests.sequenceIssues, { year: yearEntry.year, item });
      }
      sequenceIds.add(item.id);
    }

    const manifestPhotoIds = new Set();
    let albumPhotoCount = 0;
    for (const album of albums) {
      report.publicData.unexpectedFields.push(...unexpectedKeys(album, EXPECTED_PUBLIC_FIELDS.albumSummary, `${yearEntry.year}.albums.${album.id}`));
      if (typeof album.name === "string") {
        const flagged = auditAlbumLabel(album.name, `${yearEntry.year}.albums.${album.id}.name`);
        if (flagged) report.publicData.albumLabelsForReview.push(flagged);
      }
      if (typeof album.manifestUrl !== "string" || !album.manifestUrl.startsWith(`data/${yearEntry.year}/albums/`)) {
        addSample(report.publicData.malformedManifestUrls, { year: yearEntry.year, album });
        continue;
      }

      const manifest = await readJson(path.join(APP_ROOT, "public", album.manifestUrl));
      report.publicData.unexpectedFields.push(...unexpectedKeys(manifest, EXPECTED_PUBLIC_FIELDS.albumManifest, `${yearEntry.year}.albumManifest.${album.id}`));
      scanStrings(manifest, `${yearEntry.year}.albumManifest.${album.id}`, report.publicData.absoluteOrLocalPaths);

      const photos = Array.isArray(manifest.photos) ? manifest.photos : [];
      if (photos.length !== album.count) {
        addSample(report.manifests.albumCountMismatches, { year: yearEntry.year, albumId: album.id, albumCount: album.count, manifestCount: photos.length });
      }
      albumPhotoCount += photos.length;

      for (const photo of photos) {
        report.publicData.unexpectedFields.push(...unexpectedKeys(photo, EXPECTED_PUBLIC_FIELDS.photo, `${yearEntry.year}.photo.${photo.id}`));
        if (manifestPhotoIds.has(photo.id)) {
          addSample(report.manifests.duplicatePhotoIds, { year: yearEntry.year, id: photo.id });
        }
        manifestPhotoIds.add(photo.id);
        if (!sequenceIds.has(photo.id)) {
          addSample(report.manifests.photosMissingFromSequence, { year: yearEntry.year, id: photo.id });
        }

        for (const key of [photo.thumbnailKey, photo.displayKey]) {
          if (typeof key !== "string" || !isSafeAssetKey(key)) {
            addSample(report.media.unsafeAssetKeys, { year: yearEntry.year, photoId: photo.id, key });
          } else {
            referencedKeys.add(key);
          }
        }

        if (typeof photo.displayKey === "string") {
          photoDimensionsByDisplayKey.set(photo.displayKey, { width: photo.width, height: photo.height, orientation: photo.orientation, photoId: photo.id });
        }
      }
    }

    if (sequence.length !== albumPhotoCount) {
      addSample(report.manifests.sequenceCountMismatches, { year: yearEntry.year, sequenceCount: sequence.length, albumPhotoCount });
    }
    for (const item of sequence) {
      if (!manifestPhotoIds.has(item.id)) {
        addSample(report.manifests.sequenceIdsMissingFromManifest, { year: yearEntry.year, id: item.id });
      }
    }
  }

  report.media.referencedAssetCount = referencedKeys.size;
  return { referencedKeys, photoDimensionsByDisplayKey };
}

async function auditMedia(report, referencedKeys, photoDimensionsByDisplayKey) {
  if (!(await pathExists(MEDIA_ROOT))) {
    report.blockers.push("Generated media directory is missing");
    return;
  }

  const entries = await walkEntries(MEDIA_ROOT);
  const files = entries.filter((entry) => entry.type === "file");
  const fileKeySet = new Set(files.map((entry) => entry.relativePath));
  report.media.generatedImageCount = files.length;
  report.media.totalBytes = files.reduce((sum, entry) => sum + entry.stat.size, 0);

  for (const entry of entries) {
    if (entry.type === "symlink") {
      addSample(report.media.symlinks, { path: entry.relativePath, target: entry.target, escapesRoot: entry.escapesRoot });
    } else if (entry.type === "other") {
      addSample(report.media.nonRegularEntries, { path: entry.relativePath, type: entry.type });
    }
  }

  for (const key of referencedKeys) {
    if (!fileKeySet.has(key)) {
      addSample(report.media.missingReferencedAssets, key, 200);
    }
  }

  for (const fileKey of fileKeySet) {
    if (!referencedKeys.has(fileKey)) {
      addSample(report.media.unreferencedGeneratedAssets, fileKey, 200);
    }
  }

  let audited = 0;
  for (const file of files) {
    audited += 1;
    if (audited % 2500 === 0) {
      process.stdout.write(`Audited media ${audited}/${files.length}\n`);
    }

    const key = file.relativePath;
    const extension = path.extname(key).toLowerCase();
    const type = derivativeType(key);
    const formatBucket = extension.replace(/^\./, "") || "none";
    report.media.countsByDerivativeType[type] = (report.media.countsByDerivativeType[type] || 0) + 1;
    report.media.countsByFormat[formatBucket] = (report.media.countsByFormat[formatBucket] || 0) + 1;

    if (!ALLOWED_EXTENSIONS.has(extension) || !isSafeAssetKey(key)) {
      addSample(report.media.unsafeAssetKeys, { key, reason: "unexpected generated media path" });
    }

    const buffer = await fs.readFile(file.absolutePath);
    const actualMime = mimeFromBytes(buffer);
    const expectedMime = expectedMimeForExtension(extension);
    if (!expectedMime || actualMime !== expectedMime) {
      addSample(report.media.invalidMimeTypes, { key, expectedMime, actualMime });
      continue;
    }

    let metadata;
    try {
      metadata = await decodeImage(file.absolutePath);
    } catch (error) {
      addSample(report.media.decodeFailures, { key, reason: error instanceof Error ? error.message : "Decode failed" });
      continue;
    }

    const metadataFindings = hasPrivateMetadata(metadata, buffer);
    if (metadataFindings.length) {
      addSample(report.media.filesContainingEmbeddedMetadata, { key, metadata: metadataFindings }, 200);
    }
    if (metadata.icc) {
      report.media.colorProfileFiles += 1;
    }
    if (metadata.orientation && metadata.orientation !== 1) {
      addSample(report.media.orientationTags, { key, orientation: metadata.orientation });
    }

    const width = metadata.width || 0;
    const height = metadata.height || 0;
    if (type === "display") {
      const expected = photoDimensionsByDisplayKey.get(key);
      if (!expected || expected.width !== width || expected.height !== height) {
        addSample(report.media.dimensionMismatches, { key, expected, actual: { width, height } }, 200);
      }
      if (width > DISPLAY_MAX_WIDTH || height > DISPLAY_MAX_HEIGHT) {
        addSample(report.media.filesOutsideSizeLimits, { key, type, width, height, maxWidth: DISPLAY_MAX_WIDTH, maxHeight: DISPLAY_MAX_HEIGHT });
      }
    } else if (type === "thumbs") {
      if (width > THUMB_MAX_WIDTH) {
        addSample(report.media.filesOutsideSizeLimits, { key, type, width, height, maxWidth: THUMB_MAX_WIDTH });
      }
    } else {
      addSample(report.media.filesOutsideSizeLimits, { key, type, width, height, reason: "unknown derivative type" });
    }
  }
}

function collectBlockers(report) {
  const blockers = [];
  const checks = [
    ["symlinks in generated media", report.media.symlinks.length],
    ["non-regular generated media entries", report.media.nonRegularEntries.length],
    ["invalid media MIME types", report.media.invalidMimeTypes.length],
    ["media decode failures", report.media.decodeFailures.length],
    ["embedded private metadata in derivatives", report.media.filesContainingEmbeddedMetadata.length],
    ["missing referenced assets", report.media.missingReferencedAssets.length],
    ["unreferenced generated assets", report.media.unreferencedGeneratedAssets.length],
    ["media dimension mismatches", report.media.dimensionMismatches.length],
    ["media files outside size limits", report.media.filesOutsideSizeLimits.length],
    ["unsafe or malformed asset keys", report.media.unsafeAssetKeys.length],
    ["public import reports", report.publicData.publicImportReports.length],
    ["absolute or local paths in public data", report.publicData.absoluteOrLocalPaths.length],
    ["unexpected public manifest fields", report.publicData.unexpectedFields.length],
    ["malformed catalog year entries", report.publicData.malformedYearEntries.length],
    ["malformed index URLs", report.publicData.malformedIndexUrls.length],
    ["malformed manifest URLs", report.publicData.malformedManifestUrls.length],
    ["manifest sequence issues", report.manifests.sequenceIssues.length],
    ["duplicate public photo ids", report.manifests.duplicatePhotoIds.length],
    ["album count mismatches", report.manifests.albumCountMismatches.length],
    ["sequence count mismatches", report.manifests.sequenceCountMismatches.length],
    ["sequence ids missing from manifests", report.manifests.sequenceIdsMissingFromManifest.length],
    ["photos missing from sequence", report.manifests.photosMissingFromSequence.length]
  ];

  for (const [label, count] of checks) {
    if (count > 0) {
      blockers.push(`${label}: ${count}`);
    }
  }

  return blockers;
}

async function main() {
  const startedAt = Date.now();
  const report = {
    generatedAt: new Date().toISOString(),
    roots: {
      appRoot: APP_ROOT,
      mediaRoot: MEDIA_ROOT,
      publicDataRoot: PUBLIC_DATA_ROOT,
      reportPath: REPORT_PATH
    },
    media: {
      generatedImageCount: 0,
      totalBytes: 0,
      countsByDerivativeType: {},
      countsByFormat: {},
      referencedAssetCount: 0,
      missingReferencedAssets: [],
      unreferencedGeneratedAssets: [],
      invalidMimeTypes: [],
      decodeFailures: [],
      dimensionMismatches: [],
      filesContainingEmbeddedMetadata: [],
      filesOutsideSizeLimits: [],
      unsafeAssetKeys: [],
      symlinks: [],
      nonRegularEntries: [],
      orientationTags: [],
      colorProfileFiles: 0
    },
    publicData: {
      files: 0,
      publicImportReports: [],
      absoluteOrLocalPaths: [],
      unexpectedFields: [],
      removedUnusedPublicManifestFields: REMOVED_PUBLIC_FIELDS,
      albumLabelsForReview: [],
      malformedYearEntries: [],
      malformedIndexUrls: [],
      malformedManifestUrls: []
    },
    manifests: {
      sequenceIssues: [],
      duplicatePhotoIds: [],
      albumCountMismatches: [],
      sequenceCountMismatches: [],
      sequenceIdsMissingFromManifest: [],
      photosMissingFromSequence: []
    },
    blockers: [],
    passed: false,
    durationMs: 0
  };

  try {
    const { referencedKeys, photoDimensionsByDisplayKey } = await auditPublicData(report);
    await auditMedia(report, referencedKeys, photoDimensionsByDisplayKey);
  } catch (error) {
    report.blockers.push(error instanceof Error ? error.message : String(error));
  }

  report.blockers.push(...collectBlockers(report));
  report.blockers = Array.from(new Set(report.blockers));
  report.passed = report.blockers.length === 0;
  report.durationMs = Date.now() - startedAt;

  await fs.mkdir(REPORT_ROOT, { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

  const mib = (report.media.totalBytes / 1024 / 1024).toFixed(2);
  process.stdout.write(
    [
      `Public release audit ${report.passed ? "passed" : "failed"}.`,
      `Generated images ${report.media.generatedImageCount}.`,
      `Referenced assets ${report.media.referencedAssetCount}.`,
      `Bytes ${mib} MiB.`,
      `Metadata findings ${report.media.filesContainingEmbeddedMetadata.length}.`,
      `Missing ${report.media.missingReferencedAssets.length}.`,
      `Unreferenced ${report.media.unreferencedGeneratedAssets.length}.`,
      `Album labels for review ${report.publicData.albumLabelsForReview.length}.`,
      `Report ${toPosix(path.relative(APP_ROOT, REPORT_PATH))}.`
    ].join(" ") + "\n"
  );

  if (!report.passed) {
    for (const blocker of report.blockers) {
      process.stderr.write(`Blocker: ${blocker}\n`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
