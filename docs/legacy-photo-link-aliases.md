# Legacy photo-link aliases

The application optionally loads `public/data/photo-id-aliases.json`. A missing file preserves the existing behavior. A present file must use schema version 1, have status `approved`, and bind itself to the exact aggregate package, its closed-world seal, and the approved transition ledger by SHA-256.

Each alias maps an old `(year, photo ID)` pair to a current pair. Cross-year and many-old-to-one-current mappings are supported. An old ID can appear only once. Explicit retirement is supported separately, but unmatched, ambiguous, and cross-year records must not be retired merely because they lack an approved mapping.

The map must be generated only from the final eligible stages and an approved transition ledger. This candidate intentionally contains no alias data from the provisional ledger. Publication of a map therefore remains package-bound release work, not application-candidate approval.
