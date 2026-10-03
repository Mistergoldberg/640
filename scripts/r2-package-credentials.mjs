import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { verifyPublicationPackage } from "./package-media-publication.mjs";
import { verifyPackagePublicationAuthority } from "./package-publication-authority.mjs";
import { createR2LocalTemporaryCredentials } from "./r2-local-temporary-credentials.mjs";

const ACCOUNT_PATTERN = /^[a-f0-9]{32}$/;

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function requiredString(value, label) { if (typeof value !== "string" || !value) throw new Error(`${label} is missing`); return value; }
function normalizeEndpoint(value) {
  const url = new URL(requiredString(value, "R2 endpoint"));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("R2 endpoint must be a bare HTTPS account endpoint");
  return `${url.protocol}//${url.host}`;
}
async function atomicPrivateJson(filePath, value) {
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await fs.link(temporary, target); }
  catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Refusing to overwrite an existing R2 credential bundle: ${target}`);
    throw error;
  } finally { await fs.unlink(temporary).catch(() => {}); }
  const directory = await fs.open(path.dirname(target), "r");
  try { await directory.sync(); } finally { await directory.close(); }
  return target;
}

export async function mintPackageBoundR2Credentials({ packageRoot, configPath, parentCredentialsPath, outputPath, authorityPath = null, ttlSeconds = 900 }) {
  const pkg = await verifyPublicationPackage(path.resolve(packageRoot));
  const pin = JSON.parse(await fs.readFile(path.resolve(configPath), "utf8"));
  if (pin.schemaVersion !== 1 || pin.provider !== "cloudflare-r2" || !["isolated-write-test", "production-package-bound"].includes(pin.environment)) {
    throw new Error("Only a pinned package-bound R2 configuration can mint credentials");
  }
  if (pin.environment === "production-package-bound") {
    const allowedYears = new Set(pin.namespace?.allowedYears || []);
    for (const key of pkg.expectedByKey.keys()) {
      const year = key.split("/", 1)[0];
      if (!allowedYears.has(year)) throw new Error(`Package year is not approved by the production destination pin: ${year}`);
    }
  }
  const authority = pin.environment === "production-package-bound"
    ? await verifyPackagePublicationAuthority({ authorityPath, verifiedPackage: pkg })
    : null;
  const parent = JSON.parse(await fs.readFile(path.resolve(parentCredentialsPath), "utf8"));
  const accountId = requiredString(parent.R2_ACCOUNT_ID, "R2 account ID").toLowerCase();
  const endpoint = normalizeEndpoint(parent.R2_ENDPOINT);
  if (!ACCOUNT_PATTERN.test(accountId) || sha256(accountId) !== pin.accountIdSha256) throw new Error("Parent credential account does not match the isolated pin");
  if (sha256(endpoint) !== pin.endpointSha256 || endpoint !== `https://${accountId}.r2.cloudflarestorage.com`) throw new Error("Parent credential endpoint does not match the isolated pin");
  if ((pin.forbiddenBuckets || []).includes(pin.bucket)) throw new Error("Refusing to mint against a forbidden bucket");
  if (pin.environment === "isolated-write-test" && pin.bucket === parent.R2_BUCKET) throw new Error("Refusing to mint isolated credentials against the parent-default bucket");
  if (pin.environment === "production-package-bound" && parent.R2_BUCKET !== pin.bucket) throw new Error("Production parent credentials do not identify the pinned bucket");
  if ((pin.forbiddenPublicEndpoints || []).map(normalizeEndpoint).includes(endpoint)) throw new Error("Refusing a public media endpoint");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 1800) throw new Error("Package credential TTL must be 60-1800 seconds");
  const parentOptions = {
    endpoint, accountId, parentAccessKeyId: requiredString(parent.R2_ACCESS_KEY_ID, "R2 parent access key ID"),
    parentSecretAccessKey: requiredString(parent.R2_SECRET_ACCESS_KEY, "R2 parent secret access key"), bucket: pin.bucket, ttlSeconds
  };
  const newKeys = [...pkg.newByKey.keys()].sort();
  const retainedKeys = [...pkg.expectedByKey.keys()].filter((key) => !pkg.newByKey.has(key)).sort();
  if (newKeys.length === 0) throw new Error("The package has no approved new media keys");
  const publisher = await createR2LocalTemporaryCredentials({ ...parentOptions, actions: ["GetObject", "PutObject"], paths: { objectPaths: newKeys } });
  const inventory = await createR2LocalTemporaryCredentials({ ...parentOptions, actions: ["ListObjectsV2"] });
  const verifier = retainedKeys.length ? await createR2LocalTemporaryCredentials({ ...parentOptions, actions: ["GetObject"], paths: { objectPaths: retainedKeys } }) : null;
  const bundle = {
    schemaVersion: 2,
    environment: `${pin.environment}-action-scoped`,
    identity: { accountId, bucket: pin.bucket, endpoint },
    packageId: pkg.receipt.packageId,
    publicationId: pkg.publicationId,
    ...(authority ? { authority: { sha256: authority.sha256, semanticSha256: authority.semanticSha256, approvedBy: authority.authority.approvedBy, expiresAt: authority.authority.expiresAt } } : {}),
    roles: {
      publisher,
      inventory,
      ...(verifier ? { verifier } : {})
    }
  };
  const resolvedOutput = await atomicPrivateJson(outputPath, bundle);
  return {
    schemaVersion: 1,
    outputPath: resolvedOutput,
    packageId: bundle.packageId,
    publicationId: bundle.publicationId,
    identity: bundle.identity,
    ...(bundle.authority ? { authority: bundle.authority } : {}),
    roles: Object.fromEntries(Object.entries(bundle.roles).map(([role, value]) => [role, value.descriptor]))
  };
}

function parseArgs(argv) {
  const args = { packageRoot: null, configPath: null, parentCredentialsPath: null, outputPath: null, authorityPath: null, ttlSeconds: 900 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index], value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    index += 1;
    if (token === "--package-root") args.packageRoot = value;
    else if (token === "--config") args.configPath = value;
    else if (token === "--parent-credentials") args.parentCredentialsPath = value;
    else if (token === "--output") args.outputPath = value;
    else if (token === "--authority") args.authorityPath = value;
    else if (token === "--ttl-seconds") args.ttlSeconds = Number(value);
    else throw new Error(`Unknown option ${token}`);
  }
  if (!args.packageRoot || !args.configPath || !args.parentCredentialsPath || !args.outputPath) throw new Error("Provide --package-root, --config, --parent-credentials, and --output");
  return args;
}

async function main() { process.stdout.write(`${JSON.stringify(await mintPackageBoundR2Credentials(parseArgs(process.argv.slice(2))), null, 2)}\n`); }
if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
