# Working instructions — 640 / Pixilation.org

## Scope and current evidence

This repository is the public, read-only Pixilation.org archive/player. Pixilation.app's multi-user service is separate. Start with README.md and docs/audit-baseline-2026-10-31.md. The audited source baseline is d519413e6c676e93a4538ef0814f063b4f091606. Later commits must be assessed on their own evidence.

Routine local inspection, reversible cleanup, tests and documentation within the user's task should proceed without repeated approval. Verify the actual checkout, branch, HEAD, remote state and uncommitted changes before editing. Preserve unrelated changes. Never reset or clean a user's work to establish a baseline.

## Product and feature contract

Preserve observed working behaviour unless the task explicitly changes it. Hidden, disabled-by-default and retired are different states. Before removing a feature, identify its trigger, callers, dependencies, storage, CSS, tests, docs and documented replacement or owner retirement decision. Record the disposition.

Current optional flags are VITE_HOMEPAGE_AUTOPLAYER and VITE_SEAMLESS_YEAR_SEGMENTS. Both default off; application parsing accepts 1 or case-insensitive true. Diagnostics are activated with debug=1, including in production builds. Do not silently remove these paths or assume the live build uses defaults.

## Data and publication boundary

Original photographs and private inventories, EXIF/GPS, credentials and import reports must remain outside tracked/public output. Treat public/data as canonical publication data. Preserve stable IDs, ordering, album membership and share URLs unless a migration explicitly covers them.

The baseline contains 24 catalogue years, 137 albums, 66,170 photos and 132,340 distinct derivative keys. These are snapshot assertions, not permanent year allowlists. Derive navigation and acceptance fixtures from the relevant catalogue.

Current keys contain -cv1- followed by a SHA-256 digest. `scripts/media-contract.mjs` is shared by exhaustive release auditing and runtime manifest validation. The package-bound workflow in the separately controlled `pixilation-import-plan` repository is publication authority. The legacy importer, sample/limited entry points and broad uploader are retired fail-closed. Do not bypass those guards, recreate package approval locally, or weaken validation merely to make a gate pass.

## Validation and reporting

Use npm ci in a clean environment with the committed lockfile. Record Node/npm versions and any installation limitation. npm test and npm run build are the existing unit/build commands. TypeScript's strict mode is enabled; an additional unused-local/parameter check is useful.

`npm run test:browser` is the deterministic current-catalogue gate. It derives years/photos from committed data, builds its own strict-port server and verifies the build identity. Historical feature suites still contain three-year assumptions and remain outside the default gate until explicitly fixture-backed or migrated. Report actual pass/fail/skip totals and build flags; do not reuse an unidentified server as release evidence.

Use synthetic media for isolated interaction checks and identify that limitation. It does not establish remote availability, image privacy, checksums, physical Safari behaviour or real-media geometry. Retain accessible keyboard/touch navigation, reduced-motion behaviour, bounded DOM/cache work, stable history and cleanup of timers/listeners.

Runtime manifest validation must preserve canonical path, cv1 key, year/photo/album membership, ordering and count constraints while allowing pending or failed albums to remain independently retryable. Visitor-facing errors must remain generic and recoverable. Diagnostics remain available through `debug=1` pending an owner policy decision; all display/export paths must use minimized redacted data. SoundCloud loading must remain bounded, deduplicated, retryable and independent of the live service in tests.

## Release and operational instructions

Record source SHA, dirty state, lockfile/data hashes, build settings, runtime versions and artifact hashes. Supply VITE_BUILD_COMMIT deliberately; local-uncommitted is not an acceptable release identity.

Production, DNS, R2 publication, deletion and promotion require authorization within the user's task and the applicable verified runbook. An audit request alone does not authorize deployment. Prepare and verify an exact candidate and rollback before promotion. Never broaden a media upload directory, use destructive sync, expose credentials or change unrelated shared hosting services.

Historical deployment/phase/iOS reports describe their stated commits and dates. They must not override current code and fresh evidence. Update the current runbook and feature register when behaviour or tooling changes. Report what changed, validation performed and material remaining uncertainty.
