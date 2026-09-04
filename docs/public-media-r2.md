# 640x480 Public Media Release

This app publishes generated display and thumbnail derivatives only. Original source folders such as `640/2001`, `640/2013`, and future source-year folders stay local and must never be uploaded.

## Public Payload

Publish only:

```text
640/generated/library/
```

Do not publish:

```text
640/2001/
640/2013/
640/dev-01/
640/app/
640/generated/reports/
```

Run this before planning any upload:

```bash
npm run release:audit
```

The audit writes:

```text
../generated/reports/public-release-audit.json
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
http://127.0.0.1:5173/640/media/
```

For production builds, set `VITE_MEDIA_BASE_URL` to the custom media domain.

## Dry Run

The dry run performs no upload and no deletion. It runs the release audit first and refuses to plan an upload unless the audit passes.

```bash
npm run media:upload:dry-run
```

## Future Upload

Install `rclone`, export the environment variables above, run a fresh dry-run, then run:

```bash
npm run media:upload
```

The upload script uses `rclone copy` semantics. It does not delete remote objects and it does not print credentials.

The equivalent remote configuration is provided to rclone through environment variables:

```text
RCLONE_CONFIG_R2_TYPE=s3
RCLONE_CONFIG_R2_PROVIDER=Cloudflare
RCLONE_CONFIG_R2_ACCESS_KEY_ID=<from R2_ACCESS_KEY_ID>
RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=<from R2_SECRET_ACCESS_KEY>
RCLONE_CONFIG_R2_ENDPOINT=<from R2_ENDPOINT>
```

Do not run `rclone sync` for this archive unless deletion behavior has been reviewed separately.
