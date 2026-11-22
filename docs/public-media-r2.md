# Public media boundary

This repository does not provide a supported R2 planning or publication command. The former broad uploader, dry-run command and legacy importer are retired fail-closed because they do not consume the current sealed package authority. Historical upload instructions must not be used as a current runbook.

Public media consists only of approved display and thumbnail JPG derivatives referenced by the committed catalogue. Original photographs, private inventories, EXIF/GPS, credentials, import reports and caches remain outside Git, `dist`, public hosting and R2.

The authoritative workflow is the separately controlled `pixilation-import-plan` package process described in [publication-authority.md](publication-authority.md). Publication requires owner authority bound to an exact sealed package, package-bound credentials, a closed-world payload, a durable receipt and a sealed application candidate. This repository neither creates those records nor writes R2.

`npm run release:audit` remains a supported read-only local verifier. It enforces the committed cv1 key contract and checks an available approved derivative tree. In an isolated checkout without that tree, the expected result is the explicit missing-media-root blocker. Zero unsafe catalogue keys does not prove remote existence, byte hashes, metadata privacy, cache headers or decodability.

Never place credentials in source, environment examples, logs or build artifacts; broaden an approved payload; use destructive synchronization; or infer publication authority from synthetic browser acceptance. Real-media and remote-delivery verification belongs to the exact QA candidate and does not clear until the approved package and receipt are available.
