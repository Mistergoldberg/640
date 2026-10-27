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
  await fs.mkdir(path.dirname(filePath), { recursive: true });
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
  const firstPlan = await runImporter(["--plan", "--year", "2099"], { appRoot, writeStdout: () => {} });
  const proposedConflictPath = firstPlan.observedFacts.photos.find((photo) => photo.proposedPhotoId === validId).proposedOutputs.thumbnail.path;
  await fs.mkdir(path.dirname(proposedConflictPath), { recursive: true });
  await fs.writeFile(proposedConflictPath, "conflicting versioned key\n");
  const before = await snapshotTree(appRoot);
  const stdout = captureStdout();

  const plan = await runImporter(["--plan", "--year", "2099"], { appRoot, writeStdout: stdout.write });

  assert.equal(plan.zeroWrite, true);
  assert.equal(plan.observedFacts.importablePhotos, 2);
  assert.equal(plan.observedFacts.unreadableFiles.length, 1);
  assert.equal(plan.observedFacts.unsupportedFiles.length, 1);
  assert.equal(plan.observedFacts.duplicateContentGroups.length, 1);
  assert.equal(plan.observedFacts.existingKeyConflicts.length, 1);
  assert.deepEqual(plan.observedFacts.outputsThatWouldBecomeStale.mediaKeys, [`2099/thumbs/${validId}.jpg`, "2099/thumbs/stale.jpg"]);
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

  const report = await runImporter(["--year", "2098", "--staging-root", stagingRoot], {
    appRoot,
    importerCommit: "test-importer-commit",
    writeStdout: () => {}
  });

  assert.equal(report.receipt.counts.sources, 2);
  assert.deepEqual(await Promise.all(canonicalRoots.map(snapshotTree)), before);
  const staged = await snapshotTree(stagingRoot);
  assert(Object.keys(staged).some((entry) => entry.startsWith("public/data/2098/")));
  assert(Object.keys(staged).some((entry) => entry.startsWith("generated/library/2098/")));
  assert(Object.keys(staged).some((entry) => entry.startsWith("generated/reports/")));
  assert(!Object.keys(staged).some((entry) => entry.startsWith("generated/inventory-cache/")));
  assert(Object.keys(staged).some((entry) => entry.startsWith("generated/journal/")));
  for (const relativePath of Object.keys(staged).filter((entry) => staged[entry].type === "file")) {
    assert.match(relativePath, /^(public|generated\/library|generated\/reports|generated\/journal)\//);
  }
});

test("non-plan custom output refuses partial isolation and canonical aliases", async (t) => {
  const { appRoot, sourceFolder } = await makeWorkspace();
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  await writeJpeg(path.join(sourceFolder, "valid.jpg"));
  await assert.rejects(
    runImporter(["--year", "2099", "--data-root", path.join(appRoot, "stage-data")], { appRoot, writeStdout: () => {} }),
    /must use --staging-root/
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
    /must use --staging-root/
  );
});

test("explicit physical source root is bound to plans and required selection fails closed", async (t) => {
  const { appRoot } = await makeWorkspace("2094");
  const externalParent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "pixilation-external-source-"));
  const sourceRoot = path.join(externalParent, "original-photos");
  const sourcePath = path.join(sourceRoot, "2094-Chronological", "photo.jpg");
  await writeJpeg(sourcePath);
  t.after(() => Promise.all([fs.rm(appRoot, { recursive: true, force: true }), fs.rm(externalParent, { recursive: true, force: true })]));

  const plan = await runImporter(["--plan", "--year", "2094", "--source-root", sourceRoot], {
    appRoot,
    requiredSourceRoot: sourceRoot,
    writeStdout: () => {}
  });
  assert.equal(plan.configuration.sourceRoot, sourceRoot);
  assert.equal(plan.configuration.physicalSourceRoot, sourceRoot);
  assert.equal(plan.sourcePolicy.inventory.sourceRoot, sourceRoot);
  assert.deepEqual(plan.sourcePolicy.inventory.scanRoots, [path.join(sourceRoot, "2094-Chronological")]);
  assert.equal(plan.observedFacts.importablePhotos, 1);

  await assert.rejects(
    runImporter(["--plan", "--year", "2094"], { appRoot, requiredSourceRoot: sourceRoot, writeStdout: () => {} }),
    /requires an explicit --source-root/
  );
  await assert.rejects(
    runImporter(["--plan", "--year", "2094", "--source-root", await fs.realpath(path.join(appRoot, "original-photos"))], {
      appRoot,
      requiredSourceRoot: sourceRoot,
      writeStdout: () => {}
    }),
    /does not match required physical root/
  );
});

