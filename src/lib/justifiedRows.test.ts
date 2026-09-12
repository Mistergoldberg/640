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

function orderedIds(rows: ReturnType<typeof buildEditorialRows>) {
  return rows.flatMap((row) => row.items.map((item) => item.photo.id));
}

function rowWidth(row: ReturnType<typeof buildEditorialRows>[number], gap: number) {
  return row.items.reduce((sum, item) => sum + item.width, 0) + gap * Math.max(0, row.items.length - 1);
}

function rowDerivedPhotoTops(rows: ReturnType<typeof buildEditorialRows>, gap: number) {
  let top = 0;
  const tops: Array<[string, number]> = [];
  for (const row of rows) {
    for (const item of row.items) {
      tops.push([item.photo.id, top]);
    }
    top += row.height + gap;
  }
  return tops;
}

describe("buildEditorialRows", () => {
  it("preserves source order while varying row rhythm", () => {
    const photos = Array.from({ length: 24 }, (_, index) => photo(`landscape-${index}`, 640, 480));
    const rows = buildEditorialRows(photos, 1200, 174, 4);

    expect(rows.map((row) => row.tone).slice(0, 4)).toEqual([
      "feature",
      "standard",
      "pair-feature",
      "standard"
    ]);
    expect(orderedIds(rows)).toEqual(photos.map(({ id }) => id));
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
    expect(rows.some((row) => row.tone === "solo-feature")).toBe(false);
    expect(rows[0].items.length).toBeGreaterThanOrEqual(5);
    expect(rows[0].height).toBeLessThanOrEqual(120);
  });

  it("adds full-width single-image rows on narrow mobile portrait layouts", () => {
    const photos = [
      photo("mobile-landscape-0", 640, 480),
      photo("mobile-square-1", 640, 640),
      photo("mobile-portrait-2", 480, 640),
      photo("mobile-landscape-3", 640, 480),
      photo("mobile-portrait-4", 480, 640),
      photo("mobile-landscape-5", 640, 480),
      photo("mobile-square-6", 640, 640),
      photo("mobile-landscape-7", 640, 480),
      photo("mobile-portrait-8", 480, 640),
      photo("mobile-landscape-9", 640, 480),
      photo("mobile-square-10", 640, 640),
      photo("mobile-portrait-11", 480, 640)
    ];
    const rows = buildEditorialRows(photos, 390, 138, 3);
    const soloRow = rows.find((row) => row.tone === "solo-feature");

    expect(soloRow).toBeDefined();
    expect(soloRow?.items).toHaveLength(1);
    expect(soloRow?.items[0].width).toBe(390);
    expect(soloRow?.items[0].height).toBe(Math.round(390 / (soloRow!.items[0].photo.width / soloRow!.items[0].photo.height)));
    expect(orderedIds(rows)).toEqual(photos.map(({ id }) => id));
    expect(new Set(orderedIds(rows)).size).toBe(photos.length);
  });

  it("keeps the tall mobile single-image treatment out of mobile landscape", () => {
    const photos = Array.from({ length: 24 }, (_, index) => photo(`landscape-mobile-${index}`, index % 3 === 0 ? 480 : 640, index % 3 === 0 ? 640 : 480));
    const rows = buildEditorialRows(photos, 808, 184, 4, true);

    expect(rows.some((row) => row.tone === "solo-feature")).toBe(false);
    expect(rows.some((row) => row.tone === "pair-feature")).toBe(false);
    expect(orderedIds(rows)).toEqual(photos.map(({ id }) => id));
  });

  it("adds desktop pair rows with shared height and source-ratio widths", () => {
    const photos = Array.from({ length: 24 }, (_, index) => photo(`desktop-landscape-${index}`, 640, 480));
    const rows = buildEditorialRows(photos, 1200, 174, 4);
    const pairRow = rows.find((row) => row.tone === "pair-feature");

    expect(pairRow).toBeDefined();
    expect(pairRow?.items).toHaveLength(2);
    expect(pairRow?.items[0].height).toBe(pairRow?.height);
    expect(pairRow?.items[1].height).toBe(pairRow?.height);
    expect(rowWidth(pairRow!, 4)).toBeLessThanOrEqual(1200);
    expect(1200 - rowWidth(pairRow!, 4)).toBeLessThanOrEqual(4);
    for (const item of pairRow!.items) {
      expect(Math.abs(aspect(item) - item.photo.width / item.photo.height)).toBeLessThan(0.02);
    }
    expect(orderedIds(rows)).toEqual(photos.map(({ id }) => id));
  });

  it("caps tall portrait desktop pairs without distorting either frame", () => {
    const photos = Array.from({ length: 28 }, (_, index) => photo(`desktop-portrait-${index}`, 480, 640));
    const rows = buildEditorialRows(photos, 1440, 174, 4);
    const pairRow = rows.find((row) => row.tone === "pair-feature");

    expect(pairRow).toBeDefined();
    expect(pairRow?.items).toHaveLength(2);
    expect(pairRow?.height).toBeLessThanOrEqual(374);
    expect(rowWidth(pairRow!, 4)).toBeLessThan(1440);
    for (const item of pairRow!.items) {
      expect(Math.abs(aspect(item) - item.photo.width / item.photo.height)).toBeLessThan(0.02);
    }
  });

  it("is deterministic, keeps every photo once, and yields deterministic row-derived photo tops", () => {
    const photos = Array.from({ length: 36 }, (_, index) => {
      if (index % 5 === 0) return photo(`det-portrait-${index}`, 480, 640);
      if (index % 4 === 0) return photo(`det-square-${index}`, 640, 640);
      return photo(`det-landscape-${index}`, 640, 480);
    });
    const first = buildEditorialRows(photos, 390, 138, 3);
    const second = buildEditorialRows(photos, 390, 138, 3);
    const expectedIds = photos.map(({ id }) => id);

    expect(first).toEqual(second);
    expect(orderedIds(first)).toEqual(expectedIds);
    expect(new Set(orderedIds(first)).size).toBe(photos.length);
    expect(rowDerivedPhotoTops(first, 3)).toEqual(rowDerivedPhotoTops(second, 3));
  });
});
