# Buffered homepage autoplay

The homepage autoplay feature is compile-time gated by
`VITE_HOMEPAGE_AUTOPLAYER=1` and defaults off. It is independent of
`VITE_SEAMLESS_YEAR_SEGMENTS`.

An eligible entry is `/` with no `year`, `photo`, or `debug` parameter. A `v`
cache-busting parameter is allowed. Eligibility is captured before initial
archive routing adds its stable year state. Closing the automatically opened
player suppresses another automatic opening until the document is reloaded.

The current catalogue's first ordered year and that year's first collection
photo are authoritative; no year, album, or photo ID is hardcoded. Automatic
opening neither requests native fullscreen nor adds a photo URL/history entry.

The player uses its existing decoded-image cache. It requests frames 1–5 first,
shows the first usable decoded frame, and waits until that bounded group has
settled. Usable frames ping-pong without duplicate endpoints while frames 6–15
decode. Stage 2 likewise ping-pongs its usable ordered frames while the normal
forward window is established. It then ends on frame 6 and ordinary forward
playback begins at frame 7. Failed frames are excluded after their existing
bounded load result; short groups use their available ordered frames.

Manual navigation exits warm-up and retains the normal delayed automatic
resume. Explicit pause does not restart warm-up. Speed changes retain the
current phase. Closing clears timers, event handlers, and cache entries through
the established player cleanup and restores the current stable photo anchor.

## Resource accounting

Player preloads and document images are different resource classes. Each
decoded player-cache entry owns an off-DOM `Image` object created with
`new Image()`; those objects are not included in `document.images` or
`document.querySelectorAll("img")`. The player itself renders one connected
current-frame `<img>` and does not retain a hidden previous frame or crossfade
image.

The archive remains mounted beneath the inert player so that closing restores
the stable archive position. At the 1440×900 browser-test viewport, its bounded
virtual window can contain 45 connected thumbnail `<img>` elements after a
reload. The expected settled connected-DOM composition is therefore at most 45
archive thumbnails plus one current player frame, or 46 total. This total is
independent of the player cache's separate 45-entry steady warm-up window.

Resource gates must report and bound player cache entries, connected player
images, connected archive images, inactive/spacer images, and total connected
DOM images independently. A close removes the current player frame immediately
and clears the cache's handlers and ownership. Unreferenced preload objects may
remain observable until normal garbage collection, so their pre-GC presence is
not itself a retained-resource leak.
