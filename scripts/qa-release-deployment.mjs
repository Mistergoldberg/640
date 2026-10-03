import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { verifySealedCandidateRelease } from "./package-release-activation.mjs";

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 1;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }

async function localTreeInventory(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`QA release contains a symlink: ${absolute}`);
      if (stat.isDirectory()) await walk(absolute);
      else if (stat.isFile()) {
        const bytes = await fs.readFile(absolute);
        files.push({ path: path.relative(root, absolute).split(path.sep).join("/"), bytes: bytes.length, sha256: sha256(bytes) });
      } else throw new Error(`QA release contains a non-regular entry: ${absolute}`);
    }
  }
  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, sha256: sha256(stableJson(files)) };
}

async function atomicPrivateJson(filePath, value) {
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  await fs.writeFile(temporary, jsonBytes(value), { flag: "wx", mode: 0o600 });
  try { await fs.link(temporary, target); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`QA deployment receipt already exists: ${target}`); throw error; }
  finally { await fs.unlink(temporary).catch(() => {}); }
  return target;
}

export async function deployQaRelease({
  releaseRoot,
  packageRoot,
  publicationReceiptPath,
  authorityPath,
  adapter,
  deploymentReceiptPath,
  requiredMediaAdapterType = "cloudflare-r2-production-package-bound",
  faultInjector = null
}) {
  if (!adapter?.identity || adapter.identity.environment !== "qa" || adapter.identity.productionActivationEnabled !== false) throw new Error("A QA-only deployment adapter is required");
  const verified = await verifySealedCandidateRelease({ releaseRoot, packageRoot, publicationReceiptPath, requiredAdapterType: requiredMediaAdapterType, authorityPath, requireAuthority: true });
  const releaseId = verified.release.releaseId;
  const before = await adapter.inspectPointers();
  if (!before.qaRelease) throw new Error("QA has no rollback release");
  const productionBefore = before.productionRelease;
  let activated = false;
  try {
    await adapter.stage({ releaseId, payloadRoot: path.join(verified.releaseRoot, "payload"), payloadInventory: verified.payloadInventory });
    faultInjector?.("after-stage", { releaseId });
    const staged = await adapter.verifyStaged({ releaseId, expectedInventory: verified.payloadInventory });
    if (staged.sha256 !== verified.payloadInventory.sha256 || staged.fileCount !== verified.payloadInventory.files.length) throw new Error("Staged QA release inventory does not match the sealed artifact");
    await adapter.activate({ releaseId });
    activated = true;
    faultInjector?.("after-activate", { releaseId });
    const validation = await adapter.validate({ releaseId, verifiedRelease: verified });
    if (!validation?.passed) throw new Error(`QA validation failed: ${validation?.reason || "unknown failure"}`);
    const after = await adapter.inspectPointers();
    if (after.qaRelease !== releaseId) throw new Error("QA pointer does not identify the candidate release");
    if (after.productionRelease !== productionBefore) throw new Error("Production release pointer changed during QA deployment");
    const binding = {
      schemaVersion: SCHEMA_VERSION,
      releaseId,
      releaseClosedWorldSha256: verified.completion.closedWorldSha256,
      frontendCommit: verified.release.binding.frontendCommit,
      packageId: verified.activation.binding.packageId,
      packageClosedWorldSha256: verified.activation.binding.packageClosedWorldSha256,
      mediaReceiptSha256: verified.activation.binding.mediaReceiptSha256,
      authoritySha256: verified.activation.binding.authoritySha256,
      publicDataSha256: verified.activation.binding.publicDataSha256,
      payloadSha256: verified.payloadInventory.sha256,
      destination: stableValue(adapter.identity),
      previousQaRelease: before.qaRelease,
      rollbackRelease: before.qaRelease,
      productionReleaseBefore: productionBefore,
      productionReleaseAfter: after.productionRelease,
      validation: stableValue(validation)
    };
    const deploymentId = sha256(stableJson(binding));
    const receipt = { schemaVersion: SCHEMA_VERSION, status: "PASS", deploymentId, binding, completedAt: new Date().toISOString() };
    const sealed = { ...receipt, receiptSha256: sha256(stableJson(receipt)) };
    await atomicPrivateJson(deploymentReceiptPath, sealed);
    return { receipt: sealed, receiptPath: path.resolve(deploymentReceiptPath), verifiedRelease: verified };
  } catch (error) {
    if (activated) {
      await adapter.rollback({ releaseId: before.qaRelease });
      const rolledBack = await adapter.inspectPointers();
      if (rolledBack.qaRelease !== before.qaRelease || rolledBack.productionRelease !== productionBefore) {
        error.message += " (QA rollback verification failed)";
      }
    }
    await adapter.removeFailed?.({ releaseId }).catch(() => {});
    throw error;
  }
}

function safeReleaseId(value) {
  if (!/^[a-f0-9]{64}$/.test(value || "")) throw new Error("Release ID is invalid");
  return value;
}

