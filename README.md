# 640 / Pixilation.org

Public, read-only photo archive and player built with React, TypeScript and Vite.

Start with [the 2026-10-31 audit and source baseline](docs/audit-baseline-2026-10-31.md) and [working instructions](AGENTS.md). The source baseline is d519413e6c676e93a4538ef0814f063b4f091606: 24 years, 137 albums and 66,170 photos. These describe the audited snapshot; future catalogues may differ.

## Local application work

```sh
npm ci
npm test
npm run build
npm run test:browser
npm run dev
```

Use the committed lockfile and record the Node/npm versions used. A supported runtime version still needs to be established in repeatable CI.

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

`npm run test:browser` is the deterministic current-catalogue gate. Historical feature suites with former three-year assumptions remain outside that default gate until supplied with their explicit fixture or migrated.

## Documentation

[Audit and feature register](docs/audit-baseline-2026-10-31.md) records the source baseline. [Repair state](docs/repair-state-2026-10-31.md) and the [findings register](docs/findings-register.md) track subsequent work. [deployment.md](docs/deployment.md), phase reports and the iOS audit contain historical material; do not use them as current publication authority.
