import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isSupportedMediaKey } from "./content-versioned-media.mjs";
import { verifyPublicationReceipt } from "./package-media-publication.mjs";
import { verifyPackagePublicationAuthority } from "./package-publication-authority.mjs";

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 1;
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_ROOT, "..");
const PROHIBITED_PUBLIC_FIELDS = new Set(["sourceType", "sourceFilename", "sourceDuration", "sourceDurationSeconds", "sourceSecond", "videoCodec", "samplingIntervalSeconds"]);
const PROHIBITED_PAYLOAD_SEGMENTS = new Set(["generated", "original-photos", "video-jobs", "video-stages", "promotion-package", "reports", ".credentials"]);
const PROHIBITED_PAYLOAD_EXTENSIONS = new Set([".map", ".mov", ".mp4", ".m4v", ".avi", ".heic", ".tif", ".tiff"]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function toPosix(value) { return value.split(path.sep).join("/"); }
async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }
async function readJson(filePath, label) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) { throw new Error(`${label} is missing or invalid JSON: ${filePath}: ${error.message}`); }
}
function isInsideOrEqual(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
async function physicalPathWithoutCreating(targetPath) {
  const unresolved = [];
  let current = path.resolve(targetPath);
  while (true) {
    try { return path.resolve(await fs.realpath(current), ...unresolved); }
    catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      unresolved.unshift(path.basename(current));
      current = parent;
    }
  }
}
async function walkFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Release input contains a symlink: ${absolute}`);
      if (stat.isDirectory()) await walk(absolute);
      else if (stat.isFile()) files.push(absolute);
      else throw new Error(`Release input contains a non-regular entry: ${absolute}`);
    }
  }
  if (await exists(root)) await walk(root);
  return files;
}
async function treeInventory(root, excluded = new Set()) {
  const files = [];
  for (const filePath of await walkFiles(root)) {
    const relativePath = toPosix(path.relative(root, filePath));
    if (excluded.has(relativePath)) continue;
    const bytes = await fs.readFile(filePath);
    files.push({ path: relativePath, bytes: bytes.length, sha256: sha256(bytes) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, sha256: sha256(stableJson(files)) };
}
function assertExactSet(actual, expected, label) {
  const missing = [...expected].filter((value) => !actual.has(value)).sort();
  const unexpected = [...actual].filter((value) => !expected.has(value)).sort();
  if (missing.length || unexpected.length) throw new Error(`${label} differs: missing ${missing.join(", ") || "none"}; unexpected ${unexpected.join(", ") || "none"}`);
}
function assertNoVideoFields(value, currentPath = "publicData") {
  if (Array.isArray(value)) return value.forEach((child, index) => assertNoVideoFields(child, `${currentPath}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PROHIBITED_PUBLIC_FIELDS.has(key)) throw new Error(`Video-specific field is prohibited in activated public data: ${currentPath}.${key}`);
    assertNoVideoFields(child, `${currentPath}.${key}`);
  }
}
function publicPathFromUrl(value, label) {
  if (typeof value !== "string" || !value.startsWith("data/") || value.includes("..") || path.isAbsolute(value)) throw new Error(`${label} is unsafe: ${value}`);
  return value.slice(5);
}

