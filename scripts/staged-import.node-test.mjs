import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { runImporter } from "./import-photos.mjs";

const YEAR = "2097";

async function createFixture() {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-stage-test-"));
  const sourceRoot = path.join(appRoot, "original-photos", `${YEAR} Source`);
  const albumA = path.join(sourceRoot, "Album A");
  const albumB = path.join(sourceRoot, "Album B");
  await fs.mkdir(albumA, { recursive: true });
  await fs.mkdir(albumB, { recursive: true });
  const sources = [
    [path.join(albumA, "a1.jpg"), { r: 210, g: 20, b: 20 }],
    [path.join(albumA, "a2.jpg"), { r: 20, g: 210, b: 20 }],
    [path.join(albumB, "b1.jpg"), { r: 20, g: 20, b: 210 }],
    [path.join(albumB, "b2.jpg"), { r: 160, g: 80, b: 20 }]
  ];
  for (const [filePath, background] of sources) {
    await sharp({ create: { width: 48, height: 32, channels: 3, background } }).jpeg().toFile(filePath);
  }
  const canonicalRoots = [
    path.join(appRoot, "public"),
    path.join(appRoot, "generated", "library"),
    path.join(appRoot, "generated", "reports")
  ];
  for (const [index, root] of canonicalRoots.entries()) {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, `canonical-${index}.txt`), `canonical ${index}\n`);
  }
  return { appRoot, sourceRoot, sources: sources.map(([filePath]) => filePath), canonicalRoots };
}

async function snapshotTree(root) {
  const entries = {};
  async function walk(directory) {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      const stat = await fs.lstat(absolutePath);
      if (child.isSymbolicLink()) {
        entries[relativePath] = { type: "symlink", target: await fs.readlink(absolutePath) };
      } else if (child.isDirectory()) {
        entries[relativePath] = { type: "directory", mode: stat.mode };
        await walk(absolutePath);
      } else {
        const bytes = await fs.readFile(absolutePath);
        entries[relativePath] = {
          type: "file",
          bytes: stat.size,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex")
        };
      }
    }
  }
  await walk(root);
  return entries;
}

async function canonicalSnapshot(roots) {
  return Promise.all(roots.map(snapshotTree));
}

function runtime(appRoot, overrides = {}) {
  return {
    appRoot,
    importerCommit: "test-importer-commit",
    sharpVersion: "test-sharp-version",
    writeStdout: () => {},
    ...overrides
  };
}

async function runStage(appRoot, stagingRoot, runtimeOverrides = {}) {
  return runImporter(["--year", YEAR, "--staging-root", stagingRoot], runtime(appRoot, runtimeOverrides));
}

function checksums(result) {
  return Object.fromEntries(result.receipt.outputChecksums.map((entry) => [entry.path, `${entry.bytes}:${entry.sha256}`]));
}

function oneShotFault(targetPoint) {
  let fired = false;
  return async (point) => {
    if (!fired && point === targetPoint) {
      fired = true;
      throw new Error(`Injected ${point}`);
    }
  };
}

test("every sealing interruption resumes to the uninterrupted output set without canonical writes", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.appRoot, { recursive: true, force: true }));
  const canonicalBefore = await canonicalSnapshot(fixture.canonicalRoots);
  const baseline = await runStage(fixture.appRoot, path.join(fixture.appRoot, "stages", "baseline"));
  assert.equal(baseline.receipt.counts.sources, 4);
  assert.equal(baseline.receipt.counts.albums, 2);
  assert.deepEqual(await canonicalSnapshot(fixture.canonicalRoots), canonicalBefore);
  const expectedChecksums = checksums(baseline);
  const completedResume = await runStage(fixture.appRoot, path.join(fixture.appRoot, "stages", "baseline"));
  assert.equal(completedResume.generatedDerivatives, 0);
  assert.equal(completedResume.reusedDerivatives, 8);
  assert.deepEqual(checksums(completedResume), expectedChecksums);
  const points = [
    "thumbnail-generation",
    "display-generation",
    "album-manifest-writing",
    "year-index-writing",
    "catalogue-writing",
    "final-sealing"
  ];

  for (const point of points) {
    const stagingRoot = path.join(fixture.appRoot, "stages", point);
    await assert.rejects(runStage(fixture.appRoot, stagingRoot, { injectFault: oneShotFault(point) }), new RegExp(`Injected ${point}`));
    assert.deepEqual(await canonicalSnapshot(fixture.canonicalRoots), canonicalBefore, `${point} changed a canonical root`);
    const resumed = await runStage(fixture.appRoot, stagingRoot);
    assert(resumed.reusedDerivatives > 0, `${point} did not reuse verified derivatives`);
    assert.deepEqual(checksums(resumed), expectedChecksums, `${point} resume differed from uninterrupted output`);
    assert.deepEqual(await canonicalSnapshot(fixture.canonicalRoots), canonicalBefore, `${point} resume changed a canonical root`);
  }
});

