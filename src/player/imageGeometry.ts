export type ImageMode = "fit" | "expanded";
export type Rotation = 0 | 90 | 180 | 270;

export interface ImageGeometryInput {
  sourceWidth: number;
  sourceHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  controlClearance: number;
  mode: ImageMode;
  rotation: Rotation;
}

export interface ImageGeometry {
  effectiveWidth: number;
  effectiveHeight: number;
  layoutWidth: number;
  layoutHeight: number;
  scale: number;
  renderedWidth: number;
  renderedHeight: number;
  overflowX: number;
  overflowY: number;
  offsetX: number;
  offsetY: number;
  rotation: Rotation;
}

function positive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function calculateImageGeometry(input: ImageGeometryInput): ImageGeometry {
  const sourceWidth = positive(input.sourceWidth, 640);
  const sourceHeight = positive(input.sourceHeight, 480);
  const viewportWidth = positive(input.viewportWidth, sourceWidth);
  const viewportHeight = positive(input.viewportHeight, sourceHeight);
  const isQuarterTurn = input.rotation === 90 || input.rotation === 270;
  const effectiveWidth = isQuarterTurn ? sourceHeight : sourceWidth;
  const effectiveHeight = isQuarterTurn ? sourceWidth : sourceHeight;
  const availableHeight = Math.max(1, viewportHeight - Math.max(0, input.controlClearance));
  const shouldExpandByWidth = input.mode === "expanded" && viewportWidth < 620 && viewportHeight >= viewportWidth;
  const scale =
    input.mode === "fit"
      ? Math.min(1, viewportWidth / effectiveWidth, availableHeight / effectiveHeight)
      : shouldExpandByWidth
        ? viewportWidth / effectiveWidth
        : viewportHeight / effectiveHeight;
  const renderedWidth = effectiveWidth * scale;
  const renderedHeight = effectiveHeight * scale;
  const layoutWidth = sourceWidth * scale;
  const layoutHeight = sourceHeight * scale;

  return {
    effectiveWidth,
    effectiveHeight,
    layoutWidth,
    layoutHeight,
    scale,
    renderedWidth,
    renderedHeight,
    overflowX: Math.max(0, renderedWidth - viewportWidth),
    overflowY: Math.max(0, renderedHeight - viewportHeight),
    offsetX: (viewportWidth - renderedWidth) / 2,
    offsetY: (viewportHeight - renderedHeight) / 2,
    rotation: input.rotation
  };
}

export function playerFitClearance(viewportWidth: number, viewportHeight: number) {
  if (viewportWidth <= 620) {
    return viewportWidth > viewportHeight && viewportHeight <= 460
      ? { vertical: 108, horizontal: 24 }
      : { vertical: 202, horizontal: 24 };
  }

  if (viewportWidth > viewportHeight && viewportHeight <= 460) {
    return { vertical: 108, horizontal: 24 };
  }

  return { vertical: 134, horizontal: 24 };
}
