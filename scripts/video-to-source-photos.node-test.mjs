import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import {
  deriveDuration,
  estimatedFrameCount,
  inspectVideo,
  runProcess,
  runVideoImport,
  validateFrameDirectory
} from "./video-to-source-photos.mjs";

let suiteRoot;
let fixtureRoot;
let landscapePath;
let portraitPath;

async function ffmpeg(args, options) {
  return runProcess("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], options);
}

async function makeMpeg4(outputPath, source, extra = []) {
  await ffmpeg([
    "-f", "lavfi",
    "-i", source,
    "-an",
    "-c:v", "mpeg4",
    "-q:v", "4",
    "-pix_fmt", "yuv420p",
    ...extra,
    outputPath
  ]);
}

async function sha256(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function frameNames(directory) {
  return (await fs.readdir(directory)).sort();
}

async function makeJobRoot(name) {
  const root = path.join(suiteRoot, "jobs", name);
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function importFixture(inputPath, name) {
  return runVideoImport({
    inputPath,
    jobRoot: await makeJobRoot(name),
    writeStdout: () => {}
  });
}

function nearestColor(rgb) {
  const colors = {
    red: [255, 0, 0],
    green: [0, 128, 0],
    blue: [0, 0, 255],
    yellow: [255, 255, 0]
  };
  return Object.entries(colors)
    .map(([name, expected]) => ({
      name,
      distance: expected.reduce((total, channel, index) => total + Math.abs(channel - rgb[index]), 0)
    }))
    .sort((left, right) => left.distance - right.distance)[0].name;
}

async function quadrantColors(input) {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const samples = [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.2, 0.8],
    [0.8, 0.8]
  ];
  return samples.map(([xRatio, yRatio]) => {
    const x = Math.floor(info.width * xRatio);
    const y = Math.floor(info.height * yRatio);
    const offset = (y * info.width + x) * info.channels;
    return nearestColor([...data.subarray(offset, offset + 3)]);
  });
}

before(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-video-test-"));
  fixtureRoot = path.join(suiteRoot, "fixtures");
  await fs.mkdir(fixtureRoot);
  landscapePath = path.join(fixtureRoot, "landscape.mp4");
  await makeMpeg4(landscapePath, "testsrc2=size=128x72:rate=5:duration=30", ["-movflags", "+faststart"]);

  const portraitBasePath = path.join(fixtureRoot, "portrait-base.mov");
  portraitPath = path.join(fixtureRoot, "portrait-display-matrix.mov");
  await makeMpeg4(
    portraitBasePath,
    "color=c=red:s=160x90:r=5:d=30,drawbox=x=80:y=0:w=80:h=45:color=green:t=fill,drawbox=x=0:y=45:w=80:h=45:color=blue:t=fill,drawbox=x=80:y=45:w=80:h=45:color=yellow:t=fill"
  );
  await ffmpeg(["-display_rotation:v:0", "90", "-i", portraitBasePath, "-c", "copy", portraitPath]);
});

after(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
});

