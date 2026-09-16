import { describe, expect, it } from "vitest";
import { YearSegmentSpacer } from "./YearSegmentSpacer";
import {
  beginSegmentLoad,
  completeSegmentLoad,
  createYearSegmentController,
  failSegmentLoad,
  mountedSegmentCount,
  replaceSegmentWithSpacer,
  restoreSegmentFromSpacer,
  retainedCollectionCount,
  retrySegment,
  mountSegment,
  type YearSegmentControllerState
} from "./yearSegmentController";
import type { GridLayout } from "./yearSegmentLayout";

function rowPlan(height: number): GridLayout {
  return {
    entries: [],
    totalHeight: height,
    photoTops: new Map(),
    albumAnchors: [],
    yearAnchors: []
  };
}

function loaded(
  current: YearSegmentControllerState<{ photos: number }, GridLayout>,
  year: string,
  height: number
) {
  const { state: loading, request } = beginSegmentLoad(current, year);
  const result = completeSegmentLoad(loading, {
    year,
    generation: request.generation,
    collection: { photos: height },
    rowPlan: rowPlan(height),
    width: 390,
    height
  });
  expect(result.stale).toBe(false);
  return result.state;
}

describe("year segment controller", () => {
  it("tracks segment load, ready, mount, error, and retry transitions", () => {
    const initial = createYearSegmentController<{ photos: number }, GridLayout>({
      years: ["2024", "2023", "2022"],
      activeYear: "2023",
      catalogueRevision: "catalog-a"
    });
    const { state: loading, request } = beginSegmentLoad(initial, "2024");
    expect(request.duplicate).toBe(false);
    expect(loading.segments.get("2024")?.status).toBe("prefetching");

    const failed = failSegmentLoad(loading, "2024", request.generation, "Nope").state;
    expect(failed.segments.get("2024")?.status).toBe("error");
    expect(failed.segments.get("2024")?.errorMessage).toBe("Nope");

    const retried = retrySegment(failed, "2024");
    expect(retried.request.generation).toBe(request.generation + 1);
    expect(retried.state.segments.get("2024")?.retryCount).toBe(1);
  });

  it("prevents duplicate loads for the same year and catalogue revision", () => {
    const initial = createYearSegmentController({
      years: ["2024", "2023"],
      activeYear: "2024",
      catalogueRevision: "catalog-a"
    });
    const first = beginSegmentLoad(initial, "2023");
    const second = beginSegmentLoad(first.state, "2023");
    expect(second.request.duplicate).toBe(true);
    expect(second.request.generation).toBe(first.request.generation);
  });

  it("ignores aborted or stale load completions", () => {
    const initial = createYearSegmentController<{ photos: number }, GridLayout>({
      years: ["2024", "2023"],
      activeYear: "2024",
      catalogueRevision: "catalog-a"
    });
    const { state, request } = beginSegmentLoad(initial, "2023");
    const stale = completeSegmentLoad(state, {
      year: "2023",
      generation: request.generation + 1,
      collection: { photos: 1 },
      rowPlan: rowPlan(500),
      width: 390,
      height: 500
    });
    expect(stale.stale).toBe(true);
    expect(stale.state.segments.get("2023")?.status).toBe("prefetching");
  });

  it("limits mounted segments to two and protects the visual-anchor segment", () => {
    let state = createYearSegmentController({
      years: ["2024", "2023", "2022"],
      activeYear: "2023",
      catalogueRevision: "catalog-a"
    });
    state = mountSegment(state, "2023", true);
    state = mountSegment(state, "2024");
    state = mountSegment(state, "2022");

    expect(mountedSegmentCount(state)).toBeLessThanOrEqual(2);
    expect(state.segments.get("2023")?.status).toBe("mounted");
    expect(state.segments.get("2023")?.containsVisualAnchor).toBe(true);

    const protectedReplacement = replaceSegmentWithSpacer(state, "2023");
    expect(protectedReplacement.replaced).toBe(false);
    expect(protectedReplacement.state.segments.get("2023")?.status).toBe("mounted");
  });

  it("limits retained full collections to three", () => {
    let state = createYearSegmentController<{ photos: number }, GridLayout>({
      years: ["2026", "2025", "2024", "2023", "2022"],
      activeYear: "2025",
      catalogueRevision: "catalog-a"
    });
    for (const [index, year] of ["2026", "2025", "2024", "2023", "2022"].entries()) {
      state = loaded(state, year, 400 + index);
    }
    expect(retainedCollectionCount(state)).toBe(3);
  });

  it("preserves height through spacer substitution and restoration", () => {
    let state = createYearSegmentController<{ photos: number }, GridLayout>({
      years: ["2024", "2023"],
      activeYear: "2024",
      catalogueRevision: "catalog-a"
    });
    state = loaded(state, "2023", 1234);
    state = mountSegment(state, "2023");
    const replaced = replaceSegmentWithSpacer(state, "2023");
    expect(replaced.replaced).toBe(true);
    const spacer = replaced.state.segments.get("2023");
    expect(spacer?.status).toBe("spacer");
    expect(spacer?.spacerHeight).toBe(1234);
    expect(spacer?.rowPlan).toBeNull();

    const element = YearSegmentSpacer({ segment: spacer! });
    expect(element.props["aria-hidden"]).toBe("true");
    expect(element.props.style.height).toBe(1234);
    expect(element.props.children).toBeUndefined();

    const restored = restoreSegmentFromSpacer(replaced.state, "2023", rowPlan(1234));
    expect(restored.segments.get("2023")?.status).toBe("ready");
    expect(restored.segments.get("2023")?.calculatedHeight).toBe(1234);
    expect(restored.segments.get("2023")?.rowPlan).toEqual(rowPlan(1234));
  });
});
