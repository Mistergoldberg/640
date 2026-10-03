import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const FRAME_PATTERN = /^frame-(\d{6})\.jpg$/;
const JOB_SCHEMA_VERSION = 1;
const REPORT_SCHEMA_VERSION = 1;
const SAMPLING_INTERVAL_SECONDS = 1;

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writePrivateJson(filePath, value) {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporaryPath, jsonBytes(value), { mode: 0o600, flag: "wx" });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function formatProcessFailure(command, args, code, signal, stderr) {
  const detail = stderr.trim().split("\n").slice(-8).join("\n");
  const status = signal ? `signal ${signal}` : `exit code ${code}`;
  return `${command} failed with ${status}${detail ? `:\n${detail}` : ""}`;
}

export function runProcess(command, args, { cwd, maxCaptureBytes = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let captureError = null;

    const capture = (chunks, chunk, kind) => {
      const nextBytes = (kind === "stdout" ? stdoutBytes : stderrBytes) + chunk.length;
      if (nextBytes > maxCaptureBytes) {
        captureError ||= new Error(`${command} ${kind} exceeded ${maxCaptureBytes} bytes`);
        child.kill("SIGKILL");
        return;
      }
      if (kind === "stdout") stdoutBytes = nextBytes;
      else stderrBytes = nextBytes;
      chunks.push(chunk);
    };

    child.stdout.on("data", (chunk) => capture(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => capture(stderr, chunk, "stderr"));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (captureError) {
        reject(captureError);
        return;
      }
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
        signal
      };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(formatProcessFailure(command, args, code, signal, result.stderr)), result));
    });
  });
}

function parsePositiveNumber(value) {
  if (value === undefined || value === null || value === "" || value === "N/A") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseRational(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(-?\d+)\/(\d+)$/);
  if (!match || Number(match[2]) === 0) return null;
  const parsed = Number(match[1]) / Number(match[2]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function deriveDuration(stream, format = {}) {
  const durationTs = parsePositiveNumber(stream.duration_ts);
  const timeBase = parseRational(stream.time_base);
  if (durationTs !== null && timeBase !== null && timeBase > 0) {
    const seconds = Number((durationTs * timeBase).toFixed(12));
    if (Number.isFinite(seconds) && seconds > 0) {
      return { seconds, source: "stream.duration_ts*time_base" };
    }
  }

  const streamDuration = parsePositiveNumber(stream.duration);
  if (streamDuration !== null) return { seconds: streamDuration, source: "stream.duration" };
  const formatDuration = parsePositiveNumber(format.duration);
  if (formatDuration !== null) return { seconds: formatDuration, source: "format.duration" };
  throw new Error("Video duration is unknown or zero; the MVP requires a positive inspectable duration");
}

export function estimatedFrameCount(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Video duration must be positive to estimate frames");
  }
  return Math.ceil(durationSeconds);
}

function displayRotation(stream) {
  const displayMatrix = stream.side_data_list?.find((entry) => entry.side_data_type === "Display Matrix");
  const matrixRotation = Number(displayMatrix?.rotation);
  if (Number.isFinite(matrixRotation)) {
    return { degrees: matrixRotation, source: "display-matrix" };
  }
  const tagRotation = Number(stream.tags?.rotate);
  if (Number.isFinite(tagRotation)) {
    return { degrees: tagRotation, source: "stream-tag" };
  }
  return { degrees: 0, source: "none" };
}

function normalizedQuarterTurn(degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  if (Math.abs(normalized - 90) < 0.01 || Math.abs(normalized - 270) < 0.01) return true;
  return false;
}

function firstLine(value) {
  return value.trim().split("\n")[0] || "unknown";
}

export async function inspectVideo(inputPath, {
  ffprobePath = "ffprobe",
  ffmpegPath = "ffmpeg",
  processRunner = runProcess
} = {}) {
  let probe;
  try {
    const result = await processRunner(ffprobePath, [
      "-v", "error",
      "-show_streams",
      "-show_format",
      "-print_format", "json",
      inputPath
    ]);
    probe = JSON.parse(result.stdout);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`ffprobe returned invalid JSON for ${inputPath}`);
    throw error;
  }

  const stream = probe.streams?.find((candidate) =>
    candidate.codec_type === "video" &&
    Number(candidate.disposition?.attached_pic || 0) !== 1 &&
    Number(candidate.width) > 0 &&
    Number(candidate.height) > 0
  );
  if (!stream) throw new Error("Input contains no usable non-attached-picture video stream");

  const duration = deriveDuration(stream, probe.format || {});
  const rotation = displayRotation(stream);
  const [ffmpegVersionResult, ffprobeVersionResult] = await Promise.all([
    processRunner(ffmpegPath, ["-version"]),
    processRunner(ffprobePath, ["-version"])
  ]);
  const swapsDimensions = normalizedQuarterTurn(rotation.degrees);
  const codedWidth = Number(stream.width);
  const codedHeight = Number(stream.height);

  return {
    streamIndex: Number(stream.index),
    codec: stream.codec_name || "unknown",
    codedWidth,
    codedHeight,
    displayWidth: swapsDimensions ? codedHeight : codedWidth,
    displayHeight: swapsDimensions ? codedWidth : codedHeight,
    timeBase: stream.time_base || null,
    durationTs: stream.duration_ts ?? null,
    streamDuration: stream.duration ?? null,
    formatDuration: probe.format?.duration ?? null,
    durationSeconds: duration.seconds,
    durationSource: duration.source,
    estimatedFrameCount: estimatedFrameCount(duration.seconds),
    frameRateDiagnostics: {
      average: stream.avg_frame_rate || null,
      nominal: stream.r_frame_rate || null
    },
    displayRotationDegrees: rotation.degrees,
    rotationSource: rotation.source,
    rotationTag: stream.tags?.rotate ?? null,
    displayMatrix: stream.side_data_list?.find((entry) => entry.side_data_type === "Display Matrix")?.displaymatrix || null,
    creationTimestamp: stream.tags?.creation_time || probe.format?.tags?.creation_time || null,
    ffmpegVersion: firstLine(ffmpegVersionResult.stdout),
    ffprobeVersion: firstLine(ffprobeVersionResult.stdout)
  };
}

