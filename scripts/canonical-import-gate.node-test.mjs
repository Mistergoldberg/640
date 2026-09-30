import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import sharp from "sharp";
import { runImporter } from "./import-photos.mjs";
import { createSourcePolicyTemplate, evaluateSourcePolicy, inspectSourcePolicy } from "./source-policy.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function jpeg(filePath, color = { r: 40, g: 80, b: 120 }) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp({ create: { width: 32, height: 24, channels: 3, background: color } }).jpeg().toFile(filePath);
}

async function workspace(year = "2096") {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-canonical-gate-"));
  const sourceFolder = path.join(appRoot, "original-photos", `${year} Source`);
  await jpeg(path.join(sourceFolder, "Album One", "one.jpg"));
  await jpeg(path.join(sourceFolder, "Album Two", "two.jpg"), { r: 120, g: 20, b: 80 });
  await fs.mkdir(path.join(appRoot, "public", "data"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "public", "data", "catalog.json"), '{"years":[]}\n');
  await fs.mkdir(path.join(appRoot, "generated", "library"), { recursive: true });
  await fs.mkdir(path.join(appRoot, "generated", "reports"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "generated", "library", "marker"), "media\n");
  await fs.writeFile(path.join(appRoot, "generated", "reports", "marker"), "reports\n");
  return { appRoot, year, sourceFolder };
}

async function snapshot(root) {
  const entries = [];
  async function walk(directory) {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      if (child.isDirectory()) await walk(absolutePath);
      else if (child.isFile()) {
        const bytes = await fs.readFile(absolutePath);
        entries.push({
          path: path.relative(root, absolutePath).split(path.sep).join("/"),
          bytes: bytes.length,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex")
        });
      }
    }
  }
  await walk(root);
  return entries;
}

async function canonicalSnapshot(fixture) {
  return Promise.all(
    [path.join(fixture.appRoot, "public"), path.join(fixture.appRoot, "generated", "library"), path.join(fixture.appRoot, "generated", "reports")].map(snapshot)
  );
}

function resolvePolicy(template) {
  const policy = structuredClone(template);
  for (const decision of policy.decisions) {
    decision.status = "resolved";
    if (decision.category === "folder-year") {
      decision.action = "map-to-year";
      decision.year = decision.subject.importerYear;
    } else if (decision.category === "album-label") {
      decision.action = "publish-label";
      decision.publicLabel = decision.subject.proposedPublicLabel;
    } else if (decision.category === "unsupported-file" || decision.category === "unreadable-file") decision.action = "exclude-exact";
    else if (decision.category === "duplicate-content") decision.action = "keep-separate";
    else if (decision.category === "off-year-date") decision.action = "use-folder-year";
    else if (decision.category === "source-move") decision.action = "preserve-source-path";
  }
  return policy;
}

async function makePolicy(fixture, filename, transform = (policy) => policy) {
  const inspection = await inspectSourcePolicy({
    sourceRoot: path.join(fixture.appRoot, "original-photos"),
    scanRoots: [fixture.sourceFolder],
    selectedYear: fixture.year,
    publicDataRoot: path.join(fixture.appRoot, "public"),
    concurrency: 2
  });
  const policy = transform(resolvePolicy(createSourcePolicyTemplate(inspection)));
  const policyRoot = path.join(fixture.appRoot, "reviewed-policies");
  await fs.mkdir(policyRoot, { recursive: true });
  const policyPath = path.join(policyRoot, filename);
  await fs.writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  return { inspection, policy, policyPath };
}

test("all canonical runImporter flag variants fail before writing without an explicit eligible policy", async (t) => {
  const fixture = await workspace();
  t.after(() => fs.rm(fixture.appRoot, { recursive: true, force: true }));
  const before = await canonicalSnapshot(fixture);
  const variants = [
    [],
    ["--force"],
    ["--limit", "1"],
    ["--concurrency", "1"],
    ["--source", fixture.sourceFolder],
    ["--force", "--limit", "1", "--concurrency", "1"]
  ];
  for (const variant of variants) {
    await assert.rejects(
      runImporter(["--year", fixture.year, ...variant], { appRoot: fixture.appRoot, writeStdout: () => {} }),
      /Canonical import requires --source-policy/
    );
    assert.deepEqual(await canonicalSnapshot(fixture), before);
  }
});

