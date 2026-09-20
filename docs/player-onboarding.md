# Player onboarding

## Purpose and scope

The player teaches first-time homepage visitors how to navigate photographs,
change playback speed, and explicitly start the optional soundtrack. It is part
of the normal application artifact; QA does not use a special onboarding build.

The onboarding does not change archive data, photograph order, speed values,
history semantics, year navigation, media loading limits, gesture meanings, or
the SoundCloud source.

## Eligibility and preference

Automatic onboarding is considered only for the existing
`homepage-autoplay` launch mode. Direct-photo, explicit-year, debug,
diagnostic, and ordinary archive/player entries are ineligible. It also requires
a usable photograph sequence and accessible local storage.

The completion preference is exactly:

```text
key: pixilation-player-onboarding-v1
value: 1
```

Only this versioned value suppresses automatic onboarding. Completion, Skip,
Close, Escape, or trusted player interaction during the demonstration writes the
value. Manual Help remains available regardless of the preference. The current
player instance also records completion, so a failed storage write cannot cause
the tour to repeat within that instance.

To test the new-visitor path in QA, remove the key in browser storage and reload
the homepage. To test a returning visitor, set it to `1` and reload. Do not use a
different build or feature flag.

## Readiness and timing

A frame is presented only after its connected image has loaded, decoded, and
crossed two animation frames. Repeated load notifications for the same photo do
not count. The first distinct replacement frame is the first successful
transition and starts the foreground demonstration clock.

The automatic path uses all of these rules:

- pause after at least 2.4 foreground seconds and 12 successful transitions;
- if delivery is slow, pause after 5 foreground seconds once at least two
  successful transitions have occurred;
- cancel automatic onboarding after 8 foreground seconds if a second
  transition has not occurred;
- cancel the waiting state after 15 seconds if no usable transition begins;
- do not count time while the document is hidden.

Trusted player input while waiting or demonstrating completes onboarding and
leaves the visitor's action in control. Slow, failed, empty, unmounted, or
navigated-away sequences do not force a tutorial over an unusable player.

## Tutorial and playback coordination

The state path is:

```text
ineligible -> waiting-for-player -> demonstrating -> paused
  -> instruction-1 -> instruction-2 -> instruction-3 -> completed
```

The player pauses before the first instruction. The three steps use the real
interface:

1. The photograph surface teaches left/right navigation, holding, arrow keys,
   and desktop wheel direction.
2. The real speed control teaches the existing 0.1s, 0.25s, 0.5s, 1s, and 2s
   values.
3. The real music control explains that SoundCloud is optional and is never
   loaded or played without a user action.

Only the current real target, its open speed choices, and tutorial controls are
interactive. Back, Next, Skip, Close, Escape, progress indicators, and the final
`Play the pictures` action are available. Manual Help captures whether playback
was active, pauses cleanly, and restores that state on ordinary exit.

For visitors requesting reduced motion, automatic homepage playback is paused
from its first usable frame and the demonstration is omitted. Skip, Close, and
Escape leave playback paused, including during a Help replay. Only the explicit
Play control or final `Play the pictures` action starts photographs moving.

## Responsive and accessible behavior

Copy is capability-based: fine-pointer visitors receive desktop mouse, wheel,
and keyboard instructions; coarse-pointer visitors receive tap and hold copy.
The card and spotlight recalculate for resize, orientation, and visual viewport
changes. Mobile landscape preserves the existing right-hand control rail; small
portrait layouts retain 44-pixel control targets.

The player remains the modal dialog and the tutorial is a labelled non-modal
guided dialog inside it. Focus enters the highlighted real target, Tab and
Shift+Tab cycle through the target and tutorial controls, Escape exits, each step
is announced, and focus returns to the player surface or Help control. Numbered
progress and text prevent color from carrying meaning alone. Reduced-motion CSS
removes tutorial animation and transitions.

## Verification

Unit coverage lives in `src/player/playerOnboarding.test.ts` and
`src/player/playerReducer.test.ts`. Browser coverage lives in
`browser-tests/player-onboarding.pw.ts`; the existing homepage-autoplayer suite
preloads the completed preference so it continues to isolate player startup and
resource behavior.

Run the standard and enabled-mode matrices separately:

```sh
npm test
npx playwright test
VITE_HOMEPAGE_AUTOPLAYER=1 npx playwright test \
  browser-tests/homepage-autoplayer.pw.ts \
  browser-tests/player-onboarding.pw.ts
```

The deployable artifact is built with the existing homepage autoplay setting:

```sh
VITE_HOMEPAGE_AUTOPLAYER=1 \
VITE_APP_BASE_PATH=/ \
VITE_MEDIA_BASE_URL=https://media.pixilation.org/ \
npm run build
```
