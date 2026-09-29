import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { runImporter } from "./import-photos.mjs";

async function makeWorkspace(year = "2099") {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-import-test-"));
  const sourceFolder = path.join(appRoot, "original-photos", `${year} New`);
  await fs.mkdir(sourceFolder, { recursive: true });
  await fs.mkdir(path.join(appRoot, "public", "data"), { recursive: true });
  await fs.mkdir(path.join(appRoot, "generated", "library"), { recursive: true });
  await fs.mkdir(path.join(appRoot, "generated", "reports"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "public", "data", "catalog.json"), '{"years":[]}\n');
  await fs.writeFile(path.join(appRoot, "generated", "library", "canonical-marker"), "media\n");
  await fs.writeFile(path.join(appRoot, "generated", "reports", "canonical-marker"), "reports\n");
  return { appRoot, sourceFolder };
}

async function writeJpeg(filePath, color = { r: 40, g: 80, b: 120 }) {
  await sharp({ create: { width: 32, height: 24, channels: 3, background: color } }).jpeg().toFile(filePath);
}

async function snapshotTree(root) {
  const snapshot = {};
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      const stat = await fs.lstat(absolutePath);
      if (entry.isSymbolicLink()) {
        snapshot[relativePath] = { type: "symlink", target: await fs.readlink(absolutePath) };
      } else if (entry.isDirectory()) {
        snapshot[relativePath] = { type: "directory", mode: stat.mode };
        await walk(absolutePath);
      } else {
        const bytes = await fs.readFile(absolutePath);
        snapshot[relativePath] = {
          type: "file",
          mode: stat.mode,
          bytes: stat.size,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex")
        };
      }
    }
  }
  await walk(root);
  return snapshot;
}

function captureStdout() {
  let value = "";
  return {
    write: (chunk) => {
      value += chunk;
    },
    value: () => value
  };
}

test("plan mode reports valid, malformed, and unsupported inputs with zero filesystem writes", async (t) => {
  const { appRoot, sourceFolder } = await makeWorkspace();
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  const validPath = path.join(sourceFolder, "valid.jpg");
  await writeJpeg(validPath);
  await fs.copyFile(validPath, path.join(sourceFolder, "duplicate.jpg"));
  await fs.writeFile(path.join(sourceFolder, "malformed.jpg"), "not an image\n");
  await fs.writeFile(path.join(sourceFolder, "notes.dat"), "unsupported\n");
  const validId = `2099-${crypto.createHash("sha1").update("2099 New/valid.jpg").digest("hex").slice(0, 14)}`;
  await fs.mkdir(path.join(appRoot, "generated", "library", "2099", "thumbs"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "generated", "library", "2099", "thumbs", `${validId}.jpg`), "conflicting key\n");
  await fs.writeFile(path.join(appRoot, "generated", "library", "2099", "thumbs", "stale.jpg"), "stale\n");
  await fs.mkdir(path.join(appRoot, "public", "data", "2099", "albums"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "public", "data", "2099", "albums", "stale.json"), "{}\n");
  const before = await snapshotTree(appRoot);
  const stdout = captureStdout();

  const plan = await runImporter(["--plan", "--year", "2099"], { appRoot, writeStdout: stdout.write });

  assert.equal(plan.zeroWrite, true);
  assert.equal(plan.observedFacts.importablePhotos, 2);
  assert.equal(plan.observedFacts.unreadableFiles.length, 1);
  assert.equal(plan.observedFacts.unsupportedFiles.length, 1);
  assert.equal(plan.observedFacts.duplicateContentGroups.length, 1);
  assert.equal(plan.observedFacts.existingKeyConflicts.length, 1);
  assert.deepEqual(plan.observedFacts.outputsThatWouldBecomeStale.mediaKeys, ["2099/thumbs/stale.jpg"]);
  assert.equal(plan.observedFacts.outputsThatWouldBecomeStale.albumManifestPaths.length, 1);
  assert(plan.observedFacts.photos.every((photo) => path.isAbsolute(photo.sourcePath) && path.isAbsolute(photo.proposedOutputs.display.path)));
  assert.deepEqual(JSON.parse(stdout.value()), plan);
  assert.deepEqual(await snapshotTree(appRoot), before);
});

