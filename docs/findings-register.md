# Audit findings register

The dated audit remains the source record. This register tracks later disposition.

| ID | Current evidence/status | Repair and acceptance | Implementation/validation |
| --- | --- | --- | --- |
| AUD-01 | Confirmed defect. All 132,340 references use exact cv1 keys; legacy importer/uploader used the old contract. Package authority verified in adjacent `pixilation-import-plan` at `ba3bbb5`. | Exact shared key contract; retire incompatible paths; reject malformed, traversal, old, mixed and wrong-year cases. | First repair package; contract tests and release-audit catalogue pass. Full derivative audit depends on an approved local media set. |
| AUD-02 | Confirmed defect by source inspection. Sample inherited canonical output. | Sample/limited legacy commands must fail before writes and cannot become publishable. | First repair package; subprocess tests compare canonical tree digest before/after. |
| AUD-03 | Confirmed defect. Historical suites encode the former three-year catalogue. | Default gate derives years/photos; covers navigation, deep links, history, player, restoration and bounded DOM; report actual outcomes. | First repair package; synthetic-media acceptance. Old suites remain historical, outside the gate. |
| AUD-04 | Confirmed defect. Flags/test selection differed and server reuse was unidentified. | Pin runtime; record source, lock, flags, data and artifacts; strict port; verify served identity. | Partial in first repair package. Enabled-flag acceptance remains open. |
| AUD-05 | Confirmed stale operational documentation and absent CI at audited SHA. | Current repair/publication/acceptance docs and CI; retain dated history. | Partial in first repair package; broader historical runbook reconciliation remains open. |
| AUD-06 | Confirmed hidden public support surface, not a credential leak. | Decide supported/QA-only/retired; redact exports and decouple public crash recovery. | Open; owner decision needed for production `debug=1` disposition. |
| AUD-07 | Confirmed contract-hardening gap; no exploit demonstrated. | Shared semantic runtime/build contract, bounded values and recoverable errors. | Open; next package. |
| AUD-08 | Cleanup merged only in audit branch; large coupled modules remain a maintenance risk, not a defect. | Keep dead-helper cleanup; decompose only behind reliable behavior tests. | Helper cleanup inherited from PR #2; focused decomposition open. |
| AUD-09 | Confirmed by source inspection; live failure not reproduced. | Reset retryable promise, bound script lifecycle, test failure then success. | Open; next package. |

Historical production identity, live flags, real-media hashes/metadata, headers, live SoundCloud and physical iPhone/WebKit remain unverified production assumptions, not outcomes of local synthetic acceptance.
