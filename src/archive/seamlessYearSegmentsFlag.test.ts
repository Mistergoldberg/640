import { describe, expect, it } from "vitest";
import { SEAMLESS_YEAR_SEGMENTS_ENV, seamlessYearSegmentsEnabled } from "./seamlessYearSegmentsFlag";

describe("seamless year segment feature flag", () => {
  it("is enabled by default with an explicit off switch", () => {
    expect(SEAMLESS_YEAR_SEGMENTS_ENV).toBe("VITE_SEAMLESS_YEAR_SEGMENTS");
    expect(seamlessYearSegmentsEnabled(undefined)).toBe(true);
    expect(seamlessYearSegmentsEnabled("")).toBe(false);
    expect(seamlessYearSegmentsEnabled("0")).toBe(false);
  });

  it("supports the existing explicit flag values", () => {
    expect(seamlessYearSegmentsEnabled("1")).toBe(true);
    expect(seamlessYearSegmentsEnabled("true")).toBe(true);
    expect(seamlessYearSegmentsEnabled("TRUE")).toBe(true);
    expect(seamlessYearSegmentsEnabled("yes")).toBe(false);
  });
});
