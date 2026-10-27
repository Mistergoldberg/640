import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildAggregatePackage, inspectAggregateInputs, validateAggregateCandidateFiles, verifyAggregatePackage } from "./aggregate-staged-release.mjs";
import { runImporter } from "./import-photos.mjs";
import { createSourcePolicyTemplate, inspectSourcePolicy } from "./source-policy.mjs";

const YEARS = ["2091", "2092"];
const EXTRA_YEAR = "2093";

function photoId(year, relativePath) {
  return `${year}-${crypto.createHash("sha1").update(relativePath.split(path.sep).join("/")).digest("hex").slice(0, 14)}`;
}

async function jpeg(filePath, color) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp({ create: { width: 48, height: 32, channels: 3, background: color } }).jpeg().toFile(filePath);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolvePolicy(template) {
  const policy = structuredClone(template);
  for (const decision of policy.decisions) {
    decision.status = "resolved";
    if (decision.category === "folder-year") {
      decision.action = "map-to-year";
      decision.year = decision.subject.importerYear;
    } else if (decision.category === "album-label") {
      decision.action = "publish-label";
      decision.publicLabel = decision.subject.proposedPublicLabel;
    } else if (decision.category === "unsupported-file" || decision.category === "unreadable-file") decision.action = "exclude-exact";
    else if (decision.category === "duplicate-content") decision.action = "keep-separate";
    else if (decision.category === "off-year-date") decision.action = "use-folder-year";
    else if (decision.category === "source-move") decision.action = "preserve-source-path";
  }
  return policy;
}

async function writeCanonicalYear({ dataRoot, mediaRoot, year, photoId: id, color }) {
  const albumId = `${year}-published-album-12345678`;
  const thumbnailKey = `${year}/thumbs/${id}.jpg`;
  const displayKey = `${year}/display/${id}.jpg`;
  await writeJson(path.join(dataRoot, year, "albums", `${albumId}.json`), {
    photos: [{ id, thumbnailKey, displayKey, albumId, sortPosition: 0, albumSortPosition: 0 }]
  });
  await writeJson(path.join(dataRoot, year, "index.json"), {
    year,
    scannedCount: 1,
    albums: [{ id: albumId, name: `Published ${year}`, count: 1, manifestUrl: `data/${year}/albums/${albumId}.json` }],
    sequence: [{ id }]
  });
  await jpeg(path.join(mediaRoot, thumbnailKey), color);
  await jpeg(path.join(mediaRoot, displayKey), { r: color.r + 5, g: color.g + 5, b: color.b + 5 });
  return { id, thumbnailKey, displayKey };
}

async function stageYear({ appRoot, sourceRoot, year, importerCommit = "aggregate-fixture-importer", stageName = `stage-${year}`, limit = null }) {
  const sourceFolder = path.join(sourceRoot, `${year} Source`);
  const inspection = await inspectSourcePolicy({
    sourceRoot,
    scanRoots: [sourceFolder],
    selectedYear: year,
    publicDataRoot: path.join(appRoot, "public"),
    concurrency: 2
  });
  const policyPath = path.join(appRoot, `policy-${stageName}.json`);
  await writeJson(policyPath, resolvePolicy(createSourcePolicyTemplate(inspection)));
  const stagingRoot = path.join(appRoot, stageName);
  const args = ["--year", year, "--source-root", sourceRoot, "--staging-root", stagingRoot, "--source-policy", policyPath];
  if (limit !== null) args.push("--limit", String(limit));
  const result = await runImporter(args, {
    appRoot,
    requiredSourceRoot: sourceRoot,
    importerCommit,
    sharpVersion: "aggregate-fixture-sharp",
    writeStdout: () => {}
  });
  return { stagingRoot, policyPath, result };
}

