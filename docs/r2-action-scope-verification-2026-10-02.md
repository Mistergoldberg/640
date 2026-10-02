# R2 action-scoped credential verification — 2026-10-02

This is evidence from the isolated bucket only. No production bucket request,
deployment, import, manifest activation, or QA routing change was performed.

## Destination and credential construction

- Account: `c0fbfbb2c2c121569f71b59ed2c9a7dc`
- Bucket: `pixilation-media-publication-test-20261001`
- Endpoint: `https://c0fbfbb2c2c121569f71b59ed2c9a7dc.r2.cloudflarestorage.com`
- Parent access-key fingerprint: `35547593816c3475`
- Credential format: locally signed HS256 JWT, SHA-256-derived temporary
  secret, `base64("jwt/" + signedJwt)` session token
- Live credential TTL: 900 seconds; final inventory credential TTL: 300 seconds

Cloudflare's runnable example currently includes both `scope` and `actions`.
That exact claim combination returned HTTP 400 `InvalidArgument` with message
`X-Amz-Security-Token`. Omitting `scope` and retaining explicit `actions`
succeeded. The implementation consequently requires action-only credentials and
rejects a credential containing `scope`.

References:

- <https://developers.cloudflare.com/r2/api/s3/temporary-credentials/>
- <https://developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials/>
- <https://developers.cloudflare.com/r2/api/s3/api/>

## Authorization proof

Run: `live-1790903920806`

The tested publisher credential had only `GetObject` and `PutObject` actions and
six explicitly enumerated object paths under
`authz-action-test-20261002/live-1790903920806/`. It had no `scope`, prefix, list,
copy, multipart, or delete authority.

| Request | Live response |
| --- | --- |
| Conditional `PutObject` for sentinel A | HTTP 200 |
| Full `GetObject` readback for sentinel A | HTTP 200; 23 bytes; SHA-256 `b5f92f2a9df2f19c45b58e6fc13f1acc1015e41d05cbfea0a09c765291ecabb9` |
| Conditional `PutObject` for sentinel B | HTTP 200 |
| Full `GetObject` readback for sentinel B | HTTP 200; 23 bytes; SHA-256 `4153d1831f5991fd15365af61589704dfaab4103031675c0784ea5375d583351` |
| `DeleteObject` | HTTP 403 `AccessDenied` |
| `DeleteObjects` | HTTP 403 `AccessDenied` |
| `CopyObject` | HTTP 403 `AccessDenied` |
| `CreateMultipartUpload` | HTTP 403 `AccessDenied` |
| `PutObject` outside enumerated paths | HTTP 403 `AccessDenied` |
| `PutObject` to a different non-production bucket name | HTTP 403 `AccessDenied` |
| `ListObjectsV2` | HTTP 403 `AccessDenied` |

Both sentinels were fully downloaded and matched the byte counts and SHA-256
values above after each of the seven denied operations.

Two concurrent conditional writers for one approved path produced one HTTP 200
and one HTTP 412 `PreconditionFailed`. Full readback matched the HTTP 200
writer. A simulated lost response discarded an HTTP 200 create response; the
resume received HTTP 412 and full readback matched the original 26 bytes at
SHA-256 `1812567311d58d90ca93d462e5c87188b78a0ea6a1415796c00635890ede438d`.

## Package-bound publication proof

The synthetic package used year 2094 and did not represent a real archive or
curatorial approval.

- Package ID: `57f641c9227b768d20f041467f10513f452a5b5eba5a55401a21023bad4e9bc8`
- Publication ID: `6925a454c85e1fb1bb6222587946bfd84451f38e49eafd499fcca9f9dbc3e26f`
- Run ID: `6ffe9b28469213c293a7ca75de95cdcae7f31bd13fcadbbbd2ab90a089f0af2c`
- Receipt SHA-256 field: `f1dcdf2596df717d90e20ab6e199f0bdc1cf55356c8ab94fb8d597f44fd0f8dc`
- Receipt file SHA-256: `656cb7ec9cf2ba6153db2eb8c0e916fb6754d0e88b73685abf533fe4205a8959`
- Reconciliation: four required, zero missing, zero changed, zero unexpected,
  zero deletes
- Every receipt object records `credentialRole: "publisher"` and
  `full-object-sha256-readback`
- A completed-run replay returned the identical receipt bytes

The journal records an injected HTTP 503 before any request, a simulated lost
response after a successful create, an HTTP 412 resume, and verified completion
on attempt three without overwrite.

## Cleanup and remaining limitation

Authorization-test cleanup used a separate action-only `DeleteObjects`
credential bound to the exact four created keys. Package cleanup used another
exact four-key `DeleteObjects` credential. Both returned HTTP 200 with no
per-key errors. A fresh, action-only `ListObjectsV2` credential then listed one
page and zero objects.

`PutObject` action authority is not create-only authority. A different client
holding the publisher credential could issue an unconditional overwrite to an
approved path. The publisher therefore continues to require
`If-None-Match: *`, an exact package key set, and full-object SHA-256 readback.
This limitation must remain explicit before any production enablement.
