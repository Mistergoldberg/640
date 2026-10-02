import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { executePublication, verifyPublicationPackage } from "./package-media-publication.mjs";
import { mintPackageBoundR2Credentials } from "./r2-package-credentials.mjs";
import { createR2LocalTemporaryCredentials } from "./r2-local-temporary-credentials.mjs";
import {
  createIsolatedR2WriteAdapter,
  isolatedR2WriteContract,
  loadIsolatedR2WriteConfiguration
} from "./r2-isolated-write-adapter.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ACCOUNT = "a".repeat(32);
const BUCKET = "pixilation-isolated-test";
const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const ROLE_ACTIONS = { publisher: ["GetObject", "PutObject"], inventory: ["ListObjectsV2"] };
const stableValue = (value) => Array.isArray(value) ? value.map(stableValue) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])])) : value;
const stableJson = (value) => JSON.stringify(stableValue(value));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function write(filePath, bytes) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
}

async function treeInventory(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else {
        const bytes = await fs.readFile(absolute);
        files.push({ path: path.relative(root, absolute).split(path.sep).join("/"), bytes: bytes.length, sha256: digest(bytes) });
      }
    }
  }
  await walk(root);
  return { files, sha256: digest(stableJson(files)) };
}

function mediaKey(kind, idChar, contentChar) {
  return `2092/${kind}/2092-${idChar.repeat(14)}-cv1-${contentChar.repeat(64)}.jpg`;
}