test("explicit source root rejects aliases, source-output overlap, and source symlinks", async (t) => {
  const { appRoot } = await makeWorkspace("2093");
  const externalParent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "pixilation-external-isolation-"));
  const sourceRoot = path.join(externalParent, "original-photos");
  await writeJpeg(path.join(sourceRoot, "2093 Source", "photo.jpg"));
  const aliasRoot = path.join(externalParent, "source-alias");
  await fs.symlink(sourceRoot, aliasRoot);
  t.after(() => Promise.all([fs.rm(appRoot, { recursive: true, force: true }), fs.rm(externalParent, { recursive: true, force: true })]));

  await assert.rejects(
    runImporter(["--plan", "--year", "2093", "--source-root", aliasRoot], { appRoot, writeStdout: () => {} }),
    /physical directory, not a symlink/
  );
  await assert.rejects(
    runImporter(["--plan", "--year", "2093", "--source-root", sourceRoot, "--data-root", path.join(sourceRoot, "plan-output")], {
      appRoot,
      writeStdout: () => {}
    }),
    /output root must not overlap the read-only source root/
  );
  await fs.symlink(path.join(appRoot, "original-photos"), path.join(sourceRoot, "2092 Escape"));
  await assert.rejects(
    runImporter(["--plan", "--year", "2093", "--source-root", sourceRoot], { appRoot, writeStdout: () => {} }),
    /contains a symlink/
  );
});

test("same-path byte changes alter physical inventory binding and wrong-root resume is refused", async (t) => {
  const { appRoot } = await makeWorkspace("2092");
  const externalParent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "pixilation-external-binding-"));
  const firstRoot = path.join(externalParent, "first", "original-photos");
  const secondRoot = path.join(externalParent, "second", "original-photos");
  const relativePath = path.join("2092 Source", "photo.jpg");
  await writeJpeg(path.join(firstRoot, relativePath), { r: 1, g: 2, b: 3 });
  await writeJpeg(path.join(secondRoot, relativePath), { r: 3, g: 2, b: 1 });
  const stagingRoot = path.join(appRoot, "external-stage");
  t.after(() => Promise.all([fs.rm(appRoot, { recursive: true, force: true }), fs.rm(externalParent, { recursive: true, force: true })]));

  const firstPlan = await runImporter(["--plan", "--year", "2092", "--source-root", firstRoot], { appRoot, writeStdout: () => {} });
  const secondPlan = await runImporter(["--plan", "--year", "2092", "--source-root", secondRoot], { appRoot, writeStdout: () => {} });
  assert.notEqual(firstPlan.sourcePolicy.inventory.inventorySha256, secondPlan.sourcePolicy.inventory.inventorySha256);
  assert.notEqual(firstPlan.observedFacts.photos[0].sourceSha256, secondPlan.observedFacts.photos[0].sourceSha256);

  const staged = await runImporter(["--year", "2092", "--source-root", firstRoot, "--staging-root", stagingRoot], {
    appRoot,
    importerCommit: "physical-root-binding-test",
    writeStdout: () => {}
  });
  assert.equal(staged.receipt.sourcePolicy.physicalSourceRoot, firstRoot);
  assert.deepEqual(staged.receipt.sourcePolicy.physicalScanRoots, [path.join(firstRoot, "2092 Source")]);
  assert.equal(staged.receipt.sourcePolicy.freshInventorySha256, firstPlan.sourcePolicy.inventory.inventorySha256);
  const runDescriptor = JSON.parse(await fs.readFile(path.join(stagingRoot, "generated", "journal", "run.json"), "utf8"));
  assert.equal(runDescriptor.binding.sourceSelection.sourceRoot, firstRoot);
  assert.equal(runDescriptor.binding.sourcePolicy.freshInventory.sourceRoot, firstRoot);
  assert.equal(runDescriptor.binding.sourcePolicy.freshInventory.inventorySha256, firstPlan.sourcePolicy.inventory.inventorySha256);
  await assert.rejects(
    runImporter(["--year", "2092", "--source-root", secondRoot, "--staging-root", stagingRoot], {
      appRoot,
      importerCommit: "physical-root-binding-test",
      writeStdout: () => {}
    }),
    /Staged run identity changed; refusing to resume/
  );
});

