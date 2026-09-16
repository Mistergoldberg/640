# Seamless year segments Phase 3A

Phase 3A keeps the seamless archive feature behind
`VITE_SEAMLESS_YEAR_SEGMENTS=1` and extends the Phase 2 two-segment handoff into
a bounded moving window.

## Reclamation

A live adjacent year can be reclaimed only when it is mounted, fully outside the
viewport, beyond the 640 px safety margin, not the active year, not the current
visual-anchor year, not protected by player/restoration work, not pending load
work, and reclamation is needed to admit the next adjacent year.

The live segment is replaced with a `year-segment-spacer` section whose height is
the measured outer segment height for the current width. Rows and image elements
leave the DOM. The full year collection remains subject to the three-collection
LRU so spacer geometry can be recalculated while adjacent years are restored.

## Visual Anchor

Before a live/spacer transaction, the enabled path captures a stable visible
anchor near the top safe line. It prefers photo IDs, then row IDs, album IDs, and
finally year identity. It records the anchor top, year, album ID, photo ID, row
ID, container width, scroll position, generation, and adjustment.

After React commits the DOM change, the same anchor is measured again. The app
applies one `scrollBy` correction for the measured drift, then verifies the same
anchor on the next double animation frame. Stale verifications are ignored if a
newer correction supersedes them.

## Native Scroll Anchoring

Native `overflow-anchor` is disabled only inside
`.collection-shell[data-render-mode="segmented-year-window"]`. The default
feature-disabled year-window path keeps the existing browser behavior. This
prevents browser scroll anchoring and the manual visual-anchor correction from
double-compensating the same segment mutation.

## Restoration

When the user approaches a spacer, the existing bounded year cache is used to
dedupe or retrieve the year collection. The spacer remains in place if loading
fails. When the collection is ready, the spacer is replaced by the live segment
without adding history entries or changing the active year. Passive handoff still
uses `replaceState` only when the stable anchor actually crosses into the live
year.

## Resize

Layout compactness is keyed to container width changes, not height-only browser
chrome changes. Width changes rebuild active, adjacent, and retained-spacer row
plans from `buildYearSegmentLayout`. Spacer height deltas are applied through the
same visual-anchor correction path. Same-width height changes preserve spacer
height.

## Scale Measurements

Synthetic metadata-only tests create no image elements:

- 100,000 photos: 3,764,122 px at 1024 px viewport, 5,758,602 px at 390 px.
- 250,000 photos: 9,373,862 px at 1024 px viewport.
- 50 synthetic years with 5,000 photos each: 9,514,700 px total projected
  spacer/document height.
- Safety budget used by the local projection test: 24,000,000 px.

The projection stays under the local Chromium safety budget. Physical WebKit
scroll-height precision remains a Phase 3B device-validation item.