test("landscape MP4 produces a deterministic, contiguous, metadata-independent 30-frame sequence", async () => {
  const first = await importFixture(landscapePath, "landscape-first");
  const second = await importFixture(landscapePath, "landscape-second");
  assert.equal(first.report.actualFrameCount, 30);
  assert.equal(first.report.estimatedFrameCount, 30);
  assert.equal(first.report.outputWidth, 128);
  assert.equal(first.report.outputHeight, 72);
  assert.equal(first.report.validation.orientationMetadataPresent, false);
  assert.equal((await fs.stat(first.jobDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(first.reportPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(first.jobDirectory, "source-reference.json"))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(path.join(first.jobDirectory, "job.json"), "utf8")).completed, true);
  const firstNames = await frameNames(first.sourcePhotoDirectory);
  const secondNames = await frameNames(second.sourcePhotoDirectory);
  assert.equal(firstNames[0], "frame-000000.jpg");
  assert.equal(firstNames.at(-1), "frame-000029.jpg");
  assert.deepEqual(firstNames, secondNames);
  assert.deepEqual(
    await Promise.all(firstNames.map((name) => sha256(path.join(first.sourcePhotoDirectory, name)))),
    await Promise.all(secondNames.map((name) => sha256(path.join(second.sourcePhotoDirectory, name))))
  );
});

test("portrait MOV display matrix is applied to pixels with directional correctness and no EXIF dependency", async () => {
  const inspection = await inspectVideo(portraitPath);
  assert.equal(inspection.codedWidth, 160);
  assert.equal(inspection.codedHeight, 90);
  assert.equal(inspection.rotationSource, "display-matrix");
  assert.equal(inspection.displayRotationDegrees, 90);
  assert.match(inspection.displayMatrix, /65536/);
  const result = await importFixture(portraitPath, "portrait");
  assert.equal(result.report.actualFrameCount, 30);
  assert.equal(result.report.outputWidth, 90);
  assert.equal(result.report.outputHeight, 160);
  assert.match(result.report.displayMatrix, /65536/);
  assert.equal(result.report.validation.orientationMetadataPresent, false);

  for (const frameIndex of [0, 14, 29]) {
    const framePath = path.join(result.sourcePhotoDirectory, `frame-${String(frameIndex).padStart(6, "0")}.jpg`);
    const metadata = await sharp(framePath).metadata();
    assert.equal(metadata.orientation, undefined);
    assert.deepEqual(await quadrantColors(framePath), ["green", "yellow", "red", "blue"]);
    const metadataStripped = await sharp(framePath).jpeg({ quality: 95 }).toBuffer();
    const strippedMetadata = await sharp(metadataStripped).metadata();
    assert.equal(strippedMetadata.orientation, undefined);
    assert.equal(strippedMetadata.width, 90);
    assert.equal(strippedMetadata.height, 160);
    assert.deepEqual(await quadrantColors(metadataStripped), ["green", "yellow", "red", "blue"]);
  }
});

test("fractional final second uses ceil(duration) sampling semantics", async () => {
  for (const [duration, count] of [[0.2, 1], [1, 1], [1.2, 2], [29.8, 30], [30, 30], [30.2, 31], [303, 303], [303.2, 304]]) {
    assert.equal(estimatedFrameCount(duration), count);
  }
  const input = path.join(fixtureRoot, "fractional.mp4");
  await makeMpeg4(input, "testsrc2=size=64x48:rate=10:duration=1.2", ["-movflags", "+faststart"]);
  const result = await importFixture(input, "fractional");
  assert.equal(result.report.sourceDurationSeconds, 1.2);
  assert.equal(result.report.estimatedFrameCount, 2);
  assert.equal(result.report.actualFrameCount, 2);
  assert.deepEqual(await frameNames(result.sourcePhotoDirectory), ["frame-000000.jpg", "frame-000001.jpg"]);
});

test("VFR input is sampled by timestamps and preserves repeated visual moments", async () => {
  const images = path.join(fixtureRoot, "vfr-images");
  await fs.mkdir(images);
  const colors = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ffff00"];
  for (let index = 0; index < colors.length; index += 1) {
    await sharp({ create: { width: 96, height: 64, channels: 3, background: colors[index] } })
      .png()
      .toFile(path.join(images, `${index}.png`));
  }
  const concatPath = path.join(images, "frames.ffconcat");
  await fs.writeFile(concatPath, [
    "ffconcat version 1.0",
    "file 0.png", "duration 0.4",
    "file 1.png", "duration 1.2",
    "file 2.png", "duration 0.32",
    "file 3.png", "duration 1.4",
    "file 4.png", "duration 0.72",
    "file 4.png",
    ""
  ].join("\n"));
  const input = path.join(fixtureRoot, "variable-frame-rate.mp4");
  await ffmpeg([
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-an", "-fps_mode", "vfr", "-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p",
    input
  ], { cwd: images });
  const inspection = await inspectVideo(input);
  assert.notEqual(inspection.frameRateDiagnostics.average, inspection.frameRateDiagnostics.nominal);
  const result = await importFixture(input, "vfr");
  assert.equal(result.report.actualFrameCount, Math.ceil(result.report.sourceDurationSeconds));
  assert.equal(result.report.extraction.timestampBasedSampling, true);
  const hashes = await Promise.all((await frameNames(result.sourcePhotoDirectory)).map((name) => sha256(path.join(result.sourcePhotoDirectory, name))));
  assert(hashes.length >= 4);
  assert(new Set(hashes).size < hashes.length, "identical visual moments must remain separate files");
});

test("audio-only and zero/unknown-duration media fail closed", async () => {
  const audioOnlyPath = path.join(fixtureRoot, "audio-only.m4a");
  await ffmpeg([
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-vn", "-c:a", "aac", audioOnlyPath
  ]);
  await assert.rejects(importFixture(audioOnlyPath, "audio-only"), /no usable non-attached-picture video stream/);
  assert.throws(() => deriveDuration({ duration_ts: 0, time_base: "1/1000", duration: "0" }, { duration: "N/A" }), /unknown or zero/);
});

test("corrupt mid-stream input cannot promote a partial JPEG sequence", async () => {
  const healthy = path.join(fixtureRoot, "corrupt-source.mp4");
  const corrupt = path.join(fixtureRoot, "corrupt-truncated.mp4");
  await makeMpeg4(healthy, "testsrc2=size=96x64:rate=10:duration=8", ["-movflags", "+faststart"]);
  const bytes = await fs.readFile(healthy);
  await fs.writeFile(corrupt, bytes.subarray(0, Math.floor(bytes.length * 0.72)));
  const jobRoot = await makeJobRoot("corrupt");
  await assert.rejects(
    runVideoImport({ inputPath: corrupt, jobRoot, writeStdout: () => {} }),
    /ffmpeg failed|Frame count mismatch|Invalid data|corrupt|partial file/i
  );
  const jobDirectory = path.join(jobRoot, "corrupt-truncated-video-job");
  if (await fs.stat(jobDirectory).catch(() => null)) {
    assert.equal(await fs.stat(path.join(jobDirectory, "extracted")).then(() => true).catch(() => false), false);
    const job = JSON.parse(await fs.readFile(path.join(jobDirectory, "job.json"), "utf8"));
    assert.equal(job.completed, false);
    assert.equal(job.state, "failed");
  }
});

test("a source changed during extraction cannot produce a completed job", async () => {
  const input = path.join(fixtureRoot, "mutable.mp4");
  await fs.copyFile(landscapePath, input);
  const mutatingRunner = async (command, args, options) => {
    const result = await runProcess(command, args, options);
    if (command === "ffmpeg" && args.includes("-xerror")) {
      await fs.appendFile(input, Buffer.from("changed-after-decode"));
    }
    return result;
  };
  const jobRoot = await makeJobRoot("mutable");
  await assert.rejects(
    runVideoImport({ inputPath: input, jobRoot, processRunner: mutatingRunner, writeStdout: () => {} }),
    /Source video changed during extraction/
  );
  const jobDirectory = path.join(jobRoot, "mutable-video-job");
  const job = JSON.parse(await fs.readFile(path.join(jobDirectory, "job.json"), "utf8"));
  assert.equal(job.completed, false);
  assert.equal(job.state, "failed");
  assert.equal(await fs.stat(path.join(jobDirectory, "extracted")).then(() => true).catch(() => false), false);
});

test("reruns distinguish complete, incomplete, conflicting, and damaged jobs", async () => {
  const completeRoot = await makeJobRoot("rerun-complete");
  const complete = await runVideoImport({ inputPath: landscapePath, jobRoot: completeRoot, writeStdout: () => {} });
  const reused = await runVideoImport({ inputPath: landscapePath, jobRoot: completeRoot, writeStdout: () => {} });
  assert.equal(reused.reused, true);
  assert.equal(reused.report.validation.inventorySha256, complete.report.validation.inventorySha256);

  await fs.writeFile(path.join(complete.sourcePhotoDirectory, "frame-000000.jpg"), "damaged");
  await assert.rejects(
    runVideoImport({ inputPath: landscapePath, jobRoot: completeRoot, writeStdout: () => {} }),
    /does not decode|no longer matches/
  );

  const incompleteRoot = await makeJobRoot("rerun-incomplete");
  const failingRunner = async (command, args, options) => {
    if (command === "ffmpeg" && args.includes("-xerror")) throw new Error("simulated interruption");
    return runProcess(command, args, options);
  };
  await assert.rejects(
    runVideoImport({ inputPath: landscapePath, jobRoot: incompleteRoot, processRunner: failingRunner, writeStdout: () => {} }),
    /simulated interruption/
  );
  await assert.rejects(
    runVideoImport({ inputPath: landscapePath, jobRoot: incompleteRoot, writeStdout: () => {} }),
    /Incomplete prior video job requires explicit operator review/
  );

  const conflictingRoot = await makeJobRoot("rerun-conflict");
  const firstDir = path.join(fixtureRoot, "same-name-a");
  const secondDir = path.join(fixtureRoot, "same-name-b");
  await Promise.all([fs.mkdir(firstDir), fs.mkdir(secondDir)]);
  const firstPath = path.join(firstDir, "clip.mp4");
  const secondPath = path.join(secondDir, "clip.mp4");
  await fs.copyFile(landscapePath, firstPath);
  await makeMpeg4(secondPath, "color=c=purple:size=128x72:rate=5:duration=30");
  await runVideoImport({ inputPath: firstPath, jobRoot: conflictingRoot, writeStdout: () => {} });
  await assert.rejects(
    runVideoImport({ inputPath: secondPath, jobRoot: conflictingRoot, writeStdout: () => {} }),
    /belongs to a different source/
  );
});

test("closed-world validation rejects gaps and unexpected extraction outputs", async () => {
  const directory = path.join(suiteRoot, "invalid-sequence");
  await fs.mkdir(directory);
  await sharp({ create: { width: 20, height: 10, channels: 3, background: "red" } }).jpeg().toFile(path.join(directory, "frame-000000.jpg"));
  await sharp({ create: { width: 20, height: 10, channels: 3, background: "blue" } }).jpeg().toFile(path.join(directory, "frame-000002.jpg"));
  await assert.rejects(validateFrameDirectory(directory), /not contiguous/);
  await fs.rename(path.join(directory, "frame-000002.jpg"), path.join(directory, "frame-000001.jpg"));
  await fs.writeFile(path.join(directory, "notes.txt"), "unexpected");
  await assert.rejects(validateFrameDirectory(directory), /Unexpected extraction output/);
});

test("five-minute integration fixture produces and validates 300 ordered frames", {
  skip: process.env.PIXILATION_VIDEO_INTEGRATION !== "1"
}, async () => {
  const input = path.join(fixtureRoot, "five-minutes.mp4");
  await makeMpeg4(input, "testsrc2=size=64x48:rate=2:duration=300", ["-movflags", "+faststart"]);
  const result = await importFixture(input, "five-minutes");
  assert.equal(result.report.sourceDurationSeconds, 300);
  assert.equal(result.report.estimatedFrameCount, 300);
  assert.equal(result.report.actualFrameCount, 300);
  assert.equal(result.report.validation.firstFrame, "frame-000000.jpg");
  assert.equal(result.report.validation.lastFrame, "frame-000299.jpg");
  assert.equal((await frameNames(result.sourcePhotoDirectory)).length, 300);
});
