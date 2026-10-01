import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isSupportedMediaKey } from "./content-versioned-media.mjs";
import { verifyPublicationPackage } from "./package-media-publication.mjs";
import { createAuthenticatedR2ReadOnlyAdapter, loadR2ReadOnlyConfiguration } from "./r2-readonly-adapter.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_ROOT, "..");
const runtimeSecrets = [];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

async function walkCanonicalMedia(root) {
  const records = new Map();
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) throw new Error(`Canonical media contains a symlink: ${absolutePath}`);
      if (stat.isDirectory()) await walk(absolutePath);
      else if (stat.isFile()) {
        const key = toPosix(path.relative(root, absolutePath));
        if (!isSupportedMediaKey(key)) throw new Error(`Canonical media contains an invalid key: ${key}`);
        records.set(key, { key, bytes: stat.size, path: absolutePath });
      } else throw new Error(`Canonical media contains a non-regular entry: ${absolutePath}`);
    }
  }
  await walk(root);
  return records;
}

function selectRepresentativeSample(records, count) {
  if (count === 0) return [];
  const groups = new Map();
  for (const record of records.values()) {
    const group = record.key.split("/").slice(0, 2).join("/");
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(record);
  }
  for (const values of groups.values()) values.sort((left, right) => left.key.localeCompare(right.key));
  const groupNames = [...groups.keys()].sort();
  const selected = [];
  let round = 0;
  while (selected.length < count) {
    let added = false;
    for (const name of groupNames) {
      const values = groups.get(name);
      if (round >= values.length || selected.length >= count) continue;
      const index = Math.floor(((round + 0.5) / Math.ceil(count / groupNames.length)) * values.length);
      const record = values[Math.min(values.length - 1, index)];
      if (!selected.some((item) => item.key === record.key)) {
        selected.push(record);
        added = true;
      }
    }
    if (!added) break;
    round += 1;
  }
  return selected;
}

async function expectedRecord(record) {
  const bytes = await fs.readFile(record.path);
  return { key: record.key, bytes: bytes.length, sha256: sha256(bytes) };
}

