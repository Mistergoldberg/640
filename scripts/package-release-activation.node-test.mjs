import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFilesystemObjectStore, executePublication, verifyPublicationPackage, verifyPublicationReceipt } from "./package-media-publication.mjs";
import { buildSealedCandidateRelease, verifySealedCandidateRelease } from "./package-release-activation.mjs";
import { createFilesystemQaDeploymentAdapter, deployQaRelease } from "./qa-release-deployment.mjs";

const stableValue = (value) => Array.isArray(value) ? value.map(stableValue) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])])) : value;
const stableJson = (value) => JSON.stringify(stableValue(value));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function write(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.isBuffer(value) ? value : jsonBytes(value));
}

async function inventory(root, excluded = new Set()) {
  const files = [];
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else {
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (!excluded.has(relative)) {
          const bytes = await fs.readFile(absolute);
          files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
        }
      }
    }
  }
  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return { files, sha256: digest(stableJson(files)) };
}

function key(year, kind, id, hash) {
  return `${year}/${kind}/${year}-${id.repeat(14)}-cv1-${hash.repeat(64)}.jpg`;
}

function photo(year, id, albumId, sortPosition, thumbHash, displayHash) {
  return {
    id: `${year}-${id.repeat(14)}`,
    albumId,
    sortPosition,
    albumSortPosition: sortPosition,
    width: 640,
    height: 360,
    orientation: "landscape",
    thumbnailKey: key(year, "thumbs", id, thumbHash),
    displayKey: key(year, "display", id, displayHash)
  };
}

