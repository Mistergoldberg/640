# 640x480 Public Media Release

This app publishes generated display and thumbnail derivatives only. Original source folders such as `2001`, `2013`, and future source-year folders stay local and must never be uploaded.

## Public Payload

Publish only:

```text
generated/library/
```

Do not publish:

```text
2001/
2013/
dev-01/
generated/reports/
```

Run this before planning any upload:

```bash
npm run release:audit
```

The audit writes:

```text
generated/reports/public-release-audit.json
```

The report is ignored by Git and is not browser-accessible.

## Cloudflare Setup

Create these manually in Cloudflare before any real upload:

1. Create a dedicated R2 Standard bucket for generated public media.
2. Create a bucket-scoped API token with the minimum permissions needed for object listing, reading, and writing in that bucket.
3. Configure a custom public media domain for the bucket.
4. Do not use an `r2.dev` URL as the final production media URL.
5. Configure public access only for generated derivatives in this bucket.
6. Set conservative media caching because asset keys are stable and may be reused if a source photograph changes.

Suggested response headers:

```text
Content-Type: image/jpeg
Cache-Control: public, max-age=3600, stale-while-revalidate=86400
```

If the importer later changes to content-versioned asset keys, the cache policy can become longer-lived and immutable.

CORS is not access control. These photographs are intentionally public. The current app uses normal browser image loading only, so start with the narrowest CORS rules needed by the custom site origin and methods `GET` and `HEAD`.

## Environment

Store real values only in your shell or ignored local env files. Do not commit credentials.

```bash
export R2_ACCOUNT_ID=""
export R2_ACCESS_KEY_ID=""
export R2_SECRET_ACCESS_KEY=""
export R2_BUCKET=""
export R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export VITE_MEDIA_BASE_URL="https://media.example.com/"
```

For local development, leave `VITE_MEDIA_BASE_URL` blank so Vite serves:

```text
http://127.0.0.1:5173/media/
```

For production builds, set `VITE_MEDIA_BASE_URL` to the custom media domain.

## Package-bound publication gate

The legacy canonical-tree uploader is disabled. These commands now always fail
closed and must not be used as a publication route:

```bash
npm run media:upload:dry-run
npm run media:upload
```

Media publication starts with a completed, publication-eligible promotion
package. A zero-write plan and local execution against a disposable filesystem
fixture are available as follows:

```bash
npm run media:publish:plan -- --package-root /path/to/package --object-root /path/to/disposable-store
npm run media:publish:local -- --package-root /path/to/package --object-root /path/to/disposable-store --journal-root /path/to/journal
```

The gate binds the package ID, closed-world seal, manifest-reference map, media
inventory, and exact `media/new` set. It accepts an existing object only after a
full-byte SHA-256 readback, writes only absent approved new keys, and performs no
deletes. Manifest activation is a separate later operation.

## Read-only R2 preflight

The checked-in R2 destination pin records hashes of the expected account and
endpoint, the exact bucket name, and the managed year/derivative namespace. The
runtime credential file must match every pin. Account, bucket, endpoint and
namespace identities are reported, but access keys and secrets are never
printed.

Run a bounded read-only comparison of the existing R2 namespace with canonical
local media using:

```bash
npm run media:r2:preflight -- \
  --baseline \
  --config config/r2-publication-readonly.json \
  --credentials /absolute/path/to/insertcatchytitlehere-r2.json \
  --canonical-media-root /absolute/path/to/generated/library \
  --sample-count 6 \
  --max-readback-bytes 10485760
```

When a real completed promotion package exists, replace `--baseline` and the
canonical-media option with `--package-root /absolute/path/to/package`. The
command validates the sealed package, lists the complete namespace with
continuation tokens, and classifies candidate, rollback, other-known and
unexpected objects. It prints JSON to stdout and never creates a publication
receipt.

