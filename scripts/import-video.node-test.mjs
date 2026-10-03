import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { runVideoSourceAlbumImport } from "./import-video.mjs";
import { runProcess } from "./video-to-source-photos.mjs";

let suiteRoot;
let fixtureRoot;
let shortLandscapePath;
let portraitPath;

async function ffmpeg(args) {
  return runProcess("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", ...args]);
}

async function makeVideo(outputPath, source, extra = []) {
  await ffmpeg([
    "-f", "lavfi", "-i", source,
    "-an", "-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p",
    ...extra,
    outputPath
  ]);
}

async function makeWorkspace(name) {
  const appRoot = path.join(suiteRoot, name);
  const sourceRoot = path.join(appRoot, "original-photos");
  await fs.mkdir(sourceRoot, { recursive: true });
  for (const root of [path.join(appRoot, "public"), path.join(appRoot, "generated", "library"), path.join(appRoot, "generated", "reports")]) {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "canonical-marker"), "must remain unchanged\n");
  }
  return { appRoot, sourceRoot };
}

async function snapshotTree(root) {
  const snapshot = {};
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      const stat = await fs.lstat(absolutePath);
      if (entry.isDirectory()) {
        snapshot[relativePath] = { type: "directory" };
        await walk(absolutePath);
      } else if (entry.isSymbolicLink()) {
        snapshot[relativePath] = { type: "symlink", target: await fs.readlink(absolutePath) };
      } else {
        const bytes = await fs.readFile(absolutePath);
        snapshot[relativePath] = {
          type: "file",
          bytes: bytes.length,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex")
        };
      }
    }
  }
  await walk(root);
  return snapshot;
}

async function runStage2B({ workspace, inputPath, year, albumTitle, name, reuseExisting = false, injectFault = null, importerRuntime = {} }) {
  return runVideoSourceAlbumImport({
    inputPath,
    year,
    albumTitle,
    sourceRoot: workspace.sourceRoot,
    jobRoot: path.join(workspace.appRoot, "jobs", name),
    stagingRoot: path.join(workspace.appRoot, "stages", name),
    reuseExisting,
    injectFault,
    writeStdout: () => {},
    importerRuntime: {
      importerCommit: "stage-2b-test-commit",
      sharpVersion: "stage-2b-test-sharp",
      ...importerRuntime
    }
  });
}

before(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-video-stage2b-"));
  fixtureRoot = path.join(suiteRoot, "fixtures");
  await fs.mkdir(fixtureRoot);
  shortLandscapePath = path.join(fixtureRoot, "constant-landscape.mp4");
  await makeVideo(shortLandscapePath, "color=c=orange:size=128x72:rate=5:duration=3.2", ["-movflags", "+faststart"]);

  const portraitBase = path.join(fixtureRoot, "portrait-base.mov");
  portraitPath = path.join(fixtureRoot, "portrait.mov");
  await makeVideo(
    portraitBase,
    "color=c=red:size=320x180:rate=5:duration=2,drawbox=x=160:y=0:w=160:h=90:color=green:t=fill,drawbox=x=0:y=90:w=160:h=90:color=blue:t=fill,drawbox=x=160:y=90:w=160:h=90:color=yellow:t=fill"
  );
  await ffmpeg(["-display_rotation:v:0", "90", "-i", portraitBase, "-c", "copy", portraitPath]);
});

after(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
});

