import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { runImporter } from "./import-photos.mjs";
import { createSourcePolicyTemplate, evaluateSourcePolicy, inspectSourcePolicy, renderDecisionReport } from "./source-policy.mjs";

async function jpeg(filePath, background) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp({ create: { width: 24, height: 16, channels: 3, background } }).jpeg().toFile(filePath);
}

async function fixture() {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-policy-test-"));
  const sourceRoot = path.join(appRoot, "original-photos");
  const first = path.join(sourceRoot, "2002 New", "Album One", "a.jpg");
  const duplicate = path.join(sourceRoot, "2002 New", "Album One", "a-copy.jpg");
  await jpeg(first, { r: 10, g: 20, b: 30 });
  await fs.copyFile(first, duplicate);
  await jpeg(path.join(sourceRoot, "2004-2006", "ambiguous.jpg"), { r: 40, g: 50, b: 60 });
  await fs.mkdir(path.join(sourceRoot, "2010-4"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "2010-4", "corrupt.JPG"), "not a jpeg\n");
  await fs.mkdir(path.join(sourceRoot, "2012"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "2012", "zero-one.JPG"), Buffer.alloc(0));
  await fs.writeFile(path.join(sourceRoot, "2012", "zero-two.jpg"), Buffer.alloc(0));
  const thm = path.join(sourceRoot, "2011", "Camera", "sample.THM");
  await jpeg(thm, { r: 90, g: 80, b: 70 });
  await fs.writeFile(path.join(sourceRoot, "2002 New", "notes.txt"), "curatorial note\n");
  const publicRoot = path.join(appRoot, "public");
  await fs.mkdir(path.join(publicRoot, "data"), { recursive: true });
  await fs.writeFile(path.join(publicRoot, "data", "catalog.json"), '{"years":[]}\n');
  return { appRoot, sourceRoot, publicRoot, first, duplicate };
}

function resolvePolicy(template) {
  const policy = structuredClone(template);
  for (const decision of policy.decisions) {
    decision.status = "resolved";
    if (decision.category === "folder-year") {
      decision.action = "map-to-year";
      decision.year = decision.subject.proposedYear || "2004";
    } else if (decision.category === "album-label") {
      decision.action = "publish-label";
      decision.publicLabel = decision.subject.proposedPublicLabel;
    } else if (decision.category === "unsupported-file") {
      decision.action = "exclude-exact";
    } else if (decision.category === "unreadable-file") {
      decision.action = "exclude-exact";
    } else if (decision.category === "duplicate-content") {
      decision.action = "keep-separate";
    } else if (decision.category === "off-year-date") {
      decision.action = "use-folder-year";
    } else if (decision.category === "source-move") {
      decision.action = "preserve-source-path";
    }
  }
  return policy;
}

async function inspect(f) {
  return inspectSourcePolicy({ sourceRoot: f.sourceRoot, publicDataRoot: f.publicRoot, concurrency: 2 });
}

test("fresh inspection reports special cases and defaults every decision to unresolved", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.appRoot, { recursive: true, force: true }));
  const inspection = await inspect(f);
  const policy = createSourcePolicyTemplate(inspection);
  const eligibility = evaluateSourcePolicy(inspection, policy);

  assert.equal(inspection.findings.new2002.present, true);
  assert.equal(inspection.findings.new2002.importablePhotos, 2);
  assert.deepEqual(inspection.findings.new2002.proposedAlbums, ["2002 New/Album One"]);
  assert(inspection.findings.ambiguousYearFolders.some((folder) => folder.folder === "2004-2006"));
  assert.equal(inspection.findings.duplicateContentGroups.length, 1);
  assert.equal(inspection.findings.decodableThmFiles.length, 1);
  assert.equal(inspection.findings.corrupt2010Jpegs.length, 1);
  assert.equal(inspection.findings.unsupported2012Jpegs.length, 2);
  assert(policy.decisions.every((decision) => decision.status === "unresolved" && decision.action === null));
  assert.equal(eligibility.publicationEligible, false);
  assert.equal(eligibility.inventoryMatches, true);
  assert.equal(eligibility.counts.resolved, 0);
  const report = renderDecisionReport(inspection, eligibility);
  assert.match(report, /Publication eligible: \*\*NO\*\*/);
  assert.match(report, /2002 New\/Album One\/a\.jpg/);
  assert.match(report, /2004-2006\/ambiguous\.jpg/);
});

