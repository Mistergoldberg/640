import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { publicBuildSettings } from "./public-build-settings.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_ROOT = path.join(APP_ROOT, "dist");

function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, { cwd: APP_ROOT, encoding: "utf8", ...options }).trim();
}

let buildEnvironment;
function runNode(script, args) {
  const result = spawnSync(process.execPath, [path.join(APP_ROOT, script), ...args], {
    cwd: APP_ROOT,
    env: buildEnvironment,
    stdio: "inherit"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function inventory(root, excluded = new Set()) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (excluded.has(relative)) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(absolute);
        files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await walk(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, sha256: sha256(JSON.stringify(files)) };
}

const sourceCommit = command("git", ["rev-parse", "HEAD"]);
const dirtyPaths = command("git", ["status", "--porcelain=v1"]).split("\n").filter(Boolean).map((line) => line.slice(3));
const suppliedBuildCommit = process.env.VITE_BUILD_COMMIT?.trim();
if (suppliedBuildCommit && suppliedBuildCommit !== sourceCommit) {
  throw new Error(`VITE_BUILD_COMMIT ${suppliedBuildCommit} does not match source HEAD ${sourceCommit}`);
}
const buildCommit = suppliedBuildCommit || `${sourceCommit}${dirtyPaths.length ? "-dirty" : ""}`;
buildEnvironment = { ...process.env, VITE_BUILD_COMMIT: buildCommit };

runNode("node_modules/typescript/bin/tsc", ["--noEmit"]);
runNode("node_modules/vite/bin/vite.js", ["build"]);

const [lockfile, catalogue, artifacts] = await Promise.all([
  fs.readFile(path.join(APP_ROOT, "package-lock.json")),
  inventory(path.join(APP_ROOT, "public", "data")),
  inventory(DIST_ROOT, new Set(["build-identity.json"]))
]);
const identity = {
  schema: "pixilation-build-identity-v1",
  source: { commit: sourceCommit, dirty: dirtyPaths.length > 0, dirtyPaths },
  runtime: { node: process.version, npm: command("npm", ["--version"]) },
  dependencies: { lockfileSha256: sha256(lockfile) },
  settings: publicBuildSettings(buildEnvironment),
  catalogue: { fileCount: catalogue.files.length, treeSha256: catalogue.sha256 },
  artifacts: { fileCount: artifacts.files.length, treeSha256: artifacts.sha256, files: artifacts.files }
};
await fs.writeFile(path.join(DIST_ROOT, "build-identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
process.stdout.write(`Build identity ${buildCommit}; artifact tree ${artifacts.sha256}.\n`);
