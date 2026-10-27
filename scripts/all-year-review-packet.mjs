import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const PACKET_SCHEMA_VERSION = 1;
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_ROOT, "..");

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function naturalCompare(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is missing or invalid: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJson(root, relative, value) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

async function writeText(root, relative, value) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value, { flag: "wx" });
}

function yearForDecision(decision) {
  const candidates = [
    decision.subject?.year,
    decision.subject?.folderYear,
    decision.subject?.importerYear,
    decision.files?.[0]?.path?.match(/^(\d{4})(?:[-/]|$)/)?.[1],
    decision.subject?.path?.match(/^(\d{4})(?:[-/]|$)/)?.[1]
  ];
  return String(candidates.find((value) => /^\d{4}$/.test(String(value))) || "cross-year");
}

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function walkInventory(root, excluded = new Set()) {
  const files = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => naturalCompare(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Review packet contains a symlink: ${absolute}`);
      if (stat.isDirectory()) await walk(absolute);
      else if (stat.isFile()) {
        const relative = toPosix(path.relative(root, absolute));
        if (!excluded.has(relative)) {
          const bytes = await fs.readFile(absolute);
          files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
        }
      } else throw new Error(`Review packet contains a non-regular entry: ${absolute}`);
    }
  }
  await walk(root);
  files.sort((left, right) => naturalCompare(left.path, right.path));
  return { files, sha256: sha256(stableJson(files)) };
}

async function canonicalPhotos(canonicalDataRoot) {
  const catalog = await readJson(path.join(canonicalDataRoot, "catalog.json"), "Published catalogue");
  const photos = [];
  for (const entry of catalog.years || []) {
    const year = String(entry.year);
    const index = await readJson(path.join(canonicalDataRoot, year, "index.json"), `${year} published index`);
    for (const album of index.albums || []) {
      const manifestPath = album.manifestUrl.slice("data/".length);
      const manifest = await readJson(path.join(canonicalDataRoot, manifestPath), `${year} published album`);
      for (const photo of manifest.photos || []) photos.push({
        oldPhotoId: photo.id,
        status: "unresolved",
        outcome: null,
        newPhotoId: null,
        evidence: null,
        previous: { year, albumId: album.id, albumName: album.name, thumbnailKey: photo.thumbnailKey, displayKey: photo.displayKey }
      });
    }
  }
  photos.sort((left, right) => naturalCompare(left.oldPhotoId, right.oldPhotoId));
  if (new Set(photos.map((photo) => photo.oldPhotoId)).size !== photos.length) throw new Error("Published catalogue contains duplicate photo IDs");
  return photos;
}

async function stagedCandidateIds(stageInventory) {
  const ids = new Set();
  for (const entry of stageInventory.years) {
    const year = String(entry.year);
    const index = await readJson(path.join(entry.stageRoot, "public", "data", year, "index.json"), `${year} staged index`);
    for (const item of index.sequence || []) {
      if (ids.has(item.id)) throw new Error(`Duplicate staged candidate ID: ${item.id}`);
      ids.add(item.id);
    }
  }
  return ids;
}

function representativeIndexes(length, count) {
  if (length <= count) return Array.from({ length }, (_, index) => index);
  if (count === 1) return [Math.floor((length - 1) / 2)];
  return Array.from({ length: count }, (_, index) => Math.round((index * (length - 1)) / (count - 1)));
}

async function contactSheetForYear(root, entry) {
  const year = String(entry.year);
  const dataRoot = path.join(entry.stageRoot, "public", "data", year);
  const index = await readJson(path.join(dataRoot, "index.json"), `${year} staged index`);
  const albums = [];
  for (const album of index.albums || []) {
    const manifest = await readJson(path.join(entry.stageRoot, "public", album.manifestUrl), `${year} staged album`);
    albums.push({ album, photos: manifest.photos || [] });
  }
  const selections = [];
  if (albums.length >= 24) {
    for (const albumIndex of representativeIndexes(albums.length, 24)) {
      const item = albums[albumIndex];
      if (item.photos.length) selections.push({ album: item.album, photo: item.photos[Math.floor((item.photos.length - 1) / 2)] });
    }
  } else {
    const perAlbum = Math.max(1, Math.floor(24 / Math.max(1, albums.length)));
    for (const item of albums) {
      for (const photoIndex of representativeIndexes(item.photos.length, Math.min(perAlbum, item.photos.length))) selections.push({ album: item.album, photo: item.photos[photoIndex] });
    }
    selections.splice(24);
  }
  const columns = 4;
  const tileWidth = 180;
  const imageHeight = 120;
  const labelHeight = 34;
  const tileHeight = imageHeight + labelHeight;
  const rows = Math.max(1, Math.ceil(selections.length / columns));
  const composites = [];
  for (let indexPosition = 0; indexPosition < selections.length; indexPosition += 1) {
    const selection = selections[indexPosition];
    const input = path.join(entry.stageRoot, "generated", "library", selection.photo.thumbnailKey);
    const image = await sharp(input).resize(tileWidth, imageHeight, { fit: "contain", background: "#111827" }).png().toBuffer();
    const left = (indexPosition % columns) * tileWidth;
    const top = Math.floor(indexPosition / columns) * tileHeight;
    composites.push({ input: image, left, top });
    const label = `${selection.album.name} · ${selection.photo.id}`.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]);
    const svg = Buffer.from(`<svg width="${tileWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#0f172a"/><text x="6" y="14" fill="#e2e8f0" font-size="9" font-family="sans-serif">${label.slice(0, 56)}</text><text x="6" y="27" fill="#94a3b8" font-size="8" font-family="sans-serif">unreviewed mechanical projection</text></svg>`);
    composites.push({ input: svg, left, top: top + imageHeight });
  }
  const relative = `previews/${year}-contact-sheet.png`;
  await fs.mkdir(path.join(root, "previews"), { recursive: true });
  await sharp({ create: { width: columns * tileWidth, height: rows * tileHeight, channels: 3, background: "#020617" } })
    .composite(composites)
    .png()
    .toFile(path.join(root, relative));
  return {
    year,
    stageRoot: entry.stageRoot,
    albumCount: albums.length,
    photoCount: entry.stage.photos,
    previewCount: selections.length,
    contactSheet: relative,
    representatives: selections.map(({ album, photo }) => ({ albumId: album.id, albumName: album.name, photoId: photo.id, thumbnailKey: photo.thumbnailKey }))
  };
}

async function writeDecisionUnits(root, decisions) {
  const categories = new Map();
  for (const decision of decisions) {
    if (decision.status !== "unresolved" || decision.action !== null) throw new Error(`Policy decision is not unresolved: ${decision.id}`);
    if (!categories.has(decision.category)) categories.set(decision.category, []);
    categories.get(decision.category).push(decision);
  }
  const summary = {};
  const unitIndex = [];
  for (const [category, categoryDecisions] of Array.from(categories).sort(([left], [right]) => left.localeCompare(right))) {
    summary[category] = categoryDecisions.length;
    const grouped = new Map();
    for (const decision of categoryDecisions) {
      const year = yearForDecision(decision);
      if (!grouped.has(year)) grouped.set(year, []);
      grouped.get(year).push(decision);
    }
    for (const [year, yearDecisions] of Array.from(grouped).sort(([left], [right]) => naturalCompare(left, right))) {
      const units = chunk(yearDecisions, category === "duplicate-content" ? 100 : 150);
      for (let index = 0; index < units.length; index += 1) {
        const relative = `decisions/${category}/${year}-${String(index + 1).padStart(2, "0")}.json`;
        const value = {
          schemaVersion: PACKET_SCHEMA_VERSION,
          category,
          year,
          unit: index + 1,
          unitCount: units.length,
          status: "unresolved",
          count: units[index].length,
          decisions: units[index]
        };
        await writeJson(root, relative, value);
        unitIndex.push({ category, year, unit: index + 1, count: units[index].length, path: relative });
      }
    }
  }
  return { summary, unitIndex };
}

export async function verifyAllYearReviewPacket(outputRoot) {
  const root = path.resolve(outputRoot);
  const [completion, reviewIndex, transitionSummary, previewIndex] = await Promise.all([
    readJson(path.join(root, "complete.json"), "Review-packet completion seal"),
    readJson(path.join(root, "review-index.json"), "Review-packet index"),
    readJson(path.join(root, "decisions", "published-id-transition", "summary.json"), "Published-ID transition summary"),
    readJson(path.join(root, "previews", "index.json"), "Preview index")
  ]);
  if (completion.status !== "complete-unresolved-review-packet" || reviewIndex.status !== "unresolved-review-packet") throw new Error("Review packet is not complete and unresolved");
  const preSeal = await walkInventory(root, new Set(["complete.json"]));
  if (preSeal.files.length !== completion.fileCountBeforeSeal || preSeal.files.reduce((sum, file) => sum + file.bytes, 0) !== completion.bytesBeforeSeal || preSeal.sha256 !== completion.closedWorldSha256) {
    throw new Error("Review-packet closed-world seal does not match");
  }
  if (reviewIndex.counts.publishedIdTransitions !== transitionSummary.previousPublishedPhotoCount || transitionSummary.status !== "unresolved") throw new Error("Published-ID review count or status changed");
  let transitionCount = 0;
  for (const unit of reviewIndex.transitionUnits) {
    const value = await readJson(path.join(root, unit.path), "Published-ID review unit");
    if (value.status !== "unresolved" || value.transitions.some((transition) => transition.status !== "unresolved" || transition.outcome !== null || transition.newPhotoId !== null)) {
      throw new Error(`Published-ID review unit is not unresolved: ${unit.path}`);
    }
    transitionCount += value.transitions.length;
  }
  if (transitionCount !== transitionSummary.previousPublishedPhotoCount) throw new Error("Published-ID review units are incomplete");
  let policyDecisionCount = 0;
  for (const unit of reviewIndex.decisionUnits) {
    const value = await readJson(path.join(root, unit.path), "Source-policy review unit");
    if (value.status !== "unresolved" || value.decisions.some((decision) => decision.status !== "unresolved" || decision.action !== null)) throw new Error(`Source-policy unit is not unresolved: ${unit.path}`);
    policyDecisionCount += value.decisions.length;
  }
  if (policyDecisionCount !== reviewIndex.counts.policyDecisions) throw new Error("Source-policy review units are incomplete");
  if (previewIndex.years.length !== reviewIndex.counts.intendedYears) throw new Error("Representative contact sheets are incomplete");
  for (const preview of previewIndex.years) await fs.access(path.join(root, preview.contactSheet));
  return { completion, reviewIndex, policyDecisionCount, transitionCount, previewCount: previewIndex.years.length };
}

function omissionSummary(stageInventory) {
  const years = stageInventory.years.map((entry) => ({
    year: entry.year,
    status: "unresolved",
    sourceRoots: entry.sourceRoots,
    noise: entry.plan.omissions.noise,
    unsupported: entry.plan.omissions.unsupported,
    unreadable: entry.plan.omissions.unreadable,
    symlinks: entry.plan.omissions.symlinks
  }));
  return {
    schemaVersion: PACKET_SCHEMA_VERSION,
    status: "unresolved",
    totals: {
      noise: years.reduce((sum, year) => sum + year.noise.length, 0),
      unsupported: years.reduce((sum, year) => sum + year.unsupported.length, 0),
      unreadable: years.reduce((sum, year) => sum + year.unreadable.length, 0),
      symlinks: years.reduce((sum, year) => sum + year.symlinks.length, 0)
    },
    years
  };
}

export async function generateAllYearReviewPacket(options) {
  const outputRoot = path.resolve(options.outputRoot);
  if (await exists(outputRoot)) throw new Error(`Review-packet root must not already exist: ${outputRoot}`);
  const policyReport = await readJson(path.resolve(options.policyReportPath), "All-source policy report");
  const stageInventory = await readJson(path.resolve(options.stageInventoryPath), "All-year stage inventory");
  const canonicalDataRoot = path.resolve(options.canonicalDataRoot || path.join(APP_ROOT, "public", "data"));
  if (policyReport.eligibility?.publicationEligible || policyReport.eligibility?.counts?.resolved !== 0) throw new Error("Real source-policy decisions are not wholly unresolved");
  if (!stageInventory.allSelectedSourceYearsHaveCompletedStage || stageInventory.counts?.completeVerifiedResumePass !== stageInventory.selectedYears?.length) throw new Error("All selected source years must have verified mechanical stages before review-packet generation");
  await fs.mkdir(outputRoot, { recursive: false });
  try {
    const decisions = policyReport.policyTemplate?.decisions || [];
    const decisionUnits = await writeDecisionUnits(outputRoot, decisions);
    const omissions = omissionSummary(stageInventory);
    await writeJson(outputRoot, "decisions/selected-stage-omissions.json", omissions);
    await writeJson(outputRoot, "decisions/intended-years.json", {
      schemaVersion: PACKET_SCHEMA_VERSION,
      status: "unresolved",
      physicalMasterRoot: policyReport.inventory.sourceRoot,
      sourceInventorySha256: policyReport.inventory.inventorySha256,
      intendedYears: stageInventory.selectedYears,
      absentCalendarYears: stageInventory.absentCalendarYears,
      instruction: "Approve or revise the exact intended-year set; absence is not an exclusion decision."
    });

    const published = await canonicalPhotos(canonicalDataRoot);
    const candidateIds = await stagedCandidateIds(stageInventory);
    const sameId = published.filter((photo) => candidateIds.has(photo.oldPhotoId)).map((photo) => photo.oldPhotoId);
    const transitionUnits = [];
    const byYear = new Map();
    for (const transition of published) {
      if (!byYear.has(transition.previous.year)) byYear.set(transition.previous.year, []);
      byYear.get(transition.previous.year).push(transition);
    }
    for (const [year, transitions] of Array.from(byYear).sort(([left], [right]) => naturalCompare(left, right))) {
      const units = chunk(transitions, 500);
      for (let index = 0; index < units.length; index += 1) {
        const relative = `decisions/published-id-transition/${year}-${String(index + 1).padStart(2, "0")}.json`;
        await writeJson(outputRoot, relative, {
          schemaVersion: PACKET_SCHEMA_VERSION,
          category: "published-id-transition",
          year,
          unit: index + 1,
          unitCount: units.length,
          status: "unresolved",
          count: units[index].length,
          transitions: units[index]
        });
        transitionUnits.push({ year, unit: index + 1, count: units[index].length, path: relative });
      }
    }
    await writeJson(outputRoot, "decisions/published-id-transition/summary.json", {
      schemaVersion: PACKET_SCHEMA_VERSION,
      status: "unresolved",
      previousPublishedPhotoCount: published.length,
      mechanicalCandidatePhotoCount: candidateIds.size,
      exactSameIdCount: sameId.length,
      exactSameIds: sameId,
      warning: "ID overlap is not preservation approval. Every previous ID requires an approved alias with supported evidence or an explicit retired/no-successor decision.",
      units: transitionUnits
    });

    const previews = [];
    for (const entry of stageInventory.years) previews.push(await contactSheetForYear(outputRoot, entry));
    await writeJson(outputRoot, "previews/index.json", { schemaVersion: PACKET_SCHEMA_VERSION, status: "representative-only", years: previews });
    const counts = {
      intendedYears: stageInventory.selectedYears.length,
      mechanicalPhotos: stageInventory.counts.photos,
      mechanicalAlbums: stageInventory.counts.albums,
      policyDecisions: decisions.length,
      ...decisionUnits.summary,
      selectedStageNoise: omissions.totals.noise,
      selectedStageUnsupported: omissions.totals.unsupported,
      selectedStageUnreadable: omissions.totals.unreadable,
      selectedStageSymlinks: omissions.totals.symlinks,
      publishedIdTransitions: published.length,
      exactSamePublishedIdsInCandidate: sameId.length
    };
    const readme = [
      "# Pixilation archive-replacement review packet",
      "",
      "This packet is an **unresolved human-review aid** generated from the immutable mechanical stages. It does not approve a year, album label, duplicate, date, omission, unreadable file, or published-ID transition.",
      "",
      `- Physical master: \`${policyReport.inventory.sourceRoot}\``,
      `- Schema-v2 source inventory: \`${policyReport.inventory.inventorySha256}\``,
      `- Intended source-year projection: ${stageInventory.selectedYears.join(", ")}`,
      `- Absent calendar years: ${stageInventory.absentCalendarYears.join(", ")}`,
      `- Mechanical projection: ${stageInventory.counts.photos.toLocaleString("en-US")} photos in ${stageInventory.counts.albums.toLocaleString("en-US")} albums`,
      `- Unresolved source-policy decisions: ${decisions.length.toLocaleString("en-US")}`,
      `- Published IDs requiring explicit transitions: ${published.length.toLocaleString("en-US")}`,
      `- Exact same-ID intersections: ${sameId.length}; this is not a preservation pass`,
      "",
      "## Review order",
      "",
      "1. `decisions/intended-years.json` — approve or revise the exact year contract.",
      "2. `decisions/album-label/` plus `previews/` — review album boundaries and labels. Contact sheets are representative, not exhaustive.",
      "3. `decisions/duplicate-content/` — decide each exact duplicate-content group.",
      "4. `decisions/off-year-date/` and `decisions/folder-year/` — resolve date and year placement.",
      "5. `decisions/unsupported-file/`, `decisions/unreadable-file/`, and `decisions/selected-stage-omissions.json` — resolve every omission.",
      "6. `decisions/published-id-transition/` — approve an evidence-backed alias or explicit retired/no-successor result for every old ID.",
      "",
      "## Counts",
      "",
      ...Object.entries(counts).map(([key, value]) => `- ${key}: ${Number(value).toLocaleString("en-US")}`),
      "",
      "No entry in this packet is approved. Editing a copy for review does not mutate the source policy, stage receipts, or publication state."
    ].join("\n");
    await writeText(outputRoot, "README.md", `${readme}\n`);
    await writeJson(outputRoot, "review-index.json", {
      schemaVersion: PACKET_SCHEMA_VERSION,
      status: "unresolved-review-packet",
      createdAt: new Date().toISOString(),
      physicalMasterRoot: policyReport.inventory.sourceRoot,
      sourceInventorySha256: policyReport.inventory.inventorySha256,
      stageInventorySha256: sha256(stableJson(stageInventory)),
      counts,
      decisionUnits: decisionUnits.unitIndex,
      transitionUnits,
      previews: previews.map(({ year, contactSheet, previewCount }) => ({ year, contactSheet, previewCount }))
    });
    const preSeal = await walkInventory(outputRoot);
    const completion = {
      schemaVersion: PACKET_SCHEMA_VERSION,
      status: "complete-unresolved-review-packet",
      fileCountBeforeSeal: preSeal.files.length,
      bytesBeforeSeal: preSeal.files.reduce((sum, file) => sum + file.bytes, 0),
      closedWorldSha256: preSeal.sha256
    };
    await writeJson(outputRoot, "complete.json", completion);
    await verifyAllYearReviewPacket(outputRoot);
    return { outputRoot, counts, completion, previewCount: previews.length };
  } catch (error) {
    await fs.rm(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const args = { policyReportPath: null, stageInventoryPath: null, canonicalDataRoot: null, outputRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    index += 1;
    if (token === "--policy-report") args.policyReportPath = value;
    else if (token === "--stage-inventory") args.stageInventoryPath = value;
    else if (token === "--canonical-data-root") args.canonicalDataRoot = value;
    else if (token === "--output-root") args.outputRoot = value;
    else throw new Error(`Unknown option ${token}`);
  }
  if (!args.policyReportPath || !args.stageInventoryPath || !args.outputRoot) throw new Error("Provide --policy-report, --stage-inventory, and --output-root");
  return args;
}

async function main() {
  const result = await generateAllYearReviewPacket(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
