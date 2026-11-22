# 2026 order and seamless browsing QA amendment

Production promotion was approved on 2026-11-22. The [production runbook](player-continuation-production-2026-11-22.md) supersedes the historical QA-only hold below.

Owner request: reverse the entire 2026 sequence, including album order and the photos within each album, then enable seamless year transitions. This replaces the earlier forward-order decision. Production remains on the previously approved release until visual review of this candidate.

2026 now starts at photo `2026-abad9300031a9b` (2026-3/IMG_8515.JPG), continues through albums 2026-3, 2026-2 and 2026-1, and ends at `2026-7e312ff1ad75bb` (2026-1/IMG_8123.JPG). All 661 photo IDs, memberships and derivative keys remain unchanged. Other years and legacy aliases remain byte-identical.

Seamless year segments default on in runtime parsing and recorded build settings. Explicit `VITE_SEAMLESS_YEAR_SEGMENTS=0` retains the manual fallback for testing/recovery. Homepage autoplay remains off. Existing adjacent-year preloading, passive handoff, bounded mounted years/cache and retry buttons are retained; this change activates their existing implementation.

## Release procedure

Use the authoritative workflow's `scripts/catalogue-order-amendment.mjs` and its runbook `docs/catalogue-order-amendment.md`. This produces a new sealed metadata-only release from the previously verified parent; it does not mutate or republish the media package. The base release is `48392c0d608d3f8961400d26399459d5f1101f6a723992ed36dd5c5d94245837`, seal `f3db60c73dd46d74d97efb8028fc3928206e8863d9c677193ad8c15c7f3e7134`. It is also the exact QA rollback target.

Build a clean committed checkout with `VITE_BUILD_COMMIT` equal to HEAD, `VITE_HOMEPAGE_AUTOPLAYER=0`, and `VITE_SEAMLESS_YEAR_SEGMENTS=1`. Run unit/contracts, strict TypeScript, all four browser profiles and the release audit against the approved derivative tree. Verify the complete reversal against the parent, all unchanged data bytes, the original media publication receipt, frontend identity, new release ID and seal before transfer.

Upload only the new frontend payload to an immutable QA release directory. Verify every staged checksum, activate QA atomically, and recheck all hashes and both protected production pointers. On failure, restore QA to the parent release. Keep the original package, previous releases and images. No deletion or production promotion is part of this change.

Preview: https://qa.insertcatchytitlehere.com/

First reversed frame: https://qa.insertcatchytitlehere.com/?year=2026&photo=2026-abad9300031a9b

Record deployment and browser evidence separately from the immutable candidate. Synthetic interaction tests do not establish remote image availability or physical Safari behavior; distinguish those from checks using the exact payload and real media. Obtain visual review before production promotion.
