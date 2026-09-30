import assert from "node:assert/strict";
import test from "node:test";
import { build2002DecisionPacket, render2002DecisionPacket } from "./decision-packet-2002.mjs";

test("2002 decision packet separates observations, suggestions, and unresolved choices", () => {
  const albumDefinitions = [
    ["2002 New/o8o2-7104-7239", 136],
    ["2002 New/o815-7282-7361", 78],
    ["2002 New/XXXXmomHolidays-5855-6036", 65],
    ["2002-Thialand", 371],
    ["2002-WHEN-CANADA", 108]
  ];
  const photos = albumDefinitions.flatMap(([album, count]) =>
    Array.from({ length: count }, (_, index) => ({
      relativePath: `${album}/photo-${index}.jpg`,
      proposedPhotoId: `2002-${album}-${index}`,
      album: { name: album },
      sourceSha256: `${index}`.padStart(64, "0")
    }))
  );
  const inventoryFiles = [
    ...photos.map((photo) => ({ path: photo.relativePath, bytes: 10, sha256: photo.sourceSha256 })),
    { path: "2002 New/FINDER.DAT", bytes: 1, sha256: "a".repeat(64) },
    { path: "2002-WHEN-CANADA/IMG_1267.WAV", bytes: 2, sha256: "b".repeat(64) },
    ...Array.from({ length: 5 }, (_, index) => ({ path: `2002 New/noise-${index}`, bytes: index, sha256: "c".repeat(64) }))
  ];
  const plan = {
    mode: "plan",
    zeroWrite: true,
    configuration: { year: "2002" },
    observedFacts: {
      importablePhotos: 758,
      photos,
      proposedAlbums: albumDefinitions.map(([name, count], index) => ({ name, count, manifestUrl: `data/2002/albums/${index}.json` })),
      unsupportedFiles: [
        { relativePath: "2002 New/FINDER.DAT", reason: "Unsupported file extension" },
        { relativePath: "2002-WHEN-CANADA/IMG_1267.WAV", reason: "Unsupported file extension" }
      ],
      skippedNoiseFiles: Array.from({ length: 5 }, (_, index) => ({ relativePath: `2002 New/noise-${index}`, bytes: index })),
      offYearDates: Array.from({ length: 31 }, (_, index) => ({ relativePath: `off-year-${index}.jpg`, exifYear: 2001, exifTime: "2001-01-01T00:00:00.000Z", field: "DateTimeOriginal" })),
      outputsThatWouldBecomeStale: { mediaKeys: [], albumManifestPaths: [] }
    },
    sourcePolicy: {
      inventory: { inventorySha256: "d".repeat(64), files: inventoryFiles },
      eligibility: { publicationEligible: false, counts: { unresolved: 12 } },
      policyTemplate: { decisions: [], decisionGroups: [] },
      findings: {
        sourceMoves: Array.from({ length: 479 }, (_, index) => ({ photoId: `2002-published-${index}`, currentPath: `published-${index}.jpg`, bytes: 10, sha256: "e".repeat(64) })),
        missingPublishedPhotoIds: []
      }
    }
  };

  const packet = build2002DecisionPacket(plan);
  assert.equal(packet.publishedArchive.photoCount, 479);
  assert.equal(packet.publishedArchive.everyExistingIdStable, true);
  assert.equal(packet.proposed2002New.photoCount, 279);
  assert.equal(packet.proposed2002New.albumCount, 3);
  assert(packet.proposed2002New.albums.every((album) => album.suggestionStatus === "suggestion-only-unapproved"));
  assert.equal(packet.offYearExifDates.length, 31);
  assert.equal(packet.unsupportedFiles.length, 2);
  assert.equal(packet.ignoredNoiseFiles.length, 5);
  assert.equal(packet.policyEligibility.reviewUnits, 0);
  assert.equal(packet.scenarios.include2002New.photoCount, 758);
  assert.equal(packet.scenarios.exclude2002New.photoCount, 479);
  assert.match(render2002DecisionPacket(packet), /suggestion only; unapproved/);
  assert.match(render2002DecisionPacket(packet), /off-year-30\.jpg/);
});
