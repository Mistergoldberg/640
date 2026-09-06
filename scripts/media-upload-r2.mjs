import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_ROOT, "..");
const ARCHIVE_ROOT = path.resolve(APP_ROOT, "..");
const MEDIA_ROOT = path.join(ARCHIVE_ROOT, "generated", "library");
const REPORT_PATH = path.join(ARCHIVE_ROOT, "generated", "reports", "public-release-audit.json");
const ALLOWED_KEY_PATTERN = /^(?:19|20)\d{2}\/(?:thumbs|display)\/(?:19|20)\d{2}-[a-f0-9]{14}\.(?:jpg|jpeg|png|webp|gif|tif|tiff|heic|heif)$/i;
const REQUIRED_ENV = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT", "VITE_MEDIA_BASE_URL"];

function parseArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    execute: argv.includes("--execute")
  };
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isInsideOrEqual(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listMediaObjects(root) {
  const objects = [];

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const key = toPosix(path.relative(root, absolutePath));
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        if (!ALLOWED_KEY_PATTERN.test(key)) {
          throw new Error(`Refusing unexpected media file path: ${key}`);
        }
        const stat = await fs.stat(absolutePath);
        objects.push({ key, bytes: stat.size });
      } else {
        throw new Error(`Refusing non-regular media entry: ${key}`);
      }
    }
  }

  await walk(root);
  return objects;
}

async function loadAuditReport() {
  const report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));
  if (!report.passed) {
    throw new Error("release:audit did not pass");
  }
  return report;
}

async function runAudit() {
  const result = spawnSync(process.execPath, [path.join(SCRIPT_ROOT, "release-audit.mjs")], {
    cwd: APP_ROOT,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error("release:audit failed; upload planning stopped");
  }
}

function missingEnvironment() {
  return REQUIRED_ENV.filter((name) => !process.env[name]);
}

function buildRcloneEnv() {
  return {
    ...process.env,
    RCLONE_CONFIG_R2_TYPE: "s3",
    RCLONE_CONFIG_R2_PROVIDER: "Cloudflare",
    RCLONE_CONFIG_R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    RCLONE_CONFIG_R2_ENDPOINT: process.env.R2_ENDPOINT
  };
}

function rcloneArgs() {
  return [
    "copy",
    MEDIA_ROOT,
    `r2:${process.env.R2_BUCKET}`,
    "--filter",
    "+ /20??/thumbs/**",
    "--filter",
    "+ /20??/display/**",
    "--filter",
    "- **",
    "--transfers",
    "16",
    "--checkers",
    "32",
    "--s3-no-check-bucket",
    "--s3-region",
    "auto",
    "--header-upload",
    "Cache-Control: public, max-age=14400, must-revalidate",
    "--immutable",
    "--stats",
    "30s",
    "--stats-one-line",
    "--stats-log-level",
    "NOTICE"
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun === args.execute) {
    throw new Error("Choose exactly one mode: --dry-run or --execute");
  }

  const mediaRoot = path.resolve(MEDIA_ROOT);
  if (!(await pathExists(mediaRoot))) {
    throw new Error(`Generated media directory is missing: ${toPosix(path.relative(APP_ROOT, mediaRoot))}`);
  }
  if (await fs.realpath(mediaRoot) !== mediaRoot) {
    throw new Error("Refusing a generated media root that resolves through a symlink");
  }
  if (!isInsideOrEqual(mediaRoot, path.join(ARCHIVE_ROOT, "generated", "library"))) {
    throw new Error("Refusing to use a media root outside 640/generated/library");
  }
  if (/\/(?:19|20)\d{2}$/.test(toPosix(mediaRoot)) || mediaRoot.includes(`${path.sep}dev-01`)) {
    throw new Error("Refusing to use a source-year folder as upload source");
  }

  await runAudit();
  const report = await loadAuditReport();
  const objects = await listMediaObjects(mediaRoot);
  const totalBytes = objects.reduce((sum, object) => sum + object.bytes, 0);
  const mib = (totalBytes / 1024 / 1024).toFixed(2);

  if (objects.length !== report.media.referencedAssetCount) {
    throw new Error(`Object count ${objects.length} does not match audited referenced asset count ${report.media.referencedAssetCount}`);
  }

  process.stdout.write(
    [
      `${args.dryRun ? "R2 dry-run" : "R2 upload"} plan.`,
      `Source ${toPosix(path.relative(APP_ROOT, mediaRoot))}.`,
      `Objects ${objects.length}.`,
      `Bytes ${mib} MiB.`,
      "Deletes 0."
    ].join(" ") + "\n"
  );

  if (args.dryRun) {
    process.stdout.write("No upload performed. No credentials printed.\n");
    return;
  }

  const missing = missingEnvironment();
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const which = spawnSync("rclone", ["version"], { stdio: "ignore" });
  if (which.status !== 0) {
    throw new Error("rclone is required for media upload but was not found on PATH");
  }

  const result = spawnSync("rclone", rcloneArgs(), {
    cwd: APP_ROOT,
    env: buildRcloneEnv(),
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`rclone exited with status ${result.status}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
