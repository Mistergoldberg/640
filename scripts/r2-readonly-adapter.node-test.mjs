import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createR2ReadOnlyAdapter, loadR2ReadOnlyConfiguration } from "./r2-readonly-adapter.mjs";
import { runR2PackagePreflight } from "./r2-preflight.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const stableValue = (value) => Array.isArray(value) ? value.map(stableValue) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])])) : value;
const stableJson = (value) => JSON.stringify(stableValue(value));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function write(filePath, bytes) { await fs.mkdir(path.dirname(filePath), { recursive: true }); await fs.writeFile(filePath, bytes); }

async function treeInventory(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else {
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        const bytes = await fs.readFile(absolute);
        files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
      }
    }
  }
  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return { files, sha256: digest(stableJson(files)) };
}

function mediaKey(kind, id, versioned = false) {
  return `2092/${kind}/2092-${id.repeat(14)}${versioned ? `-cv1-${id.repeat(64)}` : ""}.jpg`;
}

async function makeConfiguration(root, changes = {}) {
  const accountId = changes.accountId || "a".repeat(32);
  const endpoint = changes.endpoint || `https://${accountId}.r2.cloudflarestorage.com`;
  const bucket = changes.bucket || "fixture-media";
  const pin = {
    schemaVersion: 1,
    provider: "cloudflare-r2",
    accountIdSha256: digest(changes.pinnedAccountId || "a".repeat(32)),
    bucket: changes.pinnedBucket || "fixture-media",
    endpointSha256: digest(changes.pinnedEndpoint || `https://${"a".repeat(32)}.r2.cloudflarestorage.com`),
    namespace: { id: "pixilation-generated-media-v1", remotePrefix: "", allowedYears: ["2092"], derivativeDirectories: ["thumbs", "display"], keyFormat: "pixilation-media-key-v1" }
  };
  const credentials = { R2_ACCOUNT_ID: accountId, R2_BUCKET: bucket, R2_ENDPOINT: endpoint, R2_ACCESS_KEY_ID: "test-access-not-printed", R2_SECRET_ACCESS_KEY: "test-secret-not-printed" };
  const configPath = path.join(root, "config.json"), credentialsPath = path.join(root, "credentials.json");
  await write(configPath, jsonBytes(pin)); await write(credentialsPath, jsonBytes(credentials));
  return loadR2ReadOnlyConfiguration({ configPath, credentialsPath });
}

class FakeClient {
  constructor(handler) { this.handler = handler; this.operations = []; }
  async send(command) {
    const name = command.constructor.name;
    this.operations.push({ name, input: command.input });
    return this.handler(name, command.input, this.operations.length);
  }
}

function body(bytes, failure = null) {
  return { async *[Symbol.asyncIterator]() { if (failure) throw failure; yield bytes; } };
}

async function makePackage(root) {
  const packageRoot = path.join(root, "package");
  const newData = Buffer.from("new-object-bytes"), legacyData = Buffer.from("legacy-object");
  const newEntry = { key: mediaKey("thumbs", "1", true), bytes: newData.length, sha256: digest(newData), source: "staged-new" };
  const legacyEntry = { key: mediaKey("display", "2"), bytes: legacyData.length, sha256: digest(legacyData), source: "canonical-legacy" };
  const expectedMedia = [newEntry, legacyEntry];
  const media = { schemaVersion: 1, expectedMedia, expectedMediaSha256: digest(stableJson(expectedMedia)), newVersionedKeys: [newEntry], existingVersionedKeys: [], existingLegacyKeysRetained: [legacyEntry], obsoleteButRetainedKeys: [], rollbackKeys: [legacyEntry], conflicts: [] };
  const photos = [{ id: `2092-${"1".repeat(14)}`, thumbnailKey: newEntry.key, displayKey: legacyEntry.key }];
  const manifestBytes = jsonBytes({ photos });
  const manifest = { year: "2092", manifestPath: "2092/albums/test.json", manifestSha256: digest(manifestBytes), photos };
  const manifestMap = { manifests: [manifest], sha256: digest(stableJson([manifest])) };
  await write(path.join(packageRoot, "candidate/public/data/catalog.json"), jsonBytes({ years: [] }));
  await write(path.join(packageRoot, "candidate/public/data/2092/albums/test.json"), manifestBytes);
  const publicInventory = await treeInventory(path.join(packageRoot, "candidate/public/data"));
  await write(path.join(packageRoot, "inventories/public-data.json"), jsonBytes({ schemaVersion: 1, ...publicInventory }));
  await write(path.join(packageRoot, "inventories/media.json"), jsonBytes(media));
  await write(path.join(packageRoot, "maps/manifest-media.json"), jsonBytes(manifestMap));
  await write(path.join(packageRoot, "media/new", newEntry.key), newData);
  const binding = { schemaVersion: 1, selectedYear: "2092", stagedRunId: "fixture", stagedReceiptSha256: "3".repeat(64), stagedClosedWorldSha256: "4".repeat(64), sourcePolicySha256: "5".repeat(64), sourceInventorySha256: "6".repeat(64), importerCommit: "fixture", previousPublicDataSha256: "7".repeat(64), publicDataSha256: publicInventory.sha256, mediaInventorySha256: digest(stableJson(media)), manifestReferenceMapSha256: manifestMap.sha256, obsoleteButRetainedManifests: [] };
  const packageId = digest(stableJson(binding));
  await write(path.join(packageRoot, "package.json"), jsonBytes({ schemaVersion: 1, status: "publishable-local-package", publicationEligible: true, packageId, binding }));
  const preSeal = await treeInventory(packageRoot);
  await write(path.join(packageRoot, "complete.json"), jsonBytes({ schemaVersion: 1, status: "complete", packageId, fileCountBeforeSeal: preSeal.files.length, closedWorldSha256: preSeal.sha256 }));
  return { packageRoot, newEntry, legacyEntry, newData, legacyData };
}

