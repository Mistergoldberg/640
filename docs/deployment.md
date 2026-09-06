# 640×480 deployment

## Status

Wrangler OAuth authentication succeeded and the Cloudflare zone is confirmed
active and not paused. R2 is now enabled. After verifying that the account had no
buckets, `insertcatchytitlehere-media` was created with Standard storage. Its
custom domain `media.insertcatchytitlehere.com` is enabled with active ownership
and SSL, minimum TLS 1.2; the `r2.dev` endpoint is disabled. Bucket-specific S3 credentials are saved locally with restricted permissions.
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

Phase 6 root-build and browser validation passed using public R2 media. No application release has been uploaded
to the server and no live traffic has switched.

The OAuth credential receives HTTP 403 for DNS record and zone SSL-setting reads;
those checks still require an appropriately scoped credential or verified
dashboard values. Only the dedicated R2 bucket, its generated derivative objects/cache metadata,
and media custom-domain configuration have been changed remotely. No server files, apex or `www` DNS records,
origin certificates, or live web-server configuration have been changed.
The obsolete site has not been quarantined or deleted.

The initial remediation checkpoint is
`fb345800b73bb612260c368f858c1201337a4034`
(`refactor: stabilize 640x480 player and navigation`). It was built locally after
commit; nothing was pushed. Unrelated website changes remain outside that commit.

Verified preflight results:

- 26 Vitest tests passed; TypeScript and the production root build passed.
- Browser checks with local derivatives passed selected-year metadata loading,
  all year totals, direct photo refresh, Back/Forward, share-link copying,
  fit/expanded modes, grid virtualization and desktop/mobile timeline navigation.
  Measured opening delay was about 3.12 seconds after a deliberately delayed
  decode. Five-second manual resume and persistent explicit pause passed.
  The same timing and sharing checks passed with public R2 media. SoundCloud
  loads its playlist. A SoundCloud cleanup crash and zero-size iframe canvas
  errors were corrected; history, refresh and console regression checks passed.
  Mobile touch navigation, portrait fit geometry and touch timeline scrubbing
  also passed. Production application-origin checks remain pending.
- Release audit: 22,722 JPG derivatives, 605,516,997 bytes, 11,361 photographs.
- No missing or unreferenced assets, decode failures, embedded metadata, unsafe
  asset keys, private manifest fields, or local source paths.
- Two reviewed album-label notices are the existing `2013-10-09/edit` and
  `2013-10-09/pixel` display labels.
- Upload dry run: 22,722 objects, 577.47 MiB, zero deletions, no upload.
- Validated root build: 21 files, 4,625,870 bytes; HTML, JS, CSS and JSON only.
  There is no generated photo library, source map, original image or secret.
- Server: Ubuntu 24.04.2 LTS, Nginx 1.24.0, approximately 14 GiB available.
- The domain root was resolved from effective Nginx configuration, canonicalized,
  and inventoried. It contains 605 regular files totaling 164,609,161 bytes. One
  internal dependency symlink resolves within that root. Its parent contains
  unrelated material and must never be cleaned as part of this deployment.
- The configured Cloudflare Origin Certificate covers the apex and wildcard and
  has validity dates through December 2040. Cloudflare's actual SSL mode and
  origin DNS target still require authenticated verification.
- Public apex HTTPS returns 200 and HTTP redirects to HTTPS. `www` currently
  returns 200 rather than redirecting to apex. Cloudflare nameservers and proxy
  responses are present. Authenticated zone status is active. The media hostname
  is now attached to the new R2 bucket with active SSL. Apex and `www` DNS record
  contents and zone SSL mode remain unverified because of the API responses above.

The exact server inventory and effective configuration are stored only in ignored
local `640/generated/reports/deployment-*` files with restricted permissions.
They are not part of the public build or Git checkpoint.

## Architecture and public/private boundary

The target is a static React/Vite application at
`https://insertcatchytitlehere.com/`, served by the existing Nginx server.
`https://www.insertcatchytitlehere.com/` must redirect to the apex.
Generated media belongs in the dedicated R2 Standard bucket
`insertcatchytitlehere-media`, exposed through
`https://media.insertcatchytitlehere.com/`.

Only `640/generated/library/` may be uploaded as public media. Asset keys start
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

## Local commands

Run from `640/app`:

```sh
npm ci
npm run dev
npm test
npm run build
npm run release:audit
npm run media:upload:dry-run
```

Development currently uses `/640/`; Vite serves the local generated library at
`/640/media/`. Leave `VITE_MEDIA_BASE_URL` unset to use local media. Audit output
goes to ignored `640/generated/reports/`.

## Production build

`src/lib/deploymentConfig.ts` centralizes deployment configuration. Development
defaults to `/640/` with local generated media. Production defaults to `/` and
`https://media.insertcatchytitlehere.com/`, with local-media middleware disabled.
Components obtain the base through Vite; history and sharing preserve the root
URL and query parameters. The explicit production command is:

```sh
VITE_APP_BASE_PATH=/ \
VITE_MEDIA_BASE_URL=https://media.insertcatchytitlehere.com/ \
npm run build
```

These are public values, never credentials. Record the exact final commit and
build file hashes before any server upload. Run `npm run preview` and validate
with public R2 media before switching the server.

## R2 publication

Cloudflare's official Wrangler OAuth login has completed. Credentials use the
local keychain-backed Wrangler storage. Do not place credentials in chat,
Git, build artifacts or this document. The existing uploader requires locally
configured R2 account, bucket, endpoint and bucket-scoped S3 credentials; it does
not automatically obtain those credentials from a Wrangler login.