test("plan failures create no paths and reject staging aliases before source inspection", async (t) => {
  const { appRoot, sourceFolder } = await makeWorkspace();
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  await writeJpeg(path.join(sourceFolder, "valid.jpg"));
  const aliasPath = path.join(appRoot, "public-alias");
  await fs.symlink(path.join(appRoot, "public"), aliasPath);
  const before = await snapshotTree(appRoot);

  await assert.rejects(
    runImporter(["--plan", "--year", "2099", "--staging-root", path.join(aliasPath, "stage")], { appRoot, writeStdout: () => {} }),
    /Staging root aliases or overlaps canonical data output/
  );
  assert.deepEqual(await snapshotTree(appRoot), before);
});

test("independent plan roots remain exact and plan does not create them", async (t) => {
  const { appRoot, sourceFolder } = await makeWorkspace();
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  await writeJpeg(path.join(sourceFolder, "valid.jpg"));
  const roots = {
    data: path.join(appRoot, "outside", "data"),
    media: path.join(appRoot, "outside", "media"),
    reports: path.join(appRoot, "outside", "reports"),
    cache: path.join(appRoot, "outside", "cache"),
    journal: path.join(appRoot, "outside", "journal")
  };
  const before = await snapshotTree(appRoot);
  const plan = await runImporter(
    [
      "--plan",
      "--year",
      "2099",
      "--data-root",
      roots.data,
      "--media-root",
      roots.media,
      "--reports-root",
      roots.reports,
      "--cache-root",
      roots.cache,
      "--journal-root",
      roots.journal
    ],
    { appRoot, writeStdout: () => {} }
  );
  assert.deepEqual(plan.configuration.outputRoots, roots);
  assert.deepEqual(await snapshotTree(appRoot), before);
});

test("disposable-root rehearsal contains outputs and preserves every canonical output byte", async (t) => {
  const { appRoot, sourceFolder } = await makeWorkspace("2098");
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  await writeJpeg(path.join(sourceFolder, "first.jpg"), { r: 200, g: 30, b: 10 });
  await writeJpeg(path.join(sourceFolder, "second.jpg"), { r: 10, g: 150, b: 60 });
  const canonicalRoots = [path.join(appRoot, "public"), path.join(appRoot, "generated", "library"), path.join(appRoot, "generated", "reports")];
  const before = await Promise.all(canonicalRoots.map(snapshotTree));
  const stagingRoot = path.join(appRoot, "disposable-stage");

  const report = await runImporter(["--year", "2098", "--staging-root", stagingRoot], { appRoot, writeStdout: () => {} });

  assert.equal(report.successfullyImported, 2);
  assert.deepEqual(await Promise.all(canonicalRoots.map(snapshotTree)), before);
  const staged = await snapshotTree(stagingRoot);
  assert(Object.keys(staged).some((entry) => entry.startsWith("public/data/2098/")));
  assert(Object.keys(staged).some((entry) => entry.startsWith("generated/library/2098/")));
  assert(Object.keys(staged).some((entry) => entry.startsWith("generated/reports/")));
  assert(!Object.keys(staged).some((entry) => entry.startsWith("generated/inventory-cache/")));
  assert(!Object.keys(staged).some((entry) => entry.startsWith("generated/journal/")));
  for (const relativePath of Object.keys(staged).filter((entry) => staged[entry].type === "file")) {
    assert.match(relativePath, /^(public|generated\/library|generated\/reports)\//);
  }
});

test("non-plan custom output refuses partial isolation and canonical aliases", async (t) => {
  const { appRoot, sourceFolder } = await makeWorkspace();
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  await writeJpeg(path.join(sourceFolder, "valid.jpg"));
  await assert.rejects(
    runImporter(["--year", "2099", "--data-root", path.join(appRoot, "stage-data")], { appRoot, writeStdout: () => {} }),
    /configure all five output roots/
  );
  await assert.rejects(
    runImporter(
      [
        "--year",
        "2099",
        "--data-root",
        path.join(appRoot, "public"),
        "--media-root",
        path.join(appRoot, "stage-media"),
        "--reports-root",
        path.join(appRoot, "stage-reports"),
        "--cache-root",
        path.join(appRoot, "stage-cache"),
        "--journal-root",
        path.join(appRoot, "stage-journal")
      ],
      { appRoot, writeStdout: () => {} }
    ),
    /aliases or overlaps canonical data output/
  );
});
