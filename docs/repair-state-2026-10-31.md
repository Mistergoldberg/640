# Repair state — 2026-10-31

The repair remains a stacked sequence on audit PR #2. The first package branch was based on audit commit `27b80a52c8ff7b0a5ba5603142a5a68fe6cdaa3b`; the second-package implementation commit `9fa5e0988d663f6b27165184447ed3ba30fe5963` is based on the exact first-package tip `c51492f9a923e62c5f610d1410fefcc0f93d72f4`. The previously recorded `c51492f9f78bf1978fe95ca80f695ec9d29e4b63` does not exist in the local or GitHub graph and was a transcription error. GitHub `main` remained `d519413e6c676e93a4538ef0814f063b4f091606`; PRs #2, #3 and #4 remained open, draft and clean when verified. These repairs continue the audit rather than duplicating it.

## First package

- AUD-01: confirmed. The current catalogue contains 132,340 cv1 references; the adjacent authoritative workflow is package-bound. Exact shared cv1 validation is now used by the release auditor. Legacy import/upload entry points are retired fail-closed.
- AUD-02: confirmed and repaired by retirement. Sample, limited and direct legacy import commands exit before source inspection or writes. Contract tests prove `public/data` is unchanged.
- AUD-03: confirmed. Default acceptance is now a current-catalogue-derived deterministic suite. Historical three-year suites are explicitly outside the gate until fixture-backed or migrated.
- AUD-04: partially repaired. Node 24.12/npm 11.6 are pinned; builds emit source/dirty state, runtime, lock hash, flags, catalogue tree and artifact hashes; browser tests start a strict-port server and verify identity. Enabled optional variants still need migration and execution.

Acceptance for this package: `npm ci`; `npm test`; `npm run build`; `npm run test:browser`; and `npm run release:audit` showing no unsafe cv1 keys (a missing approved media tree may remain a blocker). Record exact totals after execution in the draft PR.

Implementation commit `460684718bf6d849f0f6ce2a7587292f642a8739` validated on Node 24.12.0/npm 11.6.2:

- `npm ci`: passed from the committed lockfile; 123 packages installed.
- `npm test`: 155 Vitest cases in 24 files plus 3 Node contract cases passed; 0 failed, 0 skipped.
- TypeScript build and the additional unused-local/parameter check: passed.
- Production build: passed; 167 artifact files, artifact tree `46fbb03a45961cd9bfe06d7772a91d3861237e96d1ab8325ca401138187a7fbe`, catalogue tree `0ca202b9c692d442b343d0f7073e4ed36304fe93402be305ca79be470726044e`, lockfile `06855c41b52a3dc372a1f9e1dd003a51b7344450ecbc35e608ab4cdff237d2ee`.
- Current-catalogue Playwright: 6 passed, 0 failed, 0 skipped using synthetic JPEG media and installed Chrome.
- Release audit: all 132,340 references accepted with 0 unsafe keys; expected nonzero exit because the isolated repair worktree has no approved `generated/library` derivative set.

No import, derivative generation, R2 write, deployment, DNS change, production mutation or original-photo edit is authorized or performed by this package.

## Second package

- AUD-06: hardened while preserving the pending owner policy. `debug=1` remains available, but every in-memory, displayed, copied and downloaded diagnostic path now minimizes browser information, redacts URL values and sensitive/error fields, bounds nested data and keeps the existing 200-event cap. Listener/timer setup is idempotent and cleanable. The public error boundary exposes only generic Reload/Return recovery controls.
- AUD-07: repaired. Runtime loading now enforces canonical catalogue, year-index and album paths; exact shared cv1 media keys; year/album/photo identity and uniqueness; bounded counts, dimensions and integer positions; album and sequence membership; and complete sequence consistency. Album failures remain isolated and retryable, while a malformed catalogue presents a generic retry action.
- AUD-09: repaired without contacting the live service. SoundCloud API loading now has an eight-second bound, deduplicates concurrent requests, clears pending state after either outcome, cleans up owned scripts/listeners/timers, and permits one deliberate retry when the visitor presses Play music again. Widget event handlers are unbound during player cleanup when the API supports it.
- AUD-04: advanced but not closed. Default browser acceptance now covers diagnostic visibility/redaction and malformed-catalogue recovery. All retained optional flag combinations build successfully, but enabled-feature browser migration and a CI flag matrix remain open.
- Build identity: dirty-path capture preserves the first status entry rather than trimming its first character.

