import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRootIndex = process.argv.indexOf("--app-root");
const APP_ROOT = appRootIndex === -1 ? DEFAULT_APP_ROOT : path.resolve(process.argv[appRootIndex + 1] || "");
if (appRootIndex !== -1 && !process.argv[appRootIndex + 1]) throw new Error("--app-root requires a path");

async function inventoryRoot(root) {
  const files = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolutePath);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(absolutePath);
        files.push({
          path: path.relative(root, absolutePath).split(path.sep).join("/"),
          bytes: bytes.length,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex")
        });
      }
    }
  }
  await walk(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    root,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    ledgerSha256: crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex")
  };
}

const roots = [path.join(APP_ROOT, "public", "data"), path.join(APP_ROOT, "generated", "library"), path.join(APP_ROOT, "generated", "reports")];
const inventories = [];
for (const root of roots) inventories.push(await inventoryRoot(root));
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      algorithm: "SHA-256 of JSON for path-sorted [{path,bytes,sha256(file bytes)}] using paths relative to each root",
      inventories
    },
    null,
    2
  )}\n`
);
