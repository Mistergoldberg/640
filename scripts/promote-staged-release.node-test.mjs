import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { runImporter } from "./import-photos.mjs";
import { buildPromotionPackage, verifyPromotionPackage } from "./promote-staged-release.mjs";
import { createSourcePolicyTemplate, inspectSourcePolicy } from "./source-policy.mjs";

const SELECTED_YEAR = "2091";
const UNAFFECTED_YEAR = "2090";

function photoId(year, relativePath) {
  return `${year}-${crypto.createHash("sha1").update(relativePath.split(path.sep).join("/")).digest("hex").slice(0, 14)}`;
}

function albumId(value) {
  const normalized = value.split(path.sep).join("/");
  const slug = normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `${slug}-${crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 8)}`;
}

async function jpeg(filePath, color = { r: 40, g: 80, b: 120 }) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp({ create: { width: 48, height: 32, channels: 3, background: color } }).jpeg().toFile(filePath);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function treeLedger(root) {
  const records = [];
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolutePath);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(absolutePath);
        records.push({ path: path.relative(root, absolutePath).split(path.sep).join("/"), bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
      }
    }
  }
  await walk(root);
  return records;
}

function resolvePolicy(template) {
  const policy = structuredClone(template);
  for (const decision of policy.decisions) {
    decision.status = "resolved";
    if (decision.category === "folder-year") {
      decision.action = "map-to-year";
      decision.year = decision.subject.importerYear;
    } else if (decision.category === "album-label") {
      decision.action = "publish-label";
      decision.publicLabel = decision.subject.proposedPublicLabel;
    } else if (decision.category === "unsupported-file" || decision.category === "unreadable-file") decision.action = "exclude-exact";
    else if (decision.category === "duplicate-content") decision.action = "keep-separate";
    else if (decision.category === "off-year-date") decision.action = "use-folder-year";
    else if (decision.category === "source-move") decision.action = "preserve-source-path";
  }
  return policy;
}