async function validateCandidateData({ candidateDataRoot, receiptVerification }) {
  const { pkg, objects } = receiptVerification;
  const catalog = await readJson(path.join(candidateDataRoot, "catalog.json"), "Candidate catalog");
  assertNoVideoFields(catalog, "catalog");
  if (!Array.isArray(catalog.years) || !catalog.years.length) throw new Error("Candidate catalog has no years");
  const expectedPaths = new Set(["catalog.json"]);
  const years = new Set();
  const globalPhotoIds = new Set();
  let albumCount = 0;
  let photoCount = 0;
  for (const yearEntry of catalog.years) {
    const year = String(yearEntry.year);
    if (!/^\d{4}$/.test(year) || years.has(year)) throw new Error(`Candidate catalog has an invalid or duplicate year: ${year}`);
    years.add(year);
    const indexRelative = publicPathFromUrl(yearEntry.indexUrl, "Candidate year index URL");
    if (indexRelative !== `${year}/index.json`) throw new Error(`Candidate year index URL does not match year ${year}`);
    expectedPaths.add(indexRelative);
    const index = await readJson(path.join(candidateDataRoot, ...indexRelative.split("/")), `Candidate ${year} index`);
    assertNoVideoFields(index, `index.${year}`);
    if (String(index.year) !== year || !Array.isArray(index.albums) || !Array.isArray(index.sequence)) throw new Error(`Candidate ${year} index schema is invalid`);
    const yearPhotos = new Map();
    const albumIds = new Set();
    for (const album of index.albums) {
      if (typeof album.id !== "string" || !album.id || albumIds.has(album.id) || typeof album.name !== "string" || !album.name) throw new Error(`Candidate ${year} contains an invalid album`);
      albumIds.add(album.id);
      const manifestRelative = publicPathFromUrl(album.manifestUrl, "Candidate album manifest URL");
      if (manifestRelative !== `${year}/albums/${album.id}.json`) throw new Error(`Candidate manifest URL does not match album ${album.id}`);
      expectedPaths.add(manifestRelative);
      const manifest = await readJson(path.join(candidateDataRoot, ...manifestRelative.split("/")), `Candidate album ${album.id}`);
      assertNoVideoFields(manifest, `manifest.${album.id}`);
      if (!Array.isArray(manifest.photos) || manifest.photos.length !== album.count) throw new Error(`Candidate album count is invalid: ${album.id}`);
      for (const photo of manifest.photos) {
        if (typeof photo.id !== "string" || !photo.id || globalPhotoIds.has(photo.id) || yearPhotos.has(photo.id) || photo.albumId !== album.id) throw new Error(`Candidate photo identity is invalid: ${photo.id}`);
        if (!isSupportedMediaKey(photo.thumbnailKey) || !isSupportedMediaKey(photo.displayKey)) throw new Error(`Candidate photo media key is invalid: ${photo.id}`);
        for (const key of [photo.thumbnailKey, photo.displayKey]) if (!objects.has(key)) throw new Error(`Candidate manifest references media absent from the exact publication receipt: ${key}`);
        yearPhotos.set(photo.id, photo);
        globalPhotoIds.add(photo.id);
      }
      albumCount += 1;
      photoCount += manifest.photos.length;
    }
    if (index.scannedCount !== yearPhotos.size || index.sequence.length !== yearPhotos.size) throw new Error(`Candidate ${year} index count is inconsistent`);
    const sequenceIds = [];
    for (let position = 0; position < index.sequence.length; position += 1) {
      const id = index.sequence[position]?.id;
      const photo = yearPhotos.get(id);
      if (!photo || sequenceIds.includes(id) || photo.sortPosition !== position) throw new Error(`Candidate ${year} sequence is inconsistent at position ${position}`);
      sequenceIds.push(id);
    }
    assertExactSet(new Set(sequenceIds), new Set(yearPhotos.keys()), `Candidate ${year} sequence and manifests`);
  }
  const actualInventory = await treeInventory(candidateDataRoot);
  assertExactSet(new Set(actualInventory.files.map((entry) => entry.path)), expectedPaths, "Candidate public-data graph and files");
  if (actualInventory.sha256 !== pkg.publicInventory.sha256 || actualInventory.sha256 !== pkg.receipt.binding.publicDataSha256) throw new Error("Candidate public-data inventory does not match its package binding");
  return { catalog, years: [...years], albumCount, photoCount, inventory: actualInventory };
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  await fs.writeFile(temporary, jsonBytes(value), { flag: "wx" });
  await fs.rename(temporary, filePath);
}

async function copyTree(sourceRoot, targetRoot, { excludeData = false } = {}) {
  for (const sourcePath of await walkFiles(sourceRoot)) {
    const relative = toPosix(path.relative(sourceRoot, sourcePath));
    if (excludeData && (relative === "data" || relative.startsWith("data/"))) continue;
    const segments = relative.split("/");
    if (segments.some((segment) => PROHIBITED_PAYLOAD_SEGMENTS.has(segment)) || PROHIBITED_PAYLOAD_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
      throw new Error(`Frontend payload contains a prohibited release file: ${relative}`);
    }
    const targetPath = path.join(targetRoot, ...segments);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  }
}

