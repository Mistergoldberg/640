import { describe, expect, it } from "vitest";
import { buildEditorialRows } from "./justifiedRows";
import type { Photo } from "../types";

function photo(id: string, width: number, height: number): Photo {
  return {
    id,
    thumbnailKey: `${id}-thumb.jpg`,
    displayKey: `${id}.jpg`,
    albumId: "album",
    width,
    height,
    orientation: width > height ? "landscape" : width < height ? "portrait" : "square",
    sortPosition: Number(id.replace(/\D/g, "")) || 0,
    albumSortPosition: 0
  };
}

function aspect(item: { width: number; height: number }) {
  return item.width / item.height;
}

describe("buildEditorialRows", () => {
  it("preserves source order while varying row rhythm", () => {
    const photos = Array.from({ length: 24 }, (_, index) => photo(`landscape-${index}`, 640, 480));
    const rows = buildEditorialRows(photos, 1200, 174, 4);

    expect(rows.map((row) => row.tone).slice(0, 4)).toEqual([
      "feature",
      "standard",
      "compact",
      "standard"
    ]);
    expect(rows.flatMap((row) => row.items.map((item) => item.photo.id))).toEqual(photos.map(({ id }) => id));
    expect(Math.max(...rows.map((row) => row.height))).toBeGreaterThan(Math.min(...rows.map((row) => row.height)) + 60);
  });

  it("keeps tile boxes close to each photograph's own aspect ratio", () => {
    const photos = [
      photo("landscape-1", 640, 480),
      photo("portrait-1", 480, 640),
      photo("landscape-2", 640, 480),
      photo("square-1", 640, 640),
      photo("portrait-2", 480, 640),
      photo("landscape-3", 640, 480)
    ];
    const rows = buildEditorialRows(photos, 760, 146, 4);

    for (const item of rows.flatMap((row) => row.items)) {
      expect(Math.abs(aspect(item) - item.photo.width / item.photo.height)).toBeLessThan(0.02);
    }
  });

  it("uses denser rows for short landscape viewports", () => {
    const photos = Array.from({ length: 18 }, (_, index) => photo(`short-${index}`, 640, 480));
    const rows = buildEditorialRows(photos, 808, 112, 4, true);

    expect(rows[0].tone).toBe("standard");
    expect(rows[1].tone).toBe("compact");
    expect(rows[0].items.length).toBeGreaterThanOrEqual(5);
    expect(rows[0].height).toBeLessThanOrEqual(120);
  });
});