async function createFixture(name = "fixture") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `pixilation-release-${name}-`));
  const packageRoot = path.join(root, "package");
  const objectRoot = path.join(root, "objects");
  const journalRoot = path.join(root, "journal");
  const frontendRoot = path.join(root, "frontend-dist");
  const releaseRoot = path.join(root, "release");
  const existingAlbumId = "2091-existing-ordinary-11111111";
  const videoAlbumId = "2091-video-derived-22222222";
  const unaffectedAlbumId = "2090-unaffected-33333333";
  const existing = photo("2091", "a", existingAlbumId, 0, "1", "2");
  const videoOne = photo("2091", "b", videoAlbumId, 1, "3", "4");
  const videoTwo = { ...photo("2091", "c", videoAlbumId, 2, "5", "6"), albumSortPosition: 1 };
  const unaffected = photo("2090", "d", unaffectedAlbumId, 0, "7", "8");
  const manifests = [
    ["2091", existingAlbumId, { photos: [existing] }],
    ["2091", videoAlbumId, { photos: [videoOne, videoTwo] }],
    ["2090", unaffectedAlbumId, { photos: [unaffected] }]
  ];
  for (const [year, albumId, manifest] of manifests) await write(path.join(packageRoot, "candidate/public/data", year, "albums", `${albumId}.json`), manifest);
  await write(path.join(packageRoot, "candidate/public/data/2091/index.json"), {
    year: "2091", scannedCount: 3,
    albums: [
      { id: existingAlbumId, name: "2091 Existing Ordinary", count: 1, manifestUrl: `data/2091/albums/${existingAlbumId}.json` },
      { id: videoAlbumId, name: "2091 Video Derived", count: 2, manifestUrl: `data/2091/albums/${videoAlbumId}.json` }
    ],
    sequence: [existing, videoOne, videoTwo].map(({ id }) => ({ id }))
  });
  await write(path.join(packageRoot, "candidate/public/data/2090/index.json"), {
    year: "2090", scannedCount: 1,
    albums: [{ id: unaffectedAlbumId, name: "2090 Unaffected", count: 1, manifestUrl: `data/2090/albums/${unaffectedAlbumId}.json` }],
    sequence: [{ id: unaffected.id }]
  });
  await write(path.join(packageRoot, "candidate/public/data/catalog.json"), { years: [{ year: "2091", indexUrl: "data/2091/index.json" }, { year: "2090", indexUrl: "data/2090/index.json" }] });
  const publicInventory = await inventory(path.join(packageRoot, "candidate/public/data"));
  const expectedMedia = [];
  for (const item of [existing, videoOne, videoTwo, unaffected]) {
    for (const [type, mediaKey] of [["thumbnail", item.thumbnailKey], ["display", item.displayKey]]) {
      const bytes = Buffer.from(`${name}:${mediaKey}`);
      const record = { key: mediaKey, bytes: bytes.length, sha256: digest(bytes), source: "staged-new", derivativeType: type };
      expectedMedia.push(record);
      await write(path.join(packageRoot, "media/new", mediaKey), bytes);
    }
  }
  expectedMedia.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  const media = { schemaVersion: 1, expectedMedia, expectedMediaSha256: digest(stableJson(expectedMedia)), newVersionedKeys: expectedMedia, existingVersionedKeys: [], existingLegacyKeysRetained: [], obsoleteButRetainedKeys: [], rollbackKeys: [], conflicts: [] };
  const manifestMapEntries = [];
  for (const [year, albumId, manifest] of manifests) {
    const manifestPath = `${year}/albums/${albumId}.json`;
    const bytes = await fs.readFile(path.join(packageRoot, "candidate/public/data", manifestPath));
    manifestMapEntries.push({ year, manifestPath, manifestSha256: digest(bytes), photos: manifest.photos.map(({ id, thumbnailKey, displayKey }) => ({ id, thumbnailKey, displayKey })) });
  }
  manifestMapEntries.sort((a, b) => a.manifestPath.localeCompare(b.manifestPath));
  const map = { manifests: manifestMapEntries, sha256: digest(stableJson(manifestMapEntries)) };
  await write(path.join(packageRoot, "inventories/public-data.json"), { schemaVersion: 1, ...publicInventory });
  await write(path.join(packageRoot, "inventories/media.json"), media);
  await write(path.join(packageRoot, "maps/manifest-media.json"), map);
  const binding = { schemaVersion: 1, selectedYear: "2091", stagedRunId: `stage-${name}`, stagedReceiptSha256: "a".repeat(64), stagedClosedWorldSha256: "b".repeat(64), sourcePolicySha256: "c".repeat(64), sourceInventorySha256: "d".repeat(64), importerCommit: "fixture", previousPublicDataSha256: "e".repeat(64), publicDataSha256: publicInventory.sha256, mediaInventorySha256: digest(stableJson(media)), manifestReferenceMapSha256: map.sha256, obsoleteButRetainedManifests: [] };
  const packageId = digest(stableJson(binding));
  await write(path.join(packageRoot, "package.json"), { schemaVersion: 1, status: "publishable-local-package", publicationEligible: true, packageId, binding });
  const packagePreSeal = await inventory(packageRoot);
  await write(path.join(packageRoot, "complete.json"), { schemaVersion: 1, status: "complete", packageId, fileCountBeforeSeal: packagePreSeal.files.length, closedWorldSha256: packagePreSeal.sha256 });
  await write(path.join(frontendRoot, "index.html"), Buffer.from("<!doctype html><div id=\"root\"></div><script src=\"/assets/app.js\"></script>"));
  await write(path.join(frontendRoot, "assets/app.js"), Buffer.from("globalThis.PIXILATION=true;"));
  await write(path.join(frontendRoot, "robots.txt"), Buffer.from("User-agent: *\nAllow: /\n"));
  await write(path.join(frontendRoot, "data/stale.json"), { stale: true });
  const adapter = await createFilesystemObjectStore(objectRoot);
  const publication = await executePublication({ packageRoot, adapter, journalRoot });
  const verifiedPackage = await verifyPublicationPackage(packageRoot);
  const authorityPath = path.join(root, "authority.json");
  await write(authorityPath, {
    schemaVersion: 1, status: "approved", environment: "qa", packageId,
    packageClosedWorldSha256: verifiedPackage.completion.closedWorldSha256,
    sourcePolicySha256: binding.sourcePolicySha256,
    immutableMediaPublicationApproved: true, qaCandidateActivationApproved: true,
    productionManifestActivationApproved: false, productionFrontendActivationApproved: false,
    approvedBy: "fixture-operator", approvedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString()
  });
  return { root, packageRoot, objectRoot, journalRoot, frontendRoot, releaseRoot, publication, authorityPath, packageId, existing, videoOne, videoTwo, unaffected };
}