test("corrupt JPEG omission identity and staged run identity stay stable across inspection and resume", async (t) => {
  const { appRoot, sourceFolder } = await makeWorkspace("2091");
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  await writeJpeg(path.join(sourceFolder, "valid.jpg"), { r: 80, g: 20, b: 140 });
  const corruptPath = path.join(sourceFolder, "corrupt.jpg");
  const corruptBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0x9c, 0x00, 0x01]);
  await fs.writeFile(corruptPath, corruptBytes);
  const sourceRoot = await fs.realpath(path.join(appRoot, "original-photos"));
  const commonRuntime = {
    appRoot,
    requiredSourceRoot: sourceRoot,
    importerCommit: "stable-corrupt-jpeg-test",
    importerScriptSha256: "stable-corrupt-jpeg-script",
    writeStdout: () => {}
  };

  const plans = [];
  for (let iteration = 0; iteration < 4; iteration += 1) {
    plans.push(
      await runImporter(["--plan", "--year", "2091", "--source-root", sourceRoot, "--concurrency", "8"], commonRuntime)
    );
  }
  const firstPlan = plans[0];
  const expectedCorruptSha256 = crypto.createHash("sha256").update(corruptBytes).digest("hex");
  for (const plan of plans) {
    assert.deepEqual(
      plan.observedFacts.photos.map(({ relativePath, sourceBytes, sourceSha256, proposedPhotoId }) => ({ relativePath, sourceBytes, sourceSha256, proposedPhotoId })),
      firstPlan.observedFacts.photos.map(({ relativePath, sourceBytes, sourceSha256, proposedPhotoId }) => ({ relativePath, sourceBytes, sourceSha256, proposedPhotoId }))
    );
    assert.equal(plan.sourcePolicy.eligibility.decisionSetSha256, firstPlan.sourcePolicy.eligibility.decisionSetSha256);
    assert.equal(plan.sourcePolicy.eligibility.policySha256, firstPlan.sourcePolicy.eligibility.policySha256);
    assert.deepEqual(
      plan.observedFacts.unreadableFiles.map(({ relativePath, bytes, sha256, failureCode }) => ({ relativePath, bytes, sha256, failureCode })),
      [
        {
          relativePath: "2091 New/corrupt.jpg",
          bytes: corruptBytes.length,
          sha256: expectedCorruptSha256,
          failureCode: "supported-extension-decode-failed"
        }
      ]
    );
  }

  const firstStageRoot = path.join(appRoot, "stable-corrupt-stage-a");
  let interrupted = false;
  await assert.rejects(
    runImporter(["--year", "2091", "--source-root", sourceRoot, "--staging-root", firstStageRoot, "--concurrency", "8"], {
      ...commonRuntime,
      injectFault: async (point) => {
        if (!interrupted && point === "thumbnail-generation") {
          interrupted = true;
          throw new Error("intentional-corrupt-jpeg-interruption");
        }
      }
    }),
    /intentional-corrupt-jpeg-interruption/
  );
  const interruptedRun = JSON.parse(await fs.readFile(path.join(firstStageRoot, "generated", "journal", "run.json"), "utf8"));
  const stableUnreadable = interruptedRun.binding.sourceSelection.omissions.unreadable;
  assert.deepEqual(stableUnreadable, [
    {
      relativePath: "2091 New/corrupt.jpg",
      bytes: corruptBytes.length,
      sha256: expectedCorruptSha256,
      failureCode: "supported-extension-decode-failed"
    }
  ]);
  assert(!("diagnostic" in stableUnreadable[0]));
  assert(interruptedRun.diagnostics.unreadable[0].diagnostic);

  const resumedInterrupted = await runImporter(
    ["--year", "2091", "--source-root", sourceRoot, "--staging-root", firstStageRoot, "--concurrency", "8"],
    commonRuntime
  );
  assert.equal(resumedInterrupted.receipt.runId, interruptedRun.runId);
  assert.equal(resumedInterrupted.generatedDerivatives, 1);
  assert.equal(resumedInterrupted.reusedDerivatives, 1);
  assert.equal(resumedInterrupted.resumed, true);

  const completedResume = await runImporter(
    ["--year", "2091", "--source-root", sourceRoot, "--staging-root", firstStageRoot, "--concurrency", "8"],
    commonRuntime
  );
  assert.equal(completedResume.receipt.runId, interruptedRun.runId);
  assert.equal(completedResume.generatedDerivatives, 0);
  assert.equal(completedResume.reusedDerivatives, 2);
  assert.equal(completedResume.resumed, true);

  const secondStageRoot = path.join(appRoot, "stable-corrupt-stage-b");
  const independentStage = await runImporter(
    ["--year", "2091", "--source-root", sourceRoot, "--staging-root", secondStageRoot, "--concurrency", "8"],
    commonRuntime
  );
  const independentRun = JSON.parse(await fs.readFile(path.join(secondStageRoot, "generated", "journal", "run.json"), "utf8"));
  assert.equal(independentStage.receipt.runId, interruptedRun.runId);
  assert.equal(independentRun.binding.sourceSelectionSha256, interruptedRun.binding.sourceSelectionSha256);
  assert.deepEqual(independentRun.binding.sourceSelection.files, interruptedRun.binding.sourceSelection.files);
  assert.deepEqual(independentRun.binding.sourceSelection.omissions, interruptedRun.binding.sourceSelection.omissions);
});
