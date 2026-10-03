import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runImporter } from "./import-photos.mjs";

const RECORDED_2002_INVENTORY = {
  fileCount: 765,
  totalBytes: 48_609_569,
  inventorySha256: "58f4650294c9aa740a27dfe0c9471b9934abd9091be54b7e058bfdce71353f43"
};

const SUGGESTED_LABELS = {
  "2002 New/o8o2-7104-7239": {
    label: "August 2, 2002",
    basis: "Suggestion inferred from the folder token “o8o2”; confirm the intended date and event."
  },
  "2002 New/o815-7282-7361": {
    label: "August 15, 2002",
    basis: "Suggestion inferred from the folder token “o815”; confirm the intended date and event."
  },
  "2002 New/XXXXmomHolidays-5855-6036": {
    label: "Mom’s Holidays",
    basis: "Suggestion derived only from the existing folder words; confirm wording and capitalization."
  }
};

function signatureByPath(plan) {
  return new Map(plan.sourcePolicy.inventory.files.map((file) => [file.path, file]));
}

function exactFile(plan, relativePath) {
  return signatureByPath(plan).get(relativePath) || { path: relativePath, bytes: null, sha256: null };
}

function groupByKey(plan, key) {
  return plan.sourcePolicy.policyTemplate.decisionGroups.find((group) => group.key === key) || null;
}

function exactGroup(group) {
  return group
    ? {
        key: group.key,
        decisionIds: group.decisionIds,
        members: group.decisionIds.length,
        files: group.files,
        scopeSha256: group.scopeSha256,
        status: group.status,
        exceptions: group.exceptions
      }
    : null;
}