test("an exact fully resolved policy is eligible while partial and broad policies fail closed", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.appRoot, { recursive: true, force: true }));
  const inspection = await inspect(f);
  const resolved = resolvePolicy(createSourcePolicyTemplate(inspection));
  const eligible = evaluateSourcePolicy(inspection, resolved);
  assert.equal(eligible.publicationEligible, true);
  assert.equal(eligible.counts.unresolved, 0);

  const partial = structuredClone(resolved);
  partial.inventory.files.pop();
  assert.equal(evaluateSourcePolicy(inspection, partial).publicationEligible, false);
  assert.equal(evaluateSourcePolicy(inspection, partial).inventoryChanges.added.length, 1);

  const broad = structuredClone(resolved);
  broad.decisions[0].pattern = "**/*.jpg";
  const broadResult = evaluateSourcePolicy(inspection, broad);
  assert.equal(broadResult.publicationEligible, false);
  assert.match(broadResult.schemaErrors.join(" "), /Broad pattern/);

  const alteredIdentity = structuredClone(resolved);
  alteredIdentity.decisions[0].subject = { ...alteredIdentity.decisions[0].subject, proposedPublicLabel: "silently changed" };
  const alteredResult = evaluateSourcePolicy(inspection, alteredIdentity);
  assert.equal(alteredResult.publicationEligible, false);
  assert(alteredResult.decisionResults.some((decision) => decision.reason === "decision-scope-or-identity-changed"));

  const unappliedRepair = structuredClone(resolved);
  const unreadable = unappliedRepair.decisions.find((decision) => decision.category === "unreadable-file");
  unreadable.action = "repair-exact";
  const repairResult = evaluateSourcePolicy(inspection, unappliedRepair);
  assert.equal(repairResult.publicationEligible, false);
  assert(repairResult.decisionResults.some((decision) => decision.id === unreadable.id && decision.reason === "action-not-implemented-by-current-importer"));
});

test("selected publication year detects a source rename that would change a published photo ID", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.appRoot, { recursive: true, force: true }));
  const relativePath = "2002 New/Album One/a.jpg";
  const publishedId = `2002-${crypto.createHash("sha1").update(relativePath).digest("hex").slice(0, 14)}`;
  await fs.mkdir(path.join(f.publicRoot, "data", "2002"), { recursive: true });
  await fs.writeFile(path.join(f.publicRoot, "data", "catalog.json"), JSON.stringify({ years: [{ indexUrl: "data/2002/index.json" }] }));
  await fs.writeFile(path.join(f.publicRoot, "data", "2002", "index.json"), JSON.stringify({ albums: [{ manifestUrl: "data/2002/album.json" }] }));
  await fs.writeFile(path.join(f.publicRoot, "data", "2002", "album.json"), JSON.stringify({ photos: [{ id: publishedId }] }));

  const before = await inspectSourcePolicy({ sourceRoot: f.sourceRoot, selectedYear: "2002", publicDataRoot: f.publicRoot, concurrency: 2 });
  assert.equal(before.findings.sourceMoves.length, 1);
  assert.deepEqual(before.findings.missingPublishedPhotoIds, []);

  await fs.rename(f.first, path.join(path.dirname(f.first), "renamed.jpg"));
  const after = await inspectSourcePolicy({ sourceRoot: f.sourceRoot, selectedYear: "2002", publicDataRoot: f.publicRoot, concurrency: 2 });
  assert.equal(after.findings.sourceMoves.length, 0);
  assert.deepEqual(after.findings.missingPublishedPhotoIds, [publishedId]);
  assert.equal(evaluateSourcePolicy(after, resolvePolicy(createSourcePolicyTemplate(after))).publicationEligible, false);
});

