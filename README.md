# 640 / Pixilation.org

Public, read-only photo archive and player built with React, TypeScript and Vite.

Start with [the 2026-10-31 audit and source baseline](docs/audit-baseline-2026-10-31.md) and [working instructions](AGENTS.md). The source baseline is d519413e6c676e93a4538ef0814f063b4f091606: 24 years, 137 albums and 66,170 photos. These describe the audited snapshot; future catalogues may differ.

## Local application work

```sh
npm ci
npm test
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
npm run build
npm run test:browser
npm run dev
```

Use the committed lockfile and the Node/npm versions pinned by `.nvmrc`, `package.json` and CI.

Production builds default to the public media host https://media.pixilation.org/. Development without VITE_MEDIA_BASE_URL expects an existing local generated/library directory; a fresh clone does not contain original photos or generated derivatives. To inspect the application against public media, set VITE_MEDIA_BASE_URL=https://media.pixilation.org/ for the local dev process. This makes read-only public media requests.

## Public build settings

| Setting | Default | Purpose |
| --- | --- | --- |
| VITE_APP_BASE_PATH | / | Application base path |
| VITE_MEDIA_BASE_URL | Production: https://media.pixilation.org/; development: local media | Public derivative origin |
| VITE_BUILD_COMMIT | local-uncommitted in diagnostics when omitted | Explicit build identity |
| VITE_HOMEPAGE_AUTOPLAYER | Off | Optional automatic homepage player |
| VITE_SEAMLESS_YEAR_SEGMENTS | Off | Optional moving year-segment window |

Feature switches accept 1 or case-insensitive true in application code. Query parameter debug=1 enables local diagnostic UI even in production builds. These public values must never contain credentials.

Builds use the runtime pinned in `.nvmrc` and write `dist/build-identity.json` with source, dirty state, runtime, lockfile, flags, catalogue and artifact identities. Browser acceptance starts its own strict-port build and verifies that manifest. See [browser acceptance contracts](docs/browser-acceptance.md).

## Release tooling status

The current catalogue uses content-versioned cv1 media keys. The release auditor now validates that exact contract. The legacy importer and broad uploader are retired fail-closed; their npm commands cannot import, plan or publish. Publication authority belongs to the sealed, package-bound workflow documented in [publication authority](docs/publication-authority.md).

`npm run test:browser` is the deterministic default current-catalogue gate. `npm run test:browser:matrix` adds current-catalogue-derived optional-feature acceptance for the feature settings supplied to that process. CI runs it once for each supported combination:

| Homepage autoplay | Seamless year segments | Environment |
| --- | --- | --- |
| Off | Off | `VITE_HOMEPAGE_AUTOPLAYER=0 VITE_SEAMLESS_YEAR_SEGMENTS=0` |
| On | Off | `VITE_HOMEPAGE_AUTOPLAYER=1 VITE_SEAMLESS_YEAR_SEGMENTS=0` |
| Off | On | `VITE_HOMEPAGE_AUTOPLAYER=0 VITE_SEAMLESS_YEAR_SEGMENTS=1` |
| On | On | `VITE_HOMEPAGE_AUTOPLAYER=1 VITE_SEAMLESS_YEAR_SEGMENTS=1` |

Each profile builds its own strict-port artifact and verifies source, dirty state when required, exact flags and the committed catalogue digest before testing. The acceptance reporter fails an empty selection or any skipped case. Older fixed-2013/2002/2001 suites remain historical evidence and are not counted by these commands.

Runtime loading enforces canonical catalogue/manifest paths, exact cv1 keys, bounded integer dimensions/counts/order, unique IDs, album membership and sequence consistency. Malformed catalogue data presents a public retry action; album failures remain isolated and retryable. Diagnostics remain available with `debug=1`, but copied/downloaded reports minimize browser information and redact URL values and error details. Whether production diagnostics remain a public support mode or become QA-only is still an owner decision.

SoundCloud API loading is bounded and concurrent calls are deduplicated. Failures clear retryable state, owned timers/listeners are cleaned up, and pressing Play music again makes one deliberate retry without a background retry loop.

## Documentation

[Audit and feature register](docs/audit-baseline-2026-10-31.md) records the source baseline. [Repair state](docs/repair-state-2026-10-31.md) and the [findings register](docs/findings-register.md) track subsequent work. [deployment.md](docs/deployment.md), phase reports and the iOS audit contain historical material; do not use them as current publication authority.
