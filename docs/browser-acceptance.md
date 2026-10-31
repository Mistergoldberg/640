# Browser acceptance contracts

`npm run test:browser` is the deterministic current-catalogue gate. It builds and starts its own strict-port server, rejects an unrelated process already using the port, verifies `dist/build-identity.json`, derives years and representative photos from `public/data`, and stubs public media with a synthetic JPEG. It covers newest-year selection, bounded rendering, adjacent navigation, Back/Forward, oldest-year restoration, photo deep links, player open/close, portrait/landscape decoding, normal/debug diagnostic visibility, redacted clipboard export and malformed-catalogue retry recovery.

The synthetic image boundary makes this gate deterministic. It does not verify real R2 bytes, caching, metadata privacy, live SoundCloud, native WebKit/fullscreen, or physical iPhone behavior.

The older `*.pw.ts` suites remain as historical feature-focused coverage but are not part of the default gate: many encode the former 2001/2002/2013 fixture without supplying that fixture. They must either receive an explicit three-year fixture server or be migrated to catalogue-derived inputs before rejoining acceptance. They are not silently counted as passing or skipped by the default command.

To test an already running QA server, set both variables. Identity verification is mandatory:

```sh
PIXILATION_PLAYWRIGHT_BASE_URL=https://qa.example/ \
PIXILATION_EXPECTED_BUILD_COMMIT=<40-character-source-sha> \
npm run test:browser
```

Feature flags accept `1` or case-insensitive `true` in application and historical-suite test selection. The current default gate records both retained flags as disabled. Enabled-variant migration remains a separate acceptance package.