test("changed bytes at one path invalidate an old otherwise matching inventory and affected decisions", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.appRoot, { recursive: true, force: true }));
  const oldInspection = await inspect(f);
  const oldPolicy = resolvePolicy(createSourcePolicyTemplate(oldInspection));
  await jpeg(f.first, { r: 200, g: 1, b: 2 });
  const freshInspection = await inspect(f);
  const result = evaluateSourcePolicy(freshInspection, oldPolicy);

  assert.equal(result.publicationEligible, false);
  assert.equal(result.inventoryMatches, false);
  assert.deepEqual(result.inventoryChanges.changed.map((change) => change.path), ["2002 New/Album One/a.jpg"]);
  assert(result.decisionResults.some((decision) => decision.reason === "decision-scope-or-identity-changed" && decision.affectedPaths.includes("2002 New/Album One/a.jpg")));
});

test("added, removed, newly corrupt, and duplicate source changes invalidate recorded decisions", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.appRoot, { recursive: true, force: true }));
  const oldInspection = await inspect(f);
  const oldPolicy = resolvePolicy(createSourcePolicyTemplate(oldInspection));
  await jpeg(path.join(f.sourceRoot, "2002 New", "Album One", "added.jpg"), { r: 4, g: 5, b: 6 });
  await fs.unlink(f.duplicate);
  await fs.writeFile(path.join(f.sourceRoot, "2002 New", "Album One", "new-corrupt.jpg"), "broken\n");
  const freshInspection = await inspect(f);
  const result = evaluateSourcePolicy(freshInspection, oldPolicy);

  assert.equal(result.publicationEligible, false);
  assert.equal(result.inventoryChanges.added.length, 2);
  assert.equal(result.inventoryChanges.removed.length, 1);
  assert(result.decisionResults.some((decision) => decision.category === "unreadable-file" && decision.key.endsWith("new-corrupt.jpg") && decision.status === "unresolved"));
  assert(result.decisionResults.some((decision) => decision.category === "duplicate-content" && decision.reason === "recorded-decision-no-longer-matches-current-sources"));
});

test("unresolved 2002 New permits zero-write planning and isolated staging but marks the receipt ineligible", async (t) => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pixilation-policy-stage-test-"));
  t.after(() => fs.rm(appRoot, { recursive: true, force: true }));
  for (const [album, color] of [
    ["First", { r: 1, g: 2, b: 3 }],
    ["Second", { r: 4, g: 5, b: 6 }],
    ["Third", { r: 7, g: 8, b: 9 }]
  ]) {
    await jpeg(path.join(appRoot, "original-photos", "2002 New", album, `${album}.jpg`), color);
  }
  await fs.mkdir(path.join(appRoot, "public", "data"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "public", "data", "catalog.json"), '{"years":[]}\n');
  await fs.mkdir(path.join(appRoot, "generated", "library"), { recursive: true });
  await fs.mkdir(path.join(appRoot, "generated", "reports"), { recursive: true });
  const beforePlan = await fs.readdir(appRoot, { recursive: true });
  let planText = "";
  const plan = await runImporter(["--plan", "--year", "2002"], {
    appRoot,
    writeStdout: (chunk) => {
      planText += chunk;
    }
  });
  assert.equal(plan.sourcePolicy.eligibility.publicationEligible, false);
  assert.equal(plan.sourcePolicy.findings.new2002.proposedAlbums.length, 3);
  assert.deepEqual(await fs.readdir(appRoot, { recursive: true }), beforePlan);
  assert.deepEqual(JSON.parse(planText), plan);

  const stage = await runImporter(["--year", "2002", "--staging-root", path.join(appRoot, "stage")], {
    appRoot,
    importerCommit: "policy-stage-test",
    writeStdout: () => {}
  });
  assert.equal(stage.receipt.publicationEligible, false);
  assert.equal(stage.receipt.publicationApproved, false);
  assert(stage.receipt.sourcePolicy.unresolvedDecisions > 0);
});