test("canonical gate rejects unresolved, stale, mismatched, and incompatible policies with zero writes, then accepts an exact resolved disposable fixture", async (t) => {
  const fixture = await workspace();
  t.after(() => fs.rm(fixture.appRoot, { recursive: true, force: true }));
  const before = await canonicalSnapshot(fixture);

  const unresolvedInspection = await inspectSourcePolicy({
    sourceRoot: path.join(fixture.appRoot, "original-photos"),
    scanRoots: [fixture.sourceFolder],
    selectedYear: fixture.year,
    publicDataRoot: path.join(fixture.appRoot, "public"),
    concurrency: 2
  });
  const unresolvedRoot = path.join(fixture.appRoot, "reviewed-policies");
  await fs.mkdir(unresolvedRoot, { recursive: true });
  const unresolvedPath = path.join(unresolvedRoot, "unresolved.json");
  await fs.writeFile(unresolvedPath, JSON.stringify(createSourcePolicyTemplate(unresolvedInspection)));
  await assert.rejects(
    runImporter(["--year", fixture.year, "--source-policy", unresolvedPath], { appRoot: fixture.appRoot, writeStdout: () => {} }),
    /Canonical import blocked.*Unresolved decisions:/
  );
  assert.deepEqual(await canonicalSnapshot(fixture), before);

  const mismatch = await makePolicy(fixture, "mismatch.json", (policy) => ({ ...policy, inventory: { ...policy.inventory, selectedYear: "2095" } }));
  await assert.rejects(
    runImporter(["--year", fixture.year, "--source-policy", mismatch.policyPath], { appRoot: fixture.appRoot, writeStdout: () => {} }),
    /Inventory match: false/
  );
  assert.deepEqual(await canonicalSnapshot(fixture), before);

  const incompatible = await makePolicy(fixture, "incompatible.json", (policy) => ({ ...policy, schemaVersion: 1 }));
  await assert.rejects(
    runImporter(["--year", fixture.year, "--source-policy", incompatible.policyPath], { appRoot: fixture.appRoot, writeStdout: () => {} }),
    /Unsupported source-policy schemaVersion/
  );
  assert.deepEqual(await canonicalSnapshot(fixture), before);

  const stale = await makePolicy(fixture, "stale.json");
  await jpeg(path.join(fixture.sourceFolder, "Album One", "one.jpg"), { r: 1, g: 2, b: 3 });
  await assert.rejects(
    runImporter(["--year", fixture.year, "--source-policy", stale.policyPath, "--force"], { appRoot: fixture.appRoot, writeStdout: () => {} }),
    /Inventory match: false.*changed: 1/
  );
  assert.deepEqual(await canonicalSnapshot(fixture), before);

  const exact = await makePolicy(fixture, "exact.json");
  assert.equal(evaluateSourcePolicy(exact.inspection, exact.policy).publicationEligible, true);
  const report = await runImporter(["--year", fixture.year, "--source-policy", exact.policyPath], { appRoot: fixture.appRoot, writeStdout: () => {} });
  assert.equal(report.successfullyImported, 2);
  const after = await canonicalSnapshot(fixture);
  assert.notDeepEqual(after, before);
  assert((await fs.readdir(path.join(fixture.appRoot, "generated", "library", fixture.year, "display"))).length === 2);
});

test("direct script and npm alias ignore environment-variable and force bypass attempts", async (t) => {
  const fixture = await workspace("2095");
  t.after(() => fs.rm(fixture.appRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(fixture.appRoot, "scripts"), { recursive: true });
  await fs.copyFile(path.join(REPO_ROOT, "scripts", "import-photos.mjs"), path.join(fixture.appRoot, "scripts", "import-photos.mjs"));
  await fs.copyFile(path.join(REPO_ROOT, "scripts", "source-policy.mjs"), path.join(fixture.appRoot, "scripts", "source-policy.mjs"));
  await fs.symlink(path.join(REPO_ROOT, "node_modules"), path.join(fixture.appRoot, "node_modules"));
  await fs.writeFile(
    path.join(fixture.appRoot, "package.json"),
    JSON.stringify({ type: "module", scripts: { "import:year": "node scripts/import-photos.mjs", "import:2013": "npm run import:year -- --year 2013", import: "npm run import:year --" } })
  );
  const unusedPolicy = await makePolicy(fixture, "environment-only.json");
  const before = await canonicalSnapshot(fixture);
  const env = {
    ...process.env,
    PIXILATION_SOURCE_POLICY: unusedPolicy.policyPath,
    SOURCE_POLICY: unusedPolicy.policyPath,
    PIXILATION_IMPORT_FORCE: "1",
    FORCE: "1"
  };

  const directScriptPath = await fs.realpath(path.join(fixture.appRoot, "scripts", "import-photos.mjs"));
  await assert.rejects(
    execFileAsync(process.execPath, [directScriptPath, "--year", fixture.year, "--force"], { cwd: await fs.realpath(fixture.appRoot), env }),
    (error) => /Canonical import requires --source-policy/.test(error.stderr)
  );
  assert.deepEqual(await canonicalSnapshot(fixture), before);

  await assert.rejects(
    execFileAsync("npm", ["run", "import:year", "--", "--year", fixture.year, "--limit", "1"], { cwd: fixture.appRoot, env }),
    (error) => /Canonical import requires --source-policy/.test(error.stderr)
  );
  assert.deepEqual(await canonicalSnapshot(fixture), before);

  const packageJson = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["import:year"], "node scripts/import-photos.mjs");
  assert.match(packageJson.scripts["import:2013:sample"], /import:year/);
  assert.match(packageJson.scripts["import:2013"], /import:year/);
  assert.match(packageJson.scripts.import, /import:year/);
});