async function createFixture() {
  const appRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-aggregate-")));
  const sourceRoot = path.join(appRoot, "master", "original-photos");
  const canonicalDataRoot = path.join(appRoot, "public", "data");
  const canonicalMediaRoot = path.join(appRoot, "generated", "library");
  const sourceFiles = new Map();
  for (const [year, colors] of [
    [YEARS[0], [{ r: 20, g: 40, b: 60 }, { r: 80, g: 100, b: 120 }]],
    [YEARS[1], [{ r: 140, g: 60, b: 20 }]],
    [EXTRA_YEAR, [{ r: 10, g: 160, b: 90 }]]
  ]) {
    for (let index = 0; index < colors.length; index += 1) {
      const relative = `${year} Source/Album ${year}/${index + 1}.jpg`;
      const absolute = path.join(sourceRoot, relative);
      await jpeg(absolute, colors[index]);
      sourceFiles.set(`${year}:${index}`, absolute);
    }
  }
  const previous = [
    await writeCanonicalYear({ dataRoot: canonicalDataRoot, mediaRoot: canonicalMediaRoot, year: "2089", photoId: "2089-aaaaaaaaaaaaaa", color: { r: 2, g: 4, b: 6 } }),
    await writeCanonicalYear({ dataRoot: canonicalDataRoot, mediaRoot: canonicalMediaRoot, year: "2090", photoId: "2090-bbbbbbbbbbbbbb", color: { r: 8, g: 10, b: 12 } })
  ];
  await writeJson(path.join(canonicalDataRoot, "catalog.json"), {
    years: ["2090", "2089"].map((year) => ({ year, indexUrl: `data/${year}/index.json` }))
  });
  await fs.mkdir(path.join(appRoot, "generated", "reports"), { recursive: true });
  const stages = new Map();
  for (const year of [...YEARS, EXTRA_YEAR]) stages.set(year, await stageYear({ appRoot, sourceRoot, year }));
  const aliasStage = stages.get(YEARS[0]);
  const aliasPhoto = aliasStage.result.receipt.manifestReferences[0].photos[0];
  const aliasDisplay = aliasStage.result.receipt.media.find((entry) => entry.key === aliasPhoto.displayKey);
  await fs.copyFile(path.join(aliasStage.stagingRoot, "generated", "library", aliasDisplay.key), path.join(canonicalMediaRoot, previous[0].displayKey));
  const aliasBytes = await fs.readFile(path.join(canonicalMediaRoot, previous[0].displayKey));
  const aliasSha256 = crypto.createHash("sha256").update(aliasBytes).digest("hex");
  const inputs = await inspectAggregateInputs({
    stagingRoots: YEARS.map((year) => stages.get(year).stagingRoot),
    canonicalDataRoot,
    canonicalMediaRoot,
    concurrency: 2
  });
  const contract = {
    schemaVersion: 1,
    status: "approved",
    approvalId: "synthetic-fixture-approval",
    intendedYears: YEARS,
    physicalSourceRoot: inputs.facts.physicalSourceRoot,
    importerIdentity: inputs.facts.importerIdentity,
    stages: inputs.facts.stages,
    expectedPublishedPhotoCount: inputs.facts.previousRelease.publishedPhotoCount,
    previousRelease: { releaseId: "fixture-release-v1", ...inputs.facts.previousRelease }
  };
  const transitions = {
    schemaVersion: 1,
    previousReleaseId: contract.previousRelease.releaseId,
    transitions: [
      {
        oldPhotoId: previous[0].id,
        status: "approved",
        outcome: "alias",
        newPhotoId: aliasPhoto.id,
        evidence: {
          kind: "display-media-sha256-equality",
          oldMediaKey: previous[0].displayKey,
          newMediaKey: aliasPhoto.displayKey,
          oldSha256: aliasSha256,
          newSha256: aliasSha256
        }
      },
      {
        oldPhotoId: previous[1].id,
        status: "approved",
        outcome: "retired-no-successor",
        decisionId: "fixture-retirement-2",
        reason: "Synthetic fixture explicitly retires this ID"
      }
    ]
  };
  const contractPath = path.join(appRoot, "aggregate-contract.json");
  const transitionsPath = path.join(appRoot, "id-transitions.json");
  await writeJson(contractPath, contract);
  await writeJson(transitionsPath, transitions);
  return { appRoot, sourceRoot, canonicalDataRoot, canonicalMediaRoot, sourceFiles, stages, inputs, contract, contractPath, transitions, transitionsPath, previous };
}

function options(fixture, overrides = {}) {
  return {
    stagingRoots: YEARS.map((year) => fixture.stages.get(year).stagingRoot),
    packageRoot: path.join(fixture.appRoot, `package-${crypto.randomBytes(4).toString("hex")}`),
    contractPath: fixture.contractPath,
    transitionsPath: fixture.transitionsPath,
    canonicalDataRoot: fixture.canonicalDataRoot,
    canonicalMediaRoot: fixture.canonicalMediaRoot,
    concurrency: 2,
    ...overrides
  };
}

async function fixtureFor(t) {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.appRoot, { recursive: true, force: true }));
  return fixture;
}

