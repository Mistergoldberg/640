import crypto from "node:crypto";
import fs from "node:fs/promises";
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client
} from "@aws-sdk/client-s3";
import { isSupportedMediaKey } from "./content-versioned-media.mjs";

const CONFIG_SCHEMA_VERSION = 1;
const READ_ONLY_COMMANDS = new Set(["HeadBucketCommand", "ListObjectsV2Command", "HeadObjectCommand", "GetObjectCommand"]);
const ACCOUNT_PATTERN = /^[a-f0-9]{32}$/;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeEndpoint(value) {
  if (typeof value !== "string") throw new Error("R2 endpoint is missing");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("R2 endpoint must be an HTTPS account endpoint with no path, query, or credentials");
  }
  return `${url.protocol}//${url.host}`;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
}

function validateNamespace(namespace) {
  if (!namespace || namespace.id !== "pixilation-generated-media-v1" || namespace.keyFormat !== "pixilation-media-key-v1") {
    throw new Error("Unexpected R2 managed namespace identity or key format");
  }
  if (typeof namespace.remotePrefix !== "string" || namespace.remotePrefix.startsWith("/") || namespace.remotePrefix.includes("..")) {
    throw new Error("R2 managed namespace prefix is unsafe");
  }
  if (!Array.isArray(namespace.allowedYears) || !namespace.allowedYears.length || new Set(namespace.allowedYears).size !== namespace.allowedYears.length) {
    throw new Error("R2 managed namespace must enumerate unique years");
  }
  if (namespace.allowedYears.some((year) => !/^\d{4}$/.test(year))) throw new Error("R2 managed namespace contains an invalid year");
  if (JSON.stringify(namespace.derivativeDirectories) !== JSON.stringify(["thumbs", "display"])) {
    throw new Error("Unexpected R2 derivative-directory namespace");
  }
  return {
    id: namespace.id,
    remotePrefix: namespace.remotePrefix,
    allowedYears: [...namespace.allowedYears],
    derivativeDirectories: [...namespace.derivativeDirectories],
    keyFormat: namespace.keyFormat
  };
}

export async function loadR2ReadOnlyConfiguration({ configPath, credentialsPath }) {
  const pin = JSON.parse(await fs.readFile(configPath, "utf8"));
  const credentials = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
  if (pin.schemaVersion !== CONFIG_SCHEMA_VERSION || pin.provider !== "cloudflare-r2") throw new Error("Unsupported R2 publication configuration");
  const accountId = requiredString(credentials.R2_ACCOUNT_ID, "R2 account ID").toLowerCase();
  const bucket = requiredString(credentials.R2_BUCKET, "R2 bucket");
  const endpoint = normalizeEndpoint(credentials.R2_ENDPOINT);
  if (!ACCOUNT_PATTERN.test(accountId)) throw new Error("R2 account ID has an invalid format");
  if (sha256(accountId) !== pin.accountIdSha256) throw new Error("Configured R2 account does not match the pinned publication account");
  if (bucket !== pin.bucket) throw new Error("Configured R2 bucket does not match the pinned publication bucket");
  if (sha256(endpoint) !== pin.endpointSha256) throw new Error("Configured R2 endpoint does not match the pinned publication endpoint");
  if (endpoint !== `https://${accountId}.r2.cloudflarestorage.com`) throw new Error("R2 endpoint is not the canonical endpoint for the configured account");
  const namespace = validateNamespace(pin.namespace);
  const accessKeyId = requiredString(credentials.R2_ACCESS_KEY_ID, "R2 access key ID");
  const secretAccessKey = requiredString(credentials.R2_SECRET_ACCESS_KEY, "R2 secret access key");
  return {
    identity: { provider: "cloudflare-r2", accountId, bucket, endpoint, namespace },
    credentials: { accessKeyId, secretAccessKey }
  };
}

function createR2S3Client(configuration) {
  return new S3Client({
    region: "auto",
    endpoint: configuration.identity.endpoint,
    credentials: configuration.credentials,
    maxAttempts: 2
  });
}

function checksumHex(base64Value) {
  if (typeof base64Value !== "string" || !base64Value) return null;
  try {
    const bytes = Buffer.from(base64Value, "base64");
    return bytes.length === 32 ? bytes.toString("hex") : null;
  } catch {
    return null;
  }
}

