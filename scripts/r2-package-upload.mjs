import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createPublicationPlan, executePublication, verifyPublicationPackage } from "./package-media-publication.mjs";
import { createAuthenticatedIsolatedR2WriteAdapter, loadIsolatedR2WriteConfiguration } from "./r2-isolated-write-adapter.mjs";

const runtimeSecrets = [];

function parseArgs(argv) {
  const args = { mode: null, packageRoot: null, configPath: null, credentialsPath: null, journalRoot: null, concurrency: 4, maxAttempts: 3, pageSize: 1000 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--plan" || token === "--execute") {
      if (args.mode) throw new Error("Choose exactly one of --plan or --execute");
      args.mode = token.slice(2);
      continue;
    }
    if (["--force", "--production", "--delete", "--copy", "--overwrite", "--bucket", "--endpoint"].includes(token)) throw new Error(`Forbidden R2 publication option: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    index += 1;
    if (token === "--package-root") args.packageRoot = value;
    else if (token === "--config") args.configPath = value;
    else if (token === "--credentials") args.credentialsPath = value;
    else if (token === "--journal-root") args.journalRoot = value;
    else if (token === "--concurrency") args.concurrency = Number(value);
    else if (token === "--max-attempts") args.maxAttempts = Number(value);
    else if (token === "--page-size") args.pageSize = Number(value);
    else throw new Error(`Unknown option ${token}`);
  }
  if (!args.mode || !args.packageRoot || !args.configPath || !args.credentialsPath) throw new Error("Provide a mode, --package-root, --config, and --credentials");
  if (args.mode === "execute" && !args.journalRoot) throw new Error("--execute requires --journal-root");
  if (args.mode === "plan" && args.journalRoot) throw new Error("Zero-write plan mode does not accept --journal-root");
  return args;
}

export async function runIsolatedR2PackageUpload(args) {
  const packageRoot = path.resolve(args.packageRoot);
  const verifiedPackage = await verifyPublicationPackage(packageRoot);
  const configuration = await loadIsolatedR2WriteConfiguration({ configPath: path.resolve(args.configPath), credentialsPath: path.resolve(args.credentialsPath) });
  runtimeSecrets.push(configuration.credentials.accessKeyId, configuration.credentials.secretAccessKey, configuration.credentials.sessionToken);
  const adapter = createAuthenticatedIsolatedR2WriteAdapter({ configuration, verifiedPackage, pageSize: args.pageSize });
  if (args.mode === "plan") return createPublicationPlan({ packageRoot, adapter });
  return executePublication({ packageRoot, adapter, journalRoot: path.resolve(args.journalRoot), concurrency: args.concurrency, maxAttempts: args.maxAttempts });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runIsolatedR2PackageUpload(args);
  process.stdout.write(`${JSON.stringify(args.mode === "plan" ? result : result.receipt, null, 2)}\n`);
  if (args.mode === "plan" && !result.executable) process.exitCode = 2;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    let message = error instanceof Error ? error.stack || error.message : String(error);
    for (const secret of runtimeSecrets) if (secret) message = message.split(secret).join("[REDACTED]");
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
