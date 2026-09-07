import { describe, expect, it } from "vitest";
import { historyModeForIntent } from "./archiveHistory";
import { requestIsCurrent } from "./archiveYearCache";
import {
  activeYearAtScroll,
  buildArchiveGeometry,
  stableAnchorCorrection
} from "./continuousArchiveLayout";

describe("continuous archive layout helpers", () => {
  const geometry = buildArchiveGeometry([
    { year: "2013", index: null, loadedHeight: 1000 },
    { year: "2002", index: null, loadedHeight: 500 },
    { year: "2001", index: null, loadedHeight: 800 }
  ], 1000, 174);

  it("finds the active year from a scroll position", () => {
    expect(activeYearAtScroll(geometry.years, geometry.years[1].top + 20)).toBe("2002");
    expect(activeYearAtScroll(geometry.years, geometry.years[2].bottom)).toBe("2001");
  });

  it("rejects stale and aborted request generations", () => {
    expect(requestIsCurrent(4, 4)).toBe(true);
    expect(requestIsCurrent(5, 4)).toBe(false);
    expect(requestIsCurrent(4, 4, true)).toBe(false);
  });

  it("selects replace for passive movement and push for explicit jumps", () => {
    expect(historyModeForIntent("passive")).toBe("replace");
    expect(historyModeForIntent("scrub")).toBe("replace");
    expect(historyModeForIntent("jump")).toBe("push");
  });

  it("restores a stable anchor after layout correction", () => {
    expect(stableAnchorCorrection(420, 615)).toBe(195);
    expect(stableAnchorCorrection(undefined, 615)).toBe(0);
  });
});
