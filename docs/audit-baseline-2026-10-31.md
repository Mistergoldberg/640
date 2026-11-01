# 640 / Pixilation.org — audit and baseline
Date: 2026-10-31 (Toronto)
Repository: https://github.com/Mistergoldberg/640
Audited commit: d519413e6c676e93a4538ef0814f063b4f091606
Git tree: df32364c0cb80651e4fbe95bf9e441af5150fe5b

## Assessment

The application source builds, its unit suite passes, and the current catalogue is internally consistent. The release process needs repair before this repository can provide a reliable, repeatable acceptance baseline. The most significant confirmed problem is that the release auditor, uploader and importer describe the previous media contract while the committed catalogue uses the newer content-versioned contract.

This assessment concerns the public archive at Pixilation.org. The multi-user Pixilation.app project, authentication, user uploads and media-worker runtime admission are separate projects and were not audited here.

GitHub main matched the audited commit when inspected. Production deployment identity was supplied by the owner; this audit did not independently inspect the production server or the live build configuration.

## Evidence and boundaries

All 267 tracked blobs were obtained through the connected GitHub service and independently matched against their Git blob SHA-1 values. The tree contained 327 entries including directories and was not truncated. Review covered application code, configuration, scripts, browser and unit tests, documentation, catalogue, all 24 year indexes and all 137 album manifests.

The isolated audit copy has no connection to production deployment credentials. No source photographs were processed, no import was run, and no R2 operation was performed. Running the release auditor wrote its report only in the isolated audit copy. Repository cleanup in the companion draft change removes unused helpers and adds instructions; it does not repair the identified release-contract mismatch.

A clean offline npm installation was attempted but failed because one package was absent from the local npm cache. Verification then used an existing project dependency installation: all 126 present package versions matched this lockfile, no required package was missing, and 114 optional package entries were absent. This supports the reported execution results but is weaker evidence than a fresh installation on a clean CI runner. No claim about current dependency vulnerability status is made.

## Verified baseline

| Item | Observed value |
| --- | --- |
| Product | Public, read-only photo archive and player |
| Application | React 18, TypeScript, Vite |
| Committed catalogue | 24 years: 2001–2017, 2019–2023, 2025–2026 |
| Album manifests | 137 |
| Catalogue sequence photographs | 66,170 |
| Sum of scannedCount | 66,180 |
| Distinct thumbnail/display keys | 132,340 |
| Current key convention | YEAR/(thumbs or display)/YEAR-ID-cv1-SHA256.jpg |
| Baseline unit suite | 156 tests, 24 files, passed |
| TypeScript build | Passed |
| Additional unused-local/parameter check | Passed |
| Browser test discovery | 114 cases in 15 files; not a full execution result |
| Local browser smoke | 72 year/viewport cases and 3 player cases passed |
| Smoke viewports | 1440×900, 390×844, 844×390 |
| Highest sampled mounted photo-tile count | 74 |
| Default local production-build flags | Homepage autoplay off; seamless segments off |
| Build identity without explicit environment value | local-uncommitted |

The scanned count and published sequence count measure different things. Their difference of ten is not evidence of lost published photos. Private importer evidence is needed to explain exclusions. No missing-year folders or absent years should be invented to fill the catalogue.

The complete manifest consistency pass found no duplicate global photo IDs, sequence-to-manifest membership differences, album-count differences, incorrect albumId membership, or non-positive/non-integer dimensions. Photo objects contained only the expected public photo fields. Every referenced key matched the observed cv1 convention. These checks establish manifest consistency, not the existence, checksums, decodability, metadata privacy or dimensions of remote image bytes.

The smoke harness served the complete committed catalogue from a local production build. It replaced public media requests with a synthetic JPEG and blocked other external traffic. It opened every year at all three sizes, checked bounded tile counts, checked the root default year of 2026, confirmed normal visits hide the diagnostics panel, opened query-enabled diagnostics, and opened/decoded/rotated/closed a current 2026 photo. It recorded no page errors in those checks. It did not establish WebKit correctness, native mobile fullscreen, real portrait-image geometry, music playback, remote caching or a memory-soak result.