function sortedKeys(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function keySetSummary(keys) {
  const sorted = sortedKeys(keys);
  return { count: sorted.length, sha256: sha256(JSON.stringify(sorted)) };
}

function keySizeSetSha256(records) {
  const values = [...records.values()].map(({ key, bytes }) => ({ key, bytes })).sort((left, right) => left.key.localeCompare(right.key));
  return sha256(JSON.stringify(values));
}

function summarizeInspection(result, expected) {
  return {
    key: expected.key,
    expectedBytes: expected.bytes,
    expectedSha256: expected.sha256,
    remoteBytes: result.bytes ?? null,
    remoteSha256: result.sha256 ?? null,
    verificationStatus: result.verificationStatus,
    verificationMethod: result.verificationMethod,
    bytesRead: result.bytesRead || 0,
    evidence: result.evidence || null,
    ...(result.unverifiedReason ? { unverifiedReason: result.unverifiedReason } : {})
  };
}

async function inspectExpected(adapter, expectedRecords, maximumReadbackBytes) {
  const results = [];
  let remaining = maximumReadbackBytes;
  for (const expected of expectedRecords) {
    const result = await adapter.inspect(expected.key, { expectedSha256: expected.sha256, maximumReadbackBytes: remaining });
    remaining = Math.max(0, remaining - (result.bytesRead || 0));
    results.push(summarizeInspection(result, expected));
  }
  return { results, readbackBudgetBytes: maximumReadbackBytes, readbackBytes: maximumReadbackBytes - remaining };
}

function requestReport(adapter, listing) {
  const classARequests = adapter.stats.operations.listObjects;
  const classBRequests = adapter.stats.operations.headBucket + adapter.stats.operations.headObject + adapter.stats.operations.getObject;
  return {
    logicalRequests: adapter.stats.logicalRequests,
    transportAttempts: adapter.stats.transportAttempts,
    headBucket: adapter.stats.operations.headBucket,
    listObjects: adapter.stats.operations.listObjects,
    headObject: adapter.stats.operations.headObject,
    getObject: adapter.stats.operations.getObject,
    classARequests,
    classBRequests,
    listingPages: listing.pages,
    readbackBytes: adapter.stats.readbackBytes,
    writes: 0,
    copies: 0,
    deletes: 0,
    metadataMutations: 0
  };
}

export async function runR2Baseline({ adapter, canonicalMediaRoot, sampleCount = 6, maximumReadbackBytes = 10 * 1024 * 1024 }) {
  if (!Number.isInteger(sampleCount) || sampleCount < 0 || sampleCount > 100) throw new Error("R2 baseline sample count must be from 0 to 100");
  const identity = await adapter.verifyIdentity();
  const listing = await adapter.listNamespace();
  const local = await walkCanonicalMedia(path.resolve(canonicalMediaRoot));
  const remoteKeys = new Set(listing.objects.keys());
  const localKeys = new Set(local.keys());
  const otherKnownArchiveKeys = sortedKeys([...remoteKeys].filter((key) => localKeys.has(key)));
  const unexpectedKeys = sortedKeys([...remoteKeys].filter((key) => !localKeys.has(key)));
  const missingCanonicalKeys = sortedKeys([...localKeys].filter((key) => !remoteKeys.has(key)));
  const sizeConflicts = sortedKeys([...remoteKeys].filter((key) => local.has(key) && listing.objects.get(key).bytes !== local.get(key).bytes)).map((key) => ({ key, localBytes: local.get(key).bytes, remoteBytes: listing.objects.get(key).bytes }));
  const sample = [];
  for (const record of selectRepresentativeSample(local, sampleCount)) sample.push(await expectedRecord(record));
  const sampled = await inspectExpected(adapter, sample, maximumReadbackBytes);
  const conflicts = sampled.results.filter((item) => item.verificationStatus === "conflict");
  const unverified = sampled.results.filter((item) => item.verificationStatus === "unverified");
  const verified = sampled.results.filter((item) => item.verificationStatus === "verified");
  const clean = unexpectedKeys.length === 0 && missingCanonicalKeys.length === 0 && sizeConflicts.length === 0 && listing.outsideNamespace.length === 0 && conflicts.length === 0 && unverified.length === 0 && verified.length === sample.length;
  return {
    schemaVersion: 1,
    mode: "read-only-r2-baseline",
    status: clean ? "READ_ONLY_BASELINE_LISTING_COMPLETE_SAMPLE_VERIFIED" : "READ_ONLY_BASELINE_FINDINGS",
    publicationReceiptIssued: false,
    identity,
    namespace: {
      completePaginatedListing: listing.complete,
      pages: listing.pages,
      managedObjects: listing.objects.size,
      managedBytes: [...listing.objects.values()].reduce((sum, item) => sum + item.bytes, 0),
      managedKeySizeSetSha256: keySizeSetSha256(listing.objects),
      candidateRequiredKeys: { count: 0, keys: [] },
      rollbackRetainedKeys: { count: 0, keys: [] },
      otherKnownArchiveKeys: keySetSummary(otherKnownArchiveKeys),
      unexpectedKeys,
      outsideNamespaceObjects: listing.outsideNamespace.map((item) => item.remoteKey)
    },
    canonical: { root: path.resolve(canonicalMediaRoot), objects: local.size, bytes: [...local.values()].reduce((sum, item) => sum + item.bytes, 0), keySizeSetSha256: keySizeSetSha256(local), missingKeys: missingCanonicalKeys, sizeConflicts },
    sample: { requested: sampleCount, selected: sample.length, verified: verified.length, conflicts, unverified, objects: sampled.results, estimatedReadbackBytes: sample.reduce((sum, item) => sum + item.bytes, 0), maximumReadbackBytes },
    requests: requestReport(adapter, listing),
    readOnly: true,
    deletes: []
  };
}

export async function runR2PackagePreflight({ adapter, packageRoot, maximumReadbackBytes = 32 * 1024 * 1024 }) {
  const pkg = await verifyPublicationPackage(packageRoot);
  for (const key of [...pkg.expectedByKey.keys(), ...pkg.newByKey.keys()]) {
    if (!adapter.acceptsKey(key)) throw new Error(`Promotion package key escapes the configured R2 namespace: ${key}`);
  }
  const identity = await adapter.verifyIdentity();
  const listing = await adapter.listNamespace();
  const required = new Set(pkg.expectedByKey.keys());
  const approvedNew = new Set(pkg.newByKey.keys());
  const rollback = new Set((pkg.media.rollbackKeys || []).map((item) => item.key));
  const otherKnown = new Set((pkg.media.obsoleteButRetainedKeys || []).map((item) => item.key));
  const remote = new Set(listing.objects.keys());
  const candidateRequiredKeys = sortedKeys([...remote].filter((key) => required.has(key)));
  const rollbackRetainedKeys = sortedKeys([...remote].filter((key) => !required.has(key) && rollback.has(key)));
  const otherKnownArchiveKeys = sortedKeys([...remote].filter((key) => !required.has(key) && !rollback.has(key) && otherKnown.has(key)));
  const known = new Set([...required, ...rollback, ...otherKnown]);
  const unexpectedKeys = sortedKeys([...remote].filter((key) => !known.has(key)));
  const missingNewKeys = sortedKeys([...approvedNew].filter((key) => !remote.has(key)));
  const missingRetainedKeys = sortedKeys([...required].filter((key) => !approvedNew.has(key) && !remote.has(key)));
  const expectedExisting = candidateRequiredKeys.map((key) => pkg.expectedByKey.get(key));
  const inspected = await inspectExpected(adapter, expectedExisting, maximumReadbackBytes);
  const matchingKeys = inspected.results.filter((item) => item.verificationStatus === "verified");
  const conflicts = inspected.results.filter((item) => item.verificationStatus === "conflict");
  const unverifiedKeys = inspected.results.filter((item) => item.verificationStatus === "unverified");
  const blocked = missingRetainedKeys.length > 0 || conflicts.length > 0 || unverifiedKeys.length > 0 || unexpectedKeys.length > 0 || listing.outsideNamespace.length > 0;
  return {
    schemaVersion: 1,
    mode: "zero-write-r2-package-preflight",
    status: blocked ? "READ_ONLY_PREFLIGHT_BLOCKED" : "READ_ONLY_PREFLIGHT_COMPLETE",
    publicationReceiptIssued: false,
    mediaUploaded: false,
    packageId: pkg.receipt.packageId,
    publicationId: pkg.publicationId,
    packageBinding: pkg.binding,
    identity,
    namespace: {
      completePaginatedListing: listing.complete,
      pages: listing.pages,
      managedObjects: listing.objects.size,
      candidateRequiredKeys,
      rollbackRetainedKeys,
      otherKnownArchiveKeys,
      unexpectedKeys,
      outsideNamespaceObjects: listing.outsideNamespace.map((item) => item.remoteKey)
    },
    requiredKeys: [...pkg.expectedByKey.values()].map(({ key, bytes, sha256: checksum }) => ({ key, bytes, sha256: checksum })),
    approvedNewKeys: [...pkg.newByKey.values()].map(({ key, bytes, sha256: checksum }) => ({ key, bytes, sha256: checksum })),
    matchingKeys,
    missingNewKeys,
    missingRetainedKeys,
    conflicts,
    unverifiedKeys,
    verification: { maximumReadbackBytes, estimatedReadbackBytes: expectedExisting.reduce((sum, item) => sum + item.bytes, 0), actualReadbackBytes: inspected.readbackBytes },
    requests: requestReport(adapter, listing),
    readOnly: true,
    deletes: []
  };
}

function parseArgs(argv) {
  const args = { configPath: null, credentialsPath: null, baseline: false, packageRoot: null, canonicalMediaRoot: null, sampleCount: 6, maximumReadbackBytes: 10 * 1024 * 1024, pageSize: 1000 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--baseline") { args.baseline = true; continue; }
    if (["--execute", "--upload", "--put", "--copy", "--delete", "--mutate-metadata", "--force"].includes(token)) throw new Error(`Mutation option is forbidden in read-only R2 preflight: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    index += 1;
    if (token === "--config") args.configPath = value;
    else if (token === "--credentials") args.credentialsPath = value;
    else if (token === "--package-root") args.packageRoot = value;
    else if (token === "--canonical-media-root") args.canonicalMediaRoot = value;
    else if (token === "--sample-count") args.sampleCount = Number(value);
    else if (token === "--max-readback-bytes") args.maximumReadbackBytes = Number(value);
    else if (token === "--page-size") args.pageSize = Number(value);
    else throw new Error(`Unknown option ${token}`);
  }
  if (!args.configPath || !args.credentialsPath) throw new Error("Provide --config and --credentials");
  if (args.baseline === Boolean(args.packageRoot)) throw new Error("Choose exactly one of --baseline or --package-root");
  if (args.baseline && !args.canonicalMediaRoot) throw new Error("--baseline requires --canonical-media-root");
  if (!Number.isInteger(args.maximumReadbackBytes) || args.maximumReadbackBytes < 0 || args.maximumReadbackBytes > 1024 * 1024 * 1024) throw new Error("--max-readback-bytes must be an integer from 0 to 1 GiB");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configuration = await loadR2ReadOnlyConfiguration({ configPath: path.resolve(APP_ROOT, args.configPath), credentialsPath: path.resolve(APP_ROOT, args.credentialsPath) });
  runtimeSecrets.push(configuration.credentials.accessKeyId, configuration.credentials.secretAccessKey);
  const adapter = createAuthenticatedR2ReadOnlyAdapter({ configuration, pageSize: args.pageSize });
  const report = args.baseline
    ? await runR2Baseline({ adapter, canonicalMediaRoot: path.resolve(APP_ROOT, args.canonicalMediaRoot), sampleCount: args.sampleCount, maximumReadbackBytes: args.maximumReadbackBytes })
    : await runR2PackagePreflight({ adapter, packageRoot: path.resolve(APP_ROOT, args.packageRoot), maximumReadbackBytes: args.maximumReadbackBytes });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status.endsWith("FINDINGS") || report.status.endsWith("BLOCKED")) process.exitCode = 2;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of runtimeSecrets) if (secret) message = message.split(secret).join("[REDACTED]");
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
