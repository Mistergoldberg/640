# Continuous player playback across years

The player continues from the last frame of a year into the first frame of the next **catalogue** year: for this release, 2026 → 2025 → 2023. It stops at the oldest year. The approved reversed 2026 sequence and every public data/media file remain unchanged.

The next year's validated manifests begin loading within the last 60 frames or five seconds of playback, whichever is earlier. Five lead-in display images are decoded ahead of the handoff. A player-owned cache keeps only the current year and its two neighbours, with at most three concurrent album requests per load. The archive's existing bounded cache remains separate. Closing cancels player requests and image work. Failed prefetches remain failed until deliberate retry; a 30-second timeout makes stalled requests recoverable.

Year handoff retains the existing player, playback speed, music controls and fullscreen. The current image stays painted until the incoming frame decodes. Manual forward/backward stepping crosses year boundaries while preserving pause intent. A slow or failed year load holds the current frame and offers Retry. Pause cancels a pending automatic handoff; late responses cannot reopen a closed player.

Handoff replaces the current photo URL without adding history entries. Share uses the displayed year/photo. Escape restores the viewed photo in its album, including when the player was opened from another year's grid. Player-close restoration verifies the target after removed segments/fullscreen changes settle; other archive restoration paths retain their existing behavior.

## QA and release

This is a frontend-only amendment of the approved reversal/seamless-scroll QA release `708d5882b06ca5cc2b110705124b48d46a9ddfdc8ac99fdb4af8668d100f5266` (seal `be5f5a30d9551d2c5bb5223c95f0ba902f157c753d3719bfd73a7500479c0864`). Use the separately controlled publication workflow's `frontend-release-amendment.mjs` to verify that parent chain, exact unchanged data, clean source/build identity and new seal. That parent is the QA rollback target. Protect the legacy production pointer and actual pixilation.org production pointer during QA activation.

Run unit/contracts, strict TypeScript, the default browser gate and all four optional-feature profiles. The continuation contract runs in each profile independently of archive scrolling or homepage autoplay flags. Check actual catalogue boundaries with the exact candidate and live media. The parent's exhaustive image audit can be reused only with an identical catalogue tree and sealed media package; record those bindings explicitly. Do not upload images or delete previous releases. Stop for owner visual review before production promotion.