## Findings

### AUD-01 — High: release tools reject the current media contract

Evidence: scripts/release-audit.mjs:168; scripts/media-upload-r2.mjs:12; scripts/import-photos.mjs:685–686.

The release auditor and uploader allow only unversioned keys ending in YEAR-ID followed directly by an image extension. All 132,340 current references include a cv1 marker and a 64-character hash. A separate complete manifest pass confirmed the mismatch for every key.

Running npm run release:audit reproduced a failed result with two blockers: generated media is absent from this audit environment, and unsafe/malformed asset keys are reported. The key findings are capped at 25 samples, so the report's count of 25 is not the total number of incompatible keys. The auditor reports zero accepted referenced assets because none satisfy its old allowlist; that output does not mean the catalogue has zero media references.

The legacy importer still emits unversioned keys. Therefore the repository contains two incompatible generations of tooling and data. Do not fix this by allowing arbitrary filenames or deleting the validator.

Required change: establish which repository and package contract owns publication of the current cv1 catalogue. If the external package pipeline is authoritative, retire or explicitly quarantine the old commands and link the exact supported replacement. If these tools remain supported, adapt them to the exact versioned-key and package contract, with fixtures for valid, malformed, traversing, mixed-generation and wrong-year keys. Full media audit must then run against the approved local derivative set.

### AUD-02 — High: the sample import command can replace canonical year data

Evidence: package.json import:2013:sample; scripts/import-photos.mjs:32–39, 1219, 1335–1370.

The sample command requests a 300-photo limit while the importer defaults its output to public. The importer writes album manifests, catalog.json and the year index to that output. There is no separate default sample destination or publication-ineligibility contract in that command.

On a machine with the expected sources, an apparently exploratory sample operation can replace the tracked public year index and regenerate references using the older recipe. This was established by code inspection; no import was executed.

Required change: remove the sample command from normal operational guidance or make sample output isolated by construction. Sample and limited output must be unable to update canonical data or become release-eligible. Preserve any legacy script only under a clearly named, noncanonical workflow if it still serves a verified purpose.

### AUD-03 — High: browser acceptance tests still encode the old catalogue

Evidence: browser-tests/year-windowed-archive.pw.ts:26–34; browser-tests/archive-diagnostics.pw.ts:23 onward; fixed photo IDs in player-image-rotation.pw.ts and other suites.

Helpers treat 2013 as Home/newest and sometimes 2002 as the directly adjacent year. The current newest year is 2026 and there are many intermediate years. Several player cases also target fixed IDs from the earlier catalogue. Thus test discovery succeeds, but the existing browser suite is not a current all-year acceptance gate.

Required change: distinguish stable synthetic-fixture tests from current-catalogue acceptance tests. Derive newest/oldest/adjacent years and suitable photo IDs from the relevant fixture or catalogue. Keep intentionally fixed fixture IDs inside explicit fixture datasets. Report actual pass/fail/skip totals per build variant. Do not rewrite expectations merely to silence genuine behaviour regressions.

### AUD-04 — Medium: build flags and build identity are not captured as a release contract

Evidence: src/archive/seamlessYearSegmentsFlag.ts; src/player/homepageAutoplay.ts; src/debug/archiveDiagnostics.ts:169; playwright.config.ts:16–18; .env.example.

Both optional features default off, accept 1 or true in application code, and alter behaviour materially. Some browser tests decide whether to skip using only the exact string 1. The example environment does not list all public settings. The documented build command does not supply VITE_BUILD_COMMIT, and local diagnostics consequently identify the audited build as local-uncommitted.

Playwright permits reuse of an existing server without verifying its source SHA or compiled feature flags. Test-process environment values and the served build can therefore disagree.

