# Repair state — 2026-10-31

The repair remains a stacked sequence on audit PR #2. The first package branch was based on audit commit `27b80a52c8ff7b0a5ba5603142a5a68fe6cdaa3b`; the second package branch `repair/640-second-package-2026-10-31` is based on first-package commit `c51492f9f78bf1978fe95ca80f695ec9d29e4b63`. GitHub `main` remained `d519413e6c676e93a4538ef0814f063b4f091606`; PRs #2 and #3 remained open, draft and clean when verified. These repairs continue the audit rather than duplicating it.

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

## Next executable package

Migrate retained optional-feature browser suites and add their flag matrix to CI (AUD-04), reconcile the remaining historical runbooks/branch controls (AUD-05), then make only test-backed focused decompositions of the coupled archive/player modules (AUD-08). Owner input is still needed only for whether production `debug=1` remains a supported public support mode.
