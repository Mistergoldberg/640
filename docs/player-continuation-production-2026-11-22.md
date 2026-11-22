# Approved continuous-playback production release

On 2026-11-22 (Toronto), the owner approved production promotion of the reviewed QA release. This approval supersedes the earlier QA-only hold; it does not authorize media deletion. Promote the existing sealed payload unchanged. A new build would be a different artifact.

The release combines the full 2026 reversal, seamless archive scrolling, and player continuation across catalogue years. Within a year, albums remain one preloaded sequence. At year boundaries playback continues 2026 → 2025 → 2023 in the existing player, preserving fullscreen, speed and pause intent. Escape returns to the displayed photo's album. Failed next-year loads hold the frame and offer Retry. The oldest year ends playback.

| Binding | Value |
| --- | --- |
| Approved frontend source | `ec04b3e9566d94636aa638a68d5f073da01fc639` (clean) |
| Approved release | `9287a76d7d48b5f4571d06923d48bd59eb919a2fe9da7b1c019fad19b5a162fe` |
| Release seal | `68f58634d454fa26bb5a181c39f895528aa3fb38dfd23fd665a0c3c69c137689` |
| Payload inventory SHA-256 | `7b0aae5d945e86aa9edb187a0c25fb8eb0f1784d499b745d64f0896c113b34bf` (167 files) |
| Media package | `61bf2369db6ae7112a20360b524bfd3647093c0e7fc5ffdfe81fc8b354bd9276` |
| Package seal | `61535ceefbbe7b13dda147a8c72f3f63969592cc395ee9baabe682f762413a6e` |
| Publication receipt | `2081c3549d74cd7e2b34e20a3ac1c589213db17576dabc687e25961704cda960` |
| Build settings | Homepage autoplay off; seamless year segments on |
| Production rollback release | `48392c0d608d3f8961400d26399459d5f1101f6a723992ed36dd5c5d94245837` |

## Promotion and rollback

1. Reverify the approved release through the separate publication authority's `verifyFrontendReleaseAmendment`, including its catalogue-order parent and original sealed media package/publication receipt. Keep that QA seal unchanged; record the new owner production approval separately.
2. Verify QA still serves this release, production still serves the rollback above, and the legacy-site pointer is unchanged. Record public access/security headers. Verify the prior production directory and retain a complete rollback inventory.
3. Compare every QA file to the sealed payload inventory. Copy that exact directory to `/var/www/pixilation.org/releases/<release-id>` and recheck all paths, sizes and SHA-256 hashes. Stage immutably without changing the live pointer.
4. Recheck both source and rollback inventories. Atomically replace only `/var/www/pixilation.org/current` with a symlink to the staged release. Preserve QA, the legacy site, Basic Auth, Nginx, DNS and media.
5. Verify the activated inventory, public access/security behavior, approved 2026 order, album and year transitions, and desktop Escape. Browser checks may use the identical sealed local payload with live R2 images if hosted Basic Auth cannot be used by automation; record that limitation explicitly alongside server hashes. Physical Safari is not established by Chrome emulation.
6. If post-activation validation fails, atomically restore the recorded production target after verifying its inventory, then verify the restored pointer. Retain all releases and evidence.

QA acceptance passed 181 unit tests, four contracts, strict TypeScript and browser profiles 00/10/01/11 with 30/31/32/34 passes; default 29 and nine live-media continuation cases also passed, all with zero failures/skips. The exhaustive 131,562-image audit is reused only because its data and sealed-media input identities are unchanged. Promotion receipts and any additional checks belong in ignored `generated/reports/player-continuation-production-2026-11-22/`.

[Archive](https://pixilation.org/) · [first reversed 2026 frame](https://pixilation.org/?year=2026&photo=2026-abad9300031a9b) · [album boundary](https://pixilation.org/?year=2026&photo=2026-d06b8fad576de5) · [year boundary](https://pixilation.org/?year=2026&photo=2026-7a13672c4bddc0)