Required change: record source SHA, dirty state, Node/npm versions, dependency lock hash, public build settings, data digest and artifact hashes together. Use one flag parser/contract for builds and test selection. CI should build its own server and fail on a conflicting port. Test an already running server only through an explicit mode that verifies its identity first.

### AUD-05 — Medium: operational documentation conflicts with the current repository

Evidence: docs/deployment.md; docs/year-windowed-archive.md; docs/ios-physical-qa-audit.md.

Deployment guidance still reports 11,361 photos, 22,722 objects, three permitted years and an older active release. The iOS audit describes a removed requiresStableArchiveDom implementation as though it were current. These records contain useful history but are not reliable current runbooks.

The original audited tree had no root README, AGENTS.md, machine runtime pin or tracked CI workflow. GitHub returned main as unprotected, an empty repository ruleset collection, and zero Actions runs for the audited SHA.

Required change: make the new baseline the entry point, label old documents with the commit and period they describe, and reconcile each operational command. Add automated checks after repairing stale browser coverage. Configure branch controls separately with the appropriate repository access; a markdown policy does not enforce protection.

### AUD-06 — Medium: diagnostics are a publicly reachable support mode

Evidence: src/main.tsx; src/debug/archiveDiagnostics.ts:75–79; src/debug/ArchiveDiagnosticsPanel.tsx.

The panel is hidden on ordinary visits, but debug=1 activates it in production builds as well as development. It exposes local runtime state, URL, platform, navigation, errors and build identity through an overlay and downloadable/copied JSON. No diagnostic upload service or privileged write operation was found in this implementation.

This is a confirmed hidden surface, not a confirmed credential leak or admin backdoor. The repository does not establish that the owner has retired it.

Required disposition: retain it as an explicitly supported diagnostic mode, restrict it to an intended QA build, or remove its production surface after owner intent is established. If retained, document its data, bound its work, redact unnecessary URL parameters from exports and ensure production crash recovery does not depend on a panel that normal visitors cannot see. The current error boundary asks users to export diagnostics even when the panel is hidden.

### AUD-07 — Medium: runtime manifest validation is mostly structural

Evidence: src/data/manifestValidation.ts; src/lib/assets.ts.

The client accepts nonempty URL/key strings and finite numeric dimensions/counts. It does not itself enforce canonical same-origin manifest paths, asset-key structure, unique IDs, positive integer sizes, album membership or sequence membership. Some stronger guarantees exist in the release auditor, but that auditor currently rejects this catalogue.

With a trusted, consistently audited static catalogue, this is chiefly a contract-hardening issue. This review did not demonstrate a remote code execution or XSS exploit.

Required change: define the supported catalogue schema once, validate relevant semantic constraints before use, and retain stricter exhaustive build-time auditing. Bound unreasonable values and provide recoverable public errors. Avoid duplicating contradictory regexes across independent tools.

### AUD-08 — Low: unused autoplay scaffolding and large coupled modules

Evidence: src/player/homepageAutoplay.ts; src/player/homepageAutoplay.test.ts; src/App.tsx; src/player/PhotoPlayer.tsx.

createHomepageWarmupState has no callers. Its HomepageWarmupState interface has no consumers beyond that unused function. pingPongOrder is referenced only by its own unit test. Actual playback uses the reducer and the player implementation. The companion cleanup removes those helpers, their unused interface, and the helper-only test; HomepageWarmupPhase and runtime range helpers remain.

App.tsx contains 2,006 lines and PhotoPlayer.tsx 1,811 lines. Size alone is not a defect, but archive windowing, history, restoration, gestures and playback have tightly connected state. Decompose only after the current behaviour is protected by reliable regression checks; a broad stylistic rewrite would make this audit harder to verify.

### AUD-09 — Low: SoundCloud failure recovery can remain latched

Evidence: src/player/PhotoPlayer.tsx:81, 94–124 and music loading effect.

The module-level SoundCloud API promise is retained after rejection. Later attempts in the same document receive the same rejected promise. The existing-script path can also wait for a load event that has already occurred if the widget object is absent.

