import { describe, expect, it } from "vitest";
import type { AlbumManifest, AlbumSummary, Photo, YearIndex } from "../types";
import { buildYearCollection, type AlbumLoadResult } from "./useYearCollection";

function photo(id: string, albumId: string, sortPosition: number): Photo {
  return {
    id,
    albumId,
    sortPosition,
    albumSortPosition: sortPosition,
    thumbnailKey: `${id}-thumb.webp`,
    displayKey: `${id}.webp`,
    width: 640,
    height: 480,
    orientation: "landscape"
  };
}

describe("buildYearCollection", () => {
  it("keeps the selected year sequence order without pulling archive-wide photos", () => {
    const albums: AlbumSummary[] = [
      { id: "2013-a", name: "2013-09-03", count: 2, manifestUrl: "data/2013/a.json" },
      { id: "2013-b", name: "2013-10-09", count: 1, manifestUrl: "data/2013/b.json" },
      { id: "2013-c", name: "2013-11-21", count: 1, manifestUrl: "data/2013/c.json" }
    ];
    const sourceIndex: YearIndex = {
      year: "2013",
      scannedCount: 4,
      albums,
      sequence: [{ id: "a2" }, { id: "a1" }, { id: "b1" }, { id: "c1" }]
    };
    const manifestA: AlbumManifest = { photos: [photo("a1", "2013-a", 2), photo("a2", "2013-a", 1)] };
    const manifestB: AlbumManifest = { photos: [photo("b1", "2013-b", 3)] };
    const results: AlbumLoadResult[] = [
      { status: "ready", album: albums[0], manifest: manifestA },
      { status: "ready", album: albums[1], manifest: manifestB },
      { status: "error", album: albums[2], errorMessage: "Album could not be loaded" }
    ];

    const collection = buildYearCollection(["2013", "2002", "2001"], sourceIndex, results);

    expect(collection.year).toBe("2013");
    expect(collection.photos.map((candidate) => candidate.id)).toEqual(["a2", "a1", "b1"]);
    expect(collection.photos.every((candidate) => candidate.albumId.startsWith("2013-"))).toBe(true);
    expect(collection.expectedCount).toBe(4);
    expect(collection.availableCount).toBe(3);
    expect(collection.failedAlbumIds).toEqual(["2013-c"]);
    expect(collection.isIncomplete).toBe(true);
  });

  it("represents loading and failed albums without duplicating loaded photos", () => {
    const albums: AlbumSummary[] = [
      { id: "2013-a", name: "2013-09-03", count: 2, manifestUrl: "data/2013/a.json" },
      { id: "2013-b", name: "2013-10-09", count: 2, manifestUrl: "data/2013/b.json" }
    ];
    const sourceIndex: YearIndex = {
      year: "2013",
      scannedCount: 4,
      albums,
      sequence: [{ id: "a1" }, { id: "a2" }, { id: "b1" }, { id: "b2" }]
    };
    const results: AlbumLoadResult[] = [
      { status: "ready", album: albums[0], manifest: { photos: [photo("a1", "2013-a", 1), photo("a2", "2013-a", 2)] } },
      { status: "loading", album: albums[1] }
    ];

    const collection = buildYearCollection(["2013"], sourceIndex, results);

    expect(collection.photos.map((candidate) => candidate.id)).toEqual(["a1", "a2"]);
    expect(new Set(collection.photos.map((candidate) => candidate.id)).size).toBe(collection.photos.length);
    expect(collection.loadingAlbumIds).toEqual(["2013-b"]);
    expect(collection.index.albums.map((album) => album.loadState)).toEqual(["ready", "loading"]);
  });
});