async function createFixture() {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-promotion-"));
  const sourceRoot = path.join(appRoot, "original-photos");
  const sourceFolder = path.join(sourceRoot, `${SELECTED_YEAR} Source`);
  const firstRelative = `${SELECTED_YEAR} Source/Album A/a.jpg`;
  const secondRelative = `${SELECTED_YEAR} Source/Album B/b.jpg`;
  const firstSource = path.join(sourceRoot, firstRelative);
  const secondSource = path.join(sourceRoot, secondRelative);
  await jpeg(firstSource);
  await jpeg(secondSource, { r: 180, g: 20, b: 60 });

  const selectedPhotoId = photoId(SELECTED_YEAR, firstRelative);
  const selectedOldAlbumId = "old-selected-album-12345678";
  const selectedLegacy = {
    thumbnailKey: `${SELECTED_YEAR}/thumbs/${selectedPhotoId}.jpg`,
    displayKey: `${SELECTED_YEAR}/display/${selectedPhotoId}.jpg`
  };
  const unaffectedPhotoId = `${UNAFFECTED_YEAR}-${"a".repeat(14)}`;
  const unaffectedAlbumId = "unaffected-album-12345678";
  const unaffectedLegacy = {
    thumbnailKey: `${UNAFFECTED_YEAR}/thumbs/${unaffectedPhotoId}.jpg`,
    displayKey: `${UNAFFECTED_YEAR}/display/${unaffectedPhotoId}.jpg`
  };
  const canonicalDataRoot = path.join(appRoot, "public", "data");
  const canonicalMediaRoot = path.join(appRoot, "generated", "library");
  const selectedManifestPath = path.join(canonicalDataRoot, SELECTED_YEAR, "albums", `${selectedOldAlbumId}.json`);
  const unaffectedManifestPath = path.join(canonicalDataRoot, UNAFFECTED_YEAR, "albums", `${unaffectedAlbumId}.json`);
  await writeJson(selectedManifestPath, {
    photos: [{ id: selectedPhotoId, thumbnailKey: selectedLegacy.thumbnailKey, displayKey: selectedLegacy.displayKey, albumId: selectedOldAlbumId, sortPosition: 0, albumSortPosition: 0 }]
  });
  await writeJson(unaffectedManifestPath, {
    photos: [{ id: unaffectedPhotoId, thumbnailKey: unaffectedLegacy.thumbnailKey, displayKey: unaffectedLegacy.displayKey, albumId: unaffectedAlbumId, sortPosition: 0, albumSortPosition: 0 }]
  });
  await writeJson(path.join(canonicalDataRoot, SELECTED_YEAR, "index.json"), {
    year: SELECTED_YEAR,
    scannedCount: 1,
    albums: [{ id: selectedOldAlbumId, name: "Old selected", count: 1, manifestUrl: `data/${SELECTED_YEAR}/albums/${selectedOldAlbumId}.json` }],
    sequence: [{ id: selectedPhotoId }]
  });
  await writeJson(path.join(canonicalDataRoot, UNAFFECTED_YEAR, "index.json"), {
    year: UNAFFECTED_YEAR,
    scannedCount: 1,
    albums: [{ id: unaffectedAlbumId, name: "Unaffected", count: 1, manifestUrl: `data/${UNAFFECTED_YEAR}/albums/${unaffectedAlbumId}.json` }],
    sequence: [{ id: unaffectedPhotoId }]
  });
  await writeJson(path.join(canonicalDataRoot, "catalog.json"), {
    years: [
      { year: SELECTED_YEAR, indexUrl: `data/${SELECTED_YEAR}/index.json` },
      { year: UNAFFECTED_YEAR, indexUrl: `data/${UNAFFECTED_YEAR}/index.json` }
    ]
  });
  for (const [index, key] of [...Object.values(selectedLegacy), ...Object.values(unaffectedLegacy)].entries()) {
    await jpeg(path.join(canonicalMediaRoot, key), { r: index * 20 + 5, g: 20, b: 30 });
  }
  await fs.mkdir(path.join(appRoot, "generated", "reports"), { recursive: true });

  const inspection = await inspectSourcePolicy({
    sourceRoot,
    scanRoots: [sourceFolder],
    selectedYear: SELECTED_YEAR,
    publicDataRoot: path.join(appRoot, "public"),
    concurrency: 2
  });
  const policyPath = path.join(appRoot, "reviewed-policy.json");
  await writeJson(policyPath, resolvePolicy(createSourcePolicyTemplate(inspection)));
  const stagingRoot = path.join(appRoot, "stage");
  const staged = await runImporter(["--year", SELECTED_YEAR, "--staging-root", stagingRoot, "--source-policy", policyPath], {
    appRoot,
    importerCommit: "promotion-test-commit",
    sharpVersion: "promotion-test-sharp",
    writeStdout: () => {}
  });
  return {
    appRoot,
    sourceRoot,
    sourceFolder,
    firstSource,
    canonicalDataRoot,
    canonicalMediaRoot,
    stagingRoot,
    policyPath,
    staged,
    selectedPhotoId,
    unaffectedPhotoId,
    unaffectedManifestPath,
    selectedLegacy,
    unaffectedLegacy
  };
}

async function promote(fixture, name = "package") {
  const packageRoot = path.join(fixture.appRoot, name);
  const result = await buildPromotionPackage({
    stagingRoot: fixture.stagingRoot,
    packageRoot,
    policyPath: fixture.policyPath,
    canonicalDataRoot: fixture.canonicalDataRoot,
    canonicalMediaRoot: fixture.canonicalMediaRoot,
    concurrency: 2
  });
  return { packageRoot, result };
}

