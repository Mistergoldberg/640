> Historical evidence: this document describes earlier commits and datasets. Start with [the current source audit and baseline](audit-baseline-2026-10-31.md); verify current release identity, catalogue and tooling before following operational commands below.
>
> Current repair note: legacy import and broad-upload commands below are retired fail-closed. Use [publication authority](publication-authority.md), [repair state](repair-state-2026-10-31.md), and [browser acceptance](browser-acceptance.md) for current operational boundaries. No production action is authorized by those local repair documents.

## Current release-candidate conditions

The deployment narrative below is dated historical evidence for its stated 2026-09 release. It is not evidence for the current 24-year catalogue or stacked repair branches. A future candidate must first be integrated at one clean reviewed commit, record exact public flags and `dist/build-identity.json`, pass the quality job and all four current-catalogue browser profiles, and pass `npm run release:audit` against the approved derivative tree. It must then pass real-media, production-equivalent header/cache, rollback and physical iPhone/WebKit checks in QA. Synthetic media, a green draft-PR matrix, or the historical rollback path cannot independently authorize promotion.

As observed on 2026-11-01, GitHub `main` had no branch protection and the repository had no rulesets. Actions was enabled for all actions without SHA-pinning enforcement. These are observations, not desired-policy enforcement; no administration setting was changed.

# 640×480 deployment

## Status

Wrangler OAuth authentication succeeded and the Cloudflare zones are confirmed
active and not paused. R2 is enabled. After verifying that the account had no
buckets, `insertcatchytitlehere-media` was created with Standard storage. Its
custom domains `media.pixilation.org` and
`media.insertcatchytitlehere.com` are enabled with active ownership and SSL,
minimum TLS 1.2; the `r2.dev` endpoint is disabled. Bucket-specific S3 credentials are saved locally with restricted permissions.
Media publication is complete: 22,722 objects, 605,516,997 bytes. Every remote key,
size and MD5 checksum matched the audited local library. Representative public
thumbnail/display downloads from all three years matched SHA-256 checksums and
returned `image/jpeg`. Public HEAD works; object listing is absent and public
PUT/DELETE return 401. No objects were deleted.

The first upload did not persist the requested cache metadata. A guarded S3
metadata replacement verified every existing object's checksum before copying
that same object to itself with an explicit four-hour cache policy. Each copy
used a matching-source ETag condition and preserved image bytes and modification
time. All 22,722 updates completed with unchanged ETags. Public samples now return
`Cache-Control: public, max-age=14400, must-revalidate`. The uploader now uses the
supported upload-header option and ordered filters for future publication.

The physically accepted year-windowed release was promoted to production on
2026-09-09 from application commit
`76ae7305660fb3e66189266bb30a2248af819c93`. The existing accepted QA artifact
was promoted directly: `/var/www/insertcatchytitlehere.com/current` and
`qa-current` both point to
`releases/20260909T221614Z-76ae730`. The previous production release,
`releases/20260906T150000Z-d8aff6f`, remains intact as the rollback target.
Nothing was pushed. Unrelated local website changes remained unstaged and
untouched.

Authenticated Cloudflare inspection confirmed the zone is active and uses its
assigned Cloudflare nameservers. The apex remains a proxied A record to
`5.161.223.134`. `www` was changed from a proxied A record to a proxied CNAME to
`insertcatchytitlehere.com`. SSL/TLS was changed from Full to Full (strict) after
validating the Cloudflare Origin Certificate. The R2-managed media record, mail
records, nameservers and unrelated records were not modified. DNSSEC is disabled
and was recorded without changing it.

The former domain-only document root was quarantined during cutover and deleted
only after origin and public validation passed. It contained 605 regular files
and 164,609,161 bytes. The content was not backed up and is no longer
recoverable. A root-only administrative inventory and the previous Nginx virtual
host remain under the domain-specific server backup.

Verified deployment results:

- All 64 Vitest tests and 40 production-build Playwright tests passed before
  cutover; TypeScript and the production root build passed.
- Jared accepted the exact QA release on a physical iPhone 17 running iOS
  26.6.1 in Safari and Chrome before promotion.
- Focused public production browser checks passed on desktop and iOS Safari and
  Chrome profiles. They covered bounded scrolling, year and photo deep links,
  Back/Forward, the scrubber and boundaries, sharing, fit/expanded modes,
  portrait and landscape layouts, SoundCloud, and browser errors. The measured
  opening delay was 3.088 seconds; manual resume was 5.128 seconds; explicit
  pause remained paused for a 5.4-second observation.
