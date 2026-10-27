# Aggregate archive-replacement package

`scripts/aggregate-staged-release.mjs` assembles one atomic replacement candidate from an explicitly approved, exact set of publication-eligible year stages. It never infers approval from a stage, source folder, matching ID, or policy report.

The builder is local-only. It does not publish media, contact R2, deploy, activate a release, modify canonical data, or delete rollback objects.

## Required inputs

- One `--stage-root` for every intended year. Each root must be a complete, closed-world, unlimited, publication-eligible stage.
- `--contract`, an approved intended-year contract.
- `--id-transitions`, an approved transition for every photo ID in the previous catalogue.
- An absent `--package-root` outside all source, stage, canonical-data, and canonical-media roots.

The contract has this shape:

```json
{
  "schemaVersion": 1,
  "status": "approved",
  "approvalId": "owner-decision-reference",
  "intendedYears": ["2001", "2002"],
  "physicalSourceRoot": "/absolute/physical/original-photos",
  "importerIdentity": {
    "importerCommit": "full-sha",
    "importerScriptSha256": "sha256",
    "sharpVersion": "version",
    "derivativeRecipeSha256": "sha256",
    "contentMediaKeyVersion": 1
  },
  "stages": [],
  "expectedPublishedPhotoCount": 11361,
  "previousRelease": {
    "releaseId": "immutable-release-id",
    "publicDataSha256": "sha256",
    "publicDataFileCount": 18,
    "mediaInventorySha256": "sha256",
    "mediaObjectCount": 22722,
    "publishedPhotoCount": 11361
  }
}
```

Each exact stage binding records its run ID, receipt and completion seal, source inventory, policy and decision-set digests, manifest and output-set identities, and importer/recipe identity. Contract values must come from a separate review workflow; the package command does not generate or approve them.

Every ID transition is either:

- `alias`, with a candidate `newPhotoId` and supported evidence. Version 1 accepts exact equality of the recorded old and new display-media SHA-256 values after independently checking both inventories.
- `retired-no-successor`, with an explicit approved decision ID and reason.

Every transition must have `status: "approved"`. Missing, duplicate, conflicting, unsupported, or unverified transitions fail closed. Zero matching IDs is never treated as preservation.

## Assembly and verification

```sh
npm run release:package:aggregate -- \
  --stage-root /absolute/stage-2001 \
  --stage-root /absolute/stage-2002 \
  --contract /absolute/intended-years.json \
  --id-transitions /absolute/id-transitions.json \
  --package-root /absolute/absent-package-root
```

The candidate catalogue is constructed only from the contracted stages. Canonical catalogue entries are not inherited. The package includes:

- the complete candidate public-data tree;
- all new candidate media and an exact complete-media inventory;
- a byte-for-byte copy of the previous public-data release;
- a complete previous-media rollback inventory;
- exact stage, manifest/media, and ID-transition maps;
- an empty delete plan; and
- a closed-world package receipt and completion seal.

The verifier rejects year coverage changes, limited or stale stages, mixed source or importer identities, global photo/album/media-key collisions, ordering changes, missing media, catalogue leakage, rollback omissions, transition gaps, and any unexpected package file.

## Real-source review packet

`scripts/all-year-review-packet.mjs` converts the mechanical all-source policy report and all-year stage inventory into unresolved review units and representative contact sheets. It does not update a policy or approval record.

```sh
npm run review:archive-replacement -- \
  --policy-report /absolute/all-source-policy.json \
  --stage-inventory /absolute/all-year-stage-inventory.json \
  --canonical-data-root /absolute/public/data \
  --output-root /absolute/absent-review-packet-root
```

The packet fails unless every supplied real decision remains unresolved and every selected source year has verified stage evidence.
