import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export async function main() {
  throw new Error(
    "Legacy broad media upload is disabled. Media publication must consume a completed promotion package through the package-bound publication gate; this command cannot plan or upload."
  );
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
