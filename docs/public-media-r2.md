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

## Future isolated write test

Production publication remains unavailable. The intended create operation is a
single-object `PutObject` with `If-None-Match: *`, a supplied payload checksum,
and immutable content-versioned key. Cloudflare documents the conditional
operation in its
[S3 compatibility table](https://developers.cloudflare.com/r2/api/s3/api/), but
its exact behavior with this SDK, R2 checksum response, retry path, metadata,
and a competing writer must be proven in a new isolated bucket before any
production adapter is implemented.

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