export function build2002DecisionPacket(plan) {
  if (plan.configuration.year !== "2002" || plan.mode !== "plan" || plan.zeroWrite !== true) {
    throw new Error("The 2002 decision packet requires a zero-write 2002 plan");
  }
  const facts = plan.observedFacts;
  const findings = plan.sourcePolicy.findings;
  const decisionGroups = plan.sourcePolicy.policyTemplate.decisionGroups;
  const groupedDecisionIds = new Set(decisionGroups.flatMap((group) => group.decisionIds));
  const newPhotos = facts.photos
    .filter((photo) => photo.relativePath.startsWith("2002 New/"))
    .map((photo) => ({ ...exactFile(plan, photo.relativePath), id: photo.proposedPhotoId, album: photo.album.name }));
  const publishedPhotos = findings.sourceMoves.map((photo) => ({ id: photo.photoId, path: photo.currentPath, bytes: photo.bytes, sha256: photo.sha256 }));
  const albums = facts.proposedAlbums.map((album, order) => ({
    order: order + 1,
    currentLabel: album.name,
    count: album.count,
    manifestUrl: album.manifestUrl,
    isNew: album.name.startsWith("2002 New/"),
    suggestedLabel: SUGGESTED_LABELS[album.name]?.label || null,
    suggestionBasis: SUGGESTED_LABELS[album.name]?.basis || null,
    suggestionStatus: SUGGESTED_LABELS[album.name] ? "suggestion-only-unapproved" : null
  }));
  const unsupportedFiles = facts.unsupportedFiles.map((file) => ({ ...exactFile(plan, file.relativePath), importerReason: file.reason }));
  const noiseFiles = facts.skippedNoiseFiles.map((file) => exactFile(plan, file.relativePath));
  const offYearFiles = facts.offYearDates.map((item) => ({ ...exactFile(plan, item.relativePath), exifYear: item.exifYear, exifTime: item.exifTime, field: item.field }));
  const stale = facts.outputsThatWouldBecomeStale;
  const existingAlbums = albums.filter((album) => !album.isNew);
  const newAlbums = albums.filter((album) => album.isNew);
  const mediaByPhoto = facts.photos.map((photo) => ({
    photoId: photo.proposedPhotoId,
    sourcePath: photo.relativePath,
    thumbnailKey: photo.proposedOutputs.thumbnail.key,
    displayKey: photo.proposedOutputs.display.key
  }));
  const candidateMediaKeys = mediaByPhoto.flatMap((photo) => [photo.thumbnailKey, photo.displayKey]).sort();
  const new2002MediaKeys = mediaByPhoto
    .filter((photo) => photo.sourcePath.startsWith("2002 New/"))
    .flatMap((photo) => [photo.thumbnailKey, photo.displayKey])
    .sort();
  const publishedPhotoVersionedKeys = mediaByPhoto
    .filter((photo) => !photo.sourcePath.startsWith("2002 New/"))
    .flatMap((photo) => [photo.thumbnailKey, photo.displayKey])
    .sort();
  const legacyTransitions = facts.legacyCompatibility?.transitions || [];
  const currentLegacyKeys = legacyTransitions
    .flatMap((transition) => [transition.legacy.thumbnailKey, transition.legacy.displayKey])
    .sort();
  const includeManifestPaths = albums.map((album) => album.manifestUrl).sort();
  const currentManifestPaths = existingAlbums.map((album) => album.manifestUrl).sort();
  const exactGroups = decisionGroups.map(exactGroup);
  const labelDecisions = plan.sourcePolicy.policyTemplate.decisions.filter((decision) => decision.category === "album-label");
  const folderYearDecisions = plan.sourcePolicy.policyTemplate.decisions.filter((decision) => decision.category === "folder-year");
  const packet = {
    schemaVersion: 2,
    kind: "pixilation-2002-decision-packet",
    generatedAt: new Date().toISOString(),
    zeroWrite: true,
    sourceInventory: {
      sourceRoot: plan.sourcePolicy.inventory.sourceRoot,
      scanRoots: plan.sourcePolicy.inventory.scanRoots,
      selectedYear: plan.sourcePolicy.inventory.selectedYear,
      fileCount: plan.sourcePolicy.inventory.fileCount,
      totalBytes: plan.sourcePolicy.inventory.totalBytes,
      inventorySha256: plan.sourcePolicy.inventory.inventorySha256,
      recordedBaseline: RECORDED_2002_INVENTORY,
      matchesRecordedBaseline:
        plan.sourcePolicy.inventory.fileCount === RECORDED_2002_INVENTORY.fileCount &&
        plan.sourcePolicy.inventory.totalBytes === RECORDED_2002_INVENTORY.totalBytes &&
        plan.sourcePolicy.inventory.inventorySha256 === RECORDED_2002_INVENTORY.inventorySha256,
      files: plan.sourcePolicy.inventory.files
    },
    policyEligibility: {
      publicationEligible: plan.sourcePolicy.eligibility.publicationEligible,
      unresolvedDecisions: plan.sourcePolicy.eligibility.counts.unresolved,
      reviewUnits: decisionGroups.length + plan.sourcePolicy.policyTemplate.decisions.filter((decision) => !groupedDecisionIds.has(decision.id)).length,
      exactGroups,
      ungroupedDecisions: plan.sourcePolicy.policyTemplate.decisions.filter((decision) => !groupedDecisionIds.has(decision.id))
    },
    humanReviewUnits: [
      {
        key: "2002-new-selection-and-labels",
        status: "unresolved",
        question: "Include or exclude this exact 279-photo set; if included, approve exact public labels for its three albums.",
        files: newPhotos,
        relatedDecisionIds: [
          ...labelDecisions.filter((decision) => decision.subject.sourceAlbum.startsWith("2002 New/")).map((decision) => decision.id),
          ...folderYearDecisions.filter((decision) => decision.subject.folder === "2002 New").map((decision) => decision.id)
        ]
      },
      {
        key: "off-year-exif",
        status: "unresolved",
        question: "Keep folder-year placement for this exact set, or record exact-file exceptions.",
        policyGroup: exactGroup(groupByKey(plan, "off-year-date:all")),
        files: offYearFiles
      },
      {
        key: "unsupported-and-noise",
        status: "unresolved",
        question: "For each exact file, approve omission or require repair/reclassification.",
        policyGroups: [exactGroup(groupByKey(plan, "unsupported-file:unsupported-file")), exactGroup(groupByKey(plan, "unsupported-file:noise"))],
        unsupportedFiles,
        ignoredNoiseFiles: noiseFiles
      },
      {
        key: "published-path-id-preservation",
        status: "unresolved",
        question: "Affirm the exact 479 current source-path-to-photo-ID mappings, or request a separate migration design.",
        policyGroup: exactGroup(groupByKey(plan, "source-move:all")),
        files: publishedPhotos
      },
      {
        key: "existing-folder-year-and-labels",
        status: "unresolved",
        question: "Affirm the current 2002 folder-to-year mappings and the two currently published album labels.",
        decisions: [
          ...labelDecisions.filter((decision) => !decision.subject.sourceAlbum.startsWith("2002 New/")),
          ...folderYearDecisions.filter((decision) => decision.subject.folder !== "2002 New")
        ]
      }
    ],
    publishedArchive: {
      photoCount: publishedPhotos.length,
      everyExistingIdStable: findings.missingPublishedPhotoIds.length === 0 && publishedPhotos.length === 479,
      missingPublishedIds: findings.missingPublishedPhotoIds,
      photos: publishedPhotos
    },
    proposed2002New: {
      publicationApproved: false,
      photoCount: newPhotos.length,
      albumCount: newAlbums.length,
      albums: newAlbums,
      photos: newPhotos
    },
    offYearExifDates: offYearFiles,
    unsupportedFiles,
    ignoredNoiseFiles: noiseFiles,
    scenarios: {
      include2002New: {
        publicationApproved: false,
        photoCount: facts.importablePhotos,
        albumCount: albums.length,
        albumOrder: albums.map((album) => album.currentLabel),
        existingUrlEffect: "All 479 existing photo IDs and direct-photo URL parameters remain unchanged; their candidate manifests reference 958 new versioned derivative keys while the 958 legacy keys remain available for rollback.",
        newUrlEffect: `${newPhotos.length} new photo IDs, ${newPhotos.length * 2} new derivative keys, and ${newAlbums.length} new album manifests would be proposed.`,
        manifestDifference: {
          selectedYearCandidatePaths: ["data/2002/index.json", ...includeManifestPaths],
          changedPaths: ["data/2002/index.json", ...currentManifestPaths],
          addedPaths: newAlbums.map((album) => album.manifestUrl).sort(),
          removedPaths: [],
          catalogueEffect: "2002 already exists in the catalogue; a promotion package must prove the exact candidate catalogue bytes."
        },
        mediaDifference: {
          candidateReferences: mediaByPhoto,
          candidateKeys: candidateMediaKeys,
          keysFor279NewPhotos: new2002MediaKeys,
          replacementVersionedKeysFor479PublishedPhotos: publishedPhotoVersionedKeys,
          obsoleteButRetainedLegacyKeys: stale.mediaKeys,
          rollbackLegacyKeys: currentLegacyKeys,
          deleteKeys: []
        },
        staleMediaKeys: stale.mediaKeys,
        staleAlbumManifests: stale.albumManifestPaths
      },
      exclude2002New: {
        publicationApproved: false,
        photoCount: publishedPhotos.length,
        albumCount: existingAlbums.length,
        albumOrder: existingAlbums.map((album) => album.currentLabel),
        existingUrlEffect: "The published 2002 URL and ID set remains unchanged; no proposed 2002 New URLs are created.",
        newUrlEffect: "No new photo IDs, derivative keys, or album manifests.",
        manifestDifference: {
          selectedYearCandidatePaths: ["data/2002/index.json", ...currentManifestPaths],
          changedPaths: [],
          addedPaths: [],
          removedPaths: []
        },
        mediaDifference: {
          candidateKeys: currentLegacyKeys,
          addedKeys: [],
          obsoleteButRetainedKeys: [],
          deleteKeys: []
        },
        staleMediaKeys: [],
        staleAlbumManifests: [],
        implementationConstraint: "The default 2002 source selection includes 2002 New. Exclusion requires a separately reviewed exact source-selection mechanism; policy must not be used as an implicit filter."
      }
    },
    decisionsForJared: [
      "Include or exclude the exact 2002 New source set. Exclusion needs a separately implemented exact source selection because the current canonical importer includes it.",
      "If included, approve the three public album labels; the readable labels in this packet are suggestions only.",
      "Choose the treatment of the exact 31 off-year EXIF files; current importer behavior keeps the folder year.",
      "Approve exact exclusion or require repair for the two unsupported files and five ignored noise files; current importer behavior omits them.",
      "Affirm that the 479 published source paths remain unchanged, or require a separate URL/ID migration design.",
      "Affirm the current 2002 folder-to-year mappings and the two published album labels; these remain explicit unresolved policy decisions."
    ]
  };
  return packet;
}

