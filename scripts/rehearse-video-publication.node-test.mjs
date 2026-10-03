import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import {
  createFilesystemObjectStore,
  createPublicationPlan,
  executePublication,
  verifyPublicationPackage
} from "./package-media-publication.mjs";
import { runVideoPublicationRehearsal } from "./rehearse-video-publication.mjs";
import { runProcess } from "./video-to-source-photos.mjs";

const SELECTED_YEAR = "2086";
const UNAFFECTED_YEAR = "2085";
let suiteRoot;
let fixture;

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function photoId(year, relativePath) {
  return `${year}-${crypto
    .createHash("sha1")
    .update(relativePath.split(path.sep).join("/"))
    .digest("hex")
    .slice(0, 14)}`;
}

function albumId(value) {
  const normalized = value.split(path.sep).join("/");
  const slug = normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `${slug}-${crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 8)}`;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function jpeg(filePath, color, width = 80, height = 60) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toFile(filePath);
}

async function ffmpeg(args) {
  return runProcess("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", ...args]);
}

async function createExistingYearFixture() {
  const root = path.join(suiteRoot, "existing-year");
  const sourceRoot = path.join(root, "original-photos");
  const canonicalDataRoot = path.join(root, "public", "data");
  const canonicalMediaRoot = path.join(root, "generated", "library");
  const objectRoot = path.join(root, "filesystem-object-store");
  const existingAlbumName = `${SELECTED_YEAR} Existing Photos`;
  const existingRelativePath = `${existingAlbumName}/existing.jpg`;
  const existingId = photoId(SELECTED_YEAR, existingRelativePath);
  const existingAlbumId = albumId(existingAlbumName);
  await jpeg(path.join(sourceRoot, existingRelativePath), "purple");

  const selectedLegacy = {
    thumbnailKey: `${SELECTED_YEAR}/thumbs/${existingId}.jpg`,
    displayKey: `${SELECTED_YEAR}/display/${existingId}.jpg`
  };
  const unaffectedId = `${UNAFFECTED_YEAR}-${"a".repeat(14)}`;
  const unaffectedAlbumId = "unaffected-album-12345678";
  const unaffectedLegacy = {
    thumbnailKey: `${UNAFFECTED_YEAR}/thumbs/${unaffectedId}.jpg`,
    displayKey: `${UNAFFECTED_YEAR}/display/${unaffectedId}.jpg`
  };
  const selectedManifest = {
    photos: [{ id: existingId, ...selectedLegacy, albumId: existingAlbumId, width: 80, height: 60, orientation: "landscape", sortPosition: 0, albumSortPosition: 0 }]
  };
  const unaffectedManifest = {
    photos: [{ id: unaffectedId, ...unaffectedLegacy, albumId: unaffectedAlbumId, width: 80, height: 60, orientation: "landscape", sortPosition: 0, albumSortPosition: 0 }]
  };
  await writeJson(path.join(canonicalDataRoot, SELECTED_YEAR, "albums", `${existingAlbumId}.json`), selectedManifest);
  await writeJson(path.join(canonicalDataRoot, SELECTED_YEAR, "index.json"), {
    year: SELECTED_YEAR,
    scannedCount: 1,
    albums: [{ id: existingAlbumId, name: existingAlbumName, count: 1, manifestUrl: `data/${SELECTED_YEAR}/albums/${existingAlbumId}.json` }],
    sequence: [{ id: existingId }]
  });
  await writeJson(path.join(canonicalDataRoot, UNAFFECTED_YEAR, "albums", `${unaffectedAlbumId}.json`), unaffectedManifest);
  await writeJson(path.join(canonicalDataRoot, UNAFFECTED_YEAR, "index.json"), {
    year: UNAFFECTED_YEAR,
    scannedCount: 1,
    albums: [{ id: unaffectedAlbumId, name: "Unaffected", count: 1, manifestUrl: `data/${UNAFFECTED_YEAR}/albums/${unaffectedAlbumId}.json` }],
    sequence: [{ id: unaffectedId }]
  });
  await writeJson(path.join(canonicalDataRoot, "catalog.json"), {
    years: [
      { year: SELECTED_YEAR, indexUrl: `data/${SELECTED_YEAR}/index.json` },
      { year: UNAFFECTED_YEAR, indexUrl: `data/${UNAFFECTED_YEAR}/index.json` }
    ]
  });
  const legacyEntries = [
    [selectedLegacy.thumbnailKey, "#330066"],
    [selectedLegacy.displayKey, "#660099"],
    [unaffectedLegacy.thumbnailKey, "#003366"],
    [unaffectedLegacy.displayKey, "#006699"]
  ];
  for (const [key, color] of legacyEntries) {
    const mediaPath = path.join(canonicalMediaRoot, key);
    await jpeg(mediaPath, color);
    await fs.mkdir(path.dirname(path.join(objectRoot, key)), { recursive: true });
    await fs.copyFile(mediaPath, path.join(objectRoot, key));
  }
  const videoPath = path.join(root, "fixture.mp4");
  await ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=5:duration=3.2",
    "-an", "-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p", "-movflags", "+faststart", videoPath
  ]);
  const result = await runVideoPublicationRehearsal({
    inputPath: videoPath,
    year: SELECTED_YEAR,
    albumTitle: "Video Album",
    rehearsalRoot: root,
    allowPreexistingObjects: true,
    writeStdout: () => {},
    importerRuntime: { importerCommit: "stage-2c-test-commit", sharpVersion: "stage-2c-test-sharp" }
  });
  return { root, sourceRoot, canonicalDataRoot, canonicalMediaRoot, objectRoot, existingAlbumName, existingId, unaffectedId, result };
}