test("adapter validates identity and follows every pagination token", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-r2-pages-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configuration = await makeConfiguration(root);
  const firstKey = mediaKey("thumbs", "1"), secondKey = mediaKey("display", "2");
  const client = new FakeClient((name, input) => {
    if (name === "HeadBucketCommand") return { $metadata: { httpStatusCode: 200, attempts: 1 } };
    if (!input.ContinuationToken) return { Name: "fixture-media", Prefix: "", Contents: [{ Key: firstKey, Size: 10 }], IsTruncated: true, NextContinuationToken: "next", $metadata: { attempts: 1 } };
    assert.equal(input.ContinuationToken, "next");
    return { Name: "fixture-media", Prefix: "", Contents: [{ Key: secondKey, Size: 20 }], IsTruncated: false, $metadata: { attempts: 1 } };
  });
  const adapter = createR2ReadOnlyAdapter({ configuration, client, pageSize: 1 });
  const identity = await adapter.verifyIdentity();
  const listed = await adapter.listNamespace();
  assert.equal(identity.bucket, "fixture-media"); assert.equal(listed.pages, 2); assert.equal(listed.objects.size, 2); assert.equal(listed.complete, true);
  assert.deepEqual(client.operations.map((item) => item.name), ["HeadBucketCommand", "ListObjectsV2Command", "ListObjectsV2Command"]);
});

test("truncated pagination, namespace escape, and wrong returned bucket fail closed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-r2-list-fail-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configuration = await makeConfiguration(root);
  const truncated = createR2ReadOnlyAdapter({ configuration, client: new FakeClient(() => ({ Name: "fixture-media", Prefix: "", Contents: [], IsTruncated: true })) });
  await assert.rejects(truncated.listNamespace(), /without a fresh continuation token/);
  const wrongBucket = createR2ReadOnlyAdapter({ configuration, client: new FakeClient(() => ({ Name: "wrong", Prefix: "", Contents: [], IsTruncated: false })) });
  await assert.rejects(wrongBucket.listNamespace(), /unexpected bucket identity/);
  const escaped = createR2ReadOnlyAdapter({ configuration, client: new FakeClient(() => ({ Name: "fixture-media", Prefix: "", Contents: [{ Key: "private/source.jpg", Size: 1 }], IsTruncated: false })) });
  const listing = await escaped.listNamespace();
  assert.equal(listing.objects.size, 0); assert.deepEqual(listing.outsideNamespace.map((item) => item.remoteKey), ["private/source.jpg"]);
  assert.equal(escaped.acceptsKey("../private.jpg"), false);
});

test("wrong pinned account, endpoint, or bucket is rejected before creating a client", async (t) => {
  for (const changes of [{ accountId: "b".repeat(32) }, { endpoint: `https://${"b".repeat(32)}.r2.cloudflarestorage.com` }, { bucket: "wrong" }]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-r2-identity-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(makeConfiguration(root, changes), /does not match|canonical endpoint/);
  }
});