export function render2002DecisionPacket(packet) {
  const lines = [
    "# Pixilation 2002 decision packet",
    "",
    `- Zero-write report: ${packet.zeroWrite ? "yes" : "no"}`,
    `- Source inventory: ${packet.sourceInventory.fileCount} files; ${packet.sourceInventory.totalBytes.toLocaleString("en-US")} bytes`,
    `- Source inventory SHA-256: \`${packet.sourceInventory.inventorySha256}\``,
    `- Recorded baseline matches exactly: **${packet.sourceInventory.matchesRecordedBaseline ? "YES" : "NO"}**`,
    `- Publication eligible now: **${packet.policyEligibility.publicationEligible ? "YES" : "NO"}**`,
    `- Unresolved policy decisions: ${packet.policyEligibility.unresolvedDecisions}`,
    `- Exact review units after grouping: ${packet.policyEligibility.reviewUnits}`,
    `- Curated human review units in this packet: ${packet.humanReviewUnits.length}`,
    "",
    "## Published 2002 archive",
    "",
    `- Published photos matched to exact source paths: ${packet.publishedArchive.photoCount}`,
    `- Every existing ID stable: **${packet.publishedArchive.everyExistingIdStable ? "YES" : "NO"}**`,
    `- Missing published IDs: ${packet.publishedArchive.missingPublishedIds.length}`,
    "",
    "## 2002 New (unapproved)",
    "",
    `- Proposed photos: ${packet.proposed2002New.photoCount}`,
    `- Proposed albums: ${packet.proposed2002New.albumCount}`,
    "",
    "| Order | Existing folder label | Photos | Suggested readable label | Status |",
    "|---:|---|---:|---|---|",
    ...packet.proposed2002New.albums.map(
      (album) => `| ${album.order} | \`${album.currentLabel}\` | ${album.count} | ${album.suggestedLabel} | suggestion only; unapproved |`
    ),
    "",
    ...packet.proposed2002New.albums.map((album) => `- **${album.suggestedLabel}**: ${album.suggestionBasis}`),
    "",
    "The exact 279-photo membership, with path, byte count, SHA-256, proposed ID, and album, is in the companion JSON under `proposed2002New.photos`. No member is approved by appearing there.",
    "",
    "## Off-year EXIF dates",
    "",
    `- Exact files: ${packet.offYearExifDates.length}`,
    ...packet.offYearExifDates.map((item) => `- \`${item.path}\` (${item.bytes} bytes, \`${item.sha256}\`): EXIF ${item.exifTime} (${item.field})`),
    "",
    "## Unsupported and ignored files",
    "",
    `- Unsupported: ${packet.unsupportedFiles.length}`,
    ...packet.unsupportedFiles.map((file) => `- \`${file.path}\` (${file.bytes} bytes, \`${file.sha256}\`)`),
    `- Ignored noise: ${packet.ignoredNoiseFiles.length}`,
    ...packet.ignoredNoiseFiles.map((file) => `- \`${file.path}\` (${file.bytes} bytes, \`${file.sha256}\`)`),
    "",
    "## Include/exclude effects",
    "",
    `- Include: ${packet.scenarios.include2002New.photoCount} photos, ${packet.scenarios.include2002New.albumCount} albums, order ${packet.scenarios.include2002New.albumOrder.map((item) => `\`${item}\``).join(" → ")}.`,
    `- Include URL effect: ${packet.scenarios.include2002New.existingUrlEffect} ${packet.scenarios.include2002New.newUrlEffect}`,
    `- Include manifest difference: ${packet.scenarios.include2002New.manifestDifference.changedPaths.length} changed, ${packet.scenarios.include2002New.manifestDifference.addedPaths.length} added, ${packet.scenarios.include2002New.manifestDifference.removedPaths.length} removed.`,
    `- Include media difference: ${packet.scenarios.include2002New.mediaDifference.candidateKeys.length} candidate keys; ${packet.scenarios.include2002New.mediaDifference.keysFor279NewPhotos.length} for the 279 new photos; ${packet.scenarios.include2002New.mediaDifference.replacementVersionedKeysFor479PublishedPhotos.length} replacement versioned keys for currently published photos; ${packet.scenarios.include2002New.mediaDifference.obsoleteButRetainedLegacyKeys.length} legacy keys retained for rollback; zero deletes.`,
    `- Include stale-output findings: ${packet.scenarios.include2002New.staleMediaKeys.length} media keys; ${packet.scenarios.include2002New.staleAlbumManifests.length} manifests.`,
    `- Exclude: ${packet.scenarios.exclude2002New.photoCount} photos, ${packet.scenarios.exclude2002New.albumCount} albums, order ${packet.scenarios.exclude2002New.albumOrder.map((item) => `\`${item}\``).join(" → ")}.`,
    `- Exclude URL effect: ${packet.scenarios.exclude2002New.existingUrlEffect}`,
    `- Exclude manifest/media difference: ${packet.scenarios.exclude2002New.manifestDifference.changedPaths.length} changed manifests, ${packet.scenarios.exclude2002New.mediaDifference.addedKeys.length} added media keys, zero deletes.`,
    `- Constraint: ${packet.scenarios.exclude2002New.implementationConstraint}`,
    "",
    "## Decisions for Jared",
    "",
    ...packet.decisionsForJared.map((decision, index) => `${index + 1}. ${decision}`)
  ];
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { format: "markdown", appRoot: null, outputDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    index += 1;
    if (token === "--format") args.format = value;
    else if (token === "--app-root") args.appRoot = path.resolve(value);
    else if (token === "--output-dir") args.outputDir = path.resolve(value);
    else throw new Error(`Unknown option ${token}`);
  }
  const format = args.format;
  if (!new Set(["json", "markdown"]).has(format)) throw new Error("--format must be json or markdown");
  return args;
}

function isInsideOrEqual(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function physicalPathWithoutCreating(targetPath) {
  const unresolved = [];
  let current = path.resolve(targetPath);
  while (true) {
    try {
      return path.resolve(await fs.realpath(current), ...unresolved);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      unresolved.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function assertRecordedInventory(packet) {
  if (!packet.sourceInventory.matchesRecordedBaseline) {
    throw new Error(
      `2002 inventory drift: expected ${RECORDED_2002_INVENTORY.fileCount} files, ${RECORDED_2002_INVENTORY.totalBytes} bytes, ${RECORDED_2002_INVENTORY.inventorySha256}; ` +
        `found ${packet.sourceInventory.fileCount} files, ${packet.sourceInventory.totalBytes} bytes, ${packet.sourceInventory.inventorySha256}`
    );
  }
}

async function writePacket(outputDir, appRoot, packet) {
  const physicalOutput = await physicalPathWithoutCreating(outputDir);
  const physicalAppRoot = await fs.realpath(appRoot);
  const physicalSourceRoot = await fs.realpath(packet.sourceInventory.sourceRoot);
  if (
    isInsideOrEqual(physicalOutput, physicalAppRoot) ||
    isInsideOrEqual(physicalAppRoot, physicalOutput) ||
    isInsideOrEqual(physicalOutput, physicalSourceRoot) ||
    isInsideOrEqual(physicalSourceRoot, physicalOutput)
  ) {
    throw new Error("Decision-packet output must be isolated from the app workspace and source archive");
  }

  await fs.mkdir(physicalOutput, { recursive: true });
  const outputs = [
    { name: "2002-source-decision-packet.md", bytes: `${render2002DecisionPacket(packet)}\n` },
    { name: "2002-source-decision-packet.json", bytes: `${JSON.stringify(packet, null, 2)}\n` }
  ];
  for (const output of outputs) {
    const destination = path.join(physicalOutput, output.name);
    const temporary = path.join(physicalOutput, `.${output.name}.${process.pid}.tmp`);
    await fs.writeFile(temporary, output.bytes, { flag: "wx" });
    await fs.rename(temporary, destination);
  }
  return Object.fromEntries(outputs.map((output) => [path.extname(output.name).slice(1), path.join(physicalOutput, output.name)]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appRoot = args.appRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const plan = await runImporter(["--plan", "--year", "2002"], { appRoot, writeStdout: () => {} });
  const packet = build2002DecisionPacket(plan);
  assertRecordedInventory(packet);
  if (args.outputDir) {
    const files = await writePacket(args.outputDir, appRoot, packet);
    process.stdout.write(`${JSON.stringify({ status: "UNRESOLVED_REVIEW_PACKET", publicationEligible: false, inventoryMatchesRecordedBaseline: true, files }, null, 2)}\n`);
  } else {
    process.stdout.write(args.format === "json" ? `${JSON.stringify(packet, null, 2)}\n` : `${render2002DecisionPacket(packet)}\n`);
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
