# Public media R2 runbook

This is the operative workflow for Pixilation photo-media publication. A
completed, publication-eligible promotion package is the **only** publication
input. Never publish `generated/library/` directly, never use the legacy
uploader, and never use `rclone` as a publication route.

The source originals remain private. R2 receives only the exact
content-versioned derivative keys listed in a verified package's `media/new`
tree. Manifest activation is a separate operation and must not happen until the
media publication receipt is `PASS`.

## Non-negotiable invariants

- Start with a completed staged run, a fresh exact source inventory, and a
  fully resolved source policy.
- Build and independently verify a sealed promotion package.
- Plan against the package's exact approved new-key set before any write.
- Create only absent keys with `If-None-Match: *`; never overwrite, copy, or
  delete an object.
- Prove every required object by full-object SHA-256 readback. Size, ETag, and
  service metadata are evidence, but are not substitutes for the readback.
- Reconcile the complete required media set and require a durable `PASS`
  receipt before manifest activation.
- Retain legacy objects, obsolete-but-retained keys, and every key needed by
  the prior manifest set. They are rollback data, not cleanup candidates.
- Use `Cache-Control: public, max-age=31536000, immutable` for newly created
  content-versioned keys. The former short-cache policy applied to mutable
  legacy keys and is not the current policy.

There is no production write command in this repository. The production R2
adapter is read-only; the only R2 writer is pinned to an isolated disposable
test bucket.

## Workflow boundaries

The photo-release flow has four distinct boundaries:

1. **Staging** creates an isolated, resumable derivative and manifest set.
2. **Promotion packaging** merges the selected staged year with unaffected
   published data and seals `public-data`, `media`, and reference inventories.
3. **Media publication** plans and uploads only the package's `media/new` set,
   then emits a reconciled receipt. Production execution is not yet enabled.
4. **Manifest activation** is a later deployment operation. It is deliberately
   absent from all media commands in this document.

Do not substitute a direct canonical import for steps 1 or 2. Direct canonical
photo imports fail closed, even with a resolved policy.

## Promotion package: the sole input

Build the package only from a completed isolated staging root and the exact
resolved policy used by that run. Keep the package outside canonical
`public/data`, `generated/library`, and `generated/reports`:

```bash
npm run release:package -- \
  --staging-root /absolute/isolated/staging-root \
  --package-root /absolute/isolated/promotion-package \
  --source-policy /absolute/private/resolved-source-policy.json \
  --canonical-data-root /absolute/pixilation.org/public/data \
  --canonical-media-root /absolute/pixilation.org/generated/library
```

The package command refuses a publication-ineligible staged receipt, a stale or
unresolved policy, an incomplete selected year, duplicate IDs, missing media,
unexpected package files, or a changed closed-world seal. Its completed package
contains:

```text
package.json
complete.json
public-data/
media/new/
inventories/public-data.json
inventories/media.json
inventories/manifest-media-map.json
```

`media/new` is the complete upload allowlist. Nothing else in the working tree
is an upload source. The media inventory separately records existing legacy
keys, existing versioned keys, rollback keys, and obsolete-but-retained keys.
No category implies deletion.

## Safe local planning

The filesystem adapter is for disposable local verification only. Both paths
must be isolated; do not point either path at a canonical tree or a report
directory:

```bash
npm run media:publish:plan -- \
  --package-root /absolute/isolated/promotion-package \
  --object-root /absolute/disposable/object-store

npm run media:publish:local -- \
  --package-root /absolute/isolated/promotion-package \
  --object-root /absolute/disposable/object-store \
  --journal-root /absolute/disposable/publication-journal
```

The zero-write plan reports the exact keys, byte counts, SHA-256 checksums,
matching existing objects, missing keys, conflicts, request estimates, and zero
deletes. The local execution journal and receipt exercise the package contract;
they are not production R2 evidence.

## Production R2: read-only preflight

The checked-in production destination pin records hashes of the expected
account and endpoint, the exact bucket, and the managed media-key grammar. A
runtime credential file must match the pin. Reports identify the account,
bucket, endpoint, and namespace without printing secrets.

For the currently published baseline, use the read-only inventory mode. Output
goes to stdout; choose an isolated path yourself if it must be retained. Do not
write it to `generated/reports`:

```bash
npm run media:r2:preflight -- \
  --baseline \
  --config config/r2-publication-readonly.json \
  --credentials /absolute/private/production-readonly-credentials.json \
  --canonical-media-root /absolute/pixilation.org/generated/library \
  --sample-count 6 \
  --max-readback-bytes 10485760
```

For a real completed package, replace `--baseline` and
`--canonical-media-root` with:

```text
--package-root /absolute/isolated/promotion-package
```

Package preflight verifies the seal, completely paginates the managed
namespace, and classifies required candidate keys, rollback-retained keys,
other known archive keys, and unexpected keys. Readback is bounded by
`--max-readback-bytes`. The result is a **read-only preflight report**, never a
publication receipt and never proof that missing media was uploaded.