function safeExistingReleaseName(value) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value || "")) throw new Error("Existing release name is invalid");
  return value;
}

export async function createFilesystemQaDeploymentAdapter({ root, validate = async () => ({ passed: true }) }) {
  const resolvedRoot = path.resolve(root);
  const releasesRoot = path.join(resolvedRoot, "releases");
  await fs.mkdir(releasesRoot, { recursive: true });
  const readPointer = async (name) => {
    try { return path.basename(await fs.readlink(path.join(resolvedRoot, name))); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  const switchPointer = async (name, releaseId) => {
    safeExistingReleaseName(releaseId);
    const temporary = path.join(resolvedRoot, `.${name}.${crypto.randomBytes(8).toString("hex")}`);
    await fs.symlink(path.join("releases", releaseId), temporary);
    await fs.rename(temporary, path.join(resolvedRoot, name));
  };
  return {
    identity: { type: "filesystem-qa-fixture", environment: "qa", root: resolvedRoot, productionActivationEnabled: false },
    async inspectPointers() { return { qaRelease: await readPointer("qa-current"), productionRelease: await readPointer("current") }; },
    async stage({ releaseId, payloadRoot }) {
      safeReleaseId(releaseId);
      const target = path.join(releasesRoot, releaseId);
      if (await exists(target)) throw new Error("QA candidate release already exists");
      await fs.cp(payloadRoot, target, { recursive: true, errorOnExist: true, force: false });
    },
    async verifyStaged({ releaseId }) {
      const ledger = await localTreeInventory(path.join(releasesRoot, safeReleaseId(releaseId)));
      return { sha256: ledger.sha256, fileCount: ledger.files.length, bytes: ledger.files.reduce((sum, item) => sum + item.bytes, 0) };
    },
    async activate({ releaseId }) { await switchPointer("qa-current", releaseId); },
    async validate(options) { return validate(options); },
    async rollback({ releaseId }) { await switchPointer("qa-current", releaseId); },
    async removeFailed({ releaseId }) {
      const source = path.join(releasesRoot, safeReleaseId(releaseId));
      if (await exists(source)) await fs.rename(source, path.join(releasesRoot, `.failed-${releaseId}`));
    }
  };
}

function validateSshConfig(config) {
  if (config.schemaVersion !== 1 || config.environment !== "qa" || config.productionActivationEnabled !== false) throw new Error("SSH deployment configuration is not QA-only");
  if (!/^[a-z0-9._-]+@[a-z0-9.-]+$/i.test(config.sshTarget || "")) throw new Error("SSH target is invalid");
  if (!/^\/var\/www\/[a-z0-9._/-]+$/i.test(config.appRoot || "") || config.appRoot.includes("..")) throw new Error("QA application root is invalid");
  for (const name of [config.releasesDirectory, config.qaCurrentLink, config.productionCurrentLink]) if (!/^[a-z0-9._-]+$/i.test(name || "")) throw new Error("QA release path component is invalid");
  const url = new URL(config.qaUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("QA URL must be a bare HTTPS origin");
  return config;
}

async function run(command, args, options = {}) {
  try { return await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024, ...options }); }
  catch (error) { throw new Error(`${command} failed: ${error.stderr || error.message}`); }
}

export async function createSshQaDeploymentAdapter({ configPath }) {
  const config = validateSshConfig(JSON.parse(await fs.readFile(path.resolve(configPath), "utf8")));
  const releasesRoot = `${config.appRoot}/${config.releasesDirectory}`;
  const remote = async (script) => (await run("ssh", ["-o", "BatchMode=yes", config.sshTarget, script])).stdout.trim();
  const readPointer = async (name) => {
    const value = await remote(`readlink '${config.appRoot}/${name}'`);
    return value ? path.posix.basename(value) : null;
  };
  return {
    identity: { type: "ssh-immutable-qa", environment: "qa", sshTarget: config.sshTarget, appRoot: config.appRoot, qaUrl: config.qaUrl, productionActivationEnabled: false },
    async inspectPointers() { return { qaRelease: await readPointer(config.qaCurrentLink), productionRelease: await readPointer(config.productionCurrentLink) }; },
    async stage({ releaseId, payloadRoot, payloadInventory }) {
      safeReleaseId(releaseId);
      const incoming = `${releasesRoot}/.${releaseId}.incoming`;
      const final = `${releasesRoot}/${releaseId}`;
      await remote(`set -eu; test ! -e '${incoming}'; test ! -e '${final}'; mkdir -p '${incoming}'`);
      try {
        await run("rsync", ["-rlpt", "--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r", "--", `${path.resolve(payloadRoot)}/`, `${config.sshTarget}:${incoming}/`]);
        const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-qa-manifest-"));
        try {
          const manifestPath = path.join(temporary, ".pixilation-manifest.sha256");
          const lines = payloadInventory.files.map((entry) => {
            if (entry.path.includes("\n") || entry.path.includes("\r") || entry.path.startsWith("/") || entry.path.includes("..")) throw new Error(`Unsafe release path: ${entry.path}`);
            return `${entry.sha256}  ${entry.path}`;
          });
          await fs.writeFile(manifestPath, `${lines.join("\n")}\n`, { flag: "wx" });
          await run("rsync", ["-rlpt", "--", manifestPath, `${config.sshTarget}:${incoming}/.pixilation-manifest.sha256`]);
        } finally { await fs.rm(temporary, { recursive: true, force: true }); }
        await remote(`set -eu; cd '${incoming}'; sha256sum -c .pixilation-manifest.sha256 >/dev/null; rm .pixilation-manifest.sha256; chmod -R a-w '${incoming}'; mv '${incoming}' '${final}'`);
      } catch (error) {
        await remote(`if test -e '${incoming}'; then mv '${incoming}' '${releasesRoot}/.failed-${releaseId}'; fi`).catch(() => {});
        throw error;
      }
    },
    async verifyStaged({ releaseId, expectedInventory }) {
      safeReleaseId(releaseId);
      const final = `${releasesRoot}/${releaseId}`;
      const output = await remote(`set -eu; test -d '${final}'; find '${final}' -type f -printf '%s\\n' | awk '{b+=$1;c+=1} END {print c " " b}'`);
      const [fileCount, bytes] = output.split(/\s+/).map(Number);
      const expectedBytes = expectedInventory.files.reduce((sum, entry) => sum + entry.bytes, 0);
      if (fileCount !== expectedInventory.files.length || bytes !== expectedBytes) throw new Error("Remote QA release count or bytes changed after checksum verification");
      return { sha256: expectedInventory.sha256, fileCount, bytes };
    },
    async activate({ releaseId }) {
      safeReleaseId(releaseId);
      await remote(`set -eu; cd '${config.appRoot}'; test -d '${config.releasesDirectory}/${releaseId}'; ln -s '${config.releasesDirectory}/${releaseId}' '.${config.qaCurrentLink}.${releaseId}'; mv -Tf '.${config.qaCurrentLink}.${releaseId}' '${config.qaCurrentLink}'`);
    },
    async validate({ releaseId, verifiedRelease }) {
      safeReleaseId(releaseId);
      const cacheBust = `stage2d=${releaseId}`;
      const [indexResponse, catalogResponse] = await Promise.all([
        fetch(`${config.qaUrl}?${cacheBust}`, { cache: "no-store", redirect: "error" }),
        fetch(`${config.qaUrl}data/catalog.json?${cacheBust}`, { cache: "no-store", redirect: "error" })
      ]);
      if (!indexResponse.ok || !catalogResponse.ok) return { passed: false, reason: `QA HTTP status ${indexResponse.status}/${catalogResponse.status}` };
      const indexBytes = Buffer.from(await indexResponse.arrayBuffer());
      const catalogBytes = Buffer.from(await catalogResponse.arrayBuffer());
      const expectedIndex = verifiedRelease.payloadInventory.files.find((entry) => entry.path === "index.html");
      const expectedCatalog = verifiedRelease.payloadInventory.files.find((entry) => entry.path === "data/catalog.json");
      const passed = Boolean(expectedIndex && expectedCatalog && sha256(indexBytes) === expectedIndex.sha256 && sha256(catalogBytes) === expectedCatalog.sha256);
      return { passed, reason: passed ? null : "QA public bytes do not match sealed release", indexSha256: sha256(indexBytes), catalogSha256: sha256(catalogBytes) };
    },
    async rollback({ releaseId }) {
      safeExistingReleaseName(releaseId);
      await remote(`set -eu; cd '${config.appRoot}'; test -d '${config.releasesDirectory}/${releaseId}'; ln -s '${config.releasesDirectory}/${releaseId}' '.${config.qaCurrentLink}.rollback'; mv -Tf '.${config.qaCurrentLink}.rollback' '${config.qaCurrentLink}'`);
    },
    async removeFailed({ releaseId }) {
      safeReleaseId(releaseId);
      await remote(`if test -d '${releasesRoot}/${releaseId}'; then mv '${releasesRoot}/${releaseId}' '${releasesRoot}/.failed-${releaseId}'; fi`);
    }
  };
}

function parseArgs(argv) {
  const args = { releaseRoot: null, packageRoot: null, publicationReceiptPath: null, authorityPath: null, configPath: null, deploymentReceiptPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index], value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    index += 1;
    const key = { "--release-root": "releaseRoot", "--package-root": "packageRoot", "--publication-receipt": "publicationReceiptPath", "--authority": "authorityPath", "--config": "configPath", "--deployment-receipt": "deploymentReceiptPath" }[token];
    if (!key) throw new Error(`Unknown option: ${token}`);
    args[key] = value;
  }
  if (Object.values(args).some((value) => !value)) throw new Error("Provide release, package, publication receipt, QA config, and deployment receipt");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const adapter = await createSshQaDeploymentAdapter({ configPath: args.configPath });
  const result = await deployQaRelease({ ...args, adapter });
  process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
