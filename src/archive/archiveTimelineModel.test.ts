import { describe, expect, it } from "vitest";
import type { Catalog, YearIndex } from "../types";
import {
  archiveTargetAtRatio,
  buildArchiveTimelineModel,
  orderedArchiveYears
} from "./archiveTimelineModel";

const catalog: Catalog = { years: [
  { year: "2001", indexUrl: "2001.json" },
  { year: "2013", indexUrl: "2013.json" },
  { year: "2002", indexUrl: "2002.json" }
] };

function index(year: string, counts: number[]): YearIndex {
  const albums = counts.map((count, i) => ({ id: `${year}-${i}`, name: `${year}-album-${i}`, count, manifestUrl: `${i}.json` }));
  return { year, scannedCount: counts.reduce((a, b) => a + b, 0), albums, sequence: Array.from({ length: counts.reduce((a, b) => a + b, 0) }, (_, i) => ({ id: `${year}-photo-${i}` })) };
}

describe("archive timeline model", () => {
  const indexes = new Map([
    ["2013", index("2013", [3000, 1000])],
    ["2002", index("2002", [20, 10])],
    ["2001", index("2001", [5000, 1000])]
  ]);
  const model = buildArchiveTimelineModel(catalog, indexes);

  it("derives descending years dynamically", () => {
    expect(orderedArchiveYears(catalog).map((year) => year.year)).toEqual(["2013", "2002", "2001"]);
  });

  it("maps global positions using photo counts", () => {
    expect(model.years[2].end - model.years[2].start).toBeGreaterThan(model.years[0].end - model.years[0].start);
    expect(model.years[0].end - model.years[0].start).toBeGreaterThan(model.years[1].end - model.years[1].start);
    expect(archiveTargetAtRatio(model, 0.98)?.year).toBe("2001");
  });

  it("keeps a small year reachable", () => {
    const small = model.years.find((year) => year.year === "2002")!;
    expect(small.end - small.start).toBeGreaterThan(0.06);
  });

  it("snaps predictably to year boundaries", () => {
    const boundary = model.years[1].start;
    expect(archiveTargetAtRatio(model, boundary - 0.01, true)?.year).toBe("2002");
    expect(archiveTargetAtRatio(model, boundary - 0.01, false)?.year).toBe("2013");
  });

  it("keeps the complete archive endpoints reachable", () => {
    expect(archiveTargetAtRatio(model, 0)).toMatchObject({ year: "2013", sectionRatio: 0 });
    expect(archiveTargetAtRatio(model, 1)).toMatchObject({ year: "2001", sectionRatio: 1 });
  });

  it("maps positions to album anchors", () => {
    const album = model.years[0].albums[1];
    const target = archiveTargetAtRatio(model, album.start + (album.end - album.start) / 2);
    expect(target).toMatchObject({ year: "2013", albumId: "2013-1", albumName: "2013-album-1" });
  });
});
