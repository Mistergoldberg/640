import crypto from "node:crypto";
import { SignJWT } from "jose";

const ACCOUNT_PATTERN = /^[a-f0-9]{32}$/;
const VALID_SCOPES = new Set(["object-read-only", "object-read-write", "admin-read-only", "admin-read-write"]);
const VALID_ACTIONS = new Set([
  "HeadObject",
  "GetObject",
  "GetBucketLocation",
  "ListObjectsV1",
  "ListObjectsV2",
  "ListMultipartUploads",
  "ListParts",
  "PutObject",
  "DeleteObject",
  "DeleteObjects",
  "CopyObject",
  "CreateMultipartUpload",
  "UploadPart",
  "UploadPartCopy",
  "AbortMultipartUpload",
  "CompleteMultipartUpload"
]);

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
}

function normalizeEndpoint(value, accountId) {
  const endpoint = new URL(requiredString(value, "R2 endpoint"));
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.pathname !== "/" && endpoint.pathname !== "")) {
    throw new Error("R2 endpoint must be an HTTPS account endpoint without credentials, path, query, or fragment");
  }
  const normalized = `${endpoint.protocol}//${endpoint.host}`;
  if (normalized !== `https://${accountId}.r2.cloudflarestorage.com`) throw new Error("R2 endpoint is not the canonical account endpoint");
  return normalized;
}

function sortedUniqueStrings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error(`${label} must be a nonempty-string array`);
  const result = [...new Set(value)].sort();
  if (result.length !== value.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function validatePaths(paths) {
  if (paths === undefined) return undefined;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) throw new Error("R2 credential paths must be an object");
  const prefixPaths = sortedUniqueStrings(paths.prefixPaths || [], "R2 prefix paths");
  const objectPaths = sortedUniqueStrings(paths.objectPaths || [], "R2 object paths");
  if (prefixPaths.length === 0 && objectPaths.length === 0) throw new Error("R2 credential paths cannot be empty");
  for (const value of [...prefixPaths, ...objectPaths]) {
    if (value.startsWith("/") || value.includes("..") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) throw new Error(`Unsafe R2 credential path: ${value}`);
  }
  return { prefixPaths, objectPaths };
}

export async function createR2LocalTemporaryCredentials({
  endpoint,
  accountId,
  parentAccessKeyId,
  parentSecretAccessKey,
  bucket,
  scope,
  actions,
  ttlSeconds = 900,
  paths,
  now = Math.floor(Date.now() / 1000)
}) {
  const normalizedAccount = requiredString(accountId, "R2 account ID").toLowerCase();
  if (!ACCOUNT_PATTERN.test(normalizedAccount)) throw new Error("R2 account ID is invalid");
  const normalizedEndpoint = normalizeEndpoint(endpoint, normalizedAccount);
  const normalizedBucket = requiredString(bucket, "R2 bucket");
  const accessKeyId = requiredString(parentAccessKeyId, "R2 parent access key ID");
  const signingKey = requiredString(parentSecretAccessKey, "R2 parent secret access key");
  if (scope !== undefined && !VALID_SCOPES.has(scope)) throw new Error(`Unsupported R2 credential scope: ${scope}`);
  const normalizedActions = sortedUniqueStrings(actions, "R2 actions");
  if (normalizedActions.length === 0 || normalizedActions.some((action) => !VALID_ACTIONS.has(action))) throw new Error("R2 actions contain an unsupported or empty action");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) throw new Error("R2 temporary credential TTL must be 60-3600 seconds");
  if (!Number.isInteger(now) || now <= 0) throw new Error("R2 credential issue time is invalid");
  const normalizedPaths = validatePaths(paths);
  const claims = { bucket: normalizedBucket, ...(scope ? { scope } : {}), actions: normalizedActions, ...(normalizedPaths ? { paths: normalizedPaths } : {}) };
  const jwt = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(normalizedAccount)
    .setIssuer(accessKeyId)
    .setAudience(new URL(normalizedEndpoint).host)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(new TextEncoder().encode(signingKey));
  const secretAccessKey = crypto.createHash("sha256").update(jwt).digest("hex");
  return {
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken: Buffer.from(`jwt/${jwt}`).toString("base64")
    },
    descriptor: {
      type: "cloudflare-r2-locally-signed-temporary",
      accountId: normalizedAccount,
      bucket: normalizedBucket,
      endpoint: normalizedEndpoint,
      scope: scope || null,
      actions: normalizedActions,
      paths: normalizedPaths || null,
      issuedAt: new Date(now * 1000).toISOString(),
      expiresAt: new Date((now + ttlSeconds) * 1000).toISOString(),
      ttlSeconds,
      accessKeyFingerprint: crypto.createHash("sha256").update(accessKeyId).digest("hex").slice(0, 16),
      sessionFingerprint: crypto.createHash("sha256").update(jwt).digest("hex").slice(0, 16)
    }
  };
}

export const r2LocalTemporaryCredentialContract = Object.freeze({
  algorithm: "HS256",
  secretDerivation: "sha256-hex(signed-jwt)",
  sessionEncoding: "base64(jwt/<signed-jwt>)",
  maximumTtlSeconds: 3600,
  validActions: [...VALID_ACTIONS].sort()
});
