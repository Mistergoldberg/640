# Player onboarding

## Purpose and scope

The permanent Help control teaches visitors how to navigate photographs, change
playback speed, and explicitly start the optional soundtrack. It is part of the
normal application artifact; QA does not use a special onboarding build.

The onboarding does not change archive data, photograph order, speed values,
history semantics, year navigation, media loading limits, gesture meanings, or
the SoundCloud source.

## Help-only entry

Onboarding never opens automatically. Homepage visits retain the original
autoplay sequence without an instructional pause. Direct-photo, explicit-year,
debug, diagnostic, and ordinary player entries behave the same way. The visitor
must press the permanent `?` Help control to open the tutorial.

The former versioned completion preference is retained for storage compatibility:

```text
key: pixilation-player-onboarding-v1
value: 1
```

Tutorial completion, Skip, or Escape may write this value, but it no
longer controls entry. Missing, present, unavailable, or stale storage values
all produce the same landing behavior: no tutorial until Help is pressed.

QA must verify this with the value absent as well as set to `1`; both cases must
autoplay without opening instructions. No alternate build or feature flag is
used.

## Tutorial and playback coordination

The state path is:

```text
ineligible -- Help --> paused
  -> instruction-1 -> instruction-2 -> instruction-3 -> completed
```

Pressing Help pauses the player and starts a seven-frame sequence. Each frame is
held for exactly 700ms:

1. `Next` receives a gloss-and-press animation and advances one photograph.
2. `Previous` receives the same animation and returns one photograph.
3. `Next` animates and advances once more.
4. `Previous` animates and returns once more.
5. The real speed control is highlighted with a centered `Adjust Speed` box.
6. The real music control is highlighted with a centered `Add Music` box.
7. A centered `Tap to play` box presents the final Play action.

After the final frame, the tutorial completes and photograph playback starts.
SoundCloud remains optional and is never loaded or played by the sequence.

Only the current real target, its open speed choices, and tutorial controls are
interactive. A single compact action bar contains `Skip` beside the current
blue next action: `Speed`, `Music`, or `Play`. Escape is also available. Manual
Help captures whether playback
was active, including during the initial loading/warm-up state, pauses cleanly,
and restores that state when Skip or Escape exits early. Automatic completion
defaults to Play. Player controls are interactive again as soon as the tutorial
closes.

For visitors requesting reduced motion, automatic homepage playback is paused
from its first usable frame and the demonstration is omitted. Skip and Escape
leave playback paused, including during a Help replay. Only the explicit
Play control or final tutorial `Play` action starts photographs moving.

## Responsive and accessible behavior

Copy is capability-based: fine-pointer visitors receive desktop mouse, wheel,
and keyboard instructions; coarse-pointer visitors receive tap and hold copy.
The spotlight and control callouts recalculate for resize, orientation, and
visual viewport changes. Mobile landscape preserves the existing right-hand control rail; small
portrait layouts retain 44-pixel control targets. Portrait places permanent
Help at the top left and Close at the top right. The photograph number counter
is not displayed in any player layout.

There is no large instruction card. The three control prompts use compact,
rounded boxes centered in the viewport: `Adjust Speed`, `Add Music`, and
`Tap to play`. A top-center, two-part rounded action bar keeps `Skip` on black
and the next action on blue without covering the teaching graphic. Screen
readers still receive the step title, explanatory copy, and exact step number.

Mobile supporting graphics explain the action at the point of use. Step 1
plays `Next, Previous, Next, Previous` with one real photograph transition per
700ms frame. The active cue receives a moving gloss, press, and ripple while the
other cue recedes. Steps 2 and 3 apply a restrained pulse to the live control
while the centered rounded box names the action. Only one cue asks for attention
at a time. In mobile landscape, the Previous and Next cues
are anchored in the lower corners, clear of the top-center action bar.

The player remains the modal dialog and the tutorial is a labelled non-modal
guided dialog inside it. Focus enters the highlighted real target, Tab and
Shift+Tab cycle through the target and tutorial controls, Escape exits, each of
the seven frames is announced with its numeric position, and focus returns to the player surface
or Help control. Text labels prevent color from carrying meaning alone.
Reduced-motion CSS removes every tutorial highlight, ripple, pulse, and
transition while retaining the same labels and static outlines.

## Verification

Unit coverage lives in `src/player/playerOnboarding.test.ts` and
`src/player/playerReducer.test.ts`. Browser coverage lives in
`browser-tests/player-onboarding.pw.ts`; it verifies that homepage autoplay
never opens the tutorial and that only the permanent Help control does so.

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
