# Seamless year segments Phase 2

Phase 2 keeps `VITE_SEAMLESS_YEAR_SEGMENTS` disabled by default and adds the
feature-flagged two-segment archive window.

Run the enabled path locally with:

```sh
VITE_SEAMLESS_YEAR_SEGMENTS=1 npm run dev
```

The enabled browser regression can be run with:

```sh
VITE_SEAMLESS_YEAR_SEGMENTS=1 npx playwright test browser-tests/segment-handoff.pw.ts
```

## Behavior

The active year still uses the deterministic row plan from
`buildYearSegmentLayout`. When the user approaches the active year's bottom
boundary, the older adjacent year is prefetched. When the user approaches the
top boundary, the newer adjacent year is prefetched. Opportunistic prefetch is
suppressed when `navigator.connection.saveData` is set, but required boundary
loading still runs.

Sentinels use a viewport-derived prefetch margin clamped between 560 px and
1600 px. Handoff uses a 96 px visual-anchor hysteresis band so small movements
near a boundary do not repeatedly rewrite the URL or flip the active year.

Passive automatic handoff updates the `year` URL parameter with
`history.replaceState`. Explicit controls, including the visible year-boundary
buttons, keep the existing push/history behavior.

## Temporary limit

Phase 2 intentionally supports only the active year plus one adjacent mounted
segment. It does not reclaim a live segment, remove above-viewport content, or
support unbounded repeated crossings. After two segments are mounted, the manual
boundary controls remain the path beyond the current two-year window.

Phase 3 should add deterministic spacer replacement, scroll compensation for
safe reclamation, repeated multi-year traversal, and physical iOS QA.