The production adapter imports and permits only `HeadBucket`,
`ListObjectsV2`, `HeadObject`, and `GetObject`. `--execute`, upload, copy,
delete, metadata-mutation, and force flags fail before credentials are loaded
or a client is created. Production upload remains disabled.

R2 supports `ListObjectsV2` pagination and conditional `PutObject`, but its
compatibility table does not provide a SHA-256 `FULL_OBJECT` checksum type.
The preflight accepts checksum metadata only when it explicitly identifies
full-object SHA-256; otherwise it performs a bounded GET and hashes all returned
bytes. Size and ETag never prove equality here. See Cloudflare's
[R2 S3 compatibility table](https://developers.cloudflare.com/r2/api/s3/api/),
[AWS SDK v3 R2 example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/),
and [R2 pricing categories](https://developers.cloudflare.com/r2/pricing/).
AWS also documents that an
[ETag may not be a full-object MD5](https://docs.aws.amazon.com/AmazonS3/latest/API/API_Object.html).

## Isolated test-bucket publisher

This publisher is verification infrastructure, not a production command. It
accepts only an `environment: isolated-write-test` destination pin, refuses the
production bucket and public media endpoints, and validates the package's exact
year/key set against the pinned Pixilation key grammar.

Create short-lived package-bound credentials in an ignored, isolated location:

```bash
npm run media:r2:test:credentials -- \
  --package-root /absolute/synthetic/promotion-package \
  --config config/r2-publication-isolated-test.json \
  --parent-credentials /absolute/private/isolated-parent-credentials.json \
  --output /absolute/private/package-r2-credentials.json \
  --ttl-seconds 900
```

Then plan without a journal:

```bash
npm run media:r2:test:plan -- \
  --package-root /absolute/synthetic/promotion-package \
  --config config/r2-publication-isolated-test.json \
  --credentials /absolute/private/package-r2-credentials.json
```

Execution is allowed only against the pinned disposable bucket, with a durable
journal outside canonical trees:

```bash
npm run media:r2:test:publish -- \
  --package-root /absolute/synthetic/promotion-package \
  --config config/r2-publication-isolated-test.json \
  --credentials /absolute/private/package-r2-credentials.json \
  --journal-root /absolute/disposable/r2-publication-journal
```

Every create uses `PutObject` with `If-None-Match: *`, a supplied payload
SHA-256 checksum, `Content-Type: image/jpeg`, and the immutable cache header. A
412 means only “already present”; the adapter then downloads and hashes the
object. A successful PUT is also downloaded and hashed before the journal can
record completion. An interrupted run cannot issue a `PASS` receipt.

The short-lived publisher credential permits only `GetObject` and `PutObject`
and binds `objectPaths` to the package's exact `media/new` set. A separate
`ListObjectsV2` credential inventories the isolated bucket; a third
`GetObject` role is used when a fixture retains existing media. Role actions,
paths, expirations, and credential fingerprints enter the run binding and
receipt without secrets.

Cloudflare's local-signing example includes both `scope` and `actions`, but R2
returned `400 InvalidArgument: X-Amz-Security-Token` for that form during the
2026-10-02 isolated test. The action-only form from the same temporary-
credential reference succeeded and was authorization-tested. The publisher
credential received `403 AccessDenied` for delete, multi-delete, copy,
multipart creation, listing, cross-bucket PUT, and PUT outside its exact object
paths. Preserve this runtime/documentation discrepancy in any future release
record. See Cloudflare's [R2 token guide](https://developers.cloudflare.com/r2/api/tokens/)
and [temporary-credential guide](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/).

`PutObject` permission is not intrinsically create-only: another client holding
the publisher credential could issue an unconditional overwrite at an approved
path. The adapter's conditional request and full readback remain mandatory.
Credential scoping is defense in depth, not overwrite proof.

After a test, remove only the run's recorded synthetic keys under the isolated
bucket cleanup plan, list the bucket to prove it empty, and let the temporary
credentials expire. Never aim cleanup at production.

## Gate before manifest activation

Do not activate candidate public data until all of the following are true:

- the package is still publication-eligible and its closed-world seal verifies;
- an exact publication plan has no conflicts or extra upload keys;
- every approved new key has been conditionally created or proven identical;
- every required new and retained key has passed full SHA-256 readback;
- complete reconciliation reports zero missing or changed required objects;
- the durable package-bound media receipt is `PASS`;
- the previous manifests and all of their referenced keys remain available for
  rollback.

Production cannot reach this gate yet because production execution is disabled.
Enabling it requires a separately reviewed production adapter and change plan.

## Historical, non-operational instructions

Older procedures published `generated/library/` directly with `rclone` and used
short cache lifetimes because legacy keys could be reused. Those instructions
are retained here only to explain prior state. They are **not authorized
commands** and do not satisfy the package, journal, checksum, reconciliation, or
rollback contracts.

In particular, do not run the disabled legacy routes:

```bash
npm run media:upload:dry-run
npm run media:upload
```

Both commands fail closed. Do not run `rclone copy`, and never run
`sync --delete` for this archive. Historical environment mappings have been
removed because leaving copy-ready commands in the operative runbook creates an
unnecessary bypass risk.
