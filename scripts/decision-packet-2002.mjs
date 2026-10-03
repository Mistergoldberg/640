import crypto from "node:crypto";
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

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function uploadEstimate(measuredLegacyBytes, photoCount, publishedPhotoCount) {
  return {
    classification: "estimate",
    bytes: measuredLegacyBytes === null ? null : Math.round((measuredLegacyBytes * photoCount) / publishedPhotoCount),
    formula: `round(measured current 2002 legacy derivative bytes × ${photoCount} / ${publishedPhotoCount})`,
    limitation: "No staged derivatives were generated. New encoding output may differ from legacy bytes because legacy assets do not carry verified source/recipe provenance."
  };
}

function formatUpload(upload) {
  if (upload.bytes === null) return `${upload.classification}; bytes unavailable`;
  return `${upload.bytes.toLocaleString("en-US")} bytes (${(upload.bytes / (1024 * 1024)).toFixed(2)} MiB; ${upload.classification})`;
}

export async function measure2002PromotionEvidence(plan) {
  const publicRoot = plan.configuration.canonicalOutputRoots.data;
  const dataRoot = path.join(publicRoot, "data");
  const mediaRoot = plan.configuration.canonicalOutputRoots.media;
  const currentIndexPath = path.join(dataRoot, "2002", "index.json");
  const currentIndexBytes = await fs.readFile(currentIndexPath);
  const currentIndex = JSON.parse(currentIndexBytes);
  const existingAlbums = plan.observedFacts.proposedAlbums.filter((album) => !album.name.startsWith("2002 New/"));
  const existingPhotos = plan.observedFacts.photos.filter((photo) => !photo.relativePath.startsWith("2002 New/"));
  const scannedExistingFiles = plan.sourcePolicy.inventory.fileCount - plan.sourcePolicy.findings.new2002.files.length;
  const hypotheticalExistingIndex = {
    year: "2002",
    scannedCount: scannedExistingFiles,
    albums: existingAlbums.map(({ id, name, count, manifestUrl }) => ({ id, name, count, manifestUrl })),
    sequence: existingPhotos.map((photo) => ({ id: photo.proposedPhotoId }))
  };
  const hypotheticalIndexBytes = Buffer.from(`${JSON.stringify(hypotheticalExistingIndex, null, 2)}\n`);

  const catalog = JSON.parse(await fs.readFile(path.join(dataRoot, "catalog.json"), "utf8"));
  const archiveKeys = new Set();
  const selectedYearKeys = new Set();
  const selectedYearManifests = [];
  for (const year of catalog.years) {
    const yearIndex = JSON.parse(await fs.readFile(path.join(publicRoot, year.indexUrl), "utf8"));
    for (const album of yearIndex.albums) {
      const manifestPath = path.join(publicRoot, album.manifestUrl);
      const manifestBytes = await fs.readFile(manifestPath);
      const manifest = JSON.parse(manifestBytes);
      if (year.year === "2002") {
        selectedYearManifests.push({ path: album.manifestUrl, bytes: manifestBytes.length, sha256: sha256(manifestBytes), photos: manifest.photos.length });
      }
      for (const photo of manifest.photos) {
        for (const key of [photo.thumbnailKey, photo.displayKey]) {
          archiveKeys.add(key);
          if (year.year === "2002") selectedYearKeys.add(key);
        }
      }
    }
  }

  let selectedYearLegacyBytes = 0;
  let thumbnailBytes = 0;
  let displayBytes = 0;
  for (const key of selectedYearKeys) {
    const bytes = (await fs.stat(path.join(mediaRoot, key))).size;
    selectedYearLegacyBytes += bytes;
    if (key.includes("/thumbs/")) thumbnailBytes += bytes;
    else displayBytes += bytes;
  }
  const sortedArchiveKeys = [...archiveKeys].sort();
  const sortedSelectedKeys = [...selectedYearKeys].sort();
  const archiveLegacyKeys = sortedArchiveKeys.filter((key) => !key.includes("-cv"));
  return {
    method: "Read-only inspection of current public manifests and every referenced 2002 legacy derivative; no derivative generation or staging.",
    publishedIndex: {
      path: "data/2002/index.json",
      bytes: currentIndexBytes.length,
      sha256: sha256(currentIndexBytes),
      hypotheticalExisting479Sha256: sha256(hypotheticalIndexBytes),
      byteIdenticalForExisting479: currentIndexBytes.equals(hypotheticalIndexBytes),
      scannedExistingFiles
    },
    publishedAlbumManifests: selectedYearManifests.sort((left, right) => left.path.localeCompare(right.path)),
    legacyMedia: {
      selected2002: { keys: sortedSelectedKeys, count: sortedSelectedKeys.length, bytes: selectedYearLegacyBytes, thumbnailBytes, displayBytes },
      completePublishedArchive: {
        count: archiveLegacyKeys.length,
        totalReferencedKeyCount: sortedArchiveKeys.length,
        versionedReferencedKeyCount: sortedArchiveKeys.length - archiveLegacyKeys.length,
        keySetSha256: sha256(JSON.stringify(archiveLegacyKeys)),
        unaffectedBy2002Count: archiveLegacyKeys.length - sortedSelectedKeys.length
      }
    }
  };
}