test("aggregate package is atomic, candidate-only, closed-world, rollback-complete, and zero-delete", async (t) => {
  const fixture = await fixtureFor(t);
  const result = await buildAggregatePackage(options(fixture, { packageRoot: path.join(fixture.appRoot, "package") }));
  assert.deepEqual(result.binding.intendedYears, YEARS);
  assert.equal(result.binding.candidatePhotoCount, 3);
  assert.equal(result.binding.candidateAlbumCount, 2);
  assert.equal(result.transitionSummary.previousPhotoCount, 2);
  assert.equal(result.transitionSummary.retired, 1);
  assert.equal(result.transitionSummary.aliases, 1);
  assert.equal(result.binding.proposedDeleteCount, 0);
  assert.equal(result.candidateMedia.proposedDeletes.length, 0);
  assert.equal(result.rollback.proposedDeletes.length, 0);
  await fs.access(path.join(result.packageRoot, "rollback", "public", "data", "2089", "index.json"));
  await assert.rejects(fs.access(path.join(result.packageRoot, "candidate", "public", "data", "2089")), /ENOENT/);
  const verified = await verifyAggregatePackage(result.packageRoot);
  assert.equal(verified.receipt.packageId, result.packageId);
  assert.deepEqual(verified.contract.intendedYears, YEARS);
});

test("missing, duplicate, extra, and limited stages fail exact intended-year coverage", async (t) => {
  const fixture = await fixtureFor(t);
  await assert.rejects(buildAggregatePackage(options(fixture, { stagingRoots: [fixture.stages.get(YEARS[0]).stagingRoot] })), /Stage years versus intended-year contract/);
  await assert.rejects(buildAggregatePackage(options(fixture, { stagingRoots: [fixture.stages.get(YEARS[0]).stagingRoot, fixture.stages.get(YEARS[0]).stagingRoot] })), /Duplicate stage root/);
  await assert.rejects(buildAggregatePackage(options(fixture, { stagingRoots: [...YEARS.map((year) => fixture.stages.get(year).stagingRoot), fixture.stages.get(EXTRA_YEAR).stagingRoot] })), /Stage years versus intended-year contract/);
  const sampled = await stageYear({ appRoot: fixture.appRoot, sourceRoot: fixture.sourceRoot, year: YEARS[0], stageName: "sampled", limit: 1 });
  await assert.rejects(buildAggregatePackage(options(fixture, { stagingRoots: [sampled.stagingRoot, fixture.stages.get(YEARS[1]).stagingRoot] })), /sampled or limited staged run/);
});

test("altered seals and stale source inventories fail before package assembly", async (t) => {
  const fixture = await fixtureFor(t);
  const completePath = path.join(fixture.stages.get(YEARS[0]).stagingRoot, "generated", "journal", "complete.json");
  const completion = JSON.parse(await fs.readFile(completePath, "utf8"));
  completion.closedWorldSha256 = "0".repeat(64);
  await writeJson(completePath, completion);
  await assert.rejects(buildAggregatePackage(options(fixture)), /closed-world seal/);

  const stale = await fixtureFor(t);
  await jpeg(stale.sourceFiles.get(`${YEARS[1]}:0`), { r: 255, g: 1, b: 1 });
  await assert.rejects(buildAggregatePackage(options(stale)), /source inventory is stale/);
});

test("mixed physical sources and importer identities fail closed", async (t) => {
  const fixture = await fixtureFor(t);
  const alternateRoot = path.join(fixture.appRoot, "alternate-master", "original-photos");
  const relative = `${YEARS[1]} Source/Album ${YEARS[1]}/1.jpg`;
  await jpeg(path.join(alternateRoot, relative), { r: 140, g: 60, b: 20 });
  const alternateSource = await stageYear({ appRoot: fixture.appRoot, sourceRoot: alternateRoot, year: YEARS[1], stageName: "alternate-source" });
  await assert.rejects(buildAggregatePackage(options(fixture, { stagingRoots: [fixture.stages.get(YEARS[0]).stagingRoot, alternateSource.stagingRoot] })), /Mixed physical source roots/);
  const alternateImporter = await stageYear({ appRoot: fixture.appRoot, sourceRoot: fixture.sourceRoot, year: YEARS[1], importerCommit: "different-importer", stageName: "alternate-importer" });
  await assert.rejects(buildAggregatePackage(options(fixture, { stagingRoots: [fixture.stages.get(YEARS[0]).stagingRoot, alternateImporter.stagingRoot] })), /Mixed importer or derivative-recipe identities/);
});