async function hashBody(body, maximumBytes) {
  if (!body || typeof body[Symbol.asyncIterator] !== "function") throw new Error("R2 GET response body is not stream-readable");
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunkValue of body) {
      const chunk = Buffer.from(chunkValue);
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        body.destroy?.();
        throw new Error("R2 object exceeded the bounded readback allowance");
      }
      hash.update(chunk);
    }
  } catch (error) {
    if (error && typeof error === "object") error.readbackBytes = bytes;
    throw error;
  }
  return { bytes, sha256: hash.digest("hex") };
}

function isNotFound(error) {
  return error?.name === "NotFound" || error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404;
}

export function createR2ReadOnlyAdapter({ configuration, client = null, pageSize = 1000, maxPages = 1000, allowAnyGrammarYear = false }) {
  if (!configuration?.identity || !configuration?.credentials) throw new Error("A validated R2 configuration is required");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error("R2 page size must be from 1 to 1000");
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("R2 max pages must be positive");
  const s3 = client || createR2S3Client(configuration);
  const { identity } = configuration;
  const years = new Set(identity.namespace.allowedYears);
  const stats = { logicalRequests: 0, transportAttempts: 0, operations: { headBucket: 0, listObjects: 0, headObject: 0, getObject: 0 }, readbackBytes: 0 };

  function logicalKey(remoteKey) {
    if (typeof remoteKey !== "string" || !remoteKey.startsWith(identity.namespace.remotePrefix)) return null;
    const key = remoteKey.slice(identity.namespace.remotePrefix.length);
    if (!isSupportedMediaKey(key)) return null;
    const [year, derivative] = key.split("/");
    if ((!allowAnyGrammarYear && !years.has(year)) || !identity.namespace.derivativeDirectories.includes(derivative)) return null;
    return key;
  }

  function remoteKey(key) {
    if (logicalKey(`${identity.namespace.remotePrefix}${key}`) !== key) throw new Error(`Media key escapes the configured R2 namespace: ${key}`);
    return `${identity.namespace.remotePrefix}${key}`;
  }

  async function send(operation, command) {
    const commandName = command?.constructor?.name;
    if (!READ_ONLY_COMMANDS.has(commandName)) throw new Error(`R2 mutation command is unreachable: ${commandName || "unknown"}`);
    stats.logicalRequests += 1;
    stats.operations[operation] += 1;
    try {
      const response = await s3.send(command);
      stats.transportAttempts += response?.$metadata?.attempts || 1;
      return response;
    } catch (error) {
      stats.transportAttempts += error?.$metadata?.attempts || 1;
      throw error;
    }
  }

  return {
    identity,
    stats,
    acceptsKey(key) {
      try { return remoteKey(key).length > 0; } catch { return false; }
    },
    async verifyIdentity() {
      const response = await send("headBucket", new HeadBucketCommand({ Bucket: identity.bucket }));
      if (response?.$metadata?.httpStatusCode && response.$metadata.httpStatusCode !== 200) throw new Error("R2 bucket identity check did not return HTTP 200");
      return { ...identity, verifiedBy: "signed HeadBucket against pinned account endpoint", credentialsPrinted: false };
    },
    async listNamespace() {
      const objects = new Map();
      const outsideNamespace = [];
      const tokens = new Set();
      let continuationToken;
      let pages = 0;
      while (true) {
        if (pages >= maxPages) throw new Error(`R2 listing exceeded the configured ${maxPages}-page limit`);
        const response = await send("listObjects", new ListObjectsV2Command({
          Bucket: identity.bucket,
          Prefix: identity.namespace.remotePrefix,
          MaxKeys: pageSize,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {})
        }));
        pages += 1;
        if (response.Name && response.Name !== identity.bucket) throw new Error(`R2 listing returned unexpected bucket identity: ${response.Name}`);
        if (response.Prefix !== undefined && response.Prefix !== identity.namespace.remotePrefix) throw new Error("R2 listing returned an unexpected namespace prefix");
        if (typeof response.IsTruncated !== "boolean") throw new Error("R2 listing did not state whether the page was truncated");
        const contents = response.Contents || [];
        if (response.KeyCount !== undefined && response.KeyCount !== contents.length) throw new Error("R2 listing key count does not match the returned page");
        for (const item of contents) {
          if (typeof item.Key !== "string" || !Number.isInteger(item.Size) || item.Size < 0) throw new Error("R2 listing returned an invalid object record");
          const key = logicalKey(item.Key);
          const record = { remoteKey: item.Key, key, bytes: item.Size, etag: item.ETag || null, checksumAlgorithms: item.ChecksumAlgorithm || [], checksumType: item.ChecksumType || null, lastModified: item.LastModified?.toISOString?.() || item.LastModified || null };
          if (!key) outsideNamespace.push(record);
          else {
            if (objects.has(key)) throw new Error(`R2 listing returned duplicate key: ${key}`);
            objects.set(key, record);
          }
        }
        if (!response.IsTruncated) break;
        const next = response.NextContinuationToken;
        if (typeof next !== "string" || !next || tokens.has(next)) throw new Error("R2 listing was truncated without a fresh continuation token");
        tokens.add(next);
        continuationToken = next;
      }
      outsideNamespace.sort((left, right) => left.remoteKey.localeCompare(right.remoteKey));
      return { objects, outsideNamespace, pages, complete: true };
    },
    async inspect(key, { expectedSha256, maximumReadbackBytes = 0 } = {}) {
      const objectKey = remoteKey(key);
      let head;
      try {
        head = await send("headObject", new HeadObjectCommand({ Bucket: identity.bucket, Key: objectKey, ChecksumMode: "ENABLED" }));
      } catch (error) {
        if (isNotFound(error)) return { key, exists: false, verificationStatus: "missing", verificationMethod: "head-object" };
        throw error;
      }
      const bytes = head.ContentLength;
      if (!Number.isInteger(bytes) || bytes < 0) throw new Error(`R2 HEAD returned invalid size for ${key}`);
      const serviceSha256 = checksumHex(head.ChecksumSHA256);
      const evidence = { bytes, etag: head.ETag || null, checksumSha256: serviceSha256, checksumType: head.ChecksumType || null };
      if (serviceSha256 && head.ChecksumType === "FULL_OBJECT") {
        return { key, exists: true, bytes, sha256: serviceSha256, verificationStatus: expectedSha256 && serviceSha256 !== expectedSha256 ? "conflict" : "verified", verificationMethod: "r2-full-object-sha256-metadata", evidence, bytesRead: 0 };
      }
      if (!Number.isInteger(maximumReadbackBytes) || maximumReadbackBytes < bytes || maximumReadbackBytes < 1) {
        return { key, exists: true, bytes, verificationStatus: "unverified", verificationMethod: "size-etag-and-checksum-metadata-not-sha256-proof", evidence, bytesRead: 0, unverifiedReason: "bounded full-object readback was not permitted for this object" };
      }
      try {
        const response = await send("getObject", new GetObjectCommand({ Bucket: identity.bucket, Key: objectKey }));
        if (Number.isInteger(response.ContentLength) && response.ContentLength !== bytes) throw new Error("GET content length differs from HEAD");
        const readback = await hashBody(response.Body, maximumReadbackBytes);
        stats.readbackBytes += readback.bytes;
        if (readback.bytes !== bytes) throw new Error(`GET returned ${readback.bytes} bytes after HEAD reported ${bytes}`);
        return { key, exists: true, bytes, sha256: readback.sha256, verificationStatus: expectedSha256 && readback.sha256 !== expectedSha256 ? "conflict" : "verified", verificationMethod: "bounded-full-object-sha256-readback", evidence, bytesRead: readback.bytes };
      } catch (error) {
        const bytesRead = Number.isInteger(error?.readbackBytes) ? error.readbackBytes : 0;
        stats.readbackBytes += bytesRead;
        return { key, exists: true, bytes, verificationStatus: "unverified", verificationMethod: "readback-failed", evidence, bytesRead, unverifiedReason: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}

export function createAuthenticatedR2ReadOnlyAdapter({ configuration, pageSize = 1000, maxPages = 1000, allowAnyGrammarYear = false }) {
  return createR2ReadOnlyAdapter({ configuration, client: createR2S3Client(configuration), pageSize, maxPages, allowAnyGrammarYear });
}
