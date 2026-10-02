import crypto from "node:crypto";
import fs from "node:fs/promises";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { isSupportedMediaKey } from "./content-versioned-media.mjs";

const CONFIG_SCHEMA_VERSION = 1;
const ACCOUNT_PATTERN = /^[a-f0-9]{32}$/;
const ALLOWED_COMMANDS = new Set(["ListObjectsV2Command", "GetObjectCommand", "PutObjectCommand"]);
const ROLE_ACTIONS = Object.freeze({ publisher: ["GetObject", "PutObject"], verifier: ["GetObject"], inventory: ["ListObjectsV2"] });
const TRUSTED_METHOD = "full-object-sha256-readback";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
}

function normalizeEndpoint(value) {
  const url = new URL(requiredString(value, "R2 endpoint"));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("R2 endpoint must be an HTTPS account endpoint with no path, query, or credentials");
  }
  return `${url.protocol}//${url.host}`;
}

function decodeBase64Url(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function sortedUniqueStrings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error(`${label} must be a string array`);
  const result = [...new Set(value)].sort();
  if (result.length !== value.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function exactStrings(actual, expected, label) {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw new Error(`${label} does not match the isolated-test pin`);
}

function validateTemporaryCredential(role, roleValue, identity, expectedActions, expectedPaths) {
  const credentials = roleValue?.credentials;
  const descriptor = roleValue?.descriptor;
  if (!credentials || !descriptor) throw new Error(`R2 ${role} credential role is missing`);
  const accessKeyId = requiredString(credentials.accessKeyId, `R2 ${role} access key ID`);
  const secretAccessKey = requiredString(credentials.secretAccessKey, `R2 ${role} secret access key`);
  const sessionToken = requiredString(credentials.sessionToken, `R2 ${role} session token`);
  let encodedJwt;
  try {
    const decoded = Buffer.from(sessionToken, "base64").toString("utf8");
    if (!decoded.startsWith("jwt/")) throw new Error("prefix");
    encodedJwt = decoded.slice(4);
  } catch {
    throw new Error("R2 session token is not a Cloudflare temporary credential");
  }
  const segments = encodedJwt.split(".");
  if (segments.length !== 3) throw new Error("R2 temporary credential JWT is malformed");
  let header, claims;
  try { header = decodeBase64Url(segments[0]); claims = decodeBase64Url(segments[1]); }
  catch { throw new Error("R2 temporary credential claims are malformed"); }
  if (header.alg !== "HS256" || header.typ !== "JWT") throw new Error("R2 temporary credential uses an unexpected signature type");
  if (claims.sub !== identity.accountId || claims.iss !== accessKeyId || claims.aud !== new URL(identity.endpoint).host) throw new Error("R2 temporary credential identity claims do not match the destination");
  if (claims.bucket !== identity.bucket) throw new Error(`R2 ${role} credential is not bound to the isolated bucket`);
  if (claims.scope !== undefined) throw new Error(`R2 ${role} credential must use action-only authorization`);
  exactStrings(sortedUniqueStrings(claims.actions, `R2 ${role} actions`), expectedActions, `R2 ${role} actions`);
  const actualPrefixes = sortedUniqueStrings(claims.paths?.prefixPaths || [], `R2 ${role} prefix paths`);
  const actualObjects = sortedUniqueStrings(claims.paths?.objectPaths || [], `R2 ${role} object paths`);
  exactStrings(actualPrefixes, expectedPaths?.prefixPaths || [], `R2 ${role} prefix paths`);
  exactStrings(actualObjects, expectedPaths?.objectPaths || [], `R2 ${role} object paths`);
  if (!Number.isInteger(claims.exp) || claims.exp * 1000 <= Date.now()) throw new Error("R2 temporary credential has expired");
  if (!Number.isInteger(claims.iat) || claims.iat > claims.exp) throw new Error("R2 temporary credential timestamps are invalid");
  if (secretAccessKey !== sha256(encodedJwt)) throw new Error("R2 temporary secret does not match its session credential");
  if (descriptor.bucket !== claims.bucket || descriptor.accountId !== claims.sub || descriptor.endpoint !== identity.endpoint || descriptor.scope !== null) throw new Error(`R2 ${role} descriptor does not match its claims`);
  exactStrings(descriptor.actions || [], expectedActions, `R2 ${role} descriptor actions`);
  exactStrings(descriptor.paths?.prefixPaths || [], expectedPaths?.prefixPaths || [], `R2 ${role} descriptor prefix paths`);
  exactStrings(descriptor.paths?.objectPaths || [], expectedPaths?.objectPaths || [], `R2 ${role} descriptor object paths`);
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    scope: {
      type: "cloudflare-r2-locally-signed-temporary",
      role,
      bucket: claims.bucket,
      permission: null,
      credentialActions: [...expectedActions],
      paths: { prefixPaths: actualPrefixes, objectPaths: actualObjects },
      actionClaimStatus: "proven-action-only-2026-10-02",
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      accessKeyFingerprint: sha256(accessKeyId).slice(0, 16)
    }
  };
}

export async function loadIsolatedR2WriteConfiguration({ configPath, credentialsPath, verifiedPackage }) {
  const pin = JSON.parse(await fs.readFile(configPath, "utf8"));
  const bundle = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
  if (!verifiedPackage?.receipt?.packageId || !verifiedPackage?.publicationId || !verifiedPackage?.expectedByKey || !verifiedPackage?.newByKey) throw new Error("A verified package is required to validate R2 credential paths");
  if (pin.schemaVersion !== CONFIG_SCHEMA_VERSION || pin.provider !== "cloudflare-r2" || pin.environment !== "isolated-write-test") {
    throw new Error("Only a pinned isolated-write-test R2 configuration is accepted");
  }
  if (bundle.schemaVersion !== 2 || bundle.environment !== "isolated-write-test-action-scoped") throw new Error("R2 credential bundle is not action-scoped isolated-test format");
  if (bundle.packageId !== verifiedPackage.receipt.packageId || bundle.publicationId !== verifiedPackage.publicationId) throw new Error("R2 credential bundle belongs to a different promotion package");
  const accountId = requiredString(bundle.identity?.accountId, "R2 account ID").toLowerCase();
  const bucket = requiredString(bundle.identity?.bucket, "R2 bucket");
  const endpoint = normalizeEndpoint(bundle.identity?.endpoint);
  if (!ACCOUNT_PATTERN.test(accountId) || sha256(accountId) !== pin.accountIdSha256) throw new Error("R2 account does not match the isolated-test pin");
  if (bucket !== pin.bucket || (pin.forbiddenBuckets || []).includes(bucket)) throw new Error("R2 bucket is not the pinned isolated test bucket");
  if (sha256(endpoint) !== pin.endpointSha256 || endpoint !== `https://${accountId}.r2.cloudflarestorage.com`) throw new Error("R2 endpoint does not match the pinned account endpoint");
  const forbiddenEndpoints = (pin.forbiddenPublicEndpoints || []).map(normalizeEndpoint);
  if (forbiddenEndpoints.includes(endpoint)) throw new Error("A public media endpoint cannot be used for R2 writes");
  if (!pin.namespace || pin.namespace.id !== "pixilation-isolated-publication-test-v1" || pin.namespace.remotePrefix !== "" || pin.namespace.keyFormat !== "pixilation-media-key-v1") {
    throw new Error("Unexpected isolated R2 namespace pin");
  }
  const identity = {
    type: "cloudflare-r2-isolated-test",
    provider: pin.provider,
    accountId,
    bucket,
    endpoint,
    namespace: pin.namespace,
    checksumMethod: TRUSTED_METHOD,
    productionExecutionEnabled: false
  };
  const pinnedRoles = pin.credentialRoles || {};
  if (pinnedRoles.actionClaimStatus !== "proven-action-only-2026-10-02") throw new Error("Pinned R2 action-claim status is incompatible");
  const expectedRoleNames = ["inventory", "publisher", ...(bundle.roles?.verifier ? ["verifier"] : [])].sort();
  exactStrings(Object.keys(bundle.roles || {}).sort(), expectedRoleNames, "R2 credential bundle roles");
  for (const [role, actions] of Object.entries(ROLE_ACTIONS)) {
    if (role === "verifier" && !bundle.roles?.verifier) continue;
    exactStrings(pinnedRoles[role]?.actions || [], actions, `Pinned R2 ${role} actions`);
  }
  const newKeys = [...verifiedPackage.newByKey.keys()].sort();
  const retainedKeys = [...verifiedPackage.expectedByKey.keys()].filter((key) => !verifiedPackage.newByKey.has(key)).sort();
  const publisher = validateTemporaryCredential("publisher", bundle.roles?.publisher, identity, ROLE_ACTIONS.publisher, { prefixPaths: [], objectPaths: newKeys });
  const inventory = validateTemporaryCredential("inventory", bundle.roles?.inventory, identity, ROLE_ACTIONS.inventory, { prefixPaths: [], objectPaths: [] });
  const verifier = retainedKeys.length ? validateTemporaryCredential("verifier", bundle.roles?.verifier, identity, ROLE_ACTIONS.verifier, { prefixPaths: [], objectPaths: retainedKeys }) : null;
  if (!retainedKeys.length && bundle.roles?.verifier) throw new Error("R2 verifier role is unexpected for a package without retained media");
  return {
    identity: { ...identity, credentialRoles: { publisher: publisher.scope, inventory: inventory.scope, ...(verifier ? { verifier: verifier.scope } : {}) } },
    credentials: {
      publisher: { accessKeyId: publisher.accessKeyId, secretAccessKey: publisher.secretAccessKey, sessionToken: publisher.sessionToken },
      inventory: { accessKeyId: inventory.accessKeyId, secretAccessKey: inventory.secretAccessKey, sessionToken: inventory.sessionToken },
      ...(verifier ? { verifier: { accessKeyId: verifier.accessKeyId, secretAccessKey: verifier.secretAccessKey, sessionToken: verifier.sessionToken } } : {})
    }
  };
}

async function hashBody(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== "function") throw new Error("R2 GET response body is not stream-readable");
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const value of body) {
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function isMissing(error) {
  return error?.name === "NoSuchKey" || error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404;
}

function isPreconditionFailed(error) {
  return error?.name === "PreconditionFailed" || error?.$metadata?.httpStatusCode === 412;
}

function packageKeySets(pkg) {
  if (!pkg?.expectedByKey || !pkg?.newByKey || !pkg?.receipt?.packageId || !pkg?.publicationId) throw new Error("An independently verified publication package is required");
  const required = new Set(pkg.expectedByKey.keys());
  const approvedNew = new Set(pkg.newByKey.keys());
  const years = new Set();
  for (const key of required) {
    if (!isSupportedMediaKey(key)) throw new Error(`Package contains a key outside the Pixilation media grammar: ${key}`);
    years.add(key.split("/", 1)[0]);
  }
  for (const key of approvedNew) if (!required.has(key)) throw new Error(`Package new-media set is not part of its required set: ${key}`);
  return { required, approvedNew, years };
}

function createClient(configuration, role) {
  return new S3Client({
    region: "auto",
    endpoint: configuration.identity.endpoint,
    credentials: configuration.credentials[role],
    maxAttempts: 1
  });
}

export function createIsolatedR2WriteAdapter({ configuration, verifiedPackage, clients = null, pageSize = 1000, maxPages = 1000, hooks = {} }) {
  if (configuration?.identity?.type !== "cloudflare-r2-isolated-test" || configuration.identity.productionExecutionEnabled !== false) throw new Error("The R2 write adapter requires an isolated-test destination");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 || !Number.isInteger(maxPages) || maxPages < 1) throw new Error("Invalid R2 pagination bounds");
  const sets = packageKeySets(verifiedPackage);
  const roleClients = clients || {
    publisher: createClient(configuration, "publisher"),
    inventory: createClient(configuration, "inventory"),
    ...(configuration.credentials.verifier ? { verifier: createClient(configuration, "verifier") } : {})
  };
  const { identity } = configuration;
  const stats = { logicalRequests: 0, operations: { list: 0, get: 0, putIfAbsent: 0 }, bytesRead: 0, bytesSubmitted: 0, preconditionFailures: 0 };

  function remoteKey(key) {
    if (!isSupportedMediaKey(key)) throw new Error(`Media key violates the pinned Pixilation grammar: ${key}`);
    if (!sets.required.has(key)) throw new Error(`Media key is not in the verified package: ${key}`);
    return `${identity.namespace.remotePrefix}${key}`;
  }

  async function send(role, operation, command) {
    const name = command?.constructor?.name;
    if (!ALLOWED_COMMANDS.has(name)) throw new Error(`R2 operation is unreachable through the isolated adapter: ${name || "unknown"}`);
    stats.logicalRequests += 1;
    stats.operations[operation] += 1;
    hooks.onOperation?.({ role, operation, command: name, input: { Bucket: command.input?.Bucket, Key: command.input?.Key, IfNoneMatch: command.input?.IfNoneMatch } });
    const client = roleClients[role];
    if (!client) throw new Error(`R2 credential role is unavailable: ${role}`);
    return client.send(command);
  }

  return {
    identity: {
      ...identity,
      packageId: verifiedPackage.receipt.packageId,
      publicationId: verifiedPackage.publicationId,
      packageYears: [...sets.years].sort(),
      requiredKeyCount: sets.required.size,
      approvedNewKeyCount: sets.approvedNew.size
    },
    stats,
    acceptsKey(key) { try { return remoteKey(key).length > 0; } catch { return false; } },
    async listKeys() {
      const keys = new Set();
      const tokens = new Set();
      let token;
      for (let page = 0; page < maxPages; page += 1) {
        const response = await send("inventory", "list", new ListObjectsV2Command({ Bucket: identity.bucket, Prefix: identity.namespace.remotePrefix, MaxKeys: pageSize, ...(token ? { ContinuationToken: token } : {}) }));
        if (response.Name && response.Name !== identity.bucket) throw new Error("R2 listing returned an unexpected bucket");
        if (response.Prefix !== undefined && response.Prefix !== identity.namespace.remotePrefix) throw new Error("R2 listing returned an unexpected prefix");
        if (typeof response.IsTruncated !== "boolean") throw new Error("R2 listing omitted pagination state");
        for (const item of response.Contents || []) {
          if (typeof item.Key !== "string" || !item.Key.startsWith(identity.namespace.remotePrefix)) throw new Error("R2 listing returned an invalid key");
          const key = item.Key.slice(identity.namespace.remotePrefix.length);
          if (keys.has(key)) throw new Error(`R2 listing returned a duplicate key: ${key}`);
          keys.add(key);
        }
        if (!response.IsTruncated) return [...keys].sort();
        const next = response.NextContinuationToken;
        if (typeof next !== "string" || !next || tokens.has(next)) throw new Error("R2 listing truncated without a fresh continuation token");
        tokens.add(next);
        token = next;
      }
      throw new Error(`R2 listing exceeded ${maxPages} pages`);
    },
    async inspect(key) {
      const objectKey = remoteKey(key);
      const role = sets.approvedNew.has(key) ? "publisher" : "verifier";
      let response;
      try { response = await send(role, "get", new GetObjectCommand({ Bucket: identity.bucket, Key: objectKey, ChecksumMode: "ENABLED" })); }
      catch (error) {
        if (isMissing(error)) return { exists: false, verificationMethod: TRUSTED_METHOD, credentialRole: role, verifiedAt: new Date().toISOString() };
        throw error;
      }
      const record = await hashBody(response.Body);
      stats.bytesRead += record.bytes;
      if (Number.isInteger(response.ContentLength) && response.ContentLength !== record.bytes) throw new Error(`R2 GET returned a truncated object: ${key}`);
      return {
        exists: true,
        ...record,
        verificationMethod: TRUSTED_METHOD,
        verifiedAt: new Date().toISOString(),
        contentType: response.ContentType || null,
        cacheControl: response.CacheControl || null,
        serviceChecksumSha256: response.ChecksumSHA256 || null,
        serviceChecksumType: response.ChecksumType || null,
        etag: response.ETag || null,
        credentialRole: role
      };
    },
    async putIfAbsent(key, sourcePath) {
      const objectKey = remoteKey(key);
      if (!sets.approvedNew.has(key)) throw new Error(`R2 upload key is not in the package's exact media/new set: ${key}`);
      const expected = verifiedPackage.newByKey.get(key);
      const bytes = await fs.readFile(sourcePath);
      const checksum = sha256(bytes);
      if (bytes.length !== expected.bytes || checksum !== expected.sha256) throw new Error(`Packaged bytes changed before R2 upload: ${key}`);
      stats.bytesSubmitted += bytes.length;
      try {
        const response = await send("publisher", "putIfAbsent", new PutObjectCommand({
          Bucket: identity.bucket,
          Key: objectKey,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: "image/jpeg",
          CacheControl: "public, max-age=31536000, immutable",
          ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"),
          IfNoneMatch: "*"
        }));
        return {
          created: true,
          httpStatusCode: response?.$metadata?.httpStatusCode || null,
          requestId: response?.$metadata?.requestId || null,
          etag: response?.ETag || null,
          checksumSha256: response?.ChecksumSHA256 || null,
          checksumType: response?.ChecksumType || null,
          credentialRole: "publisher"
        };
      } catch (error) {
        if (!isPreconditionFailed(error)) throw error;
        stats.preconditionFailures += 1;
        return { created: false, httpStatusCode: 412, requestId: error?.$metadata?.requestId || null, precondition: "If-None-Match: *", credentialRole: "publisher" };
      }
    }
  };
}

export function createAuthenticatedIsolatedR2WriteAdapter(options) {
  return createIsolatedR2WriteAdapter(options);
}

export const isolatedR2WriteContract = Object.freeze({
  checksumMethod: TRUSTED_METHOD,
  allowedCommands: [...ALLOWED_COMMANDS].sort(),
  credentialPermission: null,
  credentialActionClaimStatus: "proven-action-only-2026-10-02",
  credentialRoles: ROLE_ACTIONS,
  putCondition: "If-None-Match: *",
  deletes: false,
  copies: false,
  overwrites: false,
  productionExecutionEnabled: false
});
