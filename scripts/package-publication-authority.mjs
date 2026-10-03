import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function verifyPackagePublicationAuthority({ authorityPath, verifiedPackage, now = Date.now() }) {
  if (!authorityPath) throw new Error("A reviewed package publication authority record is required");
  if (!verifiedPackage?.receipt?.packageId || !verifiedPackage?.completion?.closedWorldSha256) {
    throw new Error("A verified promotion package is required for publication authority validation");
  }
  const resolvedPath = path.resolve(authorityPath);
  let authority;
  let bytes;
  try {
    bytes = await fs.readFile(resolvedPath);
    authority = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Package publication authority is missing or invalid: ${resolvedPath}: ${error.message}`);
  }
  if (authority.schemaVersion !== SCHEMA_VERSION || authority.status !== "approved") throw new Error("Package publication authority is not approved");
  if (authority.environment !== "qa") throw new Error("Package publication authority is not limited to QA");
  if (authority.packageId !== verifiedPackage.receipt.packageId) throw new Error("Package publication authority belongs to a different package");
  if (authority.packageClosedWorldSha256 !== verifiedPackage.completion.closedWorldSha256) throw new Error("Package publication authority seal does not match the package");
  if (authority.sourcePolicySha256 !== verifiedPackage.receipt.binding.sourcePolicySha256) throw new Error("Package publication authority source policy does not match the package");
  if (authority.immutableMediaPublicationApproved !== true || authority.qaCandidateActivationApproved !== true) {
    throw new Error("Package publication authority does not approve both immutable media and QA activation");
  }
  if (authority.productionManifestActivationApproved !== false || authority.productionFrontendActivationApproved !== false) {
    throw new Error("Package publication authority must explicitly prohibit production activation");
  }
  if (typeof authority.approvedBy !== "string" || !authority.approvedBy.trim()) throw new Error("Package publication authority has no operator identity");
  const approvedAt = Date.parse(authority.approvedAt);
  const expiresAt = Date.parse(authority.expiresAt);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || approvedAt > now || expiresAt <= now || expiresAt <= approvedAt) {
    throw new Error("Package publication authority timestamps are invalid or expired");
  }
  const record = {
    path: resolvedPath,
    sha256: sha256(bytes),
    semanticSha256: sha256(stableJson(authority)),
    authority
  };
  return record;
}

export const packagePublicationAuthorityContract = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  environment: "qa",
  productionActivation: false,
  requiredApprovals: ["immutableMediaPublicationApproved", "qaCandidateActivationApproved"]
});