function expectedFrameName(index) {
  return `frame-${String(index).padStart(6, "0")}.jpg`;
}

export async function validateFrameDirectory(directoryPath, { expectedCount } = {}) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) throw new Error("Extraction produced no frames");

  const frames = [];
  let commonWidth = null;
  let commonHeight = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const match = FRAME_PATTERN.exec(entry.name);
    if (!match) throw new Error(`Unexpected extraction output: ${entry.name}`);
    if (!entry.isFile()) throw new Error(`Frame is not a regular file: ${entry.name}`);
    if (entry.name !== expectedFrameName(index) || Number(match[1]) !== index) {
      throw new Error(`Frame sequence is not contiguous at index ${index}: found ${entry.name}`);
    }

    const framePath = path.join(directoryPath, entry.name);
    const stat = await fs.lstat(framePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
      throw new Error(`Frame is empty or not a regular file: ${entry.name}`);
    }

    let metadata;
    try {
      const image = sharp(framePath, { failOn: "error", sequentialRead: true });
      metadata = await image.metadata();
      await image.clone().raw().toBuffer();
    } catch (error) {
      throw new Error(`Frame does not decode as a complete image: ${entry.name}: ${error.message}`);
    }
    if (metadata.format !== "jpeg" || !metadata.width || !metadata.height) {
      throw new Error(`Frame is not a positive-dimension JPEG: ${entry.name}`);
    }
    if (metadata.orientation !== undefined) {
      throw new Error(`Frame unexpectedly depends on EXIF orientation: ${entry.name}`);
    }
    commonWidth ??= metadata.width;
    commonHeight ??= metadata.height;
    if (metadata.width !== commonWidth || metadata.height !== commonHeight) {
      throw new Error(`Frame dimensions changed within the sequence: ${entry.name}`);
    }
    frames.push({
      filename: entry.name,
      bytes: stat.size,
      width: metadata.width,
      height: metadata.height,
      sha256: await sha256File(framePath)
    });
  }

  if (expectedCount !== undefined && frames.length !== expectedCount) {
    throw new Error(`Frame count mismatch: expected ${expectedCount}, found ${frames.length}`);
  }
  const inventorySha256 = crypto.createHash("sha256")
    .update(frames.map(({ filename, sha256 }) => `${filename}\0${sha256}\n`).join(""))
    .digest("hex");
  return {
    frameCount: frames.length,
    firstFrame: frames[0].filename,
    lastFrame: frames.at(-1).filename,
    width: commonWidth,
    height: commonHeight,
    orientationMetadataPresent: false,
    inventorySha256,
    frames
  };
}

