import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { generateAllYearReviewPacket, verifyAllYearReviewPacket } from "./all-year-review-packet.mjs";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("all-year review packet remains wholly unresolved, enumerated, previewed, and sealed", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-review-packet-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stageRoot = path.join(root, "stage");
  const dataRoot = path.join(stageRoot, "public", "data", "2091");
  const photoId = "2091-aaaaaaaaaaaaaa";
  const albumId = "2091-album-12345678";
  const thumbnailKey = `2091/thumbs/${photoId}-cv1-${"a".repeat(64)}.jpg`;
  const displayKey = `2091/display/${photoId}-cv1-${"b".repeat(64)}.jpg`;
  await writeJson(path.join(dataRoot, "albums", `${albumId}.json`), {
    photos: [{ id: photoId, albumId, thumbnailKey, displayKey, sortPosition: 0, albumSortPosition: 0 }]
  });
  await writeJson(path.join(dataRoot, "index.json"), {
    year: "2091",
    scannedCount: 1,
    albums: [{ id: albumId, name: "Mechanical album", count: 1, manifestUrl: `data/2091/albums/${albumId}.json` }],
    sequence: [{ id: photoId }]
  });
  const thumbPath = path.join(stageRoot, "generated", "library", thumbnailKey);
  await fs.mkdir(path.dirname(thumbPath), { recursive: true });
  await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 20, g: 40, b: 60 } } }).jpeg().toFile(thumbPath);

  const canonicalData = path.join(root, "canonical");
  const oldId = "2089-bbbbbbbbbbbbbb";
  const oldAlbum = "2089-album-12345678";
  await writeJson(path.join(canonicalData, "catalog.json"), { years: [{ year: "2089", indexUrl: "data/2089/index.json" }] });
  await writeJson(path.join(canonicalData, "2089", "index.json"), {
    year: "2089",
    scannedCount: 1,
    albums: [{ id: oldAlbum, name: "Old", count: 1, manifestUrl: `data/2089/albums/${oldAlbum}.json` }],
    sequence: [{ id: oldId }]
  });
  await writeJson(path.join(canonicalData, "2089", "albums", `${oldAlbum}.json`), {
    photos: [{ id: oldId, albumId: oldAlbum, thumbnailKey: `2089/thumbs/${oldId}.jpg`, displayKey: `2089/display/${oldId}.jpg`, sortPosition: 0, albumSortPosition: 0 }]
  });

  const decision = {
    id: "album-label:test",
    category: "album-label",
    key: "2091",
    status: "unresolved",
    action: null,
    subject: { year: "2091", proposedPublicLabel: "Mechanical album" },
    files: [{ path: "2091/a.jpg", bytes: 1, sha256: "c".repeat(64) }]
  };
  const policyPath = path.join(root, "policy.json");
  await writeJson(policyPath, {
    inventory: { sourceRoot: path.join(root, "master"), inventorySha256: "d".repeat(64) },
    eligibility: { publicationEligible: false, counts: { resolved: 0 } },
    policyTemplate: { decisions: [decision] }
  });
  const stageInventoryPath = path.join(root, "stages.json");
  await writeJson(stageInventoryPath, {
    selectedYears: ["2091"],
    absentCalendarYears: ["2090"],
    allSelectedSourceYearsHaveCompletedStage: true,
    counts: { completeVerifiedResumePass: 1, photos: 1, albums: 1 },
    years: [{
      year: "2091",
      stageRoot,
      sourceRoots: [path.join(root, "master", "2091")],
      plan: { omissions: { noise: [], unsupported: [], unreadable: [], symlinks: [] } },
      stage: { photos: 1 }
    }]
  });
  const outputRoot = path.join(root, "packet");
  const generated = await generateAllYearReviewPacket({ policyReportPath: policyPath, stageInventoryPath, canonicalDataRoot: canonicalData, outputRoot });
  assert.equal(generated.counts.policyDecisions, 1);
  assert.equal(generated.counts.publishedIdTransitions, 1);
  assert.equal(generated.counts.exactSamePublishedIdsInCandidate, 0);
  assert.equal(generated.previewCount, 1);
  const verified = await verifyAllYearReviewPacket(outputRoot);
  assert.equal(verified.policyDecisionCount, 1);
  assert.equal(verified.transitionCount, 1);
  await fs.appendFile(path.join(outputRoot, "README.md"), "tampered\n");
  await assert.rejects(verifyAllYearReviewPacket(outputRoot), /closed-world seal/);
});
