import type { Photo } from "../types";

export interface JustifiedItem {
  photo: Photo;
  width: number;
  height: number;
}

export type JustifiedRowTone = "feature" | "standard" | "compact" | "solo-feature" | "pair-feature";

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

const MOBILE_SOLO_FIRST_ROW_INDEX = 2;
const MOBILE_SOLO_ROW_INTERVAL = 8;
const DESKTOP_PAIR_FIRST_ROW_INDEX = 2;
const DESKTOP_PAIR_ROW_INTERVAL = 9;
const DESKTOP_PAIR_SIMILAR_SPREAD = 0.18;
const DESKTOP_PAIR_LANDSCAPE_RATIO = 1.15;

function isMobilePortraitFeatureViewport(containerWidth: number, compactViewport: boolean) {
  return containerWidth < 520 && !compactViewport;
}

function isDesktopFeatureViewport(containerWidth: number, compactViewport: boolean) {
  return containerWidth >= 900 && !compactViewport;
}

function buildSoloFeatureRow(photo: Photo, containerWidth: number): JustifiedRow {
  const aspectRatio = photoAspectRatio(photo);
  const height = Math.max(1, Math.round(containerWidth / aspectRatio));

  return {
    id: photo.id,
    items: [{
      photo,
      width: containerWidth,
      height
    }],
    height,
    tone: "solo-feature"
  };
}

function pairFeatureMaxHeight(baseRowHeight: number, firstRatio: number, secondRatio: number) {
  const spread = Math.abs(firstRatio - secondRatio) / Math.max(firstRatio, secondRatio);
  const similarLandscapePair = spread <= DESKTOP_PAIR_SIMILAR_SPREAD && Math.min(firstRatio, secondRatio) >= DESKTOP_PAIR_LANDSCAPE_RATIO;
  return similarLandscapePair ? Math.min(baseRowHeight * 3, 520) : Math.min(baseRowHeight * 2.15, 374);
}

function buildPairFeatureRow(photos: [Photo, Photo], containerWidth: number, baseRowHeight: number, gap: number): JustifiedRow {
  const ratios = photos.map(photoAspectRatio) as [number, number];
  const rawFillHeight = (containerWidth - gap) / (ratios[0] + ratios[1]);
  const maxHeight = pairFeatureMaxHeight(baseRowHeight, ratios[0], ratios[1]);
  let height = Math.max(1, Math.floor(Math.min(rawFillHeight, maxHeight)));
  let widths = ratios.map((ratio) => Math.max(42, Math.round(height * ratio))) as [number, number];

  while (height > 1 && widths[0] + widths[1] + gap > containerWidth) {
    height -= 1;
    widths = ratios.map((ratio) => Math.max(42, Math.round(height * ratio))) as [number, number];
  }

  return {
    id: photos.map((photo) => photo.id).join(":"),
    items: photos.map((photo, index) => ({
      photo,
      width: widths[index],
      height
    })),
    height,
    tone: "pair-feature"
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
  let photoIndex = 0;
  let nextSoloRowIndex = MOBILE_SOLO_FIRST_ROW_INDEX;
  let nextPairRowIndex = DESKTOP_PAIR_FIRST_ROW_INDEX;
  const mobilePortraitFeatureViewport = isMobilePortraitFeatureViewport(containerWidth, compactViewport);
  const desktopFeatureViewport = isDesktopFeatureViewport(containerWidth, compactViewport);

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

  function pushEditorialFeatureRow() {
    if (rowPhotos.length) {
      return false;
    }

    if (mobilePortraitFeatureViewport && rowIndex >= nextSoloRowIndex) {
      rows.push(buildSoloFeatureRow(photos[photoIndex], containerWidth));
      photoIndex += 1;
      rowIndex += 1;
      nextSoloRowIndex += MOBILE_SOLO_ROW_INTERVAL;
      return true;
    }

    if (desktopFeatureViewport && rowIndex >= nextPairRowIndex && photos.length - photoIndex >= 2) {
      rows.push(buildPairFeatureRow([photos[photoIndex], photos[photoIndex + 1]], containerWidth, baseRowHeight, gap));
      photoIndex += 2;
      rowIndex += 1;
      nextPairRowIndex += DESKTOP_PAIR_ROW_INTERVAL;
      return true;
    }

    return false;
  }

  while (photoIndex < photos.length) {
    if (pushEditorialFeatureRow()) {
      continue;
    }

    const photo = photos[photoIndex];
    rowPhotos.push(photo);
    activeAspectRatio += photoAspectRatio(photo);
    photoIndex += 1;

    const targetHeight = activeTargetHeight();
    const projectedWidth = activeAspectRatio * targetHeight + gap * Math.max(0, rowPhotos.length - 1);
    if (projectedWidth >= containerWidth) {
      pushRow(false);
    }
  }

  pushRow(true);
  return rows;
}