function safeJobName(inputPath) {
  const stem = path.parse(inputPath).name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${stem || "video"}-video-job`;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${filePath}: ${error.message}`);
  }
}

function publicResult(report, jobDirectory, reused = false) {
  return {
    jobDirectory,
    sourcePhotoDirectory: path.join(jobDirectory, "extracted"),
    reportPath: path.join(jobDirectory, "reports", "video-import-report.json"),
    reused,
    report
  };
}

async function inspectExistingJob(jobDirectory, source, inspection) {
  const jobPath = path.join(jobDirectory, "job.json");
  const referencePath = path.join(jobDirectory, "source-reference.json");
  if (!(await exists(jobPath)) || !(await exists(referencePath))) {
    throw new Error(`Conflicting job directory exists without required state files: ${jobDirectory}`);
  }
  const [job, reference] = await Promise.all([
    readJson(jobPath, "existing job state"),
    readJson(referencePath, "existing source reference")
  ]);
  if (reference.sourceSha256 !== source.sha256 || reference.sourcePath !== source.path) {
    throw new Error(`Conflicting job directory belongs to a different source: ${jobDirectory}`);
  }
  if (job.state !== "complete" || job.completed !== true) {
    throw new Error(`Incomplete prior video job requires explicit operator review: ${jobDirectory} (state: ${job.state || "unknown"})`);
  }

  const reportPath = path.join(jobDirectory, "reports", "video-import-report.json");
  const report = await readJson(reportPath, "completed job report");
  if (report.sourceSha256 !== source.sha256 || report.estimatedFrameCount !== inspection.estimatedFrameCount) {
    throw new Error(`Completed job report conflicts with the inspected source: ${jobDirectory}`);
  }
  const validation = await validateFrameDirectory(path.join(jobDirectory, "extracted"), {
    expectedCount: inspection.estimatedFrameCount
  });
  if (validation.inventorySha256 !== report.validation.inventorySha256) {
    throw new Error(`Completed job frame inventory no longer matches its report: ${jobDirectory}`);
  }
  return publicResult(report, jobDirectory, true);
}

function extractionArguments(inputPath, streamIndex, outputPattern) {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-xerror",
    "-err_detect", "explode",
    "-autorotate",
    "-i", inputPath,
    "-map", `0:${streamIndex}`,
    "-an",
    "-sn",
    "-dn",
    "-vf", "fps=fps=1:start_time=0:eof_action=pass",
    "-fps_mode", "passthrough",
    "-map_metadata", "-1",
    "-q:v", "2",
    "-start_number", "0",
    outputPattern
  ];
}

