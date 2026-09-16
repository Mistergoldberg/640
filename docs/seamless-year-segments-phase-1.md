# Seamless year segments Phase 1

Phase 1 adds the disabled-by-default foundation for bounded seamless year
segments. The production path remains the existing one-year `YearWindowGrid`
unless `VITE_SEAMLESS_YEAR_SEGMENTS` is explicitly enabled.

Run the local foundation path with:

```sh
VITE_SEAMLESS_YEAR_SEGMENTS=1 npm run dev
```

or with a production preview build:

```sh
VITE_SEAMLESS_YEAR_SEGMENTS=1 npm run build
VITE_SEAMLESS_YEAR_SEGMENTS=1 npm run preview
```

There is intentionally no query-string switch for this flag.

The authoritative geometry function is `buildYearSegmentLayout`. It consumes
the loaded year collection, measured grid width, target row height, row gap, and
compact-viewport state. Rendering and precomputed segment height use this same
row plan, so there is no separate estimated layout path.

The segment controller is pure TypeScript state. It models active, adjacent, and
spacer segments; enforces at most two mounted segments; limits retained full
collections to three; rejects stale completions; and keeps the visual-anchor
segment unreclaimable. Phase 1 does not perform live scroll handoff, automatic
adjacent prefetch, above-viewport removal, scroll compensation, or any catalogue
or media schema change.

Existing `Newer photos` and `Older photos` controls remain the production safety
boundary and stay visible with the feature disabled.