async function buildFixtureRelease(fixture, overrides = {}) {
  return buildSealedCandidateRelease({
    packageRoot: fixture.packageRoot,
    publicationReceiptPath: fixture.publication.receiptPath,
    frontendDistRoot: fixture.frontendRoot,
    releaseRoot: fixture.releaseRoot,
    frontendCommit: "a".repeat(40),
    previousQaRelease: "qa-previous",
    rollbackRelease: "qa-previous",
    ...overrides
  });
}

test("sealed activation preserves existing, video-derived, and unrelated public data in an immutable release", async (t) => {
  const fixture = await createFixture("preservation"); t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = await buildFixtureRelease(fixture, { requireAuthority: true, authorityPath: fixture.authorityPath });
  assert.equal(result.release.binding.packageId, fixture.packageId);
  assert.equal(result.activation.binding.mediaReceiptSha256, fixture.publication.receipt.receiptSha256);
  assert.equal(result.candidate.photoCount, 4);
  assert.equal(result.candidate.albumCount, 3);
  const selectedIndex = JSON.parse(await fs.readFile(path.join(fixture.releaseRoot, "payload/data/2091/index.json"), "utf8"));
  assert.deepEqual(selectedIndex.albums.map((item) => item.name), ["2091 Existing Ordinary", "2091 Video Derived"]);
  assert.deepEqual(selectedIndex.sequence.map((item) => item.id), [fixture.existing.id, fixture.videoOne.id, fixture.videoTwo.id]);
  assert.deepEqual(await fs.readFile(path.join(fixture.releaseRoot, "payload/data/2090/index.json")), await fs.readFile(path.join(fixture.packageRoot, "candidate/public/data/2090/index.json")));
  await assert.rejects(fs.access(path.join(fixture.releaseRoot, "payload/data/stale.json")), /ENOENT/);
  await fs.access(path.join(fixture.releaseRoot, "payload/assets/app.js"));
  const verified = await verifySealedCandidateRelease({ releaseRoot: fixture.releaseRoot, packageRoot: fixture.packageRoot, publicationReceiptPath: fixture.publication.receiptPath });
  assert.equal(verified.completion.status, "complete");
});

test("activation rejects package mismatch, package seal tamper, and incomplete publication", async (t) => {
  const one = await createFixture("one"), two = await createFixture("two");
  t.after(() => Promise.all([fs.rm(one.root, { recursive: true, force: true }), fs.rm(two.root, { recursive: true, force: true })]));
  await assert.rejects(buildSealedCandidateRelease({ packageRoot: two.packageRoot, publicationReceiptPath: one.publication.receiptPath, frontendDistRoot: two.frontendRoot, releaseRoot: two.releaseRoot, frontendCommit: "b".repeat(40) }), /different package|identity/);
  const sealPath = path.join(one.packageRoot, "complete.json");
  const originalSeal = await fs.readFile(sealPath);
  const seal = JSON.parse(originalSeal.toString("utf8"));
  await write(sealPath, { ...seal, closedWorldSha256: "0".repeat(64) });
  await assert.rejects(buildFixtureRelease(one), /closed-world seal/);
  await fs.writeFile(sealPath, originalSeal);
  const runPath = path.join(one.journalRoot, "run.json");
  const run = JSON.parse(await fs.readFile(runPath, "utf8"));
  await write(runPath, { ...run, status: "uploading" });
  await assert.rejects(buildFixtureRelease(one), /incomplete/);
});

test("activation rejects missing receipt objects and package tampering after publication", async (t) => {
  const fixture = await createFixture("tamper"); t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const receiptPath = fixture.publication.receiptPath;
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  const altered = { ...receipt, objects: receipt.objects.slice(1) };
  delete altered.receiptSha256;
  altered.receiptSha256 = digest(stableJson(altered));
  await write(receiptPath, altered);
  const runPath = path.join(fixture.journalRoot, "run.json");
  const run = JSON.parse(await fs.readFile(runPath, "utf8"));
  await write(runPath, { ...run, receiptSha256: altered.receiptSha256 });
  await assert.rejects(verifyPublicationReceipt({ packageRoot: fixture.packageRoot, receiptPath }), /differs/);

  const fresh = await createFixture("package-tamper"); t.after(() => fs.rm(fresh.root, { recursive: true, force: true }));
  await fs.appendFile(path.join(fresh.packageRoot, "candidate/public/data/2091/index.json"), " ");
  await assert.rejects(buildFixtureRelease(fresh), /closed-world seal/);
  await write(path.join(fresh.packageRoot, "candidate/public/data/unbound.json"), {});
  await assert.rejects(buildFixtureRelease(fresh), /closed-world seal/);
});

