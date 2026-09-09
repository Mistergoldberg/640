import { describe, expect, it } from "vitest";
import { resolveScrubberCommit } from "./ArchiveScrubber";
import type { ArchiveTimelineModel } from "./archiveTimelineModel";

const model: ArchiveTimelineModel = {
  years: [
    { year: "2013", count: 80, start: 0, end: 0.8, albums: [{ id: "a", name: "first", count: 80, start: 0, end: 0.8 }] },
    { year: "2002", count: 5, start: 0.8, end: 0.9, albums: [{ id: "b", name: "small", count: 5, start: 0.8, end: 0.9 }] },
    { year: "2001", count: 10, start: 0.9, end: 1, albums: [{ id: "c", name: "last", count: 10, start: 0.9, end: 1 }] }
  ],
  anchors: [
    { year: "2013", albumId: null, ratio: 0 },
    { year: "2002", albumId: null, ratio: 0.8 },
    { year: "2001", albumId: null, ratio: 0.9 }
  ]
};

describe("archive scrubber commitment", () => {
  it("resolves one snapped target only when the gesture commits", () => {
    expect(resolveScrubberCommit(model, 0.805)).toMatchObject({ year: "2002", albumId: "b", ratio: 0.8 });
    expect(resolveScrubberCommit(model, 0.98)).toMatchObject({ year: "2001", albumId: "c" });
  });
});
