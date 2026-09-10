# Mobile landscape player

## Baseline and overlap cause

The accepted `76ae730` player rendered one full-viewport absolute photo surface.
The close/counter bar, transport controls, speed menu, buffer status and progress
bar were fixed above that same surface. Its coarse-landscape media query moved
the seven-button horizontal cluster toward the lower right, but reserved no
layout space for it. Image geometry also used the full window with a generic
control clearance. The controls therefore extended across the photograph even
though their own bounds remained inside the viewport.

## Landscape architecture

The initial left-rail revision kept the photograph clear but stacked too many
controls, hid Share, Music and Screen Mode behind More, and put the counter in
the rail. The physical-device UDX review replaced it with a bounded three-row
frame for coarse-pointer landscape viewports up to 460px high:

```text
[ top action and status bar ]
[ clipped photograph stage ]
[ speed bar                 ]
```

The top and bottom rows are black player chrome outside the photograph. Each is
56px high plus its corresponding safe-area inset, reduced to 52px on viewports
up to 340px high. The middle `minmax(0, 1fr)` media stage receives the full width
and remaining dynamic viewport height. The photo surface fills only that stage,
so fit and expanded images cannot render under any control or status element.

The player measures the media-stage rectangle after mount and through the
existing resize/orientation cycle, including visual-viewport resize events.
Centralized image geometry receives that measured width and height. Fit mode may
letterbox inside the stage; expanded mode may crop only at the stage boundary.
Portrait and desktop continue to use the existing full-viewport stage and
horizontal bottom controls.

## Control hierarchy and constrained height

The top row reads left to right as Close, Previous, Next, Play/Pause, Share,
Music and Screen Mode. The counter is independently anchored at the top right.
All functionality is directly visible; landscape has no More state. Play/Pause
retains the primary light treatment, while every action keeps a minimum 44×44px
touch target.

Speed is the only action in the bottom row and is anchored at the bottom right.
It shows the current compact value. Its five 44px choices open horizontally to
the left within the same bottom row, never over the media stage. Selection
closes the menu and leaves the photograph index, opening delay, resume timer and
pause state in the existing reducers. Escape, outside pointer/focus, window
blur, resize and orientation change dismiss the menu without changing the
media-stage rectangle.

## Orientation state

Rotation changes only layout and measured stage geometry. The `PhotoPlayer`
component and its player/control reducers remain mounted, preserving the year,
stable archive restoration state, exact photograph, speed, playback and explicit
pause state, opening delay, manual-resume timer, fit/expanded mode, music state
and browser history. Fullscreen is not requested again during rotation.

## Regression validation and QA

Focused Playwright coverage uses 844×390, 667×320, 390×844 and 1440×900
viewports. It checks chrome/stage separation, all touch bounds, visible hierarchy,
both photo orientations, fit/expanded containment, the speed menu, direct access
to Share, Music and Screen Mode, timing behavior, sharing, SoundCloud loading,
close restoration, Back/Forward, portrait/desktop structure, and 30 player
rotations with stable listener, observer, history and DOM counts.

Run the complete gate from `640/app`:

```sh
npm test
npm run test:browser
VITE_APP_BASE_PATH=/ VITE_MEDIA_BASE_URL=https://media.insertcatchytitlehere.com/ npm run build
npm run release:audit
npm run media:upload:dry-run
```

The QA deployment uses a new immutable server release and changes only
`qa-current`. Production, Nginx configuration, Cloudflare configuration and R2
remain unchanged. Public QA must pass the same landscape, portrait, desktop,
direct-link, history and player checks before physical acceptance. Physical
Safari and Chrome acceptance on the iPhone 17 running iOS 26.6.1 remains Jared's
final step.
