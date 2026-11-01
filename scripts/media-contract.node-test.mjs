import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectMediaKey, isSupportedMediaKey } from "./media-contract.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HASH = "a".repeat(64);

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(APP_ROOT, "public", relativePath), "utf8"));
}

async function publicDataDigest() {
  const records = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        records.push([path.relative(APP_ROOT, absolute), createHash("sha256").update(await fs.readFile(absolute)).digest("hex")]);
      }
    }
  }
  await walk(path.join(APP_ROOT, "public", "data"));
  return createHash("sha256").update(JSON.stringify(records.sort())).digest("hex");
}

test("the committed catalogue uses only exact cv1 keys with matching year, photo, and derivative", async () => {
  const catalog = await readJson("data/catalog.json");
  let keyCount = 0;
  for (const yearEntry of catalog.years) {
    const index = await readJson(yearEntry.indexUrl);
    for (const album of index.albums) {
      const manifest = await readJson(album.manifestUrl);
      for (const photo of manifest.photos) {
        assert.equal(isSupportedMediaKey(photo.thumbnailKey, { year: yearEntry.year, photoId: photo.id, derivative: "thumbs" }), true);
        assert.equal(isSupportedMediaKey(photo.displayKey, { year: yearEntry.year, photoId: photo.id, derivative: "display" }), true);
        keyCount += 2;
      }
    }
  }
  assert.equal(keyCount, 132_340);
});

test("the media contract rejects traversal, malformed, old, mixed, and wrong-year keys", () => {
  const valid = `2026/display/2026-0123456789abcd-cv1-${HASH}.jpg`;
  assert.equal(inspectMediaKey(valid, { year: "2026", photoId: "2026-0123456789abcd", derivative: "display" }).valid, true);
  for (const key of [
    `../2026/display/2026-0123456789abcd-cv1-${HASH}.jpg`,
    `2026/display/2026-0123456789abcd.jpg`,
    `2026/display/2026-0123456789abcd-cv2-${HASH}.jpg`,
    `2026/display/2025-0123456789abcd-cv1-${HASH}.jpg`,
    `2026/display/2026-0123456789abcd-cv1-${"a".repeat(63)}.jpg`,
    `2026/display/2026-0123456789abcd-cv1-${HASH}.png`,
    `2026//display/2026-0123456789abcd-cv1-${HASH}.jpg`
  ]) assert.equal(isSupportedMediaKey(key), false, key);
  assert.equal(isSupportedMediaKey(valid, { year: "2025" }), false);
  assert.equal(isSupportedMediaKey(valid, { photoId: "2026-fedcba98765432" }), false);
  assert.equal(isSupportedMediaKey(valid, { derivative: "thumbs" }), false);
});

test("retired sample, limited, importer, and upload commands fail before changing canonical data", async (context) => {
  const before = await publicDataDigest();
  const temporaryCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-retired-command-"));
  context.after(() => fs.rm(temporaryCwd, { recursive: true, force: true }));
  for (const [script, args] of [
    ["retired-publication-command.mjs", ["sample-import", "--limit", "1"]],
    ["retired-publication-command.mjs", ["import", "--output", "public"]],
    ["import-photos.mjs", ["--year", "2013", "--limit", "1"]],
    ["media-upload-r2.mjs", ["--dry-run"]]
  ]) {
    const result = spawnSync(process.execPath, [path.join(APP_ROOT, "scripts", script), ...args], { cwd: temporaryCwd, encoding: "utf8" });
    assert.notEqual(result.status, 0, `${script} unexpectedly succeeded`);
    assert.match(`${result.stdout}${result.stderr}`, /retired|package-bound/i);
  }
  assert.equal(await publicDataDigest(), before);
});
