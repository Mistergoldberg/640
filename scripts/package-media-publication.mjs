import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isSupportedMediaKey } from "./content-versioned-media.mjs";
import { verifyPromotionPackage } from "./promote-staged-release.mjs";

const SCHEMA_VERSION = 1;
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_ROOT, "..");
const TRUSTED_METHOD = "full-object-sha256-readback";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function toPosix(value) { return value.split(path.sep).join("/"); }
function isInsideOrEqual(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
async function exists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }
async function readJson(filePath, label) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) { throw new Error(`${label} is missing or invalid JSON: ${filePath}: ${error instanceof Error ? error.message : String(error)}`); }
}
async function physicalPathWithoutCreating(targetPath) {
  const unresolved = [];
  let current = path.resolve(targetPath);
  while (true) {
    try { return path.resolve(await fs.realpath(current), ...unresolved); }
    catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      unresolved.unshift(path.basename(current));
      current = parent;
    }
  }
}
async function fileRecord(filePath) {
  const bytes = await fs.readFile(filePath);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}
async function walkFiles(root) {
  const files = [];
  if (!(await exists(root))) return files;
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symlink in object-store fixture: ${absolutePath}`);
      if (stat.isDirectory()) await walk(absolutePath);
      else if (stat.isFile()) files.push(absolutePath);
      else throw new Error(`Refusing non-regular object-store entry: ${absolutePath}`);
    }
  }
  await walk(root);
  return files;
}
function validateRecord(entry, label) {
  if (!entry || !isSupportedMediaKey(entry.key)) throw new Error(`${label} has an invalid media key: ${entry?.key}`);
  if (!Number.isInteger(entry.bytes) || entry.bytes < 0) throw new Error(`${label} has invalid bytes for ${entry.key}`);
  if (!/^[a-f0-9]{64}$/.test(entry.sha256 || "")) throw new Error(`${label} has invalid SHA-256 for ${entry.key}`);
}
function exactSet(actual, expected, label) {
  const missing = [...expected].filter((value) => !actual.has(value)).sort();
  const unexpected = [...actual].filter((value) => !expected.has(value)).sort();
  if (missing.length || unexpected.length) throw new Error(`${label} differs: missing ${missing.join(", ") || "none"}; unexpected ${unexpected.join(", ") || "none"}`);
}

export async function verifyPublicationPackage(packageRoot) {
  const resolvedRoot = path.resolve(packageRoot);
  const verified = await verifyPromotionPackage(resolvedRoot);
  const packageRecord = await fileRecord(path.join(resolvedRoot, "package.json"));
  const completeRecord = await fileRecord(path.join(resolvedRoot, "complete.json"));
  const map = await readJson(path.join(resolvedRoot, "maps", "manifest-media.json"), "Manifest-to-media map");
  if (!Array.isArray(map.manifests) || sha256(stableJson(map.manifests)) !== map.sha256) throw new Error("Manifest-to-media map digest is invalid");
  if (map.sha256 !== verified.receipt.binding.manifestReferenceMapSha256) throw new Error("Manifest-to-media map does not match the promotion-package binding");
  if ((verified.media.conflicts || []).length) throw new Error("Promotion media inventory contains unresolved conflicts");
  const expected = verified.media.expectedMedia || [];
  const expectedByKey = new Map();
  for (const entry of expected) {
    validateRecord(entry, "Expected-media inventory");
    if (expectedByKey.has(entry.key)) throw new Error(`Duplicate expected media key: ${entry.key}`);
    expectedByKey.set(entry.key, entry);
  }
  if (sha256(stableJson(expected)) !== verified.media.expectedMediaSha256) throw new Error("Expected-media inventory digest is invalid");
  const referencedKeys = new Set();
  for (const manifest of map.manifests) {
    if (typeof manifest.manifestPath !== "string" || manifest.manifestPath.includes("..") || path.isAbsolute(manifest.manifestPath)) throw new Error(`Manifest map contains an unsafe path: ${manifest.manifestPath}`);
    const manifestPath = path.join(resolvedRoot, "candidate", "public", "data", ...manifest.manifestPath.split("/"));
    const bytes = await fs.readFile(manifestPath);
    if (sha256(bytes) !== manifest.manifestSha256) throw new Error(`Manifest map checksum does not match candidate manifest: ${manifest.manifestPath}`);
    const candidate = JSON.parse(bytes.toString("utf8"));
    const actualReferences = (candidate.photos || []).map(({ id, thumbnailKey, displayKey }) => ({ id, thumbnailKey, displayKey }));
    if (stableJson(actualReferences) !== stableJson(manifest.photos || [])) throw new Error(`Manifest map references do not match candidate manifest: ${manifest.manifestPath}`);
    for (const photo of manifest.photos || []) for (const key of [photo.thumbnailKey, photo.displayKey]) {
      if (!isSupportedMediaKey(key)) throw new Error(`Manifest map contains invalid media key: ${key}`);
      referencedKeys.add(key);
    }
  }
  exactSet(referencedKeys, new Set(expectedByKey.keys()), "Manifest references and expected-media inventory");
  const newByKey = new Map();
  for (const entry of verified.media.newVersionedKeys || []) {
    validateRecord(entry, "New-media inventory");
    if (!entry.key.includes("-cv")) throw new Error(`Approved new-media key is not content-versioned: ${entry.key}`);
    const expectedEntry = expectedByKey.get(entry.key);
    if (!expectedEntry || expectedEntry.bytes !== entry.bytes || expectedEntry.sha256 !== entry.sha256) throw new Error(`New-media entry does not exactly match expected media: ${entry.key}`);
    if (newByKey.has(entry.key)) throw new Error(`Duplicate new media key: ${entry.key}`);
    newByKey.set(entry.key, entry);
  }
  const newSet = [...newByKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  const binding = {
    schemaVersion: SCHEMA_VERSION,
    packageId: verified.receipt.packageId,
    packageReceiptSha256: packageRecord.sha256,
    packageCompletionSha256: completeRecord.sha256,
    packageClosedWorldSha256: verified.completion.closedWorldSha256,
    mediaInventorySha256: verified.receipt.binding.mediaInventorySha256,
    manifestReferenceMapSha256: map.sha256,
    expectedMediaSha256: verified.media.expectedMediaSha256,
    newMediaSetSha256: sha256(stableJson(newSet))
  };
  return { packageRoot: resolvedRoot, ...verified, manifestMap: map, expectedByKey, newByKey, binding, publicationId: sha256(stableJson(binding)) };
}

async function assertNoSymlinkAncestors(root) {
  let current = path.resolve(root);
  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Refusing object-store path through symlink: ${current}`);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function createFilesystemObjectStore(objectRoot, hooks = {}) {
  const root = path.resolve(objectRoot);
  await assertNoSymlinkAncestors(root);
  const identity = { type: "filesystem-fixture", root: await physicalPathWithoutCreating(root), checksumMethod: TRUSTED_METHOD };
  const objectPath = (key) => {
    if (!isSupportedMediaKey(key)) throw new Error(`Invalid object key: ${key}`);
    const target = path.resolve(root, ...key.split("/"));
    if (!isInsideOrEqual(target, root)) throw new Error(`Object key escapes fixture root: ${key}`);
    return target;
  };
  return {
    identity,
    async listKeys() {
      hooks.onOperation?.({ operation: "list" });
      return (await walkFiles(root)).map((file) => toPosix(path.relative(root, file))).sort();
    },
    async inspect(key) {
      hooks.onOperation?.({ operation: "inspect", key });
      const target = objectPath(key);
      try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Remote object is not a regular file: ${key}`);
        const record = await fileRecord(target);
        return { exists: true, ...record, verificationMethod: TRUSTED_METHOD, verifiedAt: new Date().toISOString() };
      } catch (error) {
        if (error?.code === "ENOENT") return { exists: false, verificationMethod: TRUSTED_METHOD, verifiedAt: new Date().toISOString() };
        throw error;
      }
    },
    async putIfAbsent(key, sourcePath) {
      hooks.onOperation?.({ operation: "put-if-absent", key });
      const target = objectPath(key);
      await assertNoSymlinkAncestors(path.dirname(target));
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = path.join(path.dirname(target), `.pixilation-upload-${crypto.randomBytes(12).toString("hex")}.tmp`);
      try {
        await fs.copyFile(sourcePath, temporary, fs.constants.COPYFILE_EXCL);
        const handle = await fs.open(temporary, "r");
        try { await handle.sync(); } finally { await handle.close(); }
        try { await fs.link(temporary, target); return { created: true }; }
        catch (error) { if (error?.code === "EEXIST") return { created: false }; throw error; }
      } finally { await fs.rm(temporary, { force: true }); }
    }
  };
}

function matchesExpected(actual, expected) {
  return actual.exists && actual.verificationMethod === TRUSTED_METHOD && actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
}
function publicEntry(entry) { return { key: entry.key, bytes: entry.bytes, sha256: entry.sha256 }; }
function adapterIdentity(adapter) { return stableValue(adapter.identity); }

export async function createPublicationPlan({ packageRoot, adapter }) {
  const pkg = await verifyPublicationPackage(packageRoot);
  if (!adapter?.identity || typeof adapter.inspect !== "function" || typeof adapter.listKeys !== "function") throw new Error("A checksum-capable object-store adapter is required");
  if (adapter.identity.checksumMethod !== TRUSTED_METHOD) throw new Error(`Remote adapter cannot prove SHA-256 equality; required method: ${TRUSTED_METHOD}`);
  const remoteKeys = new Set(await adapter.listKeys());
  const allowedRetained = new Set([...pkg.expectedByKey.keys(), ...(pkg.media.obsoleteButRetainedKeys || []).map((entry) => entry.key), ...(pkg.media.rollbackKeys || []).map((entry) => entry.key)]);
  const unexpectedRemoteKeys = [...remoteKeys].filter((key) => !allowedRetained.has(key)).sort();
  const matchingExistingKeys = [], missingKeys = [], missingRequiredUnavailable = [], byteConflicts = [];
  for (const expected of pkg.expectedByKey.values()) {
    const actual = await adapter.inspect(expected.key);
    if (!actual.exists) (pkg.newByKey.has(expected.key) ? missingKeys : missingRequiredUnavailable).push(publicEntry(expected));
    else if (matchesExpected(actual, expected)) matchingExistingKeys.push({ ...publicEntry(expected), verificationMethod: actual.verificationMethod });
    else byteConflicts.push({ key: expected.key, expected: { bytes: expected.bytes, sha256: expected.sha256 }, actual });
  }
  const executable = byteConflicts.length === 0 && missingRequiredUnavailable.length === 0 && unexpectedRemoteKeys.length === 0;
  return {
    schemaVersion: SCHEMA_VERSION, mode: "zero-write-publication-plan", status: executable ? "ready" : "blocked", executable,
    packageId: pkg.receipt.packageId, publicationId: pkg.publicationId, binding: pkg.binding, adapter: adapterIdentity(adapter),
    counts: { requiredKeys: pkg.expectedByKey.size, approvedNewKeys: pkg.newByKey.size, matchingExistingKeys: matchingExistingKeys.length, missingApprovedNewKeys: missingKeys.length, missingRequiredUnavailable: missingRequiredUnavailable.length, byteConflicts: byteConflicts.length, unexpectedRemoteKeys: unexpectedRemoteKeys.length },
    requiredKeys: [...pkg.expectedByKey.values()].map(publicEntry),
    approvedNewKeys: [...pkg.newByKey.values()].map(publicEntry),
    matchingExistingKeys, missingKeys, missingRequiredUnavailable, byteConflicts, unexpectedRemoteKeys,
    expectedRequests: { list: 1, checksumReadsBeforeUpload: pkg.expectedByKey.size, uploads: missingKeys.length, checksumReadsAfterUpload: missingKeys.length, finalReconciliationList: 1, finalReconciliationChecksumReads: pkg.expectedByKey.size, deletes: 0 },
    expectedUploadBytes: missingKeys.reduce((sum, entry) => sum + entry.bytes, 0), deletes: []
  };
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  const handle = await fs.open(temporary, "wx");
  try { await handle.writeFile(jsonBytes(value)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, filePath);
  const directory = await fs.open(path.dirname(filePath), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function prepareJournal(journalPath) {
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  if (!(await exists(journalPath))) return [];
  const bytes = await fs.readFile(journalPath);
  let text = bytes.toString("utf8");
  if (text && !text.endsWith("\n")) {
    const lastNewline = text.lastIndexOf("\n");
    text = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
    await fs.writeFile(journalPath, text);
  }
  const events = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { throw new Error("Upload journal contains invalid completed JSON record"); }
  }
  return events;
}
async function appendJournal(journalPath, event) {
  const handle = await fs.open(journalPath, "a");
  try { await handle.writeFile(`${JSON.stringify(event)}\n`); await handle.sync(); } finally { await handle.close(); }
}
async function mapBounded(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor; cursor += 1; await worker(items[index]); }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}
async function reconcile(pkg, adapter) {
  const objects = [], missing = [], conflicts = [];
  for (const expected of pkg.expectedByKey.values()) {
    const actual = await adapter.inspect(expected.key);
    if (!actual.exists) missing.push(expected.key);
    else if (!matchesExpected(actual, expected)) conflicts.push({ key: expected.key, expected: publicEntry(expected), actual });
    else objects.push({ key: expected.key, expectedBytes: expected.bytes, expectedSha256: expected.sha256, verifiedBytes: actual.bytes, verifiedSha256: actual.sha256, verificationMethod: actual.verificationMethod, verifiedAt: actual.verifiedAt });
  }
  const allowed = new Set([...pkg.expectedByKey.keys(), ...(pkg.media.obsoleteButRetainedKeys || []).map((entry) => entry.key), ...(pkg.media.rollbackKeys || []).map((entry) => entry.key)]);
  const unexpected = (await adapter.listKeys()).filter((key) => !allowed.has(key)).sort();
  objects.sort((a, b) => a.key.localeCompare(b.key));
  return { objects, missing, conflicts, unexpected };
}

export async function executePublication({ packageRoot, adapter, journalRoot, concurrency = 4, maxAttempts = 3, faultInjector = null }) {
  if (!journalRoot) throw new Error("A durable journal root is required for execution");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("Concurrency must be an integer from 1 to 32");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new Error("Max attempts must be an integer from 1 to 20");
  const pkg = await verifyPublicationPackage(packageRoot);
  const resolvedJournalRoot = path.resolve(journalRoot);
  const physicalJournal = await physicalPathWithoutCreating(resolvedJournalRoot);
  const physicalPackage = await physicalPathWithoutCreating(pkg.packageRoot);
  if (isInsideOrEqual(physicalJournal, physicalPackage) || isInsideOrEqual(physicalPackage, physicalJournal)) throw new Error("Journal root overlaps the sealed package");
  const plan = await createPublicationPlan({ packageRoot, adapter });
  if (!plan.executable) throw new Error("Publication plan is blocked by missing, conflicting, or unexpected remote objects");
  if (typeof adapter.putIfAbsent !== "function") throw new Error("The object-store adapter does not provide no-overwrite publication");
  const runBinding = { ...pkg.binding, publicationId: pkg.publicationId, adapter: adapterIdentity(adapter) };
  const runId = sha256(stableJson(runBinding));
  const runPath = path.join(resolvedJournalRoot, "run.json"), journalPath = path.join(resolvedJournalRoot, "progress.ndjson"), receiptPath = path.join(resolvedJournalRoot, "receipt.json");
  if (await exists(runPath)) {
    const existing = await readJson(runPath, "Media publication run descriptor");
    if (existing.runId !== runId || stableJson(existing.binding) !== stableJson(runBinding)) throw new Error("Journal belongs to a different package or object store");
    if (existing.status === "complete") {
      const receipt = await readJson(receiptPath, "Media publication receipt");
      const { receiptSha256, ...unsealed } = receipt;
      if (receipt.status !== "PASS" || receipt.runId !== runId || receiptSha256 !== sha256(stableJson(unsealed)) || existing.receiptSha256 !== receiptSha256) {
        throw new Error("Completed media publication receipt is invalid");
      }
      const current = await reconcile(pkg, adapter);
      if (current.missing.length || current.conflicts.length || current.unexpected.length) throw new Error("Completed media publication receipt no longer matches the remote set");
      return { plan, receipt, receiptPath, journalPath };
    }
  } else await atomicWriteJson(runPath, { schemaVersion: SCHEMA_VERSION, runId, status: "uploading", binding: runBinding });
  const events = await prepareJournal(journalPath);
  const attempts = new Map();
  for (const event of events) if (event.type === "upload-attempt") attempts.set(event.key, Math.max(attempts.get(event.key) || 0, event.attempt));
  await mapBounded(plan.missingKeys, concurrency, async (expected) => {
    const sourcePath = path.join(pkg.packageRoot, "media", "new", ...expected.key.split("/"));
    const sourceRecord = await fileRecord(sourcePath);
    if (sourceRecord.bytes !== expected.bytes || sourceRecord.sha256 !== expected.sha256) throw new Error(`Packaged media changed before upload: ${expected.key}`);
    for (let attempt = (attempts.get(expected.key) || 0) + 1; attempt <= maxAttempts; attempt += 1) {
      await appendJournal(journalPath, { type: "upload-attempt", runId, packageId: pkg.receipt.packageId, key: expected.key, attempt, startedAt: new Date().toISOString() });
      try {
        faultInjector?.({ point: "before-upload", key: expected.key, attempt });
        const result = await adapter.putIfAbsent(expected.key, sourcePath);
        faultInjector?.({ point: "after-upload-before-verification", key: expected.key, attempt });
        const actual = await adapter.inspect(expected.key);
        if (!matchesExpected(actual, expected)) throw new Error(`Uploaded object failed independent SHA-256 verification: ${expected.key}`);
        await appendJournal(journalPath, { type: "object-verified", runId, packageId: pkg.receipt.packageId, key: expected.key, attempt, created: result.created, bytes: actual.bytes, sha256: actual.sha256, verificationMethod: actual.verificationMethod, verifiedAt: actual.verifiedAt });
        faultInjector?.({ point: "after-verification", key: expected.key, attempt });
        return;
      } catch (error) {
        await appendJournal(journalPath, { type: "upload-failed", runId, packageId: pkg.receipt.packageId, key: expected.key, attempt, failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
        if (attempt === maxAttempts) throw new Error(`Upload retry limit exhausted for ${expected.key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
  faultInjector?.({ point: "before-final-reconciliation" });
  const reconciliation = await reconcile(pkg, adapter);
  if (reconciliation.missing.length || reconciliation.conflicts.length || reconciliation.unexpected.length) throw new Error(`Final reconciliation failed: missing ${reconciliation.missing.length}; changed ${reconciliation.conflicts.length}; unexpected ${reconciliation.unexpected.length}`);
  const finalEvents = await prepareJournal(journalPath);
  const attemptCounts = new Map();
  for (const event of finalEvents) if (event.type === "upload-attempt") attemptCounts.set(event.key, Math.max(attemptCounts.get(event.key) || 0, event.attempt));
  for (const object of reconciliation.objects) object.retries = Math.max(0, (attemptCounts.get(object.key) || 1) - 1);
  const receipt = { schemaVersion: SCHEMA_VERSION, status: "PASS", packageId: pkg.receipt.packageId, publicationId: pkg.publicationId, runId, binding: runBinding, completedAt: new Date().toISOString(), verificationMethod: TRUSTED_METHOD, counts: { required: reconciliation.objects.length, missing: 0, changed: 0, unexpected: 0, deletes: 0 }, objects: reconciliation.objects, conflicts: [], missing: [], unexpected: [], deletes: [] };
  const receiptDigest = sha256(stableJson(receipt));
  const sealedReceipt = { ...receipt, receiptSha256: receiptDigest };
  await atomicWriteJson(receiptPath, sealedReceipt);
  await atomicWriteJson(runPath, { schemaVersion: SCHEMA_VERSION, runId, status: "complete", binding: runBinding, receiptSha256: receiptDigest });
  return { plan, receipt: sealedReceipt, receiptPath, journalPath };
}

function parseArgs(argv) {
  const args = { mode: null, packageRoot: null, objectRoot: null, journalRoot: null, concurrency: 4, maxAttempts: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--plan" || token === "--execute") { if (args.mode) throw new Error("Choose exactly one of --plan or --execute"); args.mode = token.slice(2); continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    index += 1;
    if (token === "--package-root") args.packageRoot = value;
    else if (token === "--object-root") args.objectRoot = value;
    else if (token === "--journal-root") args.journalRoot = value;
    else if (token === "--concurrency") args.concurrency = Number(value);
    else if (token === "--max-attempts") args.maxAttempts = Number(value);
    else throw new Error(`Unknown option ${token}`);
  }
  if (!args.mode || !args.packageRoot || !args.objectRoot) throw new Error("Provide exactly one mode plus --package-root and --object-root");
  if (args.mode === "execute" && !args.journalRoot) throw new Error("--execute requires --journal-root");
  return args;
}
async function assertCliIsolation(args) {
  const packageRoot = await physicalPathWithoutCreating(args.packageRoot), objectRoot = await physicalPathWithoutCreating(args.objectRoot);
  const forbidden = [path.join(APP_ROOT, "public", "data"), path.join(APP_ROOT, "generated", "library"), path.join(APP_ROOT, "generated", "reports")];
  for (const root of forbidden) {
    const physical = await physicalPathWithoutCreating(root);
    if (isInsideOrEqual(objectRoot, physical) || isInsideOrEqual(physical, objectRoot)) throw new Error(`Local object-store fixture overlaps canonical output: ${root}`);
  }
  if (isInsideOrEqual(objectRoot, packageRoot) || isInsideOrEqual(packageRoot, objectRoot)) throw new Error("Local object-store fixture overlaps the sealed package");
  if (args.journalRoot) {
    const journalRoot = await physicalPathWithoutCreating(args.journalRoot);
    for (const root of [...forbidden, packageRoot, objectRoot]) {
      const physical = await physicalPathWithoutCreating(root);
      if (isInsideOrEqual(journalRoot, physical) || isInsideOrEqual(physical, journalRoot)) throw new Error("Journal root overlaps package, object store, or canonical output");
    }
  }
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  await assertCliIsolation(args);
  const adapter = await createFilesystemObjectStore(args.objectRoot);
  const result = args.mode === "plan" ? await createPublicationPlan({ packageRoot: args.packageRoot, adapter }) : await executePublication({ packageRoot: args.packageRoot, adapter, journalRoot: args.journalRoot, concurrency: args.concurrency, maxAttempts: args.maxAttempts });
  process.stdout.write(`${JSON.stringify(args.mode === "plan" ? result : result.receipt, null, 2)}\n`);
  if (args.mode === "plan" && !result.executable) process.exitCode = 2;
}
if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`); process.exitCode = 1; });
