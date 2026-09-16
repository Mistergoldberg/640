import type { YearSegment } from "./yearSegmentController";

interface YearSegmentSpacerProps {
  segment: Pick<YearSegment, "id" | "year" | "spacerHeight">;
  onRef?: (node: HTMLElement | null) => void;
}

export function YearSegmentSpacer({ segment, onRef }: YearSegmentSpacerProps) {
  return (
    <section
      className="year-segment-spacer"
      data-segment-id={segment.id}
      data-segment-year={segment.year}
      data-year={segment.year}
      data-segment-status="spacer"
      data-spacer-height={Math.round(segment.spacerHeight)}
      style={{ height: segment.spacerHeight }}
      ref={onRef}
      aria-hidden="true"
    />
  );
}
