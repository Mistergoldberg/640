# Publication authority

Status verified 2026-10-31. This repository is the public read-only application and committed catalogue. It is not the authority for creating or publishing replacement media.

The authoritative local workflow is the separately controlled `pixilation-import-plan` repository, observed at `ba3bbb5025264a02a958b22264583f9cd7c5a69a` (`feature/stable-unreadable-run-identity`). Its package contract is documented there in `docs/aggregate-archive-package.md` and `docs/package-bound-release.md`. The workflow requires complete publication-eligible stages, explicit owner authority bound to an exact package and seal, a closed-world promotion package, package-bound R2 credentials, a durable publication receipt, and a sealed candidate release before QA activation.

Supported media keys have this exact contract:

```text
YEAR/{thumbs|display}/YEAR-PHOTO_DIGEST-cv1-DERIVATIVE_SHA256.jpg
```

The path year, photo-ID year, manifest year and manifest photo ID must agree. Only JPG derivatives and the literal `cv1` recipe are accepted. Mixed unversioned/versioned catalogues, traversal, wrong-year relationships and arbitrary extensions are rejected.

The old `scripts/import-photos.mjs` recipe in this repository emits unversioned keys. The old broad uploader does not consume or verify the external package approval contract. Both are retired and their npm entry points fail before reading sources or writing output. This includes limited and sample imports: they cannot target `public/data`, `generated/library`, or become publication-eligible. Historical source remains only as evidence for migration work.

`npm run release:audit` remains supported as a local exhaustive verifier of a supplied derivative tree. It validates the committed cv1 contract but does not mint approval, create a package, write R2, or prove remote bytes. In a checkout without the approved derivative set, the expected result is a media-root blocker—not a key-contract blocker.

Do not copy the external approval schema into this repository or invent authority records. Run publication commands only from the authoritative workflow and its exact reviewed commit.