async function packageFixture({ retainedLast = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-r2-write-"));
  const packageRoot = path.join(root, "package");
  const journalRoot = path.join(root, "journal");
  const raw = [
    { key: mediaKey("thumbs", "a", "1"), data: Buffer.from("fixture-thumb-a") },
    { key: mediaKey("display", "a", "2"), data: Buffer.from("fixture-display-a") },
    { key: mediaKey("thumbs", "b", "3"), data: Buffer.from("fixture-thumb-b") },
    { key: mediaKey("display", "b", "4"), data: Buffer.from("fixture-display-b") }
  ];
  const entries = raw.map(({ key, data }) => ({ key, bytes: data.length, sha256: digest(data), source: "staged-new", data }));
  const expectedMedia = entries.map(({ data, ...entry }) => entry);
  const newVersionedKeys = retainedLast ? expectedMedia.slice(0, -1) : expectedMedia;
  const existingVersionedKeys = retainedLast ? expectedMedia.slice(-1) : [];
  const media = { schemaVersion: 1, expectedMedia, expectedMediaSha256: digest(stableJson(expectedMedia)), newVersionedKeys, existingVersionedKeys, existingLegacyKeysRetained: [], obsoleteButRetainedKeys: [], rollbackKeys: [], conflicts: [] };
  const photos = [
    { id: `2092-${"a".repeat(14)}`, thumbnailKey: entries[0].key, displayKey: entries[1].key },
    { id: `2092-${"b".repeat(14)}`, thumbnailKey: entries[2].key, displayKey: entries[3].key }
  ];
  const manifestBytes = jsonBytes({ photos });
  const manifest = { year: "2092", manifestPath: "2092/albums/test.json", manifestSha256: digest(manifestBytes), photos };
  const map = { manifests: [manifest], sha256: digest(stableJson([manifest])) };
  await write(path.join(packageRoot, "candidate/public/data/catalog.json"), jsonBytes({ years: [{ year: "2092", indexUrl: "data/2092/index.json" }] }));
  await write(path.join(packageRoot, "candidate/public/data/2092/albums/test.json"), manifestBytes);
  const publicInventory = await treeInventory(path.join(packageRoot, "candidate/public/data"));
  await write(path.join(packageRoot, "inventories/public-data.json"), jsonBytes({ schemaVersion: 1, ...publicInventory }));
  await write(path.join(packageRoot, "inventories/media.json"), jsonBytes(media));
  await write(path.join(packageRoot, "maps/manifest-media.json"), jsonBytes(map));
  for (const entry of entries.filter(({ key }) => newVersionedKeys.some((item) => item.key === key))) await write(path.join(packageRoot, "media/new", entry.key), entry.data);
  const binding = { schemaVersion: 1, selectedYear: "2092", stagedRunId: "synthetic-fixture", stagedReceiptSha256: "6".repeat(64), stagedClosedWorldSha256: "7".repeat(64), sourcePolicySha256: "8".repeat(64), sourceInventorySha256: "9".repeat(64), importerCommit: "synthetic", previousPublicDataSha256: "0".repeat(64), publicDataSha256: publicInventory.sha256, mediaInventorySha256: digest(stableJson(media)), manifestReferenceMapSha256: map.sha256, obsoleteButRetainedManifests: [] };
  const packageId = digest(stableJson(binding));
  await write(path.join(packageRoot, "package.json"), jsonBytes({ schemaVersion: 1, status: "publishable-local-package", publicationEligible: true, packageId, binding }));
  const preSeal = await treeInventory(packageRoot);
  await write(path.join(packageRoot, "complete.json"), jsonBytes({ schemaVersion: 1, status: "complete", packageId, fileCountBeforeSeal: preSeal.files.length, closedWorldSha256: preSeal.sha256 }));
  return { root, packageRoot, journalRoot, entries, verifiedPackage: await verifyPublicationPackage(packageRoot) };
}

function base64url(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

async function configurationFixture(verifiedPackage, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-r2-config-"));
  const accessKeyId = "fixture-access-key";
  const now = Math.floor(Date.now() / 1000);
  const role = (name, actions, objectPaths = [], claimChanges = {}) => {
    const claims = { bucket: BUCKET, actions, ...(objectPaths.length ? { paths: { prefixPaths: [], objectPaths } } : {}), sub: ACCOUNT, iss: accessKeyId, aud: new URL(ENDPOINT).host, iat: now, exp: now + 3600, ...claimChanges };
    const unsigned = `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url(claims)}`;
    const signature = crypto.createHmac("sha256", "fixture-parent-secret").update(unsigned).digest("base64url");
    const jwt = `${unsigned}.${signature}`;
    return {
      credentials: { accessKeyId, secretAccessKey: digest(jwt), sessionToken: Buffer.from(`jwt/${jwt}`).toString("base64") },
      descriptor: { type: "cloudflare-r2-locally-signed-temporary", accountId: ACCOUNT, bucket: claims.bucket, endpoint: ENDPOINT, scope: null, actions: claims.actions, paths: claims.paths || null, issuedAt: new Date(claims.iat * 1000).toISOString(), expiresAt: new Date(claims.exp * 1000).toISOString(), ttlSeconds: claims.exp - claims.iat, accessKeyFingerprint: digest(accessKeyId).slice(0, 16), sessionFingerprint: digest(jwt).slice(0, 16), role: name }
    };
  };
  const newKeys = [...verifiedPackage.newByKey.keys()].sort();
  const retainedKeys = [...verifiedPackage.expectedByKey.keys()].filter((key) => !verifiedPackage.newByKey.has(key)).sort();
  const bundle = { schemaVersion: 2, environment: "isolated-write-test-action-scoped", identity: { accountId: ACCOUNT, bucket: BUCKET, endpoint: ENDPOINT, ...overrides.identity }, packageId: verifiedPackage.receipt.packageId, publicationId: verifiedPackage.publicationId, roles: { publisher: role("publisher", ROLE_ACTIONS.publisher, newKeys, overrides.publisherClaims), inventory: role("inventory", ROLE_ACTIONS.inventory, [], overrides.inventoryClaims), ...(retainedKeys.length ? { verifier: role("verifier", ["GetObject"], retainedKeys, overrides.verifierClaims) } : {}) } };
  const pin = { schemaVersion: 1, provider: "cloudflare-r2", environment: "isolated-write-test", accountIdSha256: digest(ACCOUNT), bucket: BUCKET, endpointSha256: digest(ENDPOINT), forbiddenBuckets: ["production-media"], forbiddenPublicEndpoints: ["https://media.example.com"], credentialRoles: { publisher: { actions: ROLE_ACTIONS.publisher }, verifier: { actions: ["GetObject"] }, inventory: { actions: ROLE_ACTIONS.inventory }, actionClaimStatus: "proven-action-only-2026-10-02" }, namespace: { id: "pixilation-isolated-publication-test-v1", remotePrefix: "", keyFormat: "pixilation-media-key-v1" }, ...overrides.pin };
  const configPath = path.join(root, "config.json"), credentialsPath = path.join(root, "credentials.json");
  await write(configPath, jsonBytes(pin)); await write(credentialsPath, jsonBytes(bundle));
  return { root, configPath, credentialsPath, configuration: await loadIsolatedR2WriteConfiguration({ configPath, credentialsPath, verifiedPackage }) };
}

class MemoryR2Client {
  constructor({ failPuts = 0, loseFirstPutResponse = false, corruptAfterPut = false, pageSize = Infinity } = {}) {
    this.objects = new Map(); this.requests = []; this.failPuts = failPuts; this.loseFirstPutResponse = loseFirstPutResponse; this.corruptAfterPut = corruptAfterPut; this.pageSize = pageSize; this.lost = false;
  }
  async send(command) {
    const name = command.constructor.name, input = command.input;
    this.requests.push({ name, input });
    if (name === "ListObjectsV2Command") {
      const keys = [...this.objects.keys()].sort();
      const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
      const limit = Math.min(input.MaxKeys || 1000, this.pageSize);
      const selected = keys.slice(start, start + limit);
      const next = start + selected.length;
      return { Name: input.Bucket, Prefix: input.Prefix, KeyCount: selected.length, Contents: selected.map((Key) => ({ Key, Size: this.objects.get(Key).bytes.length })), IsTruncated: next < keys.length, ...(next < keys.length ? { NextContinuationToken: String(next) } : {}), $metadata: { httpStatusCode: 200, attempts: 1 } };
    }
    if (name === "GetObjectCommand") {
      const object = this.objects.get(input.Key);
      if (!object) { const error = new Error("missing"); error.name = "NoSuchKey"; error.$metadata = { httpStatusCode: 404 }; throw error; }
      async function* body() { yield object.bytes; }
      return { Body: body(), ContentLength: object.bytes.length, ContentType: object.contentType, CacheControl: object.cacheControl, ChecksumSHA256: object.checksum, ChecksumType: "COMPOSITE", ETag: `\"${digest(object.bytes).slice(0, 32)}\"`, $metadata: { httpStatusCode: 200, attempts: 1 } };
    }
    if (name === "PutObjectCommand") {
      if (input.IfNoneMatch !== "*") throw new Error("unsafe put");
      if (this.failPuts > 0) { this.failPuts -= 1; const error = new Error("transient"); error.name = "ServiceUnavailable"; error.$metadata = { httpStatusCode: 503, attempts: 1 }; throw error; }
      if (this.objects.has(input.Key)) { const error = new Error("precondition"); error.name = "PreconditionFailed"; error.$metadata = { httpStatusCode: 412, requestId: "precondition-request" }; throw error; }
      const bytes = Buffer.from(input.Body);
      const checksum = Buffer.from(digest(bytes), "hex").toString("base64");
      if (checksum !== input.ChecksumSHA256) { const error = new Error("bad checksum"); error.name = "BadDigest"; error.$metadata = { httpStatusCode: 400 }; throw error; }
      this.objects.set(input.Key, { bytes: this.corruptAfterPut ? Buffer.alloc(bytes.length, 120) : bytes, contentType: input.ContentType, cacheControl: input.CacheControl, checksum });
      if (this.loseFirstPutResponse && !this.lost) { this.lost = true; const error = new Error("response lost"); error.name = "TimeoutError"; error.$metadata = { attempts: 1 }; throw error; }
      return { ETag: `\"${digest(bytes).slice(0, 32)}\"`, ChecksumSHA256: checksum, ChecksumType: "COMPOSITE", $metadata: { httpStatusCode: 200, requestId: "created-request", attempts: 1 } };
    }
    throw new Error(`Unsupported command ${name}`);
  }
}

test("documented local signing produces action-only, exact-path, short-lived credentials", async () => {
  const result = await createR2LocalTemporaryCredentials({ endpoint: ENDPOINT, accountId: ACCOUNT, parentAccessKeyId: "parent-access", parentSecretAccessKey: "parent-secret", bucket: BUCKET, actions: ["PutObject", "GetObject"], paths: { objectPaths: ["2092/display/example.jpg"] }, ttlSeconds: 300, now: 1_800_000_000 });
  const jwt = Buffer.from(result.credentials.sessionToken, "base64").toString("utf8").slice(4);
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  assert.equal(claims.scope, undefined);
  assert.deepEqual(claims.actions, ["GetObject", "PutObject"]);
  assert.deepEqual(claims.paths, { prefixPaths: [], objectPaths: ["2092/display/example.jpg"] });
  assert.equal(claims.exp - claims.iat, 300);
  assert.equal(result.credentials.secretAccessKey, digest(jwt));
  await assert.rejects(createR2LocalTemporaryCredentials({ endpoint: ENDPOINT, accountId: ACCOUNT, parentAccessKeyId: "a", parentSecretAccessKey: "b", bucket: BUCKET, actions: ["DeleteBucket"], ttlSeconds: 300 }), /unsupported or empty action/);
  await assert.rejects(createR2LocalTemporaryCredentials({ endpoint: ENDPOINT, accountId: ACCOUNT, parentAccessKeyId: "a", parentSecretAccessKey: "b", bucket: BUCKET, actions: ["PutObject"], paths: { objectPaths: ["../escape"] }, ttlSeconds: 300 }), /Unsafe R2 credential path/);
});

test("credential mint binds publisher and inventory roles to one verified package without printing secrets", async (t) => {
  const pkg = await packageFixture(), cfg = await configurationFixture(pkg.verifiedPackage);
  t.after(() => Promise.all([fs.rm(pkg.root, { recursive: true, force: true }), fs.rm(cfg.root, { recursive: true, force: true })]));
  const parentPath = path.join(pkg.root, "parent.json"), outputPath = path.join(pkg.root, "bundle.json");
  await write(parentPath, jsonBytes({ R2_ACCOUNT_ID: ACCOUNT, R2_ENDPOINT: ENDPOINT, R2_BUCKET: "production-media", R2_ACCESS_KEY_ID: "parent-access", R2_SECRET_ACCESS_KEY: "parent-secret" }));
  const report = await mintPackageBoundR2Credentials({ packageRoot: pkg.packageRoot, configPath: cfg.configPath, parentCredentialsPath: parentPath, outputPath, ttlSeconds: 300 });
  assert.deepEqual(report.roles.publisher.actions, ["GetObject", "PutObject"]);
  assert.deepEqual(report.roles.publisher.paths.objectPaths, pkg.entries.map((entry) => entry.key).sort());
  assert.deepEqual(report.roles.inventory.actions, ["ListObjectsV2"]);
  assert.equal(JSON.stringify(report).includes("parent-secret"), false);
  assert.equal((await fs.stat(outputPath)).mode & 0o777, 0o600);
  const loaded = await loadIsolatedR2WriteConfiguration({ configPath: cfg.configPath, credentialsPath: outputPath, verifiedPackage: pkg.verifiedPackage });
  assert.deepEqual(loaded.identity.credentialRoles.publisher.credentialActions, ["GetObject", "PutObject"]);
});

test("retained media receives a separate exact-path GetObject verifier role", async (t) => {
  const pkg = await packageFixture({ retainedLast: true }), cfg = await configurationFixture(pkg.verifiedPackage);
  t.after(() => Promise.all([fs.rm(pkg.root, { recursive: true, force: true }), fs.rm(cfg.root, { recursive: true, force: true })]));
  const parentPath = path.join(pkg.root, "parent.json"), outputPath = path.join(pkg.root, "bundle.json");
  await write(parentPath, jsonBytes({ R2_ACCOUNT_ID: ACCOUNT, R2_ENDPOINT: ENDPOINT, R2_BUCKET: "production-media", R2_ACCESS_KEY_ID: "parent-access", R2_SECRET_ACCESS_KEY: "parent-secret" }));
  const report = await mintPackageBoundR2Credentials({ packageRoot: pkg.packageRoot, configPath: cfg.configPath, parentCredentialsPath: parentPath, outputPath, ttlSeconds: 300 });
  assert.deepEqual(report.roles.verifier.actions, ["GetObject"]);
  assert.deepEqual(report.roles.verifier.paths.objectPaths, [pkg.entries.at(-1).key]);
  assert.equal(report.roles.publisher.paths.objectPaths.includes(pkg.entries.at(-1).key), false);
  const loaded = await loadIsolatedR2WriteConfiguration({ configPath: cfg.configPath, credentialsPath: outputPath, verifiedPackage: pkg.verifiedPackage });
  assert.deepEqual(loaded.identity.credentialRoles.verifier.credentialActions, ["GetObject"]);
});

test("isolated config validates destination and temporary credential claims without exposing secrets", async (t) => {
  const pkg = await packageFixture(); t.after(() => fs.rm(pkg.root, { recursive: true, force: true }));
  const fx = await configurationFixture(pkg.verifiedPackage); t.after(() => fs.rm(fx.root, { recursive: true, force: true }));
  assert.equal(fx.configuration.identity.bucket, BUCKET);
  assert.deepEqual(fx.configuration.identity.credentialRoles.publisher.credentialActions, ROLE_ACTIONS.publisher);
  assert.equal(JSON.stringify(fx.configuration.identity).includes(fx.configuration.credentials.publisher.secretAccessKey), false);
  for (const variant of [
    { identity: { bucket: "production-media" } },
    { publisherClaims: { bucket: "production-media" } },
    { publisherClaims: { scope: "object-read-write" } },
    { publisherClaims: { actions: ["DeleteObject"] } },
    { publisherClaims: { paths: { prefixPaths: [], objectPaths: ["2092/thumbs/foreign.jpg"] } } },
    { publisherClaims: { exp: Math.floor(Date.now() / 1000) - 1 } }
  ]) {
    const result = await configurationFixture(pkg.verifiedPackage, variant).catch((error) => ({ error }));
    if (!result.error) {
      await fs.rm(result.root, { recursive: true, force: true });
      assert.fail("unsafe credential accepted");
    }
  }
});

test("conditional creation validates checksum and metadata and never overwrites identical or conflicting bytes", async (t) => {
  const pkg = await packageFixture(), cfg = await configurationFixture(pkg.verifiedPackage);
  t.after(() => Promise.all([fs.rm(pkg.root, { recursive: true, force: true }), fs.rm(cfg.root, { recursive: true, force: true })]));
  const client = new MemoryR2Client({ pageSize: 1 });
  const adapter = createIsolatedR2WriteAdapter({ configuration: cfg.configuration, verifiedPackage: pkg.verifiedPackage, clients: { publisher: client, inventory: client }, pageSize: 1 });
  const entry = pkg.entries[0], source = path.join(pkg.packageRoot, "media/new", entry.key);
  assert.equal((await adapter.putIfAbsent(entry.key, source)).created, true);
  assert.equal((await adapter.putIfAbsent(entry.key, source)).created, false);
  await fs.writeFile(source, Buffer.alloc(entry.bytes, 120));
  await assert.rejects(adapter.putIfAbsent(entry.key, source), /Packaged bytes changed/);
  const actual = await adapter.inspect(entry.key);
  assert.equal(actual.sha256, entry.sha256);
  assert.equal(actual.contentType, "image/jpeg");
  assert.equal(actual.cacheControl, "public, max-age=31536000, immutable");
  assert.equal(client.requests.filter((item) => item.name === "PutObjectCommand").every((item) => item.input.IfNoneMatch === "*"), true);
  assert.equal(adapter.stats.preconditionFailures, 1);
});

test("concurrent writers race atomically and only one payload becomes visible", async (t) => {
  const pkg = await packageFixture(), cfg = await configurationFixture(pkg.verifiedPackage);
  t.after(() => Promise.all([fs.rm(pkg.root, { recursive: true, force: true }), fs.rm(cfg.root, { recursive: true, force: true })]));
  const client = new MemoryR2Client(), entry = pkg.entries[0], source = path.join(pkg.packageRoot, "media/new", entry.key);
  const one = createIsolatedR2WriteAdapter({ configuration: cfg.configuration, verifiedPackage: pkg.verifiedPackage, clients: { publisher: client, inventory: client } });
  const two = createIsolatedR2WriteAdapter({ configuration: cfg.configuration, verifiedPackage: pkg.verifiedPackage, clients: { publisher: client, inventory: client } });
  const results = await Promise.all([one.putIfAbsent(entry.key, source), two.putIfAbsent(entry.key, source)]);
  assert.deepEqual(results.map((item) => item.created).sort(), [false, true]);
  assert.equal((await one.inspect(entry.key)).sha256, entry.sha256);
});

test("lost response resumes by readback, transient failures are bounded, and retry exhaustion never PASSes", async (t) => {
  const lost = await packageFixture(), cfg = await configurationFixture(lost.verifiedPackage);
  t.after(() => Promise.all([fs.rm(lost.root, { recursive: true, force: true }), fs.rm(cfg.root, { recursive: true, force: true })]));
  const lostClient = new MemoryR2Client({ loseFirstPutResponse: true });
  const lostAdapter = createIsolatedR2WriteAdapter({ configuration: cfg.configuration, verifiedPackage: lost.verifiedPackage, clients: { publisher: lostClient, inventory: lostClient } });
  const result = await executePublication({ packageRoot: lost.packageRoot, adapter: lostAdapter, journalRoot: lost.journalRoot, concurrency: 1, maxAttempts: 3 });
  assert.equal(result.receipt.status, "PASS");
  assert.equal(result.receipt.objects.every((item) => item.verificationMethod === "full-object-sha256-readback"), true);
  assert.equal(lostClient.requests.some((item) => /Delete|Copy/.test(item.name)), false);

  const exhausted = await packageFixture(); t.after(() => fs.rm(exhausted.root, { recursive: true, force: true }));
  const failingClient = new MemoryR2Client({ failPuts: 100 });
  const exhaustedCfg = await configurationFixture(exhausted.verifiedPackage); t.after(() => fs.rm(exhaustedCfg.root, { recursive: true, force: true }));
  const failingAdapter = createIsolatedR2WriteAdapter({ configuration: exhaustedCfg.configuration, verifiedPackage: exhausted.verifiedPackage, clients: { publisher: failingClient, inventory: failingClient } });
  await assert.rejects(executePublication({ packageRoot: exhausted.packageRoot, adapter: failingAdapter, journalRoot: exhausted.journalRoot, concurrency: 1, maxAttempts: 2 }), /retry limit exhausted/);
  await assert.rejects(fs.access(path.join(exhausted.journalRoot, "receipt.json")), /ENOENT/);
  assert.equal(failingClient.requests.filter((item) => item.name === "PutObjectCommand").length, 2);
});

test("corrupt readback, unexpected keys, foreign keys, and CLI bypass flags fail closed", async (t) => {
  const pkg = await packageFixture(), cfg = await configurationFixture(pkg.verifiedPackage);
  t.after(() => Promise.all([fs.rm(pkg.root, { recursive: true, force: true }), fs.rm(cfg.root, { recursive: true, force: true })]));
  const corrupt = new MemoryR2Client({ corruptAfterPut: true });
  const corruptAdapter = createIsolatedR2WriteAdapter({ configuration: cfg.configuration, verifiedPackage: pkg.verifiedPackage, clients: { publisher: corrupt, inventory: corrupt } });
  await assert.rejects(executePublication({ packageRoot: pkg.packageRoot, adapter: corruptAdapter, journalRoot: pkg.journalRoot, concurrency: 1, maxAttempts: 1 }), /retry limit exhausted/);
  await assert.rejects(fs.access(path.join(pkg.journalRoot, "receipt.json")), /ENOENT/);

  const client = new MemoryR2Client(); client.objects.set("foreign/file.jpg", { bytes: Buffer.from("x") });
  const adapter = createIsolatedR2WriteAdapter({ configuration: cfg.configuration, verifiedPackage: pkg.verifiedPackage, clients: { publisher: client, inventory: client } });
  assert.equal((await adapter.listKeys()).includes("foreign/file.jpg"), true);
  await assert.rejects(adapter.putIfAbsent("2093/display/foreign.jpg", "/tmp/nope"), /grammar|verified package/);

  const script = path.join(REPO_ROOT, "scripts/r2-package-upload.mjs");
  for (const flag of ["--force", "--production", "--delete", "--copy", "--overwrite", "--bucket", "--endpoint"]) {
    const result = spawnSync(process.execPath, [script, "--execute", flag, "value"], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Forbidden R2 publication option/);
  }
  assert.deepEqual(isolatedR2WriteContract.credentialRoles.publisher, ["GetObject", "PutObject"]);
  assert.equal(isolatedR2WriteContract.deletes, false); assert.equal(isolatedR2WriteContract.overwrites, false);
});