- Release audit: 22,722 JPG derivatives, 605,516,997 bytes, 11,361 photographs.
- No missing or unreferenced assets, decode failures, embedded metadata, unsafe
  asset keys, private manifest fields, or local source paths.
- Two reviewed album-label notices are the existing `2013-10-09/edit` and
  `2013-10-09/pixel` display labels.
- Upload dry run: 22,722 objects, 577.47 MiB, zero deletions, no upload.
- Validated root build: 21 files, 4,673,646 bytes; HTML, JS, CSS and JSON only.
  There is no generated photo library, source map, original image or secret.
- Server: Ubuntu 24.04.2 LTS, Nginx 1.24.0, approximately 14 GB available after
  deployment. Nginx remained active and reported no new journal or error-log
  entries during production validation.
- The former root was resolved from effective Nginx configuration,
  canonicalized and inventoried before deletion. Its parent contains unrelated
  material that was not touched. The new exact document root is the `current`
  release symlink above.
- The configured Cloudflare Origin Certificate covers the apex and wildcard,
  remains valid through December 2040, and verifies against Cloudflare's official
  Origin CA root. Full (strict) reports an active certificate with no validation
  errors.
- Public apex HTTPS returns the exact release HTML. HTTP redirects to HTTPS and
  `www` redirects to the apex while preserving paths and query strings. The
  media hostname remains attached to R2 with active ownership and SSL.

The exact server inventory and effective configuration are stored only in ignored
local `generated/reports/deployment-*` files with restricted permissions.
They are not part of the public build or Git checkpoint.

## Architecture and public/private boundary

The Pixilation deployment is a static React/Vite application at
`https://pixilation.org/`, served by the existing Nginx server. The legacy
release remains on the server for rollback history, but the public
`https://insertcatchytitlehere.com/` and
`https://www.insertcatchytitlehere.com/` hostnames now permanently redirect to
`https://pixilation.org/` while preserving paths and query strings. QA remains
available at `https://qa.insertcatchytitlehere.com/` and is not redirected.
Generated media belongs in the dedicated R2 Standard bucket
`insertcatchytitlehere-media`, exposed through
`https://media.pixilation.org/` for Pixilation. The old
`https://media.insertcatchytitlehere.com/` custom domain remains attached to R2,
but traffic to it now permanently redirects to `https://media.pixilation.org/`
with the same path and query string.

Only `generated/library/` may be uploaded as public media. Asset keys start
with `2001/`, `2002/` or `2013/`, without a local directory prefix. The server
receives only the static application `dist` payload. Current year totals are
6,669 for 2001, 479 for 2002 and 4,213 for 2013.

Original photographs, source-year directories, import reports and caches remain
on the local Mac. Originals contain private source information and are outside
the deliberately limited public derivative pipeline. They must never enter Git,
the server release or the public R2 bucket. Git ignores alone are not a release
boundary: always inspect the exact staged and upload payloads.

The application is public and read-only. It has no authentication, admin login,
database, permanent rotate tool or public mutation endpoint. Existing shared PHP
and database services on the server are not dependencies of this application and
must not be removed or reconfigured for other sites.

## Canonical public identity

The public canonical hostname is `https://pixilation.org/`. The production HTML
declares that root canonical URL, Open Graph URL and WebSite structured-data URL.
`robots.txt` allows crawling and references `https://pixilation.org/sitemap.xml`.
The sitemap intentionally lists only the root URL because this remains a static
SPA without per-photo server-rendered HTML or unique per-photo metadata. Query
state URLs such as `?year=2002&photo=...` are shareable application states, not
separate indexed documents.

## Local commands

Run from the repository root:

```sh
npm ci
npm run dev
npm test
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
npm run build
npm run test:browser
npm run test:browser:matrix # one explicitly supplied flag profile; CI runs all four
npm run release:audit
```

Development currently uses `/`; Vite serves the local generated library at
`/media/`. Leave `VITE_MEDIA_BASE_URL` unset to use local media. Audit output
goes to ignored `generated/reports/`.

## Production build

`src/lib/deploymentConfig.ts` centralizes deployment configuration. Development
defaults to `/` with local generated media. Production defaults to `/` and
`https://media.pixilation.org/`, with local-media middleware disabled.
Components obtain the base through Vite; history and sharing preserve the root
URL and query parameters. The explicit production command is:

```sh
VITE_APP_BASE_PATH=/ \
VITE_MEDIA_BASE_URL=https://media.pixilation.org/ \
npm run build
```

These are public values, never credentials. Record the exact final commit and
build file hashes before any server upload. Run `npm run preview` and validate
with public R2 media before switching the server.

## R2 publication