before(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-video-stage2c-"));
  fixture = await createExistingYearFixture();
});

after(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
});

test("video stage becomes a sealed package preserving existing and unrelated albums", async () => {
  const { result } = fixture;
  assert.equal(result.promotionVerification.receipt.packageId, result.packageResult.packageId);
  assert.equal(result.publicationVerification.receipt.packageId, result.packageResult.packageId);
  assert.equal(result.packageValidation.videoPhotoCount, 4);
  assert.equal(result.report.sourceAlbumId, result.report.stagedAlbumId);
  assert.equal(result.report.photoCount, 4);
  assert.equal(result.report.derivativeCount, 10);
  assert.equal(result.packageValidation.thumbnailCount, 4);
  assert.equal(result.packageValidation.displayCount, 4);
  assert.equal(result.packageValidation.videoMediaCount, 8);
  assert.deepEqual(result.packageValidation.orientations, { landscape: 4 });
  assert.equal(result.packageResult.media.expectedMedia.length, 12);
  assert.equal(result.packageResult.media.newVersionedKeys.length, 10);
  assert.equal(result.report.publication.createdObjects, 10);
  assert.equal(result.report.publication.reusedObjects, 2);
  assert.equal(result.report.realProductionPublicationEligibilityGranted, false);
  assert.equal(result.report.safety.filesystemAdapterOnly, true);
  assert.equal(result.report.safety.networkPublicationWrites, false);

  const candidateRoot = path.join(result.packageResult.packageRoot, "candidate", "public", "data");
  const selectedIndex = JSON.parse(await fs.readFile(path.join(candidateRoot, SELECTED_YEAR, "index.json"), "utf8"));
  assert.deepEqual(selectedIndex.albums.map((album) => album.name).sort(), [`${SELECTED_YEAR} Existing Photos`, `${SELECTED_YEAR} Video Album`]);
  assert.equal(selectedIndex.sequence.length, 5);
  assert(selectedIndex.sequence.some((photo) => photo.id === fixture.existingId));
  const unaffectedIndex = JSON.parse(await fs.readFile(path.join(candidateRoot, UNAFFECTED_YEAR, "index.json"), "utf8"));
  assert.deepEqual(unaffectedIndex.sequence, [{ id: fixture.unaffectedId }]);
  assert.equal(result.publication.receipt.status, "PASS");
  assert.equal(result.publication.receipt.counts.required, 12);
});

test("filesystem publication is idempotent and receipt-bound to the exact package", async () => {
  const { result } = fixture;
  assert.equal(result.repeated.receipt.receiptSha256, result.publication.receipt.receiptSha256);
  assert.equal(result.secondPlan.counts.matchingExistingKeys, result.secondPlan.counts.requiredKeys);
  assert.equal(result.secondPlan.counts.missingApprovedNewKeys, 0);
  assert.equal(result.publication.receipt.packageId, result.packageResult.packageId);
  assert.equal(result.publication.receipt.publicationId, result.publicationVerification.publicationId);
  assert(result.publication.receipt.objects.every((entry) => entry.expectedSha256 === entry.verifiedSha256));
  assert(result.operations.every((event) => ["list", "inspect", "put-if-absent"].includes(event.operation)));
});

