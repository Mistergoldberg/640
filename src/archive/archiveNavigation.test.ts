import { describe, expect, it } from "vitest";
import type { ArchiveTimelineModel, ArchiveTarget } from "./archiveTimelineModel";
import {
  archiveWindowWarnings,
  boundaryArchiveTarget,
  createArchiveNavigationPlan,
  stableYearLocalCorrection,
  type ArchiveNavigationIntent
} from "./archiveNavigation";

const target: ArchiveTarget = {
  year: "2001",
  albumId: "2001-a",
  albumName: "2001-a",
  ratio: 0.8,
  sectionRatio: 0.2
};

const model: ArchiveTimelineModel = {
  years: [
    { year: "2013", start: 0, end: 0.5, count: 10, albums: [{ id: "2013-a", name: "2013-a", count: 10, start: 0, end: 0.5 }] },
    { year: "2002", start: 0.5, end: 0.6, count: 2, albums: [{ id: "2002-a", name: "2002-a", count: 2, start: 0.5, end: 0.6 }] },
    { year: "2001", start: 0.6, end: 1, count: 8, albums: [{ id: "2001-a", name: "2001-a", count: 8, start: 0.6, end: 1 }] }
  ],
  anchors: []
};

describe("authoritative archive navigation", () => {
  it("creates the same navigation plan shape for every entry path", () => {
    const intents: ArchiveNavigationIntent[] = ["initial", "scrub", "jump", "boundary", "history", "photo-close"];
    for (const intent of intents) {
      expect(createArchiveNavigationPlan(target, intent)).toEqual(expect.objectContaining({ intent, target, loadReason: expect.any(String) }));
    }
    expect(createArchiveNavigationPlan(target, "scrub").historyMode).toBe("push");
    expect(createArchiveNavigationPlan(target, "boundary").historyMode).toBe("push");
    expect(createArchiveNavigationPlan(target, "history").historyMode).toBeNull();
  });

  it("maps both year boundaries through catalogue-derived targets", () => {
    expect(boundaryArchiveTarget(model, "2013", "older")).toMatchObject({ year: "2002", sectionRatio: 0 });
    expect(boundaryArchiveTarget(model, "2002", "newer")).toMatchObject({ year: "2013", sectionRatio: 1 });
    expect(boundaryArchiveTarget(model, "2013", "newer")).toBeNull();
  });

  it("preserves a visible stable photo across a year-local layout resize", () => {
    expect(stableYearLocalCorrection(420, 615)).toBe(195);
    expect(stableYearLocalCorrection(undefined, 615)).toBe(0);
  });

  it("detects inactive-year rows and images as cleanup failures", () => {
    expect(archiveWindowWarnings({ mountedYears: ["2013"], mountedRows: 22, mountedPhotos: 74, inactiveImageElements: 0, observerCount: 1 })).toEqual([]);
    expect(archiveWindowWarnings({ mountedYears: ["2013", "2001"], mountedRows: 41, mountedPhotos: 171, inactiveImageElements: 3, observerCount: 3 }))
      .toEqual(["multiple-mounted-years", "photo-tile-bound-exceeded", "row-bound-exceeded", "inactive-year-images", "stale-archive-observers"]);
  });
});
