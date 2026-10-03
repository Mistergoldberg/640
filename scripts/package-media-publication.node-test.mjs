import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  createFilesystemObjectStore,
  createPublicationPlan,
  executePublication,
  verifyPublicationPackage
} from "./package-media-publication.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const stableValue = (value) => Array.isArray(value) ? value.map(stableValue) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])])) : value;
const stableJson = (value) => JSON.stringify(stableValue(value));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function write(filePath, bytes) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
}

async function treeInventory(root, excluded = new Set()) {
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

function key(kind, idChar, contentChar, versioned = true) {
  return `2092/${kind}/2092-${idChar.repeat(14)}${versioned ? `-cv1-${contentChar.repeat(64)}` : ""}.jpg`;
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-publish-"));
  const packageRoot = path.join(root, "package");
  const objectRoot = path.join(root, "objects");
  const journalRoot = path.join(root, "journal");
  const entries = [
    { key: key("thumbs", "a", "1"), data: Buffer.from("new-thumb-a"), source: "staged-new" },
    { key: key("display", "a", "2"), data: Buffer.from("new-display-a"), source: "staged-new" },
    { key: key("thumbs", "b", "3", false), data: Buffer.from("legacy-thumb-b"), source: "canonical-legacy" },
    { key: key("display", "b", "4", false), data: Buffer.from("legacy-display-b"), source: "canonical-legacy" }
  ].map(({ data, ...entry }) => ({ ...entry, bytes: data.length, sha256: digest(data), data }));
  const expectedMedia = entries.map(({ data, ...entry }) => entry);
  const newVersionedKeys = expectedMedia.filter((entry) => entry.source === "staged-new");
  const legacy = expectedMedia.filter((entry) => entry.source === "canonical-legacy");
  const obsoleteData = Buffer.from("rollback-only");
  const obsolete = { key: key("thumbs", "c", "5", false), bytes: obsoleteData.length, sha256: digest(obsoleteData), reason: "previous-manifest-rollback" };
  const media = { schemaVersion: 1, expectedMedia, expectedMediaSha256: digest(stableJson(expectedMedia)), newVersionedKeys, existingVersionedKeys: [], existingLegacyKeysRetained: legacy, obsoleteButRetainedKeys: [obsolete], rollbackKeys: [...legacy, obsolete].map(({ key: objectKey, bytes, sha256 }) => ({ key: objectKey, bytes, sha256 })), conflicts: [] };
  const manifestPhotos = [
    { id: `2092-${"a".repeat(14)}`, thumbnailKey: entries[0].key, displayKey: entries[1].key },
    { id: `2092-${"b".repeat(14)}`, thumbnailKey: entries[2].key, displayKey: entries[3].key }
  ];
  const manifestBytes = jsonBytes({ photos: manifestPhotos });
  const manifest = { year: "2092", manifestPath: "2092/albums/test.json", manifestSha256: digest(manifestBytes), photos: manifestPhotos };
  const map = { manifests: [manifest], sha256: digest(stableJson([manifest])) };
  await write(path.join(packageRoot, "candidate/public/data/catalog.json"), jsonBytes({ years: [{ year: "2092", indexUrl: "data/2092/index.json" }] }));
  await write(path.join(packageRoot, "candidate/public/data/2092/albums/test.json"), manifestBytes);
  const publicInventory = await treeInventory(path.join(packageRoot, "candidate/public/data"));
  await write(path.join(packageRoot, "inventories/public-data.json"), jsonBytes({ schemaVersion: 1, ...publicInventory }));
  await write(path.join(packageRoot, "inventories/media.json"), jsonBytes(media));
  await write(path.join(packageRoot, "maps/manifest-media.json"), jsonBytes(map));
  for (const entry of entries.filter((item) => item.source === "staged-new")) await write(path.join(packageRoot, "media/new", entry.key), entry.data);
  const binding = { schemaVersion: 1, selectedYear: "2092", stagedRunId: "fixture", stagedReceiptSha256: "6".repeat(64), stagedClosedWorldSha256: "7".repeat(64), sourcePolicySha256: "8".repeat(64), sourceInventorySha256: "9".repeat(64), importerCommit: "test", previousPublicDataSha256: "0".repeat(64), publicDataSha256: publicInventory.sha256, mediaInventorySha256: digest(stableJson(media)), manifestReferenceMapSha256: map.sha256, obsoleteButRetainedManifests: [] };
  const packageId = digest(stableJson(binding));
  await write(path.join(packageRoot, "package.json"), jsonBytes({ schemaVersion: 1, status: "publishable-local-package", publicationEligible: true, packageId, binding }));
  const preSeal = await treeInventory(packageRoot);
  await write(path.join(packageRoot, "complete.json"), jsonBytes({ schemaVersion: 1, status: "complete", packageId, fileCountBeforeSeal: preSeal.files.length, closedWorldSha256: preSeal.sha256 }));
  for (const entry of legacy) await write(path.join(objectRoot, entry.key), entries.find((item) => item.key === entry.key).data);
  await write(path.join(objectRoot, obsolete.key), obsoleteData);
  return { root, packageRoot, objectRoot, journalRoot, entries, media, obsolete };
}

async function operationsAdapter(objectRoot, operations, hooks = {}) {
  return createFilesystemObjectStore(objectRoot, { onOperation(event) { operations.push(event); hooks.onOperation?.(event); } });
}

test("zero-write plan reports exact missing, matching, conflicts, requests, bytes, and no deletes", async (t) => {
  const fx = await fixture(); t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  await write(path.join(fx.objectRoot, fx.entries[0].key), fx.entries[0].data);
  const beforePackage = await treeInventory(fx.packageRoot), beforeRemote = await treeInventory(fx.objectRoot);
  const adapter = await createFilesystemObjectStore(fx.objectRoot);
  const plan = await createPublicationPlan({ packageRoot: fx.packageRoot, adapter });
  assert.equal(plan.status, "ready");
  assert.equal(plan.counts.matchingExistingKeys, 3);
  assert.equal(plan.counts.missingApprovedNewKeys, 1);
  assert.equal(plan.expectedRequests.uploads, 1);
  assert.equal(plan.counts.objectsToCreate, 1);
  assert.equal(plan.counts.objectsToOverwrite, 0);
  assert.equal(plan.counts.objectsToDelete, 0);
  assert.equal(plan.expectedUploadBytes, fx.entries[1].bytes);
  assert.deepEqual(plan.deletes, []);
  assert.deepEqual(await treeInventory(fx.packageRoot), beforePackage);
  assert.deepEqual(await treeInventory(fx.objectRoot), beforeRemote);
});

test("missing retained media, byte conflict, untrusted checksum, unexpected key, and altered package fail closed", async (t) => {
  const missing = await fixture(); t.after(() => fs.rm(missing.root, { recursive: true, force: true }));
  await fs.unlink(path.join(missing.objectRoot, missing.entries[2].key));
  let plan = await createPublicationPlan({ packageRoot: missing.packageRoot, adapter: await createFilesystemObjectStore(missing.objectRoot) });
  assert.equal(plan.executable, false); assert.equal(plan.counts.missingRequiredUnavailable, 1);

  const conflict = await fixture(); t.after(() => fs.rm(conflict.root, { recursive: true, force: true }));
  await write(path.join(conflict.objectRoot, conflict.entries[0].key), Buffer.from("xxxxxxxxxxx"));
  const ops = [], conflictAdapter = await operationsAdapter(conflict.objectRoot, ops);
  plan = await createPublicationPlan({ packageRoot: conflict.packageRoot, adapter: conflictAdapter });
  assert.equal(plan.counts.byteConflicts, 1); assert.equal(ops.filter((op) => op.operation === "put-if-absent").length, 0);
  await assert.rejects(executePublication({ packageRoot: conflict.packageRoot, adapter: conflictAdapter, journalRoot: conflict.journalRoot }), /blocked/);

  const untrusted = { ...conflictAdapter, identity: { ...conflictAdapter.identity, checksumMethod: "etag" } };
  await assert.rejects(createPublicationPlan({ packageRoot: conflict.packageRoot, adapter: untrusted }), /cannot prove SHA-256/);

  const unexpected = await fixture(); t.after(() => fs.rm(unexpected.root, { recursive: true, force: true }));
  await write(path.join(unexpected.objectRoot, key("display", "d", "6", false)), Buffer.from("unexpected"));
  plan = await createPublicationPlan({ packageRoot: unexpected.packageRoot, adapter: await createFilesystemObjectStore(unexpected.objectRoot) });
  assert.equal(plan.counts.unexpectedRemoteKeys, 1); assert.equal(plan.executable, false);

  const altered = await fixture(); t.after(() => fs.rm(altered.root, { recursive: true, force: true }));
  await fs.appendFile(path.join(altered.packageRoot, "maps/manifest-media.json"), " ");
  await assert.rejects(verifyPublicationPackage(altered.packageRoot), /closed-world seal/);

  const resealed = await fixture(); t.after(() => fs.rm(resealed.root, { recursive: true, force: true }));
  const mapPath = path.join(resealed.packageRoot, "maps/manifest-media.json");
  const map = JSON.parse(await fs.readFile(mapPath, "utf8"));
  map.sha256 = "f".repeat(64);
  await write(mapPath, jsonBytes(map));
  const completionPath = path.join(resealed.packageRoot, "complete.json");
  const completion = JSON.parse(await fs.readFile(completionPath, "utf8"));
  await fs.unlink(completionPath);
  const newPreSeal = await treeInventory(resealed.packageRoot);
  await write(completionPath, jsonBytes({ ...completion, fileCountBeforeSeal: newPreSeal.files.length, closedWorldSha256: newPreSeal.sha256 }));
  await assert.rejects(verifyPublicationPackage(resealed.packageRoot), /Manifest-to-media map digest is invalid/);
});

test("interrupted upload cannot PASS and resumes without overwrite to the same verified result", async (t) => {
  const fx = await fixture(); t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const operations = [];
  const adapter = await operationsAdapter(fx.objectRoot, operations);
  let interrupted = false;
  await assert.rejects(executePublication({
    packageRoot: fx.packageRoot, adapter, journalRoot: fx.journalRoot, maxAttempts: 1, concurrency: 1,
    faultInjector(event) { if (!interrupted && event.point === "after-upload-before-verification") { interrupted = true; throw new Error("injected interruption"); } }
  }), /retry limit exhausted/);
  await assert.rejects(fs.access(path.join(fx.journalRoot, "receipt.json")), /ENOENT/);
  const firstPutCount = operations.filter((op) => op.operation === "put-if-absent").length;
  const resumed = await executePublication({ packageRoot: fx.packageRoot, adapter, journalRoot: fx.journalRoot, maxAttempts: 3, concurrency: 2 });
  assert.equal(resumed.receipt.status, "PASS");
  assert.equal(resumed.receipt.counts.required, 4);
  assert.equal(resumed.receipt.counts.deletes, 0);
  assert.equal(operations.filter((op) => op.operation === "put-if-absent").length, firstPutCount + 1);
  const receiptBytes = await fs.readFile(resumed.receiptPath);
  const reproduced = await executePublication({ packageRoot: fx.packageRoot, adapter, journalRoot: fx.journalRoot });
  assert.equal(reproduced.receipt.status, "PASS");
  assert.deepEqual(reproduced.receipt.objects.map(({ key: k, expectedSha256 }) => [k, expectedSha256]), resumed.receipt.objects.map(({ key: k, expectedSha256 }) => [k, expectedSha256]));
  assert.deepEqual(await fs.readFile(resumed.receiptPath), receiptBytes);
  assert(resumed.receipt.objects.every((object) => object.verificationMethod === "full-object-sha256-readback" && Number.isInteger(object.retries)));
  assert.equal(operations.some((op) => op.operation === "delete" || op.operation === "overwrite"), false);
});

test("retry exhaustion and post-upload corruption never produce PASS or overwrite", async (t) => {
  const retry = await fixture(); t.after(() => fs.rm(retry.root, { recursive: true, force: true }));
  const base = await createFilesystemObjectStore(retry.objectRoot);
  let attempts = 0;
  const failing = { ...base, async putIfAbsent() { attempts += 1; throw new Error("transient fixture failure"); } };
  await assert.rejects(executePublication({ packageRoot: retry.packageRoot, adapter: failing, journalRoot: retry.journalRoot, maxAttempts: 2 }), /retry limit exhausted/);
  assert.equal(attempts, 4); await assert.rejects(fs.access(path.join(retry.journalRoot, "receipt.json")), /ENOENT/);

  const corrupt = await fixture(); t.after(() => fs.rm(corrupt.root, { recursive: true, force: true }));
  const corruptBase = await createFilesystemObjectStore(corrupt.objectRoot);
  let corrupted = false;
  const corrupting = { ...corruptBase, async putIfAbsent(objectKey, source) { const result = await corruptBase.putIfAbsent(objectKey, source); if (!corrupted) { corrupted = true; fsSync.writeFileSync(path.join(corrupt.objectRoot, objectKey), Buffer.alloc((await fs.stat(source)).size, 120)); } return result; } };
  await assert.rejects(executePublication({ packageRoot: corrupt.packageRoot, adapter: corrupting, journalRoot: corrupt.journalRoot, maxAttempts: 2, concurrency: 1 }), /retry limit exhausted/);
  await assert.rejects(fs.access(path.join(corrupt.journalRoot, "receipt.json")), /ENOENT/);
});

test("post-upload remote corruption and incomplete complete-set reconciliation fail", async (t) => {
  const fx = await fixture(); t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  const base = await createFilesystemObjectStore(fx.objectRoot);
  let injected = false;
  await assert.rejects(executePublication({
    packageRoot: fx.packageRoot, adapter: base, journalRoot: fx.journalRoot,
    faultInjector(event) {
      if (!injected && event.point === "before-final-reconciliation") {
        injected = true;
        fsSync.writeFileSync(path.join(fx.objectRoot, fx.entries[0].key), Buffer.from("corrupt-after-upload"));
      }
    }
  }), /Final reconciliation failed/);
  await assert.rejects(fs.access(path.join(fx.journalRoot, "receipt.json")), /ENOENT/);

  const incomplete = await fixture(); t.after(() => fs.rm(incomplete.root, { recursive: true, force: true }));
  const incompleteBase = await createFilesystemObjectStore(incomplete.objectRoot);
  let removed = false;
  await assert.rejects(executePublication({ packageRoot: incomplete.packageRoot, adapter: incompleteBase, journalRoot: incomplete.journalRoot, faultInjector(event) {
    if (!removed && event.point === "before-final-reconciliation") { removed = true; fsSync.unlinkSync(path.join(incomplete.objectRoot, incomplete.entries[2].key)); }
  } }), /Final reconciliation failed/);
});

test("legacy uploader rejects direct invocation, flags, environment, and npm aliases", () => {
  const script = path.join(REPO_ROOT, "scripts", "media-upload-r2.mjs");
  for (const args of [[], ["--dry-run"], ["--execute"], ["--execute", "--force"], ["--source", "/tmp"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, R2_BUCKET: "must-not-be-used", R2_ACCESS_KEY_ID: "must-not-be-used" } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Legacy broad media upload is disabled/);
  }
  for (const command of ["media:upload:dry-run", "media:upload"]) {
    const result = spawnSync("npm", ["run", command, "--", "--force"], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, R2_BUCKET: "must-not-be-used" } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Legacy broad media upload is disabled/);
  }
});