Implementation commit `9fa5e0988d663f6b27165184447ed3ba30fe5963` validated on Node 24.12.0/npm 11.6.2:

- `npm ci`: passed from the committed lockfile; 123 packages installed.
- `npm test`: 168 Vitest cases in 27 files plus 3 Node contract cases passed; 0 failed, 0 skipped.
- TypeScript and the additional unused-local/parameter check: passed.
- Default production build: passed with clean source identity; 167 artifact files, artifact tree `44eaa9f5e7e1e2ef9887befd78e2d9311102f99eff94ff82e9b09e2601353a41`, catalogue tree `0ca202b9c692d442b343d0f7073e4ed36304fe93402be305ca79be470726044e`, lockfile `06855c41b52a3dc372a1f9e1dd003a51b7344450ecbc35e608ab4cdff237d2ee`.
- Optional builds: homepage autoplay only passed (`bf306b6887228483398dfae1e7cf780fc933f6bcf2758412852bbd241a24ed8e`); seamless year segments only passed (`25b8ed79f15b56b6c1c2094116491a2e6335645752eb9018b6f0a47e1a25f36b`); both passed (`9cedc04e1e4a5496073aeb0cb5ddbe347d5641424550aba9bdcf24232afafcc6`). A final default rebuild reproduced the default artifact tree. These are build checks, not enabled-feature browser acceptance.
- Current-catalogue Playwright: 8 passed, 0 failed, 0 skipped using synthetic JPEG media and installed Chrome.
- Release audit: all 132,340 references accepted with 0 unsafe keys; expected nonzero exit because the isolated repair worktree has no approved `generated/library` derivative set.

No import, derivative generation, R2 write, deployment, DNS change, production mutation, live SoundCloud request or original-photo edit is authorized or performed by this package.

## Third package — 2026-11-01

- AUD-04: completes current-catalogue browser acceptance for all four retained flag combinations. Each profile builds its own strict-port artifact, verifies exact source/flags/catalogue identity, uses deterministic synthetic media, blocks SoundCloud, reports pass/fail/skip totals and fails on an empty or skipped selection.
- The migrated feature contract covers autoplay eligibility, failed frames, warm-up ordering, normal playback, pause/manual/close/reload cleanup; segmented handoff/history, cancellation/retry, reclamation, stable resize/orientation correction and explicit resource bounds; and a dedicated combined autoplay/segment restoration path.
- A demonstrated segmented-history regression was repaired: programmatic restoration could arm passive handoff and replace a Forward entry with the next year. Passive handoff now requires user wheel, touch, pointer or navigation-key intent; explicit Back/Forward restoration remains authoritative.
- CI separates one quality job (install, unit/contract and strict TypeScript) from four browser jobs so expensive identical checks are not repeated. Every browser job supplies and verifies its intended flags and retains Playwright traces only on failure.
- AUD-05: active README, instructions and runbooks now agree on commands, the matrix, diagnostics, publication authority and release conditions. Repository administration was inspected but not changed: `main` is unprotected, rulesets are empty, Actions permits all actions, and SHA pinning is not enforced.
- AUD-08: no broad decomposition was justified. The only application change is the focused passive-handoff guard required by the reproduced regression; the current-catalogue suite is the durable test boundary.

Local pre-commit matrix: off/off 11 passed; on/off 12 passed; off/on 13 passed; on/on 15 passed; every profile had 0 failed and 0 skipped. Exact clean-commit evidence and artifact hashes are recorded after the implementation commit exists.

Historical identities `76ae7305660fb3e66189266bb30a2248af819c93` and `6212af362da6d72d2cf31d6acfd067b98c1bfc22` are retained only inside dated historical reports; neither is reachable from the current local graph or GitHub commit API, so this package does not reinterpret or silently correct those owner-supplied historical claims. The audited source/tree pair `d519413e6c676e93a4538ef0814f063b4f091606` / `df32364c0cb80651e4fbe95bf9e441af5150fe5b` and earlier repair identities were reverified.

No catalogue/media mutation, import, derivative generation, R2 write, deployment, DNS change, repository-administration change, live SoundCloud request or original-photo edit is authorized or performed by this package.

## Next executable package

Integrate the stacked repairs into one reviewed candidate branch without changing catalogue/media, run the clean four-profile CI matrix and exhaustive audit against the approved derivative tree, then validate the exact candidate against real media, production-equivalent headers and rollback in QA. Physical iPhone/WebKit acceptance remains required for the segmented scroll/history change. Owner input is still needed for production `debug=1` disposition and repository protection/ruleset policy.