async function expectPromotionFailure(t, mutate, pattern) {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.appRoot, { recursive: true, force: true }));
  await mutate(fixture);
  const packageRoot = path.join(fixture.appRoot, "failed-package");
  await assert.rejects(
    buildPromotionPackage({
      stagingRoot: fixture.stagingRoot,
      packageRoot,
      policyPath: fixture.policyPath,
      canonicalDataRoot: fixture.canonicalDataRoot,
      canonicalMediaRoot: fixture.canonicalMediaRoot,
      concurrency: 2
    }),
    pattern
  );
  await assert.rejects(fs.access(packageRoot), /ENOENT/);
}

test("promotion is reproducible, preserves unaffected years byte-for-byte, and retains complete rollback media", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.appRoot, { recursive: true, force: true }));
  const unaffectedBefore = await treeLedger(path.join(fixture.canonicalDataRoot, UNAFFECTED_YEAR));
  const canonicalBefore = await Promise.all([treeLedger(path.join(fixture.appRoot, "public")), treeLedger(fixture.canonicalMediaRoot), treeLedger(path.join(fixture.appRoot, "generated", "reports"))]);
  const first = await promote(fixture, "package-one");
  const second = await promote(fixture, "package-two");
  assert.equal(first.result.packageId, second.result.packageId);
  assert.equal(first.result.completion.closedWorldSha256, second.result.completion.closedWorldSha256);
  assert.deepEqual(await treeLedger(path.join(first.packageRoot, "candidate", "public", "data", UNAFFECTED_YEAR)), unaffectedBefore);
  assert.equal(first.result.media.newVersionedKeys.length, 4);
  assert.equal(first.result.media.existingLegacyKeysRetained.length, 4);
  assert.equal(first.result.media.existingLegacyKeysRetained.filter((entry) => entry.retainedFor === "candidate-unaffected-year").length, 2);
  assert.equal(first.result.media.existingLegacyKeysRetained.filter((entry) => entry.retainedFor === "previous-manifest-rollback").length, 2);
  assert.equal(first.result.media.obsoleteButRetainedKeys.length, 2);
  assert.equal(first.result.media.rollbackKeys.length, 4);
  assert.equal(first.result.media.conflicts.length, 0);
  assert(first.result.binding.obsoleteButRetainedManifests.some((value) => value.includes("old-selected-album")));
  const rollback = new Set(first.result.media.rollbackKeys.map((entry) => entry.key));
  for (const key of [...Object.values(fixture.selectedLegacy), ...Object.values(fixture.unaffectedLegacy)]) assert(rollback.has(key));
  for (const entry of first.result.media.rollbackKeys) await fs.access(path.join(fixture.canonicalMediaRoot, entry.key));
  const verified = await verifyPromotionPackage(first.packageRoot);
  assert.equal(verified.receipt.packageId, first.result.packageId);
  assert.deepEqual(await Promise.all([treeLedger(path.join(fixture.appRoot, "public")), treeLedger(fixture.canonicalMediaRoot), treeLedger(path.join(fixture.appRoot, "generated", "reports"))]), canonicalBefore);
});

test("missing media fails before a publishable package exists", async (t) => {
  await expectPromotionFailure(t, async (fixture) => fs.unlink(path.join(fixture.canonicalMediaRoot, fixture.unaffectedLegacy.thumbnailKey)), /missing canonical media/);
});

test("publication-ineligible and sampled staged receipts cannot produce packages", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.appRoot, { recursive: true, force: true }));
  const ineligibleStage = path.join(fixture.appRoot, "ineligible-stage");
  await runImporter(["--year", SELECTED_YEAR, "--staging-root", ineligibleStage], {
    appRoot: fixture.appRoot,
    importerCommit: "promotion-test-commit",
    sharpVersion: "promotion-test-sharp",
    writeStdout: () => {}
  });
  await assert.rejects(
    buildPromotionPackage({
      stagingRoot: ineligibleStage,
      packageRoot: path.join(fixture.appRoot, "ineligible-package"),
      policyPath: fixture.policyPath,
      canonicalDataRoot: fixture.canonicalDataRoot,
      canonicalMediaRoot: fixture.canonicalMediaRoot
    }),
    /publication-ineligible/
  );
  const sampledStage = path.join(fixture.appRoot, "sampled-stage");
  await runImporter(["--year", SELECTED_YEAR, "--limit", "1", "--staging-root", sampledStage, "--source-policy", fixture.policyPath], {
    appRoot: fixture.appRoot,
    importerCommit: "promotion-test-commit",
    sharpVersion: "promotion-test-sharp",
    writeStdout: () => {}
  });
  await assert.rejects(
    buildPromotionPackage({
      stagingRoot: sampledStage,
      packageRoot: path.join(fixture.appRoot, "sampled-package"),
      policyPath: fixture.policyPath,
      canonicalDataRoot: fixture.canonicalDataRoot,
      canonicalMediaRoot: fixture.canonicalMediaRoot
    }),
    /sampled or limited staged run/
  );
});

