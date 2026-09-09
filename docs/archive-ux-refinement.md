# Archive UX refinement

## Baseline at `f0d33f6`

The global timeline is derived from `catalog.json` and the lightweight year indexes. Years are ordered newest to oldest, weighted by photo count with a minimum year share, and subdivided by album counts. The active thumb position is calculated from the visible album and the year-local scroll progress; it does not use inactive-year document geometry.

The timeline has a full-height pointer region at the right edge. Pointer movement is scheduled through one animation frame and updates only a preview target. Pointer release resolves a snapped target and calls the shared archive navigation action once. Passive archive scrolling updates the active ratio without writing history. Keyboard arrows move through timeline anchors, Page Up and Page Down move between years, and Home and End select the first and final archive positions.

The strange mobile appearance came from a presentation override rather than the timeline model. At widths below 620px, the 44px desktop hit region grew to 62px, the visible thumb became a 20×42px white half-pill positioned 2px beyond the right edge, and large white year buttons appeared over the archive during interaction. The outer timeline also carried `touch-action: none`, and lost pointer capture recorded diagnostics without completing drag cleanup.

## Refined interaction

The refined timeline keeps a 56px invisible interaction region and a separate 18×28px visible thumb. The rail and thumb remain inside the right safe area, while archive content reserves a narrow gutter for the visible rail. Drag and hover labels use one bounded `year · album` line to the left of the rail. Year ticks remain stronger than album ticks; large floating year buttons are removed.

Pointer capture now ends through one cleanup path for release, cancellation, lost capture, resize, and orientation changes. Preview remains local UI state: it does not fetch manifests, mount a year, write history, or change restoration. A successful release performs one shared navigation action.

Year boundaries use compact directional controls: `↑ Newer photos: YEAR` above the active year and `Older photos: YEAR ↓` below it. New-year landing positions the inline year heading at the viewport target so the upper boundary remains above the viewport. Sticky year and album context appears only after the corresponding inline heading has left the header region.
