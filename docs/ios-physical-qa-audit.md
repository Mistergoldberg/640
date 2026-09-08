# Continuous archive iOS QA audit

## Scope and evidence status

This audit freezes commit `6212af362da6d72d2cf31d6acfd067b98c1bfc22` as the failed candidate and adds diagnostics without changing archive behavior. Chromium measurements below describe the implementation and its scaling characteristics. They do not establish Safari correctness. The architecture recommendation remains preliminary until the physical iPhone 17 report is captured in Safari and Chrome on iOS 26.6.1.

## iOS keep-mounted fallback

The fallback is selected by `requiresStableArchiveDom()` in `src/App.tsx`. Detection is user-agent based for `iPad`, `iPhone`, and `iPod`; it also treats `MacIntel` with more than one touch point as iPadOS. It is therefore a browser/platform sniff with a capability-assisted iPadOS clause, rather than a capability test for the scrolling behavior that failed.

Both paths build the same archive geometry and justified-row layout. Their rendering and loading policies materially diverge:

| Behavior | iOS/iPad stable path | Other browsers |
| --- | --- | --- |
| Entries rendered | Every entry for every loaded year | Entries intersecting the viewport plus 4,000 px overscan |
| Thumbnail hint | `loading="lazy"` | `loading="eager"` for the mounted window |
| Collection retention | Every loaded collection remains in the year-state map | Same data retention |
| DOM retention | All rows and photo tiles in loaded collections remain mounted | Off-window rows and tiles unmount |

Visited years are never evicted. When an adjacent year, scrub target, history target, or retry finishes, its collection remains in the cache. On iOS, all of its row, tile, and image elements also remain mounted.

The browser tests exercise desktop windowing, mobile Chromium windowing, and the stable path by supplying Safari and Chrome iPhone user-agent strings to Chrome. They do not run WebKit and do not reproduce iOS Safari's compositor scrolling, visual viewport behavior, memory policy, or scroll anchoring. They prove the two code branches can render in Chromium; they do not prove the fallback works on a physical iPhone.

Orientation changes rebuild layout for the new width. In the measurement below, row count changed but photo-tile count did not, so React replaced the layout without duplicating photos. Rebuilding thousands of entries remains expensive and the diagnostic report must show whether this coincides with a physical-device failure.

### Measured current archive

Measurement setup: Chrome headless, 390 × 844 CSS px, touch enabled, iPhone Safari user agent, all three current years loaded. This is a controlled implementation measurement, not a substitute for the requested physical WebKit run.

| Metric | Result |
| --- | ---: |
| Imported photos | 11,361 |
| Photo tiles / image elements mounted | 11,361 / 11,361 |
| Photo row or mosaic elements, portrait | 3,278 |
| Virtual entries, portrait | 3,295 |
| HTML elements, portrait | 26,109 |
| Chrome-reported DOM nodes, portrait | 37,563 |
| Document height, portrait | 463,909 px |
| JavaScript heap before full traversal | 35.0 MB used / 110.4 MB allocated |
| Complete images before full traversal | 160 of 11,361 |
| Complete images after traversing the archive | 11,360 of 11,361 |
| JavaScript heap after traversal | 96.9 MB used / 186.0 MB allocated |
| Photo tiles after landscape relayout | 11,361, with no duplicates |
| Rows after landscape relayout | 2,140 |

`loading="lazy"` delays most network and decode work at initial mount, but it does not remove image elements or their `src` values. After the test traversed the full document, 11,360 images reported complete. Browsers may discard offscreen decoded surfaces under pressure, so continued decoding is browser controlled rather than guaranteed. If every current 300 px thumbnail surface were resident as uncompressed RGBA at once, the calculated upper bound is about 3.03 GiB. That is not a claim of measured resident memory; it describes the pressure the browser must manage by evicting decoded surfaces.

### Forecast at 50,000 photos

Linear projection from the measured portrait DOM gives roughly 115,000 HTML elements and 165,000 total DOM nodes. Linear projection from the post-traversal JavaScript heap is about 426 MB used and 819 MB allocated, but actual values will vary because fixed application costs, garbage collection, browser-native DOM memory, and image caches do not scale uniformly. The uncompressed-thumbnail upper bound would be about 13.3 GiB if all 300 px decoded surfaces were resident, which forces aggressive cache eviction and repeated decode work well before that point.

The fallback grows with every visited year and photograph. It is unsuitable for the final archive.

## Architecture comparison

| Criterion | A. Giant virtual document | B. iOS keep-mounted fallback | C. Year-windowed archive with global scrubber |
| --- | --- | --- | --- |
| Required continuous feel | Direct, but depends on archive-wide pixel estimates | Direct while memory permits | Preserved through automatic year transitions and a global scrubber |
| iPhone reliability | High risk from changing heights, scroll anchoring, compositor timing, and corrections | Current physical failure remains; memory risk rises with use | Lower risk because the active scroll document is bounded |
| Desktop reliability | Existing tests cover it, though async height changes remain complex | Irrelevant as implemented | One shared bounded model can cover desktop and mobile |
| 50,000-photo scale | Data can be virtualized, but global height and offset errors compound | Unsuitable; DOM and memory grow with visits | Designed for bounded DOM and one-year scale |
| Memory / DOM | Bounded DOM if virtualization stays synchronized | Unbounded across visited years | Bounded to active year, optionally one prefetched neighbor |
| Restoration | Archive-wide pixel corrections plus stable-ID recovery | Same global restoration complexity | Restore by year, album, and photo ID within a bounded year |
| Testability | Requires async-height, anchoring, rapid-scroll, and restoration matrices | Requires browser-sniffed branches and physical memory tests | Shared path with explicit year-transition states |
| Accessibility | One document has familiar reading order, but virtualization complicates focus | Large DOM harms navigation and assistive technology | Needs announced automatic transitions and retained logical scrubber semantics |
| Implementation cost | Lowest only if current defects are solvable | Lowest immediate change, highest scaling debt | Moderate rebuild of archive navigation and restoration |
| Technical debt | High: estimated global offsets and correction logic | Highest: all Option A complexity plus browser divergence | Lower long term: bounded coordinates and shared behavior |

The preliminary direction is Option C: keep the archive-wide scrubber model, mount and virtualize the active year, optionally prefetch one neighbor, and transition automatically at year boundaries or direct scrub targets. This removes archive-wide absolute pixel restoration and gives iOS, Android, and desktop the same rendering model. A final recommendation and implementation plan should be made only after the physical diagnostic report identifies the actual failure sequence and confirms which viewport, pointer, restoration, or layout state diverges.
