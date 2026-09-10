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

The physical-device UDX review uses a full-viewport photograph with a compact
vertical control rail for coarse-pointer landscape viewports up to 460px high:

```text
[ close ] [ photograph                                               ]
[ back  ] [                                                          ]
[ next  ] [             full viewport height                         ]
[ play  ] [                                                          ]
[ share ] [                                                          ]
[       ] [                                             ] [ music ]
[       ] [                                             ] [ speed ]
```

The media stage spans the complete dynamic viewport from top to bottom. Images
in fit mode use that full height whenever their aspect ratio allows it. The rail
overlays the left letterbox area instead of reserving horizontal or vertical
chrome, maximizing the photograph on both 844×390 and 667×320 screens.

The player measures the full media-stage rectangle after mount and through the
existing resize/orientation cycle, including visual-viewport resize events.
Portrait and desktop retain their existing full-viewport stage and horizontal
bottom controls.

## Control hierarchy and constrained height

The left rail reads top to bottom as Close, Previous, Next, Play/Pause and Share.
Music and Speed form a second rail at the bottom right. Play/Pause and Speed
retain the primary light treatment, while every action keeps a minimum 44×44px
touch target. The image counter and Screen Mode control are hidden only in this
compact landscape layout because neither is needed there; both remain available
in portrait and desktop layouts.

Speed shows the current compact value. Its five 44px choices open as a vertical
stack immediately to the left of the right rail. Selection closes the menu
and leaves the photograph index, opening delay, resume timer and pause state in
the existing reducers. Escape, outside pointer/focus, window blur, resize and
orientation change dismiss the menu without changing image geometry.

## Orientation state

Rotation changes only layout and measured stage geometry. The `PhotoPlayer`
component and its player/control reducers remain mounted, preserving the year,
stable archive restoration state, exact photograph, speed, playback and explicit
pause state, opening delay, manual-resume timer, fit/expanded mode, music state
and browser history. Fullscreen is not requested again during rotation.

## Regression validation and QA

Focused Playwright coverage uses 844×390, 667×320, 390×844 and 1440×900
viewports. It checks the full-height stage, all touch bounds, vertical hierarchy,
both photo orientations, fit/expanded containment, the vertical speed menu,
landscape counter and Screen Mode suppression, timing behavior, sharing, SoundCloud loading,
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
