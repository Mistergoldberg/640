# Approved fresh archive release

The owner approved the hosted QA release and production promotion after visual
review on 2026-11-21 (Toronto). This release replaces the catalogue with 24 years,
135 albums and 65,781 photos. Its 131,562 content-versioned JPEG derivatives have
a complete successful remote SHA-256 publication receipt.

Desktop Escape closes the player and returns to the album, including native
fullscreen, Help, speed choices and rotation controls. The screen-size button
continues to resize the player; touch fullscreen behavior is preserved.

2026 follows the approved forward master/importer order, beginning with
`2026-1/IMG_8123.JPG`. Fully and uniquely numbered editorial albums retain their
explicit sequence. Removed links resolve through 326 verified unique aliases;
63 ambiguous or unmatched links return to their year archive.

## Exact artifact identity

| Binding | Value |
| --- | --- |
| Frontend source | `4fd035f8daa0f7d006a06efb3ca63c1e3372b943` |
| QA release | `48392c0d608d3f8961400d26399459d5f1101f6a723992ed36dd5c5d94245837` |
| Release seal | `f3db60c73dd46d74d97efb8028fc3928206e8863d9c677193ad8c15c7f3e7134` |
| Media package | `61bf2369db6ae7112a20360b524bfd3647093c0e7fc5ffdfe81fc8b354bd9276` |
| Package seal | `61535ceefbbe7b13dda147a8c72f3f63969592cc395ee9baabe682f762413a6e` |
| Publication receipt | `2081c3549d74cd7e2b34e20a3ac1c589213db17576dabc687e25961704cda960` |
| QA deployment receipt | `38bcd0caed67a95edd4c895441e6ade4121900a2b0e929f74fa3369eb72f4e93` |
| Optional features | Homepage autoplay off; seamless year segments off |

The release bookkeeping commit records the exact sealed public JSON in
`public/data`; application source and dependencies remain identical to the QA
frontend commit above. QA's build identity records that earlier source commit
and its intentional catalogue overlay. Promote its existing sealed payload
unchanged: rebuilding the final Git commit would create a different artifact.

## Promotion and rollback

1. Reverify the approved release seal, package seal and publication receipt.
   Verify that QA still points to the approved release and record both current
   production pointers before changing anything.
2. Check every file in the existing QA payload against the sealed inventory.
   Stage that identical payload under `/var/www/pixilation.org/releases/` and
   verify all filenames, byte counts and SHA-256 hashes again.
3. Atomically switch only `/var/www/pixilation.org/current`. Keep the QA pointer,
   legacy-site pointer, existing Basic Auth, Nginx, DNS and media unchanged.
4. Verify authenticated public HTML/build/catalogue identity, all public data,
   representative media, forward 2026 playback, links, and desktop Escape.
5. If validation fails, atomically restore the recorded prior production target
   and verify it. The existing rollback release is
   `/var/www/pixilation.org/releases/20261031T202000Z-d519413-all-year-protected`;
   confirm this actual target immediately before promotion.

Keep private verification receipts in the ignored release evidence directory.
No source photographs, credentials or private importer inventories belong in
Git or the static payload. This promotion does not authorize deletion. Any later
media cleanup requires a fresh inventory and separate owner authorization.

Public review links: [archive](https://pixilation.org/) and
[first 2026 frame](https://pixilation.org/?year=2026&photo=2026-7e312ff1ad75bb).
