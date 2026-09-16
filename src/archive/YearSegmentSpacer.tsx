import type { YearSegment } from "./yearSegmentController";

export function YearSegmentSpacer({ segment }: { segment: Pick<YearSegment, "id" | "year" | "spacerHeight"> }) {
  return (
    <section
      className="year-segment-spacer"
      data-segment-id={segment.id}
      data-year={segment.year}
      style={{ height: segment.spacerHeight }}
      aria-hidden="true"
    />
  );
}
