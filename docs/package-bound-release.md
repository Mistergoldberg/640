# Package-bound R2 publication and QA release

This workflow is generic. It accepts an ordinary verified promotion package and
does not inspect or branch on how the package's photographs originated.

## Capability boundary

The release path is:

```text
verified promotion package
→ reviewed package authority
→ exact-path temporary R2 credentials
→ zero-write R2 plan
→ conditional immutable-media reconciliation
→ full-object SHA-256 receipt
→ sealed candidate release
→ immutable QA release
```

Production manifest and frontend activation are deliberately unavailable. The
QA deployer pins `qa-current`, records `current` before and after deployment,
and fails if the production pointer changes.

## Reviewed authority

The production-bucket credential mint and QA activation require a private,
time-bounded operator record. A test-only source-policy fixture is not release
authority. The record must bind the exact package ID, package seal, and source
policy digest and must explicitly prohibit production activation:

```json
{
  "schemaVersion": 1,
  "status": "approved",
  "environment": "qa",
  "packageId": "<exact package ID>",
  "packageClosedWorldSha256": "<exact package seal>",
  "sourcePolicySha256": "<exact package source-policy digest>",
  "immutableMediaPublicationApproved": true,
  "qaCandidateActivationApproved": true,
  "productionManifestActivationApproved": false,
  "productionFrontendActivationApproved": false,
  "approvedBy": "<operator identity>",
  "approvedAt": "<ISO timestamp>",
  "expiresAt": "<ISO timestamp>"
}
```

Keep this record and every credential bundle outside the repository with mode
0600. Approval is a human release decision; tooling must not synthesize it.

## R2 dry run and publication

Mint 5–15 minute package-bound credentials using the pinned production profile:

```sh
npm run media:r2:credentials -- \
  --package-root /absolute/package \
  --config config/r2-publication-production.json \
  --parent-credentials /private/parent-r2.json \
  --authority /private/package-authority.json \
  --output /private/package-r2-credentials.json \
  --ttl-seconds 900
```

Run the mandatory zero-write plan:

```sh
npm run media:r2:plan -- \
  --package-root /absolute/package \
  --config config/r2-publication-production.json \
  --credentials /private/package-r2-credentials.json \
  --authority /private/package-authority.json
```

Proceed only when conflicts, overwrites and deletes are zero. Execution uses
the same verified plan and adapter:

```sh
npm run media:r2:publish -- \
  --package-root /absolute/package \
  --config config/r2-publication-production.json \
  --credentials /private/package-r2-credentials.json \
  --authority /private/package-authority.json \
  --journal-root /private/durable-publication-journal
```

The publisher credential has `GetObject` and `PutObject` only for the exact
`media/new` paths. A separate role lists the pinned bucket, and a separate
exact-path `GetObject` role verifies retained media. `PutObject` authority is
not inherently create-only; the adapter enforces `If-None-Match: *`, has no
unconditional-write API, and downloads every required object to calculate its
full SHA-256. The implementation exposes no copy or delete command.

## Candidate activation

Build the frontend normally with the approved public media origin. Then construct
a new release without editing canonical `public/data`:

```sh
VITE_APP_BASE_PATH=/ VITE_MEDIA_BASE_URL=https://media.pixilation.org/ npm run build

npm run release:candidate -- \
  --package-root /absolute/package \
  --publication-receipt /private/durable-publication-journal/receipt.json \
  --frontend-dist /absolute/repository/dist \
  --release-root /private/candidate-release \
  --authority /private/package-authority.json \
  --require-authority \
  --required-adapter-type cloudflare-r2-production-package-bound \
  --previous-qa-release '<recorded QA release>' \
  --rollback-release '<recorded QA release>'
```

The builder copies frontend files except the build's canonical `data/`, installs
only `candidate/public/data` from the verified package, validates every catalog,
index, manifest, sequence and receipt-bound media reference, and seals the
result. Package metadata, video jobs, source media, reports, source maps and
credentials cannot enter the public payload.

## QA deployment

The checked-in QA pin matches the documented immutable server layout. Deployment
uploads to a new release directory, verifies every file checksum, atomically
switches only `qa-current`, and compares public `index.html` and `catalog.json`
to the sealed payload. A validation failure restores the previous QA pointer;
the production `current` pointer must remain identical.

```sh
npm run release:qa -- \
  --release-root /private/candidate-release \
  --package-root /absolute/package \
  --publication-receipt /private/durable-publication-journal/receipt.json \
  --authority /private/package-authority.json \
  --config config/qa-release.json \
  --deployment-receipt /private/qa-deployment-receipt.json
```

Run browser checks against QA without starting a local preview server:

```sh
PIXILATION_PLAYWRIGHT_BASE_URL=https://qa.insertcatchytitlehere.com/ npm run test:browser
```

Image rotation is not in the Stage 2D ancestry and must be tested separately;
do not cherry-pick it into this release.