test("changed source bytes, Sharp version, recipe, and importer commit fail closed", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.appRoot, { recursive: true, force: true }));
  const canonicalBefore = await canonicalSnapshot(fixture.canonicalRoots);

  const sourceStage = path.join(fixture.appRoot, "stages", "source-change");
  await assert.rejects(runStage(fixture.appRoot, sourceStage, { injectFault: oneShotFault("thumbnail-generation") }), /Injected thumbnail-generation/);
  await sharp({ create: { width: 48, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toFile(fixture.sources[0]);
  await assert.rejects(runStage(fixture.appRoot, sourceStage), /identity changed; refusing to resume/);

  const versionStage = path.join(fixture.appRoot, "stages", "version-change");
  await assert.rejects(
    runStage(fixture.appRoot, versionStage, { sharpVersion: "sharp-v1", injectFault: oneShotFault("thumbnail-generation") }),
    /Injected thumbnail-generation/
  );
  await assert.rejects(runStage(fixture.appRoot, versionStage, { sharpVersion: "sharp-v2" }), /identity changed; refusing to resume/);

  const recipeStage = path.join(fixture.appRoot, "stages", "recipe-change");
  await assert.rejects(
    runStage(fixture.appRoot, recipeStage, { derivativeRecipe: { version: "recipe-v1" }, injectFault: oneShotFault("thumbnail-generation") }),
    /Injected thumbnail-generation/
  );
  await assert.rejects(
    runStage(fixture.appRoot, recipeStage, { derivativeRecipe: { version: "recipe-v2" } }),
    /identity changed; refusing to resume/
  );

  const commitStage = path.join(fixture.appRoot, "stages", "commit-change");
  await assert.rejects(
    runStage(fixture.appRoot, commitStage, { importerCommit: "commit-a", injectFault: oneShotFault("thumbnail-generation") }),
    /Injected thumbnail-generation/
  );
  await assert.rejects(runStage(fixture.appRoot, commitStage, { importerCommit: "commit-b" }), /identity changed; refusing to resume/);
  assert.deepEqual(await canonicalSnapshot(fixture.canonicalRoots), canonicalBefore);
});

test("truncated journal, corrupt derivative, and leftover temporary file recover safely", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.appRoot, { recursive: true, force: true }));
  const canonicalBefore = await canonicalSnapshot(fixture.canonicalRoots);
  const baseline = await runStage(fixture.appRoot, path.join(fixture.appRoot, "stages", "baseline"));
  const expectedChecksums = checksums(baseline);

  const truncatedStage = path.join(fixture.appRoot, "stages", "truncated");
  await assert.rejects(runStage(fixture.appRoot, truncatedStage, { injectFault: oneShotFault("display-generation") }), /Injected display-generation/);
  const truncatedJournal = path.join(truncatedStage, "generated", "journal", "progress.ndjson");
  await fs.appendFile(truncatedJournal, '{"type":"artifact-com');
  const recoveredTruncation = await runStage(fixture.appRoot, truncatedStage);
  assert.deepEqual(checksums(recoveredTruncation), expectedChecksums);
  assert.match(await fs.readFile(truncatedJournal, "utf8"), /"truncatedJournalBytes":/);

  const corruptStage = path.join(fixture.appRoot, "stages", "corrupt");
  await assert.rejects(runStage(fixture.appRoot, corruptStage, { injectFault: oneShotFault("album-manifest-writing") }), /Injected album-manifest-writing/);
  const thumbnailDirectory = path.join(corruptStage, "generated", "library", YEAR, "thumbs");
  const corruptTarget = path.join(thumbnailDirectory, (await fs.readdir(thumbnailDirectory))[0]);
  await fs.writeFile(corruptTarget, "corrupt derivative\n");
  const recoveredCorruption = await runStage(fixture.appRoot, corruptStage);
  assert.equal(recoveredCorruption.generatedDerivatives, 1);
  assert.deepEqual(checksums(recoveredCorruption), expectedChecksums);

  const temporaryStage = path.join(fixture.appRoot, "stages", "temporary");
  await assert.rejects(runStage(fixture.appRoot, temporaryStage, { injectFault: oneShotFault("display-generation") }), /Injected display-generation/);
  const temporaryPath = path.join(temporaryStage, "generated", "library", YEAR, "thumbs", ".leftover.pixilation-tmp-test");
  await fs.writeFile(temporaryPath, "leftover\n");
  const recoveredTemporary = await runStage(fixture.appRoot, temporaryStage);
  assert.deepEqual(checksums(recoveredTemporary), expectedChecksums);
  await assert.rejects(fs.access(temporaryPath), /ENOENT/);
  assert.deepEqual(await canonicalSnapshot(fixture.canonicalRoots), canonicalBefore);
});

test("nested staging symlinks and output-root escapes fail before writing staged artifacts", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.appRoot, { recursive: true, force: true }));
  const canonicalBefore = await canonicalSnapshot(fixture.canonicalRoots);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-stage-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const stagingRoot = path.join(fixture.appRoot, "stages", "symlink");
  await fs.mkdir(path.join(stagingRoot, "generated", "library"), { recursive: true });
  await fs.symlink(outside, path.join(stagingRoot, "generated", "library", YEAR));

  await assert.rejects(runStage(fixture.appRoot, stagingRoot), /Staging tree contains a symlink/);
  assert.deepEqual(await snapshotTree(outside), {});
  assert.deepEqual(await canonicalSnapshot(fixture.canonicalRoots), canonicalBefore);
});
