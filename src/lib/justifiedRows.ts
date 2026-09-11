import type { Photo } from "../types";

export interface JustifiedItem {
  photo: Photo;
  width: number;
  height: number;
}

export type JustifiedRowTone = "feature" | "standard" | "compact";

export interface JustifiedRow {
  id: string;
  items: JustifiedItem[];
  height: number;
  tone?: JustifiedRowTone;
}

function photoAspectRatio(photo: Photo): number {
  if (!photo.width || !photo.height) {
    return 4 / 3;
  }

  return photo.width / photo.height;
}

function buildJustifiedRow(photos: Photo[], containerWidth: number, targetRowHeight: number, gap: number, isFinalRow: boolean, tone?: JustifiedRowTone): JustifiedRow {
  const totalGap = gap * Math.max(0, photos.length - 1);
  const aspectSum = photos.reduce((sum, photo) => sum + photoAspectRatio(photo), 0);
  const rawHeight = (containerWidth - totalGap) / aspectSum;
  const height = isFinalRow ? Math.min(targetRowHeight, rawHeight) : rawHeight;
  const items = photos.map((photo) => ({
    photo,
    width: Math.max(42, Math.round(height * photoAspectRatio(photo))),
    height: Math.round(height)
  }));

  return {
    id: photos.map((photo) => photo.id).join(":"),
    items,
    height: Math.round(height),
    tone
  };
}

export function buildJustifiedRows(photos: Photo[], containerWidth: number, targetRowHeight: number, gap: number): JustifiedRow[] {
  if (!containerWidth || !photos.length) {
    return [];
  }

  const rows: JustifiedRow[] = [];
  let activePhotos: Photo[] = [];
  let activeAspectRatio = 0;

  function pushRow(rowPhotos: Photo[], isFinalRow: boolean) {
    if (!rowPhotos.length) {
      return;
    }

    rows.push(buildJustifiedRow(rowPhotos, containerWidth, targetRowHeight, gap, isFinalRow));
  }

  for (const photo of photos) {
    activePhotos.push(photo);
    activeAspectRatio += photoAspectRatio(photo);

    const projectedWidth = activeAspectRatio * targetRowHeight + gap * Math.max(0, activePhotos.length - 1);
    if (projectedWidth >= containerWidth) {
      pushRow(activePhotos, false);
      activePhotos = [];
      activeAspectRatio = 0;
    }
  }

  pushRow(activePhotos, true);
  return rows;
}

function editorialToneForRow(rowIndex: number, compactViewport: boolean): JustifiedRowTone {
  if (compactViewport) {
    return rowIndex % 5 === 0 ? "standard" : "compact";
  }

  const pattern: JustifiedRowTone[] = ["feature", "standard", "compact", "standard", "standard", "feature", "compact", "standard"];
  return pattern[rowIndex % pattern.length];
}

function targetHeightForTone(baseRowHeight: number, tone: JustifiedRowTone, containerWidth: number) {
  if (tone === "feature") {
    return containerWidth < 520 ? baseRowHeight * 1.25 : containerWidth < 900 ? baseRowHeight * 1.22 : baseRowHeight * 1.45;
  }

  if (tone === "compact") {
    return baseRowHeight * 0.82;
  }

  return baseRowHeight;
}

export function buildEditorialRows(photos: Photo[], containerWidth: number, baseRowHeight: number, gap: number, compactViewport = false): JustifiedRow[] {
  if (!containerWidth || !photos.length) {
    return [];
  }

  const rows: JustifiedRow[] = [];
  let rowPhotos: Photo[] = [];
  let activeAspectRatio = 0;
  let rowIndex = 0;

  function activeTone() {
    return editorialToneForRow(rowIndex, compactViewport);
  }

  function activeTargetHeight() {
    return targetHeightForTone(baseRowHeight, activeTone(), containerWidth);
  }

  function pushRow(isFinalRow: boolean) {
    if (!rowPhotos.length) {
      return;
    }

    const tone = activeTone();
    rows.push(buildJustifiedRow(rowPhotos, containerWidth, activeTargetHeight(), gap, isFinalRow, tone));
    rowPhotos = [];
    activeAspectRatio = 0;
    rowIndex += 1;
  }

  for (const photo of photos) {
    rowPhotos.push(photo);
    activeAspectRatio += photoAspectRatio(photo);

    const targetHeight = activeTargetHeight();
    const projectedWidth = activeAspectRatio * targetHeight + gap * Math.max(0, rowPhotos.length - 1);
    if (projectedWidth >= containerWidth) {
      pushRow(false);
    }
  }

  pushRow(true);
  return rows;
}