test("new-year video installs one ordinary durable album and reruns with stable IDs", async () => {
  const workspace = await makeWorkspace("new-year");
  const canonicalBefore = await Promise.all([
    snapshotTree(path.join(workspace.appRoot, "public")),
    snapshotTree(path.join(workspace.appRoot, "generated", "library")),
    snapshotTree(path.join(workspace.appRoot, "generated", "reports"))
  ]);
  const first = await runStage2B({
    workspace,
    inputPath: shortLandscapePath,
    year: "2096",
    albumTitle: "First Video",
    name: "new-year"
  });
  assert.equal(first.sourceAlbumReused, false);
  assert.equal(first.sourceInventory.frameCount, 4);
  assert.equal(first.stagedAlbum.stagedAlbumPhotoCount, 4);
  assert.equal(first.stagedAlbum.fullYearPhotoCount, 4);
  assert.equal(first.stagedAlbum.fullYearAlbumCount, 1);
  assert.equal(first.stagedAlbum.albumName, "2096 First Video");
  assert.equal(new Set(first.stagedAlbum.photoIds).size, 4);
  assert.equal(new Set(first.sourceInventory.frames.map((frame) => frame.sha256)).size, 1, "identical frame bytes should remain distinct path IDs");
  assert.equal(first.stageResult.receipt.publicationApproved, false);
  assert.equal(first.privateReport.completedStage2B, true);
  assert.equal((await fs.stat(first.privateReportPath)).mode & 0o777, 0o600);
  assert.equal(await existsAt(path.join(path.dirname(first.privateReportPath), "stage-2b-source-policy-template.json")), true);
  assert.deepEqual(
    await Promise.all([
      snapshotTree(path.join(workspace.appRoot, "public")),
      snapshotTree(path.join(workspace.appRoot, "generated", "library")),
      snapshotTree(path.join(workspace.appRoot, "generated", "reports"))
    ]),
    canonicalBefore
  );
  const sourceBeforeRerun = await snapshotTree(workspace.sourceRoot);
  const completedReportBeforeRejectedRerun = await fs.readFile(first.privateReportPath);
  await assert.rejects(
    runStage2B({ workspace, inputPath: shortLandscapePath, year: "2096", albumTitle: "First Video", name: "new-year" }),
    /--reuse-existing/
  );
  assert.deepEqual(await fs.readFile(first.privateReportPath), completedReportBeforeRejectedRerun);
  const rerun = await runStage2B({
    workspace,
    inputPath: shortLandscapePath,
    year: "2096",
    albumTitle: "First Video",
    name: "new-year",
    reuseExisting: true
  });
  assert.equal(rerun.sourceAlbumReused, true);
  assert.equal(rerun.stagedAlbum.albumId, first.stagedAlbum.albumId);
  assert.deepEqual(rerun.stagedAlbum.photoIds, first.stagedAlbum.photoIds);
  assert.equal(rerun.stageResult.receipt.runId, first.stageResult.receipt.runId);
  assert.equal(rerun.stagedAlbum.closedWorldSha256, first.stagedAlbum.closedWorldSha256);
  assert.deepEqual(await snapshotTree(workspace.sourceRoot), sourceBeforeRerun);
});

async function existsAt(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

test("existing-year staging preserves the pre-existing album and adds the video album", async () => {
  const workspace = await makeWorkspace("existing-year");
  const existingAlbum = path.join(workspace.sourceRoot, "2095 Existing Photos");
  await fs.mkdir(existingAlbum);
  await sharp({ create: { width: 80, height: 60, channels: 3, background: "purple" } }).jpeg().toFile(path.join(existingAlbum, "existing.jpg"));
  const result = await runStage2B({
    workspace,
    inputPath: shortLandscapePath,
    year: "2095",
    albumTitle: "New Video",
    name: "existing-year"
  });
  assert.deepEqual(result.privateReport.authoritativeYearFolders, ["2095 Existing Photos", "2095 New Video"]);
  assert.equal(result.stagedAlbum.fullYearPhotoCount, 5);
  assert.equal(result.stagedAlbum.fullYearAlbumCount, 2);
  assert(result.plan.observedFacts.proposedAlbums.some((album) => album.name === "2095 Existing Photos" && album.count === 1));
  const index = JSON.parse(await fs.readFile(result.stagedAlbum.yearIndexPath, "utf8"));
  assert.deepEqual(index.albums.map((album) => album.name).sort(), ["2095 Existing Photos", "2095 New Video"]);
});

test("portrait display rotation remains portrait through ordinary importer derivatives", async () => {
  const workspace = await makeWorkspace("portrait");
  const result = await runStage2B({
    workspace,
    inputPath: portraitPath,
    year: "2094",
    albumTitle: "Portrait Video",
    name: "portrait"
  });
  assert.deepEqual(result.stagedAlbum.orientations, { portrait: 2 });
  const manifest = JSON.parse(await fs.readFile(result.stagedAlbum.albumManifestPath, "utf8"));
  for (const photo of manifest.photos) {
    assert.equal(photo.width, 180);
    assert.equal(photo.height, 320);
    assert.equal(photo.orientation, "portrait");
    const thumbnail = await sharp(path.join(result.stageResult.receipt.stagedPaths.media, photo.thumbnailKey)).metadata();
    const display = await sharp(path.join(result.stageResult.receipt.stagedPaths.media, photo.displayKey)).metadata();
    assert.deepEqual([thumbnail.width, thumbnail.height], [180, 320]);
    assert.deepEqual([display.width, display.height], [180, 320]);
  }
});

test("frame 000099 to 000100 ordering survives the staged manifest", async () => {
  const orderingVideo = path.join(fixtureRoot, "ordering-101.mp4");
  await makeVideo(orderingVideo, "testsrc2=size=48x32:rate=2:duration=101", ["-movflags", "+faststart"]);
  const workspace = await makeWorkspace("ordering");
  const result = await runStage2B({
    workspace,
    inputPath: orderingVideo,
    year: "2093",
    albumTitle: "Ordered Frames",
    name: "ordering"
  });
  assert.equal(result.stagedAlbum.stagedAlbumPhotoCount, 101);
  const targetPhotos = result.plan.observedFacts.photos.filter((photo) => photo.album.id === result.stagedAlbum.albumId);
  assert.equal(targetPhotos[99].relativePath, "2093 Ordered Frames/frame-000099.jpg");
  assert.equal(targetPhotos[100].relativePath, "2093 Ordered Frames/frame-000100.jpg");
  const manifest = JSON.parse(await fs.readFile(result.stagedAlbum.albumManifestPath, "utf8"));
  assert.equal(manifest.photos[99].id, targetPhotos[99].proposedPhotoId);
  assert.equal(manifest.photos[100].id, targetPhotos[100].proposedPhotoId);
  assert.deepEqual(manifest.photos.map((photo) => photo.albumSortPosition), Array.from({ length: 101 }, (_, index) => index));
});

test("an existing different album fails without changing any source byte", async () => {
  const workspace = await makeWorkspace("collision");
  const albumPath = path.join(workspace.sourceRoot, "2092 Collision");
  await fs.mkdir(albumPath);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: "black" } }).jpeg().toFile(path.join(albumPath, "frame-000000.jpg"));
  const before = await snapshotTree(workspace.sourceRoot);
  await assert.rejects(
    runStage2B({ workspace, inputPath: shortLandscapePath, year: "2092", albumTitle: "Collision", name: "collision" }),
    /Existing source album conflicts|differs/
  );
  assert.deepEqual(await snapshotTree(workspace.sourceRoot), before);
  assert.equal(await existsAt(path.join(workspace.appRoot, "stages", "collision")), false);
});

