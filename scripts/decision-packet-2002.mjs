import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runImporter } from "./import-photos.mjs";

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
    .map((photo) => ({ path: photo.relativePath, id: photo.proposedPhotoId, album: photo.album.name, sourceSha256: photo.sourceSha256 }));
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
  const stale = facts.outputsThatWouldBecomeStale;
  const existingAlbums = albums.filter((album) => !album.isNew);
  const newAlbums = albums.filter((album) => album.isNew);
  const packet = {
    schemaVersion: 1,
    kind: "pixilation-2002-decision-packet",
    generatedAt: new Date().toISOString(),
    zeroWrite: true,
    sourceInventorySha256: plan.sourcePolicy.inventory.inventorySha256,
    policyEligibility: {
      publicationEligible: plan.sourcePolicy.eligibility.publicationEligible,
      unresolvedDecisions: plan.sourcePolicy.eligibility.counts.unresolved,
      reviewUnits: decisionGroups.length + plan.sourcePolicy.policyTemplate.decisions.filter((decision) => !groupedDecisionIds.has(decision.id)).length,
      exactGroups: decisionGroups.map((group) => ({
        key: group.key,
        members: group.decisionIds.length,
        files: group.files.length,
        scopeSha256: group.scopeSha256,
        status: group.status,
        exceptions: group.exceptions
      }))
    },
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
    offYearExifDates: facts.offYearDates.map((item) => ({ path: item.relativePath, exifYear: item.exifYear, exifTime: item.exifTime, field: item.field })),
    unsupportedFiles,
    ignoredNoiseFiles: noiseFiles,
    scenarios: {
      include2002New: {
        publicationApproved: false,
        photoCount: facts.importablePhotos,
        albumCount: albums.length,
        albumOrder: albums.map((album) => album.currentLabel),
        existingUrlEffect: "All 479 existing IDs and media keys remain unchanged.",
        newUrlEffect: `${newPhotos.length} new photo IDs, ${newPhotos.length * 2} new derivative keys, and ${newAlbums.length} new album manifests would be proposed.`,
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
      "Affirm that the 479 published source paths remain unchanged, or require a separate URL/ID migration design."
    ]
  };
  return packet;
}

export function render2002DecisionPacket(packet) {
  const lines = [
    "# Pixilation 2002 decision packet",
    "",
    `- Zero-write report: ${packet.zeroWrite ? "yes" : "no"}`,
    `- Source inventory SHA-256: \`${packet.sourceInventorySha256}\``,
    `- Publication eligible now: **${packet.policyEligibility.publicationEligible ? "YES" : "NO"}**`,
    `- Unresolved policy decisions: ${packet.policyEligibility.unresolvedDecisions}`,
    `- Exact review units after grouping: ${packet.policyEligibility.reviewUnits}`,
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
    "## Off-year EXIF dates",
    "",
    `- Exact files: ${packet.offYearExifDates.length}`,
    ...packet.offYearExifDates.map((item) => `- \`${item.path}\`: EXIF ${item.exifTime} (${item.field})`),
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
    `- Include stale-output findings: ${packet.scenarios.include2002New.staleMediaKeys.length} media keys; ${packet.scenarios.include2002New.staleAlbumManifests.length} manifests.`,
    `- Exclude: ${packet.scenarios.exclude2002New.photoCount} photos, ${packet.scenarios.exclude2002New.albumCount} albums, order ${packet.scenarios.exclude2002New.albumOrder.map((item) => `\`${item}\``).join(" → ")}.`,
    `- Exclude URL effect: ${packet.scenarios.exclude2002New.existingUrlEffect}`,
    `- Constraint: ${packet.scenarios.exclude2002New.implementationConstraint}`,
    "",
    "## Decisions for Jared",
    "",
    ...packet.decisionsForJared.map((decision, index) => `${index + 1}. ${decision}`)
  ];
  return lines.join("\n");
}

function parseArgs(argv) {
  const formatIndex = argv.indexOf("--format");
  const format = formatIndex === -1 ? "markdown" : argv[formatIndex + 1];
  if (!new Set(["json", "markdown"]).has(format)) throw new Error("--format must be json or markdown");
  return { format };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = await runImporter(["--plan", "--year", "2002"], { writeStdout: () => {} });
  const packet = build2002DecisionPacket(plan);
  process.stdout.write(args.format === "json" ? `${JSON.stringify(packet, null, 2)}\n` : `${render2002DecisionPacket(packet)}\n`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