test("release construction interruption leaves no partial active release and authority must match exactly", async (t) => {
  const fixture = await createFixture("interrupt"); t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await assert.rejects(buildFixtureRelease(fixture, { faultInjector(point) { if (point === "after-payload-copy") throw new Error("injected release interruption"); } }), /injected release interruption/);
  await assert.rejects(fs.access(fixture.releaseRoot), /ENOENT/);
  assert.equal((await fs.readdir(fixture.root)).some((name) => name.startsWith("release.building-")), false);
  const authority = JSON.parse(await fs.readFile(fixture.authorityPath, "utf8"));
  await write(fixture.authorityPath, { ...authority, packageId: "f".repeat(64) });
  await assert.rejects(buildFixtureRelease(fixture, { requireAuthority: true, authorityPath: fixture.authorityPath }), /different package/);
});

async function prepareQaFixture(fixture, validate) {
  const qaRoot = path.join(fixture.root, "qa-server");
  await fs.mkdir(path.join(qaRoot, "releases", "previous-qa"), { recursive: true });
  await fs.mkdir(path.join(qaRoot, "releases", "production-live"), { recursive: true });
  await fs.symlink("releases/previous-qa", path.join(qaRoot, "qa-current"));
  await fs.symlink("releases/production-live", path.join(qaRoot, "current"));
  return { qaRoot, adapter: await createFilesystemQaDeploymentAdapter({ root: qaRoot, validate }) };
}

test("QA deployment atomically activates the sealed release and records production as unchanged", async (t) => {
  const fixture = await createFixture("qa-pass"); t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const release = await buildFixtureRelease(fixture, { requireAuthority: true, authorityPath: fixture.authorityPath });
  const qa = await prepareQaFixture(fixture, async () => ({ passed: true, checks: ["index", "catalog", "media"] }));
  const deploymentReceiptPath = path.join(fixture.root, "deployment", "receipt.json");
  const deployed = await deployQaRelease({ releaseRoot: fixture.releaseRoot, packageRoot: fixture.packageRoot, publicationReceiptPath: fixture.publication.receiptPath, authorityPath: fixture.authorityPath, adapter: qa.adapter, deploymentReceiptPath, requiredMediaAdapterType: "filesystem-fixture" });
  assert.equal(deployed.receipt.status, "PASS");
  assert.equal(deployed.receipt.binding.releaseId, release.release.releaseId);
  assert.equal(deployed.receipt.binding.previousQaRelease, "previous-qa");
  assert.equal(deployed.receipt.binding.productionReleaseBefore, "production-live");
  assert.equal(deployed.receipt.binding.productionReleaseAfter, "production-live");
  const pointers = await qa.adapter.inspectPointers();
  assert.deepEqual(pointers, { qaRelease: release.release.releaseId, productionRelease: "production-live" });
  assert.equal((await fs.stat(deploymentReceiptPath)).mode & 0o777, 0o600);
});

test("QA validation failure rolls the pointer back and never changes production", async (t) => {
  const fixture = await createFixture("qa-rollback"); t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const release = await buildFixtureRelease(fixture, { requireAuthority: true, authorityPath: fixture.authorityPath });
  const qa = await prepareQaFixture(fixture, async () => ({ passed: false, reason: "injected browser validation failure" }));
  await assert.rejects(deployQaRelease({ releaseRoot: fixture.releaseRoot, packageRoot: fixture.packageRoot, publicationReceiptPath: fixture.publication.receiptPath, authorityPath: fixture.authorityPath, adapter: qa.adapter, deploymentReceiptPath: path.join(fixture.root, "deployment-failed.json"), requiredMediaAdapterType: "filesystem-fixture" }), /validation failed/);
  assert.deepEqual(await qa.adapter.inspectPointers(), { qaRelease: "previous-qa", productionRelease: "production-live" });
  await fs.access(path.join(qa.qaRoot, "releases", `.failed-${release.release.releaseId}`));
  await assert.rejects(fs.access(path.join(fixture.root, "deployment-failed.json")), /ENOENT/);
});
