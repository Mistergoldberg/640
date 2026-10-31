# Repair state — 2026-10-31

Branch: `repair/640-first-package-2026-10-31`, based on audit PR #2 commit `27b80a52c8ff7b0a5ba5603142a5a68fe6cdaa3b`. GitHub `main` remained `d519413e6c676e93a4538ef0814f063b4f091606`; PR #2 remained open, draft and clean when verified. This repair continues that audit rather than duplicating it.

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

## Next executable package

Unify runtime catalogue validation with the cv1 contract (AUD-07), harden public error recovery/diagnostic export policy (AUD-06), and add retryable bounded SoundCloud loading tests (AUD-09). Then migrate retained optional-feature browser suites and add their flag matrix to CI. Owner input is needed only for whether production `debug=1` remains a supported public support mode.