test("extra staged media and stale staged manifests fail the closed-world seal", async (t) => {
  await expectPromotionFailure(
    t,
    async (fixture) => {
      await jpeg(path.join(fixture.stagingRoot, "generated", "library", SELECTED_YEAR, "display", `${SELECTED_YEAR}-${"f".repeat(14)}-cv1-${"a".repeat(64)}.jpg`));
    },
    /closed-world seal|not closed-world/
  );
  await expectPromotionFailure(
    t,
    async (fixture) => writeJson(path.join(fixture.stagingRoot, "public", "data", SELECTED_YEAR, "albums", "stale.json"), { photos: [] }),
    /closed-world seal|not closed-world/
  );
});

test("duplicate photo IDs across candidate years fail before packaging", async (t) => {
  await expectPromotionFailure(
    t,
    async (fixture) => {
      const manifest = JSON.parse(await fs.readFile(fixture.unaffectedManifestPath, "utf8"));
      manifest.photos[0].id = fixture.selectedPhotoId;
      await writeJson(fixture.unaffectedManifestPath, manifest);
      const indexPath = path.join(fixture.canonicalDataRoot, UNAFFECTED_YEAR, "index.json");
      const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
      index.sequence[0].id = fixture.selectedPhotoId;
      await writeJson(indexPath, index);
    },
    /Duplicate photo ID across candidate years/
  );
});

test("changed receipt, policy, source inventory, and incomplete staging each fail closed", async (t) => {
  await expectPromotionFailure(
    t,
    async (fixture) => {
      const receiptPath = fixture.staged.receiptPath;
      const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
      receipt.changedAfterSeal = true;
      await writeJson(receiptPath, receipt);
    },
    /receipt changed|closed-world seal/
  );
  await expectPromotionFailure(
    t,
    async (fixture) => {
      const policy = JSON.parse(await fs.readFile(fixture.policyPath, "utf8"));
      policy.reviewNote = "changed after staging";
      await writeJson(fixture.policyPath, policy);
    },
    /policy changed|missing, stale, unresolved, or incompatible/
  );
  await expectPromotionFailure(t, async (fixture) => jpeg(fixture.firstSource, { r: 1, g: 2, b: 3 }), /source policy|source inventory/i);
  await expectPromotionFailure(t, async (fixture) => fs.unlink(path.join(fixture.stagingRoot, "generated", "journal", "complete.json")), /completion seal/);
});

test("a canonical object at a proposed immutable key with different bytes is a fatal conflict", async (t) => {
  await expectPromotionFailure(
    t,
    async (fixture) => {
      const key = fixture.staged.receipt.media[0].key;
      await jpeg(path.join(fixture.canonicalMediaRoot, key), { r: 255, g: 0, b: 0 });
    },
    /Media-key conflict with different bytes/
  );
});

test("altering a completed promotion package invalidates its closed-world seal", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.appRoot, { recursive: true, force: true }));
  const { packageRoot } = await promote(fixture);
  await fs.writeFile(path.join(packageRoot, "candidate", "public", "data", "catalog.json"), "{}\n");
  await assert.rejects(verifyPromotionPackage(packageRoot), /closed-world seal|public-data checksum/);
});