test("existing conflicting and unexpected filesystem objects block without overwrite", async () => {
  const packageRoot = fixture.result.packageResult.packageRoot;
  const expected = [...fixture.result.publicationVerification.newByKey.values()][0];
  const conflictRoot = path.join(fixture.root, "conflict-store");
  const conflictPath = path.join(conflictRoot, expected.key);
  await fs.mkdir(path.dirname(conflictPath), { recursive: true });
  const conflictingBytes = Buffer.alloc(expected.bytes, 120);
  await fs.writeFile(conflictPath, conflictingBytes);
  const conflictAdapter = await createFilesystemObjectStore(conflictRoot);
  const plan = await createPublicationPlan({ packageRoot, adapter: conflictAdapter });
  assert.equal(plan.counts.byteConflicts, 1);
  await assert.rejects(
    executePublication({ packageRoot, adapter: conflictAdapter, journalRoot: path.join(fixture.root, "conflict-journal") }),
    /blocked/
  );
  assert.deepEqual(await fs.readFile(conflictPath), conflictingBytes);

  const unexpectedRoot = path.join(fixture.root, "unexpected-store");
  const unexpectedKey = `${SELECTED_YEAR}/display/${SELECTED_YEAR}-${"f".repeat(14)}-cv1-${"a".repeat(64)}.jpg`;
  await fs.mkdir(path.dirname(path.join(unexpectedRoot, unexpectedKey)), { recursive: true });
  await fs.writeFile(path.join(unexpectedRoot, unexpectedKey), "unexpected");
  const unexpectedPlan = await createPublicationPlan({ packageRoot, adapter: await createFilesystemObjectStore(unexpectedRoot) });
  assert.equal(unexpectedPlan.counts.unexpectedRemoteKeys, 1);
  assert.equal(unexpectedPlan.executable, false);
});

test("tampered media, public data, inventory, package metadata, and unexpected package files fail verification", async () => {
  const original = fixture.result.packageResult.packageRoot;
  const firstNewKey = fixture.result.packageResult.media.newVersionedKeys[0].key;
  const targetManifest = fixture.result.packageValidation.targetManifestPath;
  const variants = [
    ["modified-media", async (root) => fs.appendFile(path.join(root, "media", "new", firstNewKey), "tamper")],
    ["missing-media", async (root) => fs.unlink(path.join(root, "media", "new", firstNewKey))],
    ["modified-manifest", async (root) => fs.appendFile(path.join(root, "candidate", "public", "data", targetManifest), " ")],
    ["modified-package", async (root) => fs.appendFile(path.join(root, "package.json"), " ")],
    ["modified-seal", async (root) => {
      const sealPath = path.join(root, "complete.json");
      const seal = JSON.parse(await fs.readFile(sealPath, "utf8"));
      await writeJson(sealPath, { ...seal, closedWorldSha256: "0".repeat(64) });
    }],
    ["unexpected-public", async (root) => writeJson(path.join(root, "candidate", "public", "data", "unexpected.json"), {})],
    ["altered-inventory", async (root) => fs.appendFile(path.join(root, "inventories", "media.json"), " ")]
  ];
  for (const [name, mutate] of variants) {
    const clone = path.join(fixture.root, `tamper-${name}`);
    await fs.cp(original, clone, { recursive: true });
    await mutate(clone);
    await assert.rejects(verifyPublicationPackage(clone), /closed-world|checksum|inventory|identity|invalid JSON/i, name);
  }
});

test("portrait video remains portrait in packaged and filesystem-published derivatives", async () => {
  const root = path.join(suiteRoot, "portrait");
  await writeJson(path.join(root, "public", "data", "catalog.json"), { years: [] });
  await fs.mkdir(path.join(root, "generated", "library"), { recursive: true });
  const base = path.join(root, "base.mov");
  const rotated = path.join(root, "portrait.mov");
  await ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=5:duration=2",
    "-an", "-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p", base
  ]);
  await ffmpeg(["-display_rotation:v:0", "90", "-i", base, "-c", "copy", rotated]);
  const result = await runVideoPublicationRehearsal({
    inputPath: rotated,
    year: "2084",
    albumTitle: "Portrait Video",
    rehearsalRoot: root,
    writeStdout: () => {},
    importerRuntime: { importerCommit: "stage-2c-test-commit", sharpVersion: "stage-2c-test-sharp" }
  });
  assert.deepEqual(result.packageValidation.orientations, { portrait: 2 });
  const manifest = result.publicationVerification.manifestMap.manifests.find((entry) => entry.manifestPath.endsWith(`/${result.eligibleStage.stagedAlbum.albumId}.json`));
  for (const photo of manifest.photos) {
    const displayPath = path.join(root, "filesystem-object-store", photo.displayKey);
    const metadata = await sharp(displayPath).metadata();
    assert(metadata.height > metadata.width);
  }
  assert.equal(result.publication.receipt.counts.required, 4);
});
