# Year-windowed archive

The archive browsing surface renders one active year. Its justified layout is virtualized to the visible rows plus directional overscan. Changing years replaces the mounted grid; inactive years contribute no rows, photo tiles, or image elements.

The global scrubber is built from `catalog.json` and the three year indexes. Those indexes total 536,496 bytes uncompressed and contain stable IDs, album labels, ordering, and counts. Album photo manifests are loaded only after a navigation target is committed. Pointer movement previews a target label without fetching, mounting, changing the URL, or writing browser history.

Full year collections use a two-entry LRU: the active year and the most recently used year. Loading a third collection evicts the least recent collection while preserving its lightweight index. Only the active collection is turned into a rendered layout, so retained layouts have a capacity of one. A new committed target aborts any obsolete manifest request.

`navigateToArchiveTarget` handles initial URLs, committed scrub targets, year buttons, boundary controls, browser history, and player-close restoration. Explicit year changes use one history entry per committed target. Back and Forward use the entry's versioned stable anchor. The `year-window-archive-v1` anchor stores a year, album ID, photo ID, and adjustment bounded to 160 px; no archive-wide pixel position is stored.

Year boundaries are accessible `Continue to …` rows. The older-year boundary opens the next year at its beginning. The newer-year boundary restores a saved stable photo when one exists and otherwise begins at the final album. This avoids relying on raw overscroll behavior across touch, wheel, and keyboard input.

## Production-build measurements

Measurements used Chromium's production build, forced garbage collection, and traversal through all three years more than once. The mobile run also changed between 390×844 and 844×390 ten times before settling.

| Profile | Mounted years | Rows | Tiles | Loaded images | HTML elements | DOM nodes | JS listeners | JS heap used / allocated |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Desktop 1440×900 | 1 | 8 | 54 | 54 | 167 | 268 | 315 | 6.7 / 7.3 MB |
| Mobile emulation after 10 rotations | 1 | 19 | 64 | 64 | 198 | 309 | 345 | 8.0 / 8.6 MB |

Both runs retained two collection-cache entries, one active layout, zero inactive-year image elements, and two registered archive observers. Diagnostic warning events remained at zero. An additional 30-orientation stress pass settled at 16 rows, 55 tiles, 267 DOM nodes, 318 JavaScript listeners, and 7.0 MB used heap, showing that the footprint did not grow with each resize.

These measurements validate the bounded architecture in desktop Chrome and mobile emulation. Physical iPhone Safari and Chrome acceptance remains required before treating the original WebKit content-process failure as fixed.