The broad uploader and its `media:upload` npm entry points are retired fail-closed.
They are historical evidence and are not a supported planning or publication
path. Current media publication must use the exact sealed package, owner authority,
package-bound credentials, durable receipt and candidate activation controls in
[publication-authority.md](publication-authority.md). This repository does not
mint those records or write R2. Never place credentials in Git or build artifacts,
upload a broader directory, or use a destructive sync.

## Server release and rollback

The active release is
`/var/www/insertcatchytitlehere.com/releases/20260909T221614Z-76ae730`. Its 21
files and 4,673,646 bytes matched the deterministic local SHA-256 manifest
exactly. Only HTML, JavaScript, CSS and JSON are present. The accepted artifact
retains its consistent QA-release ownership, with directories mode 0755 and
files mode 0644; `www-data` can read and cannot write them. The prior
`20260906T150000Z-d8aff6f` release remains unchanged for atomic rollback.

The Nginx virtual host was tested both in an isolated loopback listener and with
the complete enabled-site configuration. Cutover moved the former root into a
same-filesystem quarantine, activated the verified `current` release, installed
the prepared domain-specific virtual host, tested syntax and reloaded Nginx. The
quarantine remained available until all public checks passed, then was
permanently removed as authorized.

The active release is the known-good baseline for the next deployment. Future
deployments must upload a new `releases/<timestamp>-<commit>/` directory, verify
it, atomically change `current`, and test Nginx. Reload Nginx only when its
configuration changes. Keep this release until the next release passes. Atomic
rollback repoints `current` to the prior release; a symlink-only rollback does
not require an Nginx reload. The server backup retains the pre-deployment virtual
host and former-site inventory, but not the deleted site content.

## Hosting, caches and security

Nginx serves the Vite application directly from `current` at the apex. It
provides SPA fallback for application routes, while missing static assets,
manifests, Markdown, PHP and dotfiles return 404. HTTP redirects to canonical
HTTPS and `www` redirects to the apex. Directory listing is disabled and no Node
service or shared PHP change was introduced. Cloudflare uses Full (strict) with
the validated origin certificate. Nameservers, mail and unrelated DNS records
remain unchanged.

- `index.html`: no-cache or must-revalidate.
- Catalogue and JSON manifests: short cache or must-revalidate.
- Content-hashed JS/CSS: long-lived immutable cache.
- Stable media keys: conservative cache as described above.

Production responses include `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` and a
Permissions Policy disabling camera, microphone and geolocation. No CSP was
introduced. Browser validation confirmed that R2 images, SoundCloud, inline
geometry, clipboard sharing and application controls remain functional.

## Release validation

The public Cloudflare path passed deterministic HTTP checks for exact release
HTML, SPA refreshes, apex and `www` redirects, MIME types, 404s, public/private
boundaries and cache/security headers. Representative thumbnail and display
objects from 2001, 2002 and 2013 returned HTTPS 200 with `image/jpeg` and the
expected conservative cache policy.

The production browser run confirmed totals of 4,213 for 2013, 479 for 2002 and
6,669 for 2001. Direct year/photo loads, Back/Forward, normal scrolling, the
56px scrubber target and 18×28px visible thumb, single-commit drag behavior,
directional year boundaries, fit/expanded views, portrait/landscape decoding,
sharing and SoundCloud passed. After six year traversals and 30 orientation
changes, production retained one mounted year, one year layout, two cache
entries, two observers, 18 rows, 61 photo tiles, zero inactive-year images and
242 DOM nodes. There were no application/media request failures, console errors,
page errors, diagnostic bound warnings or new Nginx error-log bytes.

The promotion changed only the existing `current` symlink. QA remained on the
same accepted artifact. Nginx configuration, DNS, Cloudflare settings, TLS and
R2 were unchanged; the R2 dry run again reported 22,722 objects and zero
deletions with no upload.

The existing clean five-minute local playback result remains the long playback
baseline: 300 seconds, photograph 2,971 at 0.1 seconds per photograph, 3,057
image responses, no failed image requests, no page errors and zero sampled
buffering. The accepted artifact was promoted unchanged after physical QA, so
the long playback test was not repeated during the symlink-only promotion.

## Adding future years and curator corrections

The import commands in this repository are retired fail-closed and are not a
supported future-year or correction workflow. Use only the separately controlled,
package-bound authority described in [publication-authority.md](publication-authority.md).
That workflow must keep originals/private reports outside public output, seal and
approve the exact package, publish through package-bound credentials, and return a
durable receipt before an application candidate can be activated. The catalogue
drives navigation; do not hard-code a year list. No public admin or write capability
is authorized by this deployment.