export async function runVideoImport({
  inputPath,
  jobRoot,
  ffmpegPath = "ffmpeg",
  ffprobePath = "ffprobe",
  processRunner = runProcess,
  writeStdout = (value) => process.stdout.write(value)
}) {
  if (!inputPath) throw new Error("Provide --input with one local video path");
  if (!jobRoot) throw new Error("Provide --job-root for private conversion jobs");
  const resolvedInput = await fs.realpath(path.resolve(inputPath)).catch(() => null);
  if (!resolvedInput) throw new Error(`Input video does not exist: ${path.resolve(inputPath)}`);
  const sourceStat = await fs.stat(resolvedInput);
  if (!sourceStat.isFile()) throw new Error(`Input video is not a regular file: ${resolvedInput}`);
  const resolvedJobRoot = path.resolve(jobRoot);
  if (resolvedJobRoot === resolvedInput || resolvedJobRoot.startsWith(`${resolvedInput}${path.sep}`)) {
    throw new Error("Job root cannot be the input file or inside it");
  }

  writeStdout("Inspecting video...\n");
  const [inspection, sourceSha256] = await Promise.all([
    inspectVideo(resolvedInput, { ffprobePath, ffmpegPath, processRunner }),
    sha256File(resolvedInput)
  ]);
  const source = {
    path: resolvedInput,
    filename: path.basename(resolvedInput),
    sha256: sourceSha256,
    bytes: sourceStat.size,
    modifiedAt: sourceStat.mtime.toISOString()
  };
  writeStdout(`Duration: ${inspection.durationSeconds} seconds\n`);
  writeStdout(`Display: ${inspection.displayWidth} × ${inspection.displayHeight} ${inspection.displayHeight > inspection.displayWidth ? "portrait" : "landscape"}\n`);
  writeStdout(`Estimated frames: ${inspection.estimatedFrameCount}\n\n`);

  await fs.mkdir(resolvedJobRoot, { recursive: true, mode: 0o700 });
  const jobDirectory = path.join(resolvedJobRoot, safeJobName(resolvedInput));
  try {
    await fs.mkdir(jobDirectory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    writeStdout("Validating existing completed job...\n");
    const existing = await inspectExistingJob(jobDirectory, source, inspection);
    writeStdout(`\nPASS (existing validated job)\n${existing.report.actualFrameCount} frames\n${existing.report.validation.firstFrame} → ${existing.report.validation.lastFrame}\n`);
    return existing;
  }

  const jobPath = path.join(jobDirectory, "job.json");
  const referencePath = path.join(jobDirectory, "source-reference.json");
  const extractingPath = path.join(jobDirectory, "extracting");
  const extractedPath = path.join(jobDirectory, "extracted");
  const reportsPath = path.join(jobDirectory, "reports");
  const startedAt = new Date().toISOString();
  let state = {
    schemaVersion: JOB_SCHEMA_VERSION,
    state: "inspected",
    completed: false,
    startedAt,
    updatedAt: startedAt,
    sourceSha256,
    estimatedFrameCount: inspection.estimatedFrameCount
  };
  const updateState = async (changes) => {
    state = { ...state, ...changes, updatedAt: new Date().toISOString() };
    await writePrivateJson(jobPath, state);
  };

  await writePrivateJson(jobPath, state);
  await writePrivateJson(referencePath, {
    schemaVersion: 1,
    sourceType: "video",
    sourcePath: source.path,
    sourceFilename: source.filename,
    sourceSha256: source.sha256,
    sourceBytes: source.bytes,
    sourceModifiedAt: source.modifiedAt
  });
  await fs.mkdir(extractingPath, { mode: 0o700 });
  await fs.mkdir(reportsPath, { mode: 0o700 });
  const outputPattern = path.join(extractingPath, "frame-%06d.jpg");
  const ffmpegArguments = extractionArguments(resolvedInput, inspection.streamIndex, outputPattern);

  try {
    writeStdout("Extracting...\n");
    await updateState({ state: "extracting" });
    await processRunner(ffmpegPath, ffmpegArguments);
    const [postExtractionSha256, postExtractionStat] = await Promise.all([
      sha256File(resolvedInput),
      fs.stat(resolvedInput)
    ]);
    if (postExtractionSha256 !== source.sha256 || postExtractionStat.size !== source.bytes) {
      throw new Error("Source video changed during extraction; refusing to validate or promote the frame sequence");
    }
    writeStdout("Validating...\n");
    await updateState({ state: "validating" });
    const validation = await validateFrameDirectory(extractingPath, {
      expectedCount: inspection.estimatedFrameCount
    });
    if (await exists(extractedPath)) throw new Error(`Final extracted directory already exists: ${extractedPath}`);
    await fs.rename(extractingPath, extractedPath);

    const completedAt = new Date().toISOString();
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      sourceType: "video",
      sourceFilename: source.filename,
      sourcePath: source.path,
      sourceSha256: source.sha256,
      sourceBytes: source.bytes,
      sourceDurationSeconds: inspection.durationSeconds,
      durationSource: inspection.durationSource,
      estimatedFrameCount: inspection.estimatedFrameCount,
      actualFrameCount: validation.frameCount,
      samplingIntervalSeconds: SAMPLING_INTERVAL_SECONDS,
      sourceCodec: inspection.codec,
      sourceWidth: inspection.codedWidth,
      sourceHeight: inspection.codedHeight,
      outputWidth: validation.width,
      outputHeight: validation.height,
      selectedVideoStreamIndex: inspection.streamIndex,
      displayRotationDegrees: inspection.displayRotationDegrees,
      rotationSource: inspection.rotationSource,
      rotationTag: inspection.rotationTag,
      displayMatrix: inspection.displayMatrix,
      timeBase: inspection.timeBase,
      durationTs: inspection.durationTs,
      streamDuration: inspection.streamDuration,
      formatDuration: inspection.formatDuration,
      frameRateDiagnostics: inspection.frameRateDiagnostics,
      creationTimestamp: inspection.creationTimestamp,
      outputFormat: "jpeg",
      ffmpegVersion: inspection.ffmpegVersion,
      ffprobeVersion: inspection.ffprobeVersion,
      extraction: {
        executable: ffmpegPath,
        arguments: ffmpegArguments.map((argument) => argument === resolvedInput ? "<SOURCE_VIDEO>" : argument === outputPattern ? "<EXTRACTING_DIR>/frame-%06d.jpg" : argument),
        timestampBasedSampling: true,
        metadataMapped: false,
        audioMapped: false
      },
      validation: {
        firstFrame: validation.firstFrame,
        lastFrame: validation.lastFrame,
        contiguousZeroBasedNames: true,
        allFramesDecoded: true,
        orientationMetadataPresent: validation.orientationMetadataPresent,
        inventorySha256: validation.inventorySha256,
        frames: validation.frames
      },
      startedAt,
      completedAt,
      completed: true
    };
    await writePrivateJson(path.join(reportsPath, "video-import-report.json"), report);
    await updateState({ state: "complete", completed: true, completedAt });
    writeStdout(`\nPASS\n${validation.frameCount} frames\n${validation.firstFrame} → ${validation.lastFrame}\n`);
    return publicResult(report, jobDirectory, false);
  } catch (error) {
    const failedAt = new Date().toISOString();
    const failure = {
      schemaVersion: 1,
      completed: false,
      failedAt,
      state: state.state,
      sourceFilename: source.filename,
      sourcePath: source.path,
      sourceSha256: source.sha256,
      error: error.message
    };
    try {
      await writePrivateJson(path.join(reportsPath, "failure.json"), failure);
      await updateState({ state: "failed", completed: false, failedAt, error: error.message });
    } catch (stateError) {
      error.message += ` (also failed to persist failure state: ${stateError.message})`;
    }
    throw error;
  }
}

function parseArgs(argv) {
  const args = { inputPath: null, jobRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (token !== "--input" && token !== "--job-root") throw new Error(`Unknown option: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    index += 1;
    if (token === "--input") args.inputPath = value;
    else args.jobRoot = value;
  }
  return args;
}

function usage() {
  return "Usage: npm run import:video -- --input /path/video.mov --job-root /path/video-jobs\n";
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) process.stdout.write(usage());
    else await runVideoImport(args);
  } catch (error) {
    process.stderr.write(`FAIL\n${error.message}\n`);
    process.exitCode = 1;
  }
}