test("missing objects, same-size different bytes, untrusted metadata, and readback failures remain explicit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-r2-inspect-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configuration = await makeConfiguration(root);
  const key = mediaKey("thumbs", "1"), expected = Buffer.from("expected");
  const missingError = Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
  let client = new FakeClient(() => { throw missingError; });
  let adapter = createR2ReadOnlyAdapter({ configuration, client });
  assert.equal((await adapter.inspect(key, { expectedSha256: digest(expected), maximumReadbackBytes: 100 })).verificationStatus, "missing");

  client = new FakeClient((name) => name === "HeadObjectCommand"
    ? { ContentLength: expected.length, ETag: '"not-proof"', ChecksumSHA256: Buffer.from(digest(expected), "hex").toString("base64"), ChecksumType: "COMPOSITE", $metadata: { attempts: 1 } }
    : { ContentLength: expected.length, Body: body(Buffer.from("differnt")), $metadata: { attempts: 1 } });
  adapter = createR2ReadOnlyAdapter({ configuration, client });
  const conflict = await adapter.inspect(key, { expectedSha256: digest(expected), maximumReadbackBytes: 100 });
  assert.equal(conflict.verificationStatus, "conflict"); assert.equal(conflict.verificationMethod, "bounded-full-object-sha256-readback");

  client = new FakeClient(() => ({ ContentLength: expected.length, ETag: `"${digest(expected).slice(0, 32)}"`, ChecksumSHA256: Buffer.from(digest(expected), "hex").toString("base64"), ChecksumType: "COMPOSITE", $metadata: { attempts: 1 } }));
  adapter = createR2ReadOnlyAdapter({ configuration, client });
  const unverified = await adapter.inspect(key, { expectedSha256: digest(expected), maximumReadbackBytes: 0 });
  assert.equal(unverified.verificationStatus, "unverified"); assert.match(unverified.verificationMethod, /not-sha256-proof/);

  client = new FakeClient(() => ({ ContentLength: expected.length, ChecksumSHA256: Buffer.from(digest(expected), "hex").toString("base64"), ChecksumType: "FULL_OBJECT", $metadata: { attempts: 1 } }));
  adapter = createR2ReadOnlyAdapter({ configuration, client });
  const trusted = await adapter.inspect(key, { expectedSha256: digest(expected), maximumReadbackBytes: 0 });
  assert.equal(trusted.verificationStatus, "verified"); assert.equal(trusted.verificationMethod, "r2-full-object-sha256-metadata");
  assert.deepEqual(client.operations.map((operation) => operation.name), ["HeadObjectCommand"]);

  client = new FakeClient((name) => name === "HeadObjectCommand" ? { ContentLength: expected.length, ETag: '"etag"', $metadata: { attempts: 1 } } : { ContentLength: expected.length, Body: body(null, new Error("readback broke")), $metadata: { attempts: 1 } });
  adapter = createR2ReadOnlyAdapter({ configuration, client });
  const failed = await adapter.inspect(key, { expectedSha256: digest(expected), maximumReadbackBytes: 100 });
  assert.equal(failed.verificationStatus, "unverified"); assert.equal(failed.verificationMethod, "readback-failed"); assert.match(failed.unverifiedReason, /readback broke/);
});

test("package preflight reports missing new, verified retained, and unexpected managed objects without a receipt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-r2-package-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configuration = await makeConfiguration(root), pkg = await makePackage(root);
  const unexpectedKey = mediaKey("display", "3");
  const client = new FakeClient((name) => {
    if (name === "HeadBucketCommand") return { $metadata: { httpStatusCode: 200, attempts: 1 } };
    if (name === "ListObjectsV2Command") return { Name: "fixture-media", Prefix: "", Contents: [{ Key: pkg.legacyEntry.key, Size: pkg.legacyEntry.bytes }, { Key: unexpectedKey, Size: 4 }], IsTruncated: false, $metadata: { attempts: 1 } };
    if (name === "HeadObjectCommand") return { ContentLength: pkg.legacyEntry.bytes, ETag: '"etag"', $metadata: { attempts: 1 } };
    if (name === "GetObjectCommand") return { ContentLength: pkg.legacyEntry.bytes, Body: body(pkg.legacyData), $metadata: { attempts: 1 } };
    throw new Error(`Unexpected command ${name}`);
  });
  const adapter = createR2ReadOnlyAdapter({ configuration, client });
  const report = await runR2PackagePreflight({ adapter, packageRoot: pkg.packageRoot, maximumReadbackBytes: 1024 });
  assert.equal(report.status, "READ_ONLY_PREFLIGHT_BLOCKED");
  assert.equal(report.publicationReceiptIssued, false); assert.equal(report.mediaUploaded, false);
  assert.deepEqual(report.missingNewKeys, [pkg.newEntry.key]); assert.deepEqual(report.missingRetainedKeys, []);
  assert.equal(report.matchingKeys.length, 1); assert.deepEqual(report.namespace.unexpectedKeys, [unexpectedKey]);
  assert.equal(report.requests.writes, 0); assert.equal(report.requests.deletes, 0);
  assert(client.operations.every((operation) => ["HeadBucketCommand", "ListObjectsV2Command", "HeadObjectCommand", "GetObjectCommand"].includes(operation.name)));
});

test("R2 preflight and legacy upload CLIs reject every mutation bypass before network access", () => {
  const preflight = path.join(REPO_ROOT, "scripts", "r2-preflight.mjs"), legacy = path.join(REPO_ROOT, "scripts", "media-upload-r2.mjs");
  for (const flag of ["--execute", "--upload", "--put", "--copy", "--delete", "--mutate-metadata", "--force"]) {
    const result = spawnSync(process.execPath, [preflight, flag], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Mutation option is forbidden/);
  }
  for (const args of [["--execute"], ["--dry-run"], ["--force"], ["--delete"]]) {
    const result = spawnSync(process.execPath, [legacy, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Legacy broad media upload is disabled/);
  }
});