test("interrupted installation remains hidden and blocks unsafe rerun", async () => {
  const workspace = await makeWorkspace("interrupted");
  await assert.rejects(
    runStage2B({
      workspace,
      inputPath: shortLandscapePath,
      year: "2091",
      albumTitle: "Interrupted",
      name: "interrupted",
      injectFault: async (point) => {
        if (point === "after-install-copy") throw new Error("simulated install interruption");
      }
    }),
    /simulated install interruption/
  );
  assert.equal(await existsAt(path.join(workspace.sourceRoot, "2091 Interrupted")), false);
  assert((await fs.readdir(workspace.sourceRoot)).some((name) => name.startsWith(".2091 Interrupted.installing-")));
  await assert.rejects(
    runStage2B({ workspace, inputPath: shortLandscapePath, year: "2091", albumTitle: "Interrupted", name: "interrupted" }),
    /Incomplete durable source installation requires operator review/
  );
});

test("changed Stage 2A frame inventory cannot install a durable album", async () => {
  const workspace = await makeWorkspace("changed-source");
  await assert.rejects(
    runStage2B({
      workspace,
      inputPath: shortLandscapePath,
      year: "2090",
      albumTitle: "Changed Source",
      name: "changed-source",
      injectFault: async (point, details) => {
        if (point === "after-stage-2a-validation") {
          await sharp({ create: { width: 128, height: 72, channels: 3, background: "white" } })
            .jpeg()
            .toFile(path.join(details.stage2AResult.sourcePhotoDirectory, "frame-000000.jpg"));
        }
      }
    }),
    /does not match the Stage 2A frame inventory|changed during durable installation/
  );
  assert.equal(await existsAt(path.join(workspace.sourceRoot, "2090 Changed Source")), false);
});

test("importer failure retains the durable source and safely resumes isolated staging", async () => {
  const workspace = await makeWorkspace("importer-resume");
  let fired = false;
  await assert.rejects(
    runStage2B({
      workspace,
      inputPath: shortLandscapePath,
      year: "2088",
      albumTitle: "Importer Resume",
      name: "importer-resume",
      importerRuntime: {
        injectFault: async (point) => {
          if (!fired && point === "thumbnail-generation") {
            fired = true;
            throw new Error("simulated importer interruption");
          }
        }
      }
    }),
    /simulated importer interruption/
  );
  const albumPath = path.join(workspace.sourceRoot, "2088 Importer Resume");
  assert.equal(await existsAt(albumPath), true);
  const sourceAfterFailure = await snapshotTree(albumPath);
  const resumed = await runStage2B({
    workspace,
    inputPath: shortLandscapePath,
    year: "2088",
    albumTitle: "Importer Resume",
    name: "importer-resume",
    reuseExisting: true
  });
  assert.equal(resumed.sourceAlbumReused, true);
  assert.equal(resumed.stageResult.resumed, true);
  assert.equal(resumed.privateReport.completedStage2B, true);
  assert.deepEqual(await snapshotTree(albumPath), sourceAfterFailure);
});

test("album input validation rejects traversal and material normalization", async () => {
  const workspace = await makeWorkspace("bad-title");
  for (const albumTitle of ["", " ../escape", "nested/name", "trailing "]) {
    await assert.rejects(
      runStage2B({ workspace, inputPath: shortLandscapePath, year: "2089", albumTitle, name: "bad-title" }),
      /album-title/
    );
  }
  assert.deepEqual(await fs.readdir(workspace.sourceRoot), []);
});