R2 currently supports `ListObjectsV2` pagination and conditional operations on
`PutObject`, but its compatibility table does not support a SHA-256
`FULL_OBJECT` checksum type. The preflight therefore accepts checksum metadata
only if it explicitly identifies full-object SHA-256; otherwise it performs a
bounded GET and hashes every returned byte. Size and ETag alone never prove
SHA-256 equality. See the current official
[R2 S3 compatibility table](https://developers.cloudflare.com/r2/api/s3/api/)
and [AWS SDK v3 R2 example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/).
AWS likewise documents that an
[ETag may not be a full-object MD5](https://docs.aws.amazon.com/AmazonS3/latest/API/API_Object.html),
and it is never treated here as SHA-256 proof. Request reports separate Class A
listing calls from Class B HEAD/GET calls using Cloudflare's current
[R2 operation pricing categories](https://developers.cloudflare.com/r2/pricing/).

The R2 adapter imports and permits only `HeadBucket`, `ListObjectsV2`,
`HeadObject`, and `GetObject`. `--execute`, upload, copy, delete, metadata and
force flags fail before credentials are loaded or a client is created.

## Isolated conditional-write verification

The isolated-test adapter accepts
only a verified promotion package and an `environment: isolated-write-test`
destination pin. Its command surface contains only `ListObjectsV2`, `GetObject`,
and `PutObject`; it has no copy, delete, metadata-replacement, or unconditional
write operation. The package's exact `media/new` set is the upload allowlist.

Run only against the pinned disposable bucket:

```bash
npm run media:r2:test:credentials -- \
  --package-root /path/to/synthetic/package \
  --config config/r2-publication-isolated-test.json \
  --parent-credentials /absolute/path/to/parent-r2-credentials.json \
  --output /absolute/ignored/path/package-r2-credentials.json \
  --ttl-seconds 900

npm run media:r2:test:plan -- \
  --package-root /path/to/synthetic/package \
  --config config/r2-publication-isolated-test.json \
  --credentials /absolute/path/to/isolated-test-credentials.json

npm run media:r2:test:publish -- \
  --package-root /path/to/synthetic/package \
  --config config/r2-publication-isolated-test.json \
  --credentials /absolute/path/to/isolated-test-credentials.json \
  --journal-root /path/to/durable/journal
```

Every create uses `PutObject` with `If-None-Match: *`, a supplied payload
SHA-256 checksum, `Content-Type: image/jpeg`, and
`Cache-Control: public, max-age=31536000, immutable`. A 412 response is treated
only as “already present”; the object is then downloaded in full and hashed.
A successful PUT is also downloaded and hashed before the journal can record it
as complete. Service checksum metadata, size, and ETag are retained as evidence
but never replace full-object SHA-256 readback.

The publisher uses locally signed, short-lived, action-only credentials. Its
credential permits only `GetObject` and `PutObject`, and its `objectPaths` claim
must exactly equal the verified package's `media/new` key set. A separate
`ListObjectsV2` credential supplies complete isolated-bucket inventory. When a
package retains existing media, a third `GetObject` credential is bound exactly
to that retained-key set. These roles, actions, paths, expiration times, and
credential fingerprints are included in the publication run binding and
receipt without including credential secrets.

Cloudflare's current local-signing example includes both `scope` and `actions`,
but R2 returned `400 InvalidArgument: X-Amz-Security-Token` for that form on
2026-10-02. The action-only form described by the same temporary-credential
reference succeeded and was authorization-tested. The `GetObject`/`PutObject`
credential received `403 AccessDenied` for `DeleteObject`, `DeleteObjects`,
`CopyObject`, `CreateMultipartUpload`, `ListObjectsV2`, cross-bucket PUT, and PUT
outside its exact object paths. Sentinels remained byte-identical after every
denial. Keep this runtime/documentation discrepancy in the release record.

Action restriction does not turn `PutObject` into create-only permission. A
different client holding the publisher credential could issue an unconditional
PUT to one of its approved paths. The package adapter therefore still requires
`If-None-Match: *`, rejects any command outside its three-command surface, and
performs full-object SHA-256 readback. Do not treat the credential restriction
alone as overwrite protection.

The checked-in isolated destination pin names the test bucket and hashes its
account and endpoint. Every runtime role must be a locally signed Cloudflare
temporary credential for that exact bucket, must not be expired, and must match
the package-bound action and path pin.
The production bucket and public media hosts are explicit deny-list entries.
Cloudflare documents bucket-scoped tokens and temporary credentials in its
[R2 token guide](https://developers.cloudflare.com/r2/api/tokens/) and
[temporary-credential guide](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/).

The disposable bucket is retained empty for later isolated tests. Each test run
must record its exact synthetic keys before creation, remove only that recorded
set after verification, list the bucket to prove cleanup, and allow its temporary
credential to expire. Never point this isolated profile at the production
bucket.

The generic production profile reuses the same adapter surface against the
pinned production bucket. It additionally requires an exact, expiring QA
authority record and production-profile temporary credentials before even a
plan can run. Its dry run must report zero conflicts, overwrites and deletes.
See `docs/package-bound-release.md`; production manifest/frontend activation is
still unavailable and out of scope.

Do not substitute direct `rclone copy`, because that bypasses the package gate
and its durable receipt. Never run `sync --delete` for this archive.

The historical rclone environment mapping was:

```text
RCLONE_CONFIG_R2_TYPE=s3
RCLONE_CONFIG_R2_PROVIDER=Cloudflare
RCLONE_CONFIG_R2_ACCESS_KEY_ID=<from R2_ACCESS_KEY_ID>
RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=<from R2_SECRET_ACCESS_KEY>
RCLONE_CONFIG_R2_ENDPOINT=<from R2_ENDPOINT>
```