Required change: give API loading an explicit bounded lifecycle, reset retryable failures and test failure-then-success. This was identified by code inspection; the smoke run blocked SoundCloud and did not test its live service.

## Feature register and removal policy

| Surface | Trigger/status established in source | Disposition |
| --- | --- | --- |
| Public year/archive browsing, scrubber, album labels | Normal navigation | Preserve |
| Player, manual frame navigation, speed, sharing, fit/expanded mode | Visible player controls | Preserve |
| Temporary rotation | Visible rotation control; transient state | Preserve; no permanent image editing implied |
| Help/onboarding | Player Help control and instruction state | Preserve unless explicitly retired |
| SoundCloud music | Player music control; external script/iframe | Preserve; harden failure handling |
| Archive diagnostics | debug=1; included in production code | Review support/QA/retire policy |
| Homepage autoplay | VITE_HOMEPAGE_AUTOPLAYER; default off | Supported optional path until a decision establishes otherwise |
| Seamless year segments | VITE_SEAMLESS_YEAR_SEGMENTS; default off | Supported optional path until a decision establishes otherwise |
| Old storage cleanup | Removal of owned legacy keys | Preserve compatibility until removal is justified |
| Legacy import/upload/release scripts | npm commands; incompatible current key recipe | Quarantine or reconcile publication authority first |
| Unused warmup builder and test-only order helper | No application callers | Remove in companion cleanup |
| Historical phase/failed iOS documents | Documentation only | Retain as clearly dated history |

No hidden runtime feature was established as formally sunset by the available repository evidence. Removing a compile-time branch solely because it defaults off could discard intentional functionality. A retirement needs an owner decision or documented replacement, followed by a check of imports, UI triggers, URL parameters, environment settings, storage, dependencies, CSS, tests and documentation. Record any compatibility behaviour deliberately retained.

## Execution sequence and acceptance

1. Freeze this commit as the source baseline. Capture the actual live artifact, public build flags and rollback identity separately.
2. Merge the small instructions/baseline/dead-helper cleanup through review. Its unit count should be 155 after removing the test of the removed helper.
3. Resolve the current publication authority, then repair or retire the legacy canonical/sample import and release commands. Validate only approved local packages; no R2 write is needed to establish the contract.
4. Repair the current browser acceptance matrix and add repeatable CI using the supported Node version and lockfile. Exercise each retained flag combination or document unsupported combinations.
5. Apply approved feature retirements as focused changes, with before/after feature and trigger inventories. Harden runtime validation, error recovery and third-party loading in separate reviewable patches.
6. Validate real derivatives, public delivery and cache/security headers in the intended QA environment. Obtain physical iPhone/WebKit acceptance for scroll/fullscreen/gesture changes. Promote an exact verified artifact when deployment is explicitly authorized.

A clean release requires passing reproducible installation, TypeScript/build/unit checks, current-catalogue browser checks, retained optional-path checks, exhaustive manifest/media auditing, source/artifact identity checks and successful rollback validation. Historical PASS statements do not substitute for the new artifact's results.

Open verification: live production identity and flags; source/import authority and private exclusion reasons; real media existence/hashes/metadata; current dependency advisories; live TLS/headers/CSP; live SoundCloud; full browser regression suite; physical iOS; promotion and rollback. No broad clean/security signoff is justified until these checks are completed.

## Companion cleanup verification

The companion change adds README.md, AGENTS.md, this baseline and historical-document notices, then removes only the unused warmup builder/interface and test-only ping-pong helper/test. After cleanup, 155 unit tests across 24 files passed; the removed test exercised only the removed helper. TypeScript, the unused-local/parameter check and the production build passed. All 167 built distribution files have exactly the same SHA-256 hashes as the pre-cleanup build, including all catalogue/manifests. This proves byte-identical output for the tested default configuration. It does not certify enabled optional variants or live production settings. No production deployment or merge accompanies the draft change.
