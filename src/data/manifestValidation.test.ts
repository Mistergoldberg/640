import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AlbumSummary, PhotoSequenceItem } from "../types";
import { ManifestValidationError, validateAlbumManifest, validateCatalog, validateYearIndex } from "./manifestValidation";

const APP_ROOT = path.resolve(import.meta.dirname, "../..");
const read = (relativePath: string) => JSON.parse(fs.readFileSync(path.join(APP_ROOT, "public", relativePath), "utf8"));

function expectCode(run: () => unknown, code: string) {
  try {
    run();
    throw new Error("Expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestValidationError);
    expect((error as ManifestValidationError).code).toBe(code);
    expect((error as Error).message).not.toContain("/");
  }
}

const id = "2026-0123456789abcd";
const digest = "a".repeat(64);
const album: AlbumSummary = { id: "2026-album-a", name: "Album A", count: 1, manifestUrl: "data/2026/albums/2026-album-a.json" };
const sequence: PhotoSequenceItem[] = [{ id }];
const validPhoto = {
  id,
  thumbnailKey: `2026/thumbs/${id}-cv1-${digest}.jpg`,
  displayKey: `2026/display/${id}-cv1-${digest}.jpg`,
  albumId: album.id,
  width: 640,
  height: 480,
  orientation: "landscape",
  sortPosition: 0,
  albumSortPosition: 0
};

describe("semantic manifest validation", () => {
  it("accepts the complete committed catalogue without mutation", () => {
    const rawCatalog = read("data/catalog.json");
    const catalog = validateCatalog(rawCatalog);
    let albums = 0;
    let photos = 0;
    for (const year of catalog.years) {
      const index = validateYearIndex(read(year.indexUrl), year.year);
      for (const summary of index.albums) {
        const manifest = validateAlbumManifest(read(summary.manifestUrl), { year: year.year, album: summary, sequence: index.sequence });
        albums += 1;
        photos += manifest.photos.length;
      }
    }
    expect(catalog.years).toHaveLength(24);
    expect(albums).toBe(137);
    expect(photos).toBe(66_170);
    expect(rawCatalog).toEqual(catalog);
  });

  it("rejects duplicate years and noncanonical or encoded catalogue paths", () => {
    expectCode(() => validateCatalog({ years: [
      { year: "2026", indexUrl: "data/2026/index.json" },
      { year: "2026", indexUrl: "data/2026/index.json" }
    ] }), "duplicate-year");
    for (const indexUrl of ["../2026/index.json", "data/%32%30%32%36/index.json", "https://example.com/data/2026/index.json", "/data/2026/index.json"]){
      expectCode(() => validateCatalog({ years: [{ year: "2026", indexUrl }] }), "invalid-index-path");
    }
  });

  it("rejects wrong-year identity, duplicate IDs, unsafe manifest paths, and inconsistent counts", () => {
    expectCode(() => validateYearIndex({ year: "2025", scannedCount: 0, albums: [], sequence: [] }, "2026"), "year-identity-mismatch");
    expectCode(() => validateYearIndex({ year: "2026", scannedCount: 0, albums: [album, album], sequence: [sequence[0], sequence[0]] }, "2026"), "duplicate-album-id");
    expectCode(() => validateYearIndex({ year: "2026", scannedCount: 1, albums: [{ ...album, manifestUrl: "data/2026/albums/%2e%2e/catalog.json" }], sequence }, "2026"), "invalid-album-path");
    expectCode(() => validateYearIndex({ year: "2026", scannedCount: 0, albums: [album], sequence }, "2026"), "index-count-mismatch");
  });

  it("rejects wrong membership, invalid dimensions/order, and malformed or mixed media keys", () => {
    expect(validateAlbumManifest({ photos: [validPhoto] }, { year: "2026", album, sequence }).photos[0]).toEqual(validPhoto);
    expectCode(() => validateAlbumManifest({ photos: [{ ...validPhoto, albumId: "2026-other" }] }, { year: "2026", album, sequence }), "album-membership-mismatch");
    expectCode(() => validateAlbumManifest({ photos: [{ ...validPhoto, width: 0 }] }, { year: "2026", album, sequence }), "invalid-display-dimensions");
    expectCode(() => validateAlbumManifest({ photos: [{ ...validPhoto, sortPosition: -1 }] }, { year: "2026", album, sequence }), "invalid-sort-position");
    expectCode(() => validateAlbumManifest({ photos: [{ ...validPhoto, displayKey: `2026/display/${id}.jpg` }] }, { year: "2026", album, sequence }), "invalid-media-key");
    expectCode(() => validateAlbumManifest({ photos: [{ ...validPhoto, thumbnailKey: `2025/thumbs/${id}-cv1-${digest}.jpg` }] }, { year: "2026", album, sequence }), "invalid-media-key");
  });
});