test("candidate validation rejects old-catalogue leakage and duplicate global IDs", async (t) => {
  const fixture = await fixtureFor(t);
  const result = await buildAggregatePackage(options(fixture));
  const root = path.join(result.packageRoot, "candidate", "public", "data");
  const files = new Map();
  async function load(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await load(absolute);
      else files.set(path.relative(root, absolute).split(path.sep).join("/"), await fs.readFile(absolute));
    }
  }
  await load(root);
  const leaked = new Map(files);
  leaked.set("2089/index.json", await fs.readFile(path.join(fixture.canonicalDataRoot, "2089", "index.json")));
  for (const name of await fs.readdir(path.join(fixture.canonicalDataRoot, "2089", "albums"))) leaked.set(`2089/albums/${name}`, await fs.readFile(path.join(fixture.canonicalDataRoot, "2089", "albums", name)));
  const leakedCatalog = JSON.parse(leaked.get("catalog.json").toString("utf8"));
  leakedCatalog.years.push({ year: "2089", indexUrl: "data/2089/index.json" });
  leaked.set("catalog.json", Buffer.from(`${JSON.stringify(leakedCatalog)}\n`));
  assert.throws(() => validateAggregateCandidateFiles(leaked, YEARS), /Candidate catalogue years/);

  const duplicate = new Map(files);
  const firstYearIndex = JSON.parse(duplicate.get(`${YEARS[0]}/index.json`).toString("utf8"));
  const secondYearIndex = JSON.parse(duplicate.get(`${YEARS[1]}/index.json`).toString("utf8"));
  const firstId = firstYearIndex.sequence[0].id;
  const secondManifestPath = secondYearIndex.albums[0].manifestUrl.slice("data/".length);
  const secondManifest = JSON.parse(duplicate.get(secondManifestPath).toString("utf8"));
  secondManifest.photos[0].id = firstId;
  secondYearIndex.sequence[0].id = firstId;
  duplicate.set(secondManifestPath, Buffer.from(`${JSON.stringify(secondManifest)}\n`));
  duplicate.set(`${YEARS[1]}/index.json`, Buffer.from(`${JSON.stringify(secondYearIndex)}\n`));
  assert.throws(() => validateAggregateCandidateFiles(duplicate, YEARS), /Duplicate photo ID across candidate years/);
});

test("missing candidate media and rollback omissions fail closed", async (t) => {
  const fixture = await fixtureFor(t);
  const stagedMedia = fixture.stages.get(YEARS[0]).result.receipt.media[0].key;
  await fs.unlink(path.join(fixture.stages.get(YEARS[0]).stagingRoot, "generated", "library", stagedMedia));
  await assert.rejects(buildAggregatePackage(options(fixture)), /closed-world seal|checksum mismatch|ENOENT/);

  const rollbackFixture = await fixtureFor(t);
  await fs.unlink(path.join(rollbackFixture.canonicalMediaRoot, rollbackFixture.previous[0].thumbnailKey));
  await assert.rejects(buildAggregatePackage(options(rollbackFixture)), /Rollback release inventory|Rollback release references missing media/);
});

test("incomplete transitions and conflicting aliases fail independently of ID overlap", async (t) => {
  const fixture = await fixtureFor(t);
  const incompletePath = path.join(fixture.appRoot, "incomplete-transitions.json");
  await writeJson(incompletePath, { ...fixture.transitions, transitions: fixture.transitions.transitions.slice(0, 1) });
  await assert.rejects(buildAggregatePackage(options(fixture, { transitionsPath: incompletePath })), /Published-ID transition coverage|incomplete/);

  const conflictingPath = path.join(fixture.appRoot, "conflicting-transitions.json");
  const oldPhotoId = fixture.transitions.transitions[0].oldPhotoId;
  const newPhotoId = photoId(YEARS[0], `${YEARS[0]} Source/Album ${YEARS[0]}/1.jpg`);
  await writeJson(conflictingPath, {
    ...fixture.transitions,
    transitions: [
      ...fixture.transitions.transitions,
      { oldPhotoId, status: "approved", outcome: "alias", newPhotoId, evidence: { kind: "stable-photo-id" } }
    ]
  });
  await assert.rejects(buildAggregatePackage(options(fixture, { transitionsPath: conflictingPath })), /Conflicting or duplicate ID transitions/);
});

test("tampering any completed aggregate package invalidates the closed-world seal", async (t) => {
  const fixture = await fixtureFor(t);
  const result = await buildAggregatePackage(options(fixture));
  await fs.writeFile(path.join(result.packageRoot, "plans", "deletes.json"), `${JSON.stringify({ schemaVersion: 1, deletes: ["legacy"] })}\n`);
  await assert.rejects(verifyAggregatePackage(result.packageRoot), /closed-world seal|proposes deletes/);
});