export function build2002DecisionPacket(plan, promotionEvidence = null) {
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
  const measuredLegacy = promotionEvidence?.legacyMedia?.selected2002 || null;
  if (measuredLegacy && JSON.stringify(measuredLegacy.keys) !== JSON.stringify(currentLegacyKeys)) {
    throw new Error("Measured published 2002 media keys do not match the plan's legacy transitions");
  }
  const completeArchiveLegacy = promotionEvidence?.legacyMedia?.completePublishedArchive || null;
  const existing479UploadEstimate = uploadEstimate(measuredLegacy?.bytes ?? null, publishedPhotos.length, publishedPhotos.length);
  const all758UploadEstimate = uploadEstimate(measuredLegacy?.bytes ?? null, facts.importablePhotos, publishedPhotos.length);
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
    promotionEvidence,
    outcomes: {
      defer2002Entirely: {
        label: "Defer 2002 entirely",
        publicationApproved: false,
        photoCount: publishedPhotos.length,
        albumCount: existingAlbums.length,
        albumOrder: existingAlbums.map((album) => album.currentLabel),
        currentCodeCanExecute: true,
        executionStatus: "available-as-no-action",
        explanation: "This is the only outcome with no staged run, promotion package, upload, or manifest activation. It is deferral, not an exclusion-stage workflow.",
        manifestDifference: {
          changedPaths: [],
          addedPaths: [],
          removedPaths: []
        },
        mediaDifference: {
          newVersionedKeys: [],
          selected2002LegacyKeysStillReferenced: currentLegacyKeys,
          completePublishedArchiveLegacyKeyCount: completeArchiveLegacy?.count ?? null,
          deleteKeys: []
        },
        upload: { classification: "exact", bytes: 0, requests: 0 }
      },
      stageAndPromoteAll758: {
        label: "Stage and promote all 758 photos, including 2002 New",
        publicationApproved: false,
        photoCount: facts.importablePhotos,
        albumCount: albums.length,
        albumOrder: albums.map((album) => album.currentLabel),
        currentCodeCanExecute: false,
        executionStatus: "mechanically-supported-but-policy-blocked",
        blockedReasons: ["The fresh real source policy has unresolved decisions and is publication-ineligible."],
        futureCapability: "After exact policy resolution, the current default year selector, staging workflow, and promotion package support this full three-folder selection.",
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
          newVersionedKeys: candidateMediaKeys,
          keysFor279NewPhotos: new2002MediaKeys,
          replacementVersionedKeysFor479PublishedPhotos: publishedPhotoVersionedKeys,
          selected2002LegacyKeysRetainedForRollback: currentLegacyKeys,
          completePublishedArchiveLegacyKeyCount: completeArchiveLegacy?.count ?? null,
          unaffectedYearLegacyKeyCount: completeArchiveLegacy?.unaffectedBy2002Count ?? null,
          deleteKeys: []
        },
        upload: { ...all758UploadEstimate, requests: candidateMediaKeys.length },
        staleMediaKeys: stale.mediaKeys,
        staleAlbumManifests: stale.albumManifestPaths
      },
      stageAndPromoteExisting479Only: {
        label: "Stage and promote only the existing 479 photos",
        publicationApproved: false,
        photoCount: publishedPhotos.length,
        albumCount: existingAlbums.length,
        albumOrder: existingAlbums.map((album) => album.currentLabel),
        currentCodeCanExecute: false,
        executionStatus: "blocked-exact-source-selection-not-implemented",
        blockedReasons: [
          "The default 2002 selector includes all three 2002-prefixed folders.",
          "The explicit --source option accepts only one root, so it cannot express the two-folder complete 479-photo year.",
          "The fresh real source policy remains unresolved and publication-ineligible."
        ],
        existingUrlEffect: "The 479 photo IDs and direct-photo URL parameters remain stable, but both album manifests must change to reference 958 new content-versioned derivatives.",
        newUrlEffect: "No new photo IDs or album manifests, but 958 new immutable media keys are required.",
        manifestDifference: {
          selectedYearCandidatePaths: ["data/2002/index.json", ...currentManifestPaths],
          changedPaths: currentManifestPaths,
          addedPaths: [],
          removedPaths: [],
          unchangedPaths: promotionEvidence?.publishedIndex?.byteIdenticalForExisting479 ? ["data/2002/index.json"] : [],
          yearIndexVerification: promotionEvidence?.publishedIndex || null
        },
        mediaDifference: {
          newVersionedKeys: publishedPhotoVersionedKeys,
          selected2002LegacyKeysRetainedForRollback: currentLegacyKeys,
          completePublishedArchiveLegacyKeyCount: completeArchiveLegacy?.count ?? null,
          unaffectedYearLegacyKeyCount: completeArchiveLegacy?.unaffectedBy2002Count ?? null,
          deleteKeys: []
        },
        upload: { ...existing479UploadEstimate, requests: publishedPhotoVersionedKeys.length },
        staleMediaKeys: currentLegacyKeys,
        staleAlbumManifests: [],
        implementationConstraint: "This is a hypothetical staged-promotion outcome, not deferral. It requires a separately reviewed exact multi-root source-selection implementation; policy must not be used as an implicit filter."
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
  const defer = packet.outcomes.defer2002Entirely;
  const all = packet.outcomes.stageAndPromoteAll758;
  const existing = packet.outcomes.stageAndPromoteExisting479Only;
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
    "## Three distinct outcomes",
    "",
    "Excluding `2002 New` from a staged promotion is **not** the same as deferring 2002. A staged 479-photo promotion still replaces its manifest media references with content-versioned keys.",
    "",
    "| Outcome | Photos / albums | Changed manifests | Added manifests | New versioned keys | Retained 2002 legacy keys | Upload bytes | Executable now? |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
    `| Defer 2002 entirely | ${defer.photoCount} / ${defer.albumCount} | ${defer.manifestDifference.changedPaths.length} | ${defer.manifestDifference.addedPaths.length} | ${defer.mediaDifference.newVersionedKeys.length} | ${defer.mediaDifference.selected2002LegacyKeysStillReferenced.length} | ${formatUpload(defer.upload)} | Yes: take no action |`,
    `| Stage/promote all 758 | ${all.photoCount} / ${all.albumCount} | ${all.manifestDifference.changedPaths.length} | ${all.manifestDifference.addedPaths.length} | ${all.mediaDifference.newVersionedKeys.length} | ${all.mediaDifference.selected2002LegacyKeysRetainedForRollback.length} | ${formatUpload(all.upload)} | No: unresolved policy |`,
    `| Stage/promote existing 479 only | ${existing.photoCount} / ${existing.albumCount} | ${existing.manifestDifference.changedPaths.length} | ${existing.manifestDifference.addedPaths.length} | ${existing.mediaDifference.newVersionedKeys.length} | ${existing.mediaDifference.selected2002LegacyKeysRetainedForRollback.length} | ${formatUpload(existing.upload)} | No: exact multi-root selection is absent and policy is unresolved |`,
    "",
    "### 1. Defer 2002 entirely",
    "",
    `- Album order: ${defer.albumOrder.map((item) => `\`${item}\``).join(" → ")}.`,
    "- Changed manifests: none. Added manifests: none.",
    `- No stage, package, upload, or activation occurs. The current 958 2002 legacy keys remain referenced, as do all ${defer.mediaDifference.completePublishedArchiveLegacyKeyCount ?? "currently published"} archive legacy keys.`,
    "",
    "### 2. Stage and promote all 758 photos",
    "",
    `- Album order: ${all.albumOrder.map((item) => `\`${item}\``).join(" → ")}.`,
    `- Changed manifests: ${all.manifestDifference.changedPaths.map((item) => `\`${item}\``).join(", ")}.`,
    `- Added manifests: ${all.manifestDifference.addedPaths.map((item) => `\`${item}\``).join(", ")}.`,
    `- Media: ${all.mediaDifference.newVersionedKeys.length} new keys (${all.mediaDifference.keysFor279NewPhotos.length} for 2002 New; ${all.mediaDifference.replacementVersionedKeysFor479PublishedPhotos.length} for published photos).`,
    `- Rollback: all ${all.mediaDifference.selected2002LegacyKeysRetainedForRollback.length} selected-year legacy keys remain; the promotion inventory retains ${all.mediaDifference.completePublishedArchiveLegacyKeyCount ?? "an unmeasured number of"} legacy keys across the published archive.`,
    `- Current status: ${all.executionStatus}. ${all.blockedReasons.join(" ")}`,
    "",
    "### 3. Stage and promote only the existing 479 photos",
    "",
    `- Album order: ${existing.albumOrder.map((item) => `\`${item}\``).join(" → ")}.`,
    `- Changed manifests: ${existing.manifestDifference.changedPaths.map((item) => `\`${item}\``).join(", ")}.`,
    "- Added manifests: none.",
    `- Unchanged year index: ${existing.manifestDifference.yearIndexVerification?.byteIdenticalForExisting479 ? "verified byte-for-byte" : "not verified"}.`,
    `- Media: ${existing.mediaDifference.newVersionedKeys.length} new content-versioned keys; all ${existing.mediaDifference.selected2002LegacyKeysRetainedForRollback.length} current 2002 legacy keys remain for rollback, and the promotion inventory retains ${existing.mediaDifference.completePublishedArchiveLegacyKeyCount ?? "all"} legacy keys across the archive.`,
    `- Current status: ${existing.executionStatus}. ${existing.blockedReasons.join(" ")}`,
    `- Constraint: ${existing.implementationConstraint}`,
    "",
    `Upload estimate basis: ${packet.promotionEvidence?.method || "No measurement supplied."}`,
    `Estimate limitation: ${all.upload.limitation}`,
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
  const promotionEvidence = await measure2002PromotionEvidence(plan);
  const packet = build2002DecisionPacket(plan, promotionEvidence);
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