export async function verifySealedCandidateRelease({ releaseRoot, packageRoot, publicationReceiptPath, requiredAdapterType = null, authorityPath = null, requireAuthority = false }) {
  const resolvedRoot = path.resolve(releaseRoot);
  const activation = await readJson(path.join(resolvedRoot, "activation.json"), "Candidate activation receipt");
  const release = await readJson(path.join(resolvedRoot, "release.json"), "Candidate release receipt");
  const completion = await readJson(path.join(resolvedRoot, "complete.json"), "Candidate release completion seal");
  const receiptVerification = await verifyPublicationReceipt({ packageRoot, receiptPath: publicationReceiptPath, requiredAdapterType });
  const authority = requireAuthority ? await verifyPackagePublicationAuthority({ authorityPath, verifiedPackage: receiptVerification.pkg }) : null;
  if (activation.status !== "PASS" || release.status !== "sealed-candidate-release" || completion.status !== "complete") throw new Error("Candidate release is not complete");
  if (activation.activationId !== sha256(stableJson(activation.binding))) throw new Error("Candidate activation identity is invalid");
  if (release.releaseId !== sha256(stableJson(release.binding)) || release.binding.activationId !== activation.activationId) throw new Error("Candidate release identity is invalid");
  if (completion.releaseId !== release.releaseId) throw new Error("Candidate release completion identity is invalid");
  const packageBinding = receiptVerification.pkg;
  if (
    activation.binding.packageId !== packageBinding.receipt.packageId ||
    activation.binding.packageClosedWorldSha256 !== packageBinding.completion.closedWorldSha256 ||
    activation.binding.mediaReceiptSha256 !== receiptVerification.receipt.receiptSha256 ||
    activation.binding.mediaReceiptFileSha256 !== receiptVerification.receiptFileSha256
  ) throw new Error("Candidate activation is not bound to the exact package and media receipt");
  if (authority && (activation.binding.authoritySha256 !== authority.sha256 || activation.binding.authoritySemanticSha256 !== authority.semanticSha256)) {
    throw new Error("Candidate activation is not bound to the reviewed package authority");
  }
  const payloadInventory = await treeInventory(path.join(resolvedRoot, "payload"));
  if (payloadInventory.sha256 !== release.binding.payloadSha256 || payloadInventory.files.length !== release.binding.payloadFileCount) throw new Error("Candidate release payload inventory changed");
  const candidate = await validateCandidateData({ candidateDataRoot: path.join(resolvedRoot, "payload", "data"), receiptVerification });
  if (candidate.inventory.sha256 !== activation.binding.publicDataSha256) throw new Error("Activated candidate data differs from the activation binding");
  const preSeal = await treeInventory(resolvedRoot, new Set(["complete.json"]));
  if (preSeal.sha256 !== completion.closedWorldSha256 || preSeal.files.length !== completion.fileCountBeforeSeal) throw new Error("Candidate release closed-world seal is invalid");
  assertExactSet(new Set((await walkFiles(resolvedRoot)).map((item) => toPosix(path.relative(resolvedRoot, item)))), new Set([...preSeal.files.map((item) => item.path), "complete.json"]), "Candidate release closed-world files");
  return { releaseRoot: resolvedRoot, activation, release, completion, payloadInventory, candidate, receiptVerification, authority };
}

