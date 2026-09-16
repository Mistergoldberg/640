import { describe, expect, it } from "vitest";
import { SEAMLESS_YEAR_SEGMENTS_ENV, seamlessYearSegmentsEnabled } from "./seamlessYearSegmentsFlag";

describe("seamless year segment feature flag", () => {
  it("is disabled by default", () => {
    expect(SEAMLESS_YEAR_SEGMENTS_ENV).toBe("VITE_SEAMLESS_YEAR_SEGMENTS");
    expect(seamlessYearSegmentsEnabled(undefined)).toBe(false);
    expect(seamlessYearSegmentsEnabled("")).toBe(false);
    expect(seamlessYearSegmentsEnabled("0")).toBe(false);
  });

  it("supports explicit enabled values only", () => {
    expect(seamlessYearSegmentsEnabled("1")).toBe(true);
    expect(seamlessYearSegmentsEnabled("true")).toBe(true);
    expect(seamlessYearSegmentsEnabled("TRUE")).toBe(true);
    expect(seamlessYearSegmentsEnabled("yes")).toBe(false);
  });
});
