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

Coarse-pointer landscape viewports up to 460px high now use a two-column player
grid. The first column is a black control rail whose total width is the left safe
area plus 68px. The second column is a `minmax(0, 1fr)` media stage with its own
clipped coordinate system and the full dynamic viewport height. The photo
surface fills only that stage, so fit and expanded images cannot render beneath
the rail. Progress and buffering chrome belong to the rail in this layout.

The player measures the media-stage rectangle after mount and through the
existing resize/orientation cycle, including visual-viewport resize events.
Centralized image geometry receives that measured width and height. Fit mode may
letterbox inside the stage; expanded mode may crop only at the stage boundary.
Portrait and desktop continue to use the existing full-viewport stage and
horizontal bottom controls.

## Control hierarchy and constrained height

Landscape controls are visually ordered as Speed, Previous, Play/Pause and Next.
The 56×44px Speed control is the first and most prominent item and shows the
current compact value. Play/Pause is 52×48px with the strongest treatment inside
the transport group; Previous and Next retain equal 44×44px targets.

The normal landscape rail keeps a 44×44px More control near the bottom. It
replaces the transport group with Music, Share and Screen Mode inside the rail;
Close and the compact counter remain in the lower rail. This keeps every
secondary action available in 844×390 and 667×320 layouts without scrolling the
rail or covering the image.

Speed selection is also rail-local. It temporarily replaces the lower controls
with the five existing 44px speed choices and a Done action. Selection closes
the menu and leaves the photograph index, opening delay, resume timer and pause
state in the existing reducers. Escape, outside pointer/focus, window blur,
resize and orientation change dismiss the menu without changing the media-stage
width.

## Orientation state

Rotation changes only layout and measured stage geometry. The `PhotoPlayer`
component and its player/control reducers remain mounted, preserving the year,
stable archive restoration state, exact photograph, speed, playback and explicit
pause state, opening delay, manual-resume timer, fit/expanded mode, music state
and browser history. Fullscreen is not requested again during rotation.

## Regression validation and QA

Focused Playwright coverage uses 844×390, 667×320, 390×844 and 1440×900
viewports. It checks rail/stage separation, all touch bounds, visible hierarchy,
both photo orientations, fit/expanded containment, speed and secondary menus,
timing behavior, sharing, SoundCloud loading, close restoration, Back/Forward,
portrait/desktop structure, and 30 player rotations with stable listener,
observer, history and DOM counts.

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