export async function buildSealedCandidateRelease({
  packageRoot,
  publicationReceiptPath,
  frontendDistRoot,
  releaseRoot,
  frontendCommit,
  deploymentTarget = "qa",
  previousQaRelease = null,
  rollbackRelease = null,
  authorityPath = null,
  requireAuthority = false,
  requiredAdapterType = null,
  faultInjector = null
}) {
  if (deploymentTarget !== "qa") throw new Error("Candidate release construction is limited to QA");
  if (!/^[a-f0-9]{7,64}$/.test(frontendCommit || "")) throw new Error("Frontend commit SHA is invalid");
  const resolvedPackage = path.resolve(packageRoot), resolvedFrontend = path.resolve(frontendDistRoot), resolvedRelease = path.resolve(releaseRoot);
  const [physicalPackage, physicalFrontend, physicalRelease] = await Promise.all([resolvedPackage, resolvedFrontend, resolvedRelease].map(physicalPathWithoutCreating));
  for (const [left, right] of [[physicalRelease, physicalPackage], [physicalRelease, physicalFrontend]]) if (isInsideOrEqual(left, right) || isInsideOrEqual(right, left)) throw new Error("Release output must not overlap package or frontend input");
  if (await exists(resolvedRelease)) throw new Error(`Candidate release root already exists: ${resolvedRelease}`);
  const receiptVerification = await verifyPublicationReceipt({ packageRoot: resolvedPackage, receiptPath: publicationReceiptPath, requiredAdapterType });
  const authority = requireAuthority ? await verifyPackagePublicationAuthority({ authorityPath, verifiedPackage: receiptVerification.pkg }) : null;
  const candidate = await validateCandidateData({ candidateDataRoot: path.join(resolvedPackage, "candidate", "public", "data"), receiptVerification });
  const temporaryRoot = `${resolvedRelease}.building-${crypto.randomBytes(8).toString("hex")}`;
  try {
    const payloadRoot = path.join(temporaryRoot, "payload");
    await fs.mkdir(payloadRoot, { recursive: true });
    await copyTree(resolvedFrontend, payloadRoot, { excludeData: true });
    await copyTree(path.join(resolvedPackage, "candidate", "public", "data"), path.join(payloadRoot, "data"));
    faultInjector?.("after-payload-copy", { temporaryRoot, payloadRoot });
    const frontendInventoryAll = await treeInventory(resolvedFrontend);
    const frontendFiles = frontendInventoryAll.files.filter((entry) => entry.path !== "data" && !entry.path.startsWith("data/"));
    const frontendInventory = { files: frontendFiles, sha256: sha256(stableJson(frontendFiles)) };
    const payloadInventory = await treeInventory(payloadRoot);
    const activationBinding = {
      schemaVersion: SCHEMA_VERSION,
      packageId: receiptVerification.pkg.receipt.packageId,
      packageClosedWorldSha256: receiptVerification.pkg.completion.closedWorldSha256,
      publicationId: receiptVerification.pkg.publicationId,
      mediaPublicationRunId: receiptVerification.receipt.runId,
      mediaReceiptSha256: receiptVerification.receipt.receiptSha256,
      mediaReceiptFileSha256: receiptVerification.receiptFileSha256,
      mediaDestination: stableValue(receiptVerification.adapter),
      publicDataSha256: candidate.inventory.sha256,
      publicDataFileCount: candidate.inventory.files.length,
      ...(authority ? { authoritySha256: authority.sha256, authoritySemanticSha256: authority.semanticSha256 } : {})
    };
    const activationId = sha256(stableJson(activationBinding));
    await atomicWriteJson(path.join(temporaryRoot, "activation.json"), { schemaVersion: SCHEMA_VERSION, status: "PASS", activationId, binding: activationBinding });
    const releaseBinding = {
      schemaVersion: SCHEMA_VERSION,
      frontendCommit,
      frontendDistSha256: frontendInventory.sha256,
      activationId,
      packageId: receiptVerification.pkg.receipt.packageId,
      packageClosedWorldSha256: receiptVerification.pkg.completion.closedWorldSha256,
      publicDataSha256: candidate.inventory.sha256,
      payloadSha256: payloadInventory.sha256,
      payloadFileCount: payloadInventory.files.length,
      deploymentTarget,
      previousQaRelease,
      rollbackRelease
    };
    const releaseId = sha256(stableJson(releaseBinding));
    await atomicWriteJson(path.join(temporaryRoot, "release.json"), { schemaVersion: SCHEMA_VERSION, status: "sealed-candidate-release", releaseId, binding: releaseBinding });
    faultInjector?.("before-final-seal", { temporaryRoot, releaseId });
    const preSeal = await treeInventory(temporaryRoot);
    await atomicWriteJson(path.join(temporaryRoot, "complete.json"), { schemaVersion: SCHEMA_VERSION, status: "complete", releaseId, fileCountBeforeSeal: preSeal.files.length, closedWorldSha256: preSeal.sha256 });
    await fs.rename(temporaryRoot, resolvedRelease);
    return verifySealedCandidateRelease({ releaseRoot: resolvedRelease, packageRoot: resolvedPackage, publicationReceiptPath, requiredAdapterType, authorityPath, requireAuthority });
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const args = { packageRoot: null, publicationReceiptPath: null, frontendDistRoot: null, releaseRoot: null, frontendCommit: null, authorityPath: null, previousQaRelease: null, rollbackRelease: null, requireAuthority: false, requiredAdapterType: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--require-authority") { args.requireAuthority = true; continue; }
    const key = { "--package-root": "packageRoot", "--publication-receipt": "publicationReceiptPath", "--frontend-dist": "frontendDistRoot", "--release-root": "releaseRoot", "--frontend-commit": "frontendCommit", "--authority": "authorityPath", "--previous-qa-release": "previousQaRelease", "--rollback-release": "rollbackRelease", "--required-adapter-type": "requiredAdapterType" }[token];
    if (!key) throw new Error(`Unknown option: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    args[key] = value; index += 1;
  }
  if (!args.packageRoot || !args.publicationReceiptPath || !args.frontendDistRoot || !args.releaseRoot) throw new Error("Provide package, publication receipt, frontend dist, and release root");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.frontendCommit) args.frontendCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: APP_ROOT })).stdout.trim();
  const result = await buildSealedCandidateRelease(args);
  process.stdout.write(`${JSON.stringify({ releaseRoot: result.releaseRoot, activation: result.activation, release: result.release, completion: result.completion, candidate: { years: result.candidate.years, albumCount: result.candidate.albumCount, photoCount: result.candidate.photoCount } }, null, 2)}\n`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