The ignored local `640/generated/reports/configure-r2.command` helper collects
the Access Key ID and Secret Access Key through hidden Terminal input. It writes
only to `640/generated/.credentials/insertcatchytitlehere-r2.json` with mode 0600
in a mode 0700 directory. It refuses to overwrite existing credentials and does
not upload anything. That directory is outside the public-media upload source.

Before creating the bucket, inspect whether it exists and list its contents using
authenticated access. Stop before overwriting unexpected objects in a non-empty
bucket. Confirm R2 Standard storage, attach the media custom domain, and configure
public HTTPS GET/HEAD access without public listing or mutation.

Use the audited uploader:

```sh
npm run media:upload:dry-run
npm run media:upload
```

Execution requires `rclone`. Version 1.75.1 was downloaded from the official
release and its SHA-256 checksum verified; the binary is kept in ignored local
tooling. The script uses `rclone copy` with overwrite protection, explicit ordered
allowlist filters and zero deletes.
The overwrite guard is separate from HTTP caching: images are not served with
an immutable cache directive. The uploader sets:

```text
Content-Type: image/jpeg
Cache-Control: public, max-age=14400, must-revalidate
```

A local endpoint-only CONNECT tunnel was needed because one DNS address of the
S3 endpoint timed out from this Mac. The tunnel retries the endpoint addresses;
TLS verification and signing remain in rclone. It runs only for the child upload
process, binds to loopback and makes no global network changes. Credentials are
passed in the child environment and never sent through a third-party proxy.

Compare the authenticated remote count and bytes against the local audit. Check
representative checksums and public thumbnail/display URLs from every year.
Never upload a broader directory and never use `sync --delete`.

## Server release and rollback: pending

Re-read effective Nginx configuration immediately before mutation. Reconfirm the
domain's exclusive canonical root and save its exact inventory, byte count and
configuration privately. Never substitute its parent or follow an unexplained
symlink. Retain certificates, keys, configuration, logs, databases and other sites.

Prepare a fresh domain-specific `releases/<timestamp>-<commit>/` directory outside
the live root on the same filesystem. Upload only the validated static `dist`.
Compare every uploaded file against the local build inventory and hashes. Use
readable, non-writable permissions for the web-server process.

Prepare the minimum domain-specific Nginx change and test it before reload. Use an
atomic `current` symlink switch if compatible with the verified arrangement, or
an atomic same-filesystem rename of an adjacent staging directory. Do not copy
incrementally over the live site. Keep old content in a timestamped, domain-only
quarantine until public health checks pass.

Rollback before quarantine deletion restores the previous release pointer or
quarantined directory and the saved domain configuration; validate Nginx and
reload. Do not restart shared services. Delete only the exact verified quarantine
after successful production checks. Record its former size and acknowledge that
server recovery is unavailable after deletion unless a separate backup exists.

## Hosting, caches and security: pending

Use apex canonical HTTPS, HTTP-to-HTTPS and `www`-to-apex redirects, and Cloudflare
Full (strict) with validated origin TLS. Preserve nameservers, mail and unrelated
DNS records. Serve application routes statically with refresh support. Missing
static assets and manifests must return 404, not the application HTML. Disable
directory listing and access to private or obsolete paths. No Node proxy is needed.

- `index.html`: no-cache or must-revalidate.
- Catalogue and JSON manifests: short cache or must-revalidate.
- Content-hashed JS/CSS: long-lived immutable cache.
- Stable media keys: conservative cache as described above.

Test security headers against actual browser requests. The app currently uses
R2 images, a SoundCloud iframe and widget API, Google Fonts, and React inline
styles for image geometry and virtualization. Any future CSP must explicitly account for
these resources and styles. The prepared domain configuration uses nosniff,
frame denial and a strict-origin-when-cross-origin referrer policy without a CSP. Preserve clipboard/native sharing behavior. Verify
the effective policy in the browser; configuration syntax alone is insufficient.

## Release validation: pending

Preview the exact root build locally with production R2 media before server
mutation. Then repeat through the public Cloudflare URL on desktop and mobile:
all year totals, selected-year-only metadata loading, album failure isolation,
grid virtualization, timeline scrubbing, scroll restoration, direct year/photo
URL refresh, Back/Forward, fit/expanded modes, portrait/landscape images,
SoundCloud, sharing, 404 behavior, public/private boundaries and browser errors.

Measure the three-second opening delay from the first decoded image, five-second
manual resume, and persistent explicit pause. The existing reducer unit tests
cover state transitions; they do not establish real browser timing. Also verify
decoded readiness before setting the rolling-buffer ready flag.

Run at least five minutes of 2013 playback at 0.1 seconds per photograph where
practical. Record failed image requests, buffering, R2/cache behavior, Nginx errors
and server resource use. The first preview run loaded public R2 images smoothly for over four minutes
before the Mac suspended network activity. It is not a successful five-minute
result. The clean rerun completed 300 seconds and reached photograph 2,971 at the
default 0.1-second speed, with 3,057 image responses, no failed image requests,
no page errors and zero buffering observations at one-second sampling. Idle
sleep was inhibited only for the test process.
The application is still local in these tests; a separate public apex run is
required after the eventual server switch.

## Adding future years and curator corrections

Keep each new source-year folder local and ignored. Review the importer options
in `scripts/import-photos.mjs`, import the intended year with `npm run import:year
-- --year YYYY`, and inspect the private import report. The catalogue drives year
navigation; do not hard-code a year list in components.

Audit all public manifests and derivatives again, review labels, verify counts,
publish only generated library keys, and make a new committed static release.
Never publish import reports or caches. Adding a year changes expected release
counts, so record the new audited totals before publication.

Future permanent corrections remain a separate local curator workflow: edit
correction instructions locally, regenerate approved derivatives without modifying
originals, re-audit, republish affected media and update relevant caches. No public
admin or write capability is authorized by this deployment.
