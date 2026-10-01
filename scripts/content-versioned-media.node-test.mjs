import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { contentVersionedMediaAsset, isSupportedMediaKey } from "./content-versioned-media.mjs";
import { runImporter } from "./import-photos.mjs";

const YEAR = "2094";
const RECIPE = {
  version: 1,
  thumbnail: { width: 300, withoutEnlargement: true, format: "jpeg", quality: 76, mozjpeg: true, autoOrient: true },
  display: { width: 640, height: 480, fit: "inside", withoutEnlargement: true, format: "jpeg", quality: 84, mozjpeg: true, autoOrient: true },
  json: { indentation: 2, trailingNewline: true }
};

async function jpeg(filePath, color = { r: 40, g: 80, b: 120 }) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp({ create: { width: 48, height: 32, channels: 3, background: color } }).jpeg().toFile(filePath);
}

async function digest(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function fixture({ identical = false, publishedLegacy = false } = {}) {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-content-media-"));
  const sourceFolder = path.join(appRoot, "original-photos", `${YEAR} Source`);
  const first = path.join(sourceFolder, "Album A", "one.jpg");
  const second = path.join(sourceFolder, "Album B", "two.jpg");
  await jpeg(first);
  if (identical) {
    await fs.mkdir(path.dirname(second), { recursive: true });
    await fs.copyFile(first, second);
  } else {
    await jpeg(second, { r: 180, g: 20, b: 60 });
  }
  await fs.mkdir(path.join(appRoot, "public", "data"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "public", "data", "catalog.json"), '{"years":[]}\n');
  await fs.mkdir(path.join(appRoot, "generated", "library"), { recursive: true });
  await fs.mkdir(path.join(appRoot, "generated", "reports"), { recursive: true });

  if (publishedLegacy) {
    const firstRelative = `${YEAR} Source/Album A/one.jpg`;
    const secondRelative = `${YEAR} Source/Album B/two.jpg`;
    const photoId = (relative) => `${YEAR}-${crypto.createHash("sha1").update(relative).digest("hex").slice(0, 14)}`;
    const albumId = (name) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${crypto.createHash("sha1").update(name).digest("hex").slice(0, 8)}`;
    const albums = [
      { id: albumId("Album A"), name: "Album A", photo: photoId(firstRelative) },
      { id: albumId("Album B"), name: "Album B", photo: photoId(secondRelative) }
    ];
    await fs.mkdir(path.join(appRoot, "public", "data", YEAR, "albums"), { recursive: true });
    for (const album of albums) {
      const thumbnailKey = `${YEAR}/thumbs/${album.photo}.jpg`;
      const displayKey = `${YEAR}/display/${album.photo}.jpg`;
      await jpeg(path.join(appRoot, "generated", "library", thumbnailKey), { r: 1, g: 2, b: 3 });
      await jpeg(path.join(appRoot, "generated", "library", displayKey), { r: 4, g: 5, b: 6 });
      await fs.writeFile(
        path.join(appRoot, "public", "data", YEAR, "albums", `${album.id}.json`),
        `${JSON.stringify({ photos: [{ id: album.photo, thumbnailKey, displayKey, albumId: album.id }] }, null, 2)}\n`
      );
    }
    await fs.writeFile(
      path.join(appRoot, "public", "data", YEAR, "index.json"),
      `${JSON.stringify({ year: YEAR, albums: albums.map((album) => ({ ...album, manifestUrl: `data/${YEAR}/albums/${album.id}.json` })) }, null, 2)}\n`
    );
  }
  return { appRoot, sourceFolder, first, second };
}

function runtime(appRoot, overrides = {}) {
  return { appRoot, importerCommit: "content-media-test", sharpVersion: "sharp-test", writeStdout: () => {}, ...overrides };
}

async function stage(appRoot, stagingRoot, overrides = {}) {
  return runImporter(["--year", YEAR, "--staging-root", stagingRoot], runtime(appRoot, overrides));
}

async function fileLedger(root) {
  const records = [];
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) records.push({ path: path.relative(root, absolute).split(path.sep).join("/"), sha256: await digest(absolute) });
    }
  }
  await walk(root);
  return records;
}

test("key derivation changes for source bytes, recipe, derivative type, and path-derived photo identity", () => {
  const base = { year: YEAR, photoId: `${YEAR}-${"1".repeat(14)}`, sourceSha256: "a".repeat(64), recipe: RECIPE, sharpVersion: "sharp-test" };
  const thumbnail = contentVersionedMediaAsset({ ...base, derivativeType: "thumbnail" });
  assert.deepEqual(contentVersionedMediaAsset({ ...base, derivativeType: "thumbnail" }), thumbnail);
  assert.notEqual(contentVersionedMediaAsset({ ...base, sourceSha256: "b".repeat(64), derivativeType: "thumbnail" }).key, thumbnail.key);
  assert.notEqual(contentVersionedMediaAsset({ ...base, recipe: { ...RECIPE, version: 2 }, derivativeType: "thumbnail" }).key, thumbnail.key);
  assert.notEqual(contentVersionedMediaAsset({ ...base, derivativeType: "display" }).key, thumbnail.key);
  assert.notEqual(contentVersionedMediaAsset({ ...base, photoId: `${YEAR}-${"2".repeat(14)}`, derivativeType: "thumbnail" }).key, thumbnail.key);
  assert.match(thumbnail.key, new RegExp(`^${YEAR}/thumbs/${YEAR}-${"1".repeat(14)}-cv1-[a-f0-9]{64}\\.jpg$`));
  assert.equal(isSupportedMediaKey(thumbnail.key), true);
  assert.equal(isSupportedMediaKey(`${YEAR}/thumbs/${YEAR}-${"a".repeat(14)}.jpg`), true);
  assert.equal(isSupportedMediaKey(`${YEAR}/thumbs/${YEAR}-${"a".repeat(14)}-cv1-short.jpg`), false);
});

test("identical content at different paths keeps separate photo IDs and content-versioned keys", async (t) => {
  const item = await fixture({ identical: true });
  t.after(() => fs.rm(item.appRoot, { recursive: true, force: true }));
  const plan = await runImporter(["--plan", "--year", YEAR], runtime(item.appRoot));
  assert.equal(plan.observedFacts.duplicateContentGroups.length, 1);
  const photos = plan.observedFacts.photos;
  assert.equal(new Set(photos.map((photo) => photo.sourceSha256)).size, 1);
  assert.equal(new Set(photos.map((photo) => photo.proposedPhotoId)).size, 2);
  assert.equal(new Set(photos.map((photo) => photo.proposedOutputs.thumbnail.key)).size, 2);
});

test("renaming a source follows the existing path-derived photo ID rule and therefore creates new keys", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.appRoot, { recursive: true, force: true }));
  const before = await runImporter(["--plan", "--year", YEAR], runtime(item.appRoot));
  const sourceSha256 = await digest(item.second);
  const beforePhoto = before.observedFacts.photos.find((photo) => photo.sourceSha256 === sourceSha256);
  const renamed = path.join(path.dirname(item.second), "renamed.jpg");
  await fs.rename(item.second, renamed);
  const after = await runImporter(["--plan", "--year", YEAR], runtime(item.appRoot));
  const afterPhoto = after.observedFacts.photos.find((photo) => photo.sourceSha256 === sourceSha256);
  assert.notEqual(afterPhoto.proposedPhotoId, beforePhoto.proposedPhotoId);
  assert.notEqual(afterPhoto.proposedOutputs.thumbnail.key, beforePhoto.proposedOutputs.thumbnail.key);
  assert.notEqual(afterPhoto.proposedOutputs.display.key, beforePhoto.proposedOutputs.display.key);
});

test("changed bytes and recipe create new keys in fresh stages while the original stage remains intact", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.appRoot, { recursive: true, force: true }));
  const stageOneRoot = path.join(item.appRoot, "stages", "one");
  const firstRun = await stage(item.appRoot, stageOneRoot);
  const firstLedger = await fileLedger(stageOneRoot);
  const firstPhoto = firstRun.receipt.media.filter((asset) => asset.sourcePath === item.first).map((asset) => asset.key).sort();

  await jpeg(item.first, { r: 2, g: 3, b: 4 });
  const secondRun = await stage(item.appRoot, path.join(item.appRoot, "stages", "two"));
  const secondPhoto = secondRun.receipt.media.filter((asset) => asset.sourcePath === item.first).map((asset) => asset.key).sort();
  assert.notDeepEqual(secondPhoto, firstPhoto);
  assert.deepEqual(await fileLedger(stageOneRoot), firstLedger);

  const thirdRun = await stage(item.appRoot, path.join(item.appRoot, "stages", "three"), { derivativeRecipe: { ...RECIPE, version: 2 } });
  assert.notDeepEqual(
    thirdRun.receipt.media.map((asset) => asset.key).sort(),
    secondRun.receipt.media.map((asset) => asset.key).sort()
  );
});

test("an unjournaled existing key with different bytes fails closed without overwrite", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.appRoot, { recursive: true, force: true }));
  const stagingRoot = path.join(item.appRoot, "stages", "collision");
  let fired = false;
  await assert.rejects(
    stage(item.appRoot, stagingRoot, {
      injectFault: async (point) => {
        if (!fired && point === "thumbnail-generation") {
          fired = true;
          throw new Error("stop after first thumbnail");
        }
      }
    }),
    /stop after first thumbnail/
  );
  const run = JSON.parse(await fs.readFile(path.join(stagingRoot, "generated", "journal", "run.json"), "utf8"));
  const unjournaled = run.binding.mediaKeySet.find((asset) => asset.derivativeType === "display");
  const collisionPath = path.join(stagingRoot, "generated", "library", unjournaled.key);
  await fs.mkdir(path.dirname(collisionPath), { recursive: true });
  await fs.writeFile(collisionPath, "different bytes\n");
  const collisionSha = await digest(collisionPath);
  await assert.rejects(stage(item.appRoot, stagingRoot), /key collision without matching run provenance/);
  assert.equal(await digest(collisionPath), collisionSha);
});

test("staging retains the complete legacy rollback set and binds new manifest references to receipt checksums", async (t) => {
  const item = await fixture({ publishedLegacy: true });
  t.after(() => fs.rm(item.appRoot, { recursive: true, force: true }));
  const canonicalRoots = [path.join(item.appRoot, "public"), path.join(item.appRoot, "generated", "library"), path.join(item.appRoot, "generated", "reports")];
  const before = await Promise.all(canonicalRoots.map(fileLedger));
  const plan = await runImporter(["--plan", "--year", YEAR], runtime(item.appRoot));
  assert.equal(plan.observedFacts.legacyCompatibility.transitions.length, 2);
  assert.equal(plan.observedFacts.legacyCompatibility.obsoleteButRetainedKeys.length, 4);
  assert.deepEqual(plan.observedFacts.legacyCompatibility.reusedLegacyReferences, []);
  assert.equal(plan.observedFacts.legacyCompatibility.deletionPlanned, false);
  const result = await stage(item.appRoot, path.join(item.appRoot, "stages", "legacy"));
  assert.deepEqual(await Promise.all(canonicalRoots.map(fileLedger)), before);
  assert.equal(result.receipt.legacyCompatibility.transitions.length, 2);
  assert.equal(result.receipt.legacyCompatibility.obsoleteButRetainedKeys.length, 4);
  assert.deepEqual(result.receipt.legacyCompatibility.reusedLegacyReferences, []);
  assert.equal(result.receipt.legacyCompatibility.deletionPlanned, false);
  for (const transition of result.receipt.legacyCompatibility.transitions) {
    assert.notEqual(transition.legacy.thumbnailKey, transition.staged.thumbnailKey);
    assert.notEqual(transition.legacy.displayKey, transition.staged.displayKey);
    await fs.access(path.join(item.appRoot, "generated", "library", transition.legacy.thumbnailKey));
    await fs.access(path.join(item.appRoot, "generated", "library", transition.legacy.displayKey));
  }
  for (const manifest of result.receipt.manifestReferences) {
    const stagedManifestPath = path.join(item.appRoot, "stages", "legacy", "public", manifest.path);
    assert.equal(await digest(stagedManifestPath), manifest.sha256);
    const parsed = JSON.parse(await fs.readFile(stagedManifestPath, "utf8"));
    assert.deepEqual(
      parsed.photos.map(({ id, thumbnailKey, displayKey }) => ({ id, thumbnailKey, displayKey })),
      manifest.photos
    );
    assert(parsed.photos.every((photo) => photo.thumbnailKey.includes("-cv1-") && photo.displayKey.includes("-cv1-")));
  }
});
