# Browser acceptance contracts

`npm run test:browser` is the deterministic default current-catalogue gate. It builds and starts its own strict-port server, rejects an unrelated process already using the port, verifies `dist/build-identity.json`, derives years and representative photos from `public/data`, and stubs public media with a synthetic JPEG. It covers newest-year selection, bounded rendering, adjacent navigation, Back/Forward, oldest-year restoration, photo deep links, player open/close, portrait/landscape decoding, normal/debug diagnostic visibility, redacted clipboard export and malformed-catalogue retry recovery.

The synthetic image boundary makes this gate deterministic. It does not verify real R2 bytes, caching, metadata privacy, live SoundCloud, native WebKit/fullscreen, or physical iPhone behavior.

`npm run test:browser:matrix` selects the default gate plus `optional-feature-acceptance.pw.ts` for exactly one supplied flag profile. CI invokes all four profiles. The migrated suite covers autoplay eligibility/exclusions, failed-frame warm-up and normal playback, explicit pause, manual navigation, close/reload cleanup, segmented passive/explicit history, cancellation, retry, reclamation, stable resize/orientation corrections, bounds and the combined close/restoration/handoff path. SoundCloud is blocked; no third-party request is required.

The acceptance reporter prints `PIXILATION_ACCEPTANCE_SUMMARY` with the profile and passed/failed/skipped totals. It changes the run to failure when no test passes or any selected case skips. The older `*.pw.ts` suites remain historical feature-focused evidence outside both gates because many encode the former 2001/2002/2013 fixture without supplying that fixture. They are not silently counted.

To test an already running QA server, set both variables. Identity verification is mandatory:

```sh
PIXILATION_PLAYWRIGHT_BASE_URL=https://qa.example/ \
PIXILATION_EXPECTED_BUILD_COMMIT=<40-character-source-sha> \
npm run test:browser
```

Feature flags accept `1` or case-insensitive `true`. The default gate records both retained flags as disabled. For a local matrix profile, set both flags, set a descriptive `PIXILATION_ACCEPTANCE_PROFILE`, then run `npm run test:browser:matrix`. Set `PIXILATION_EXPECT_CLEAN_BUILD=1` when the artifact must come from a clean exact source commit.
