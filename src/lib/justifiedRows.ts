import type { Photo } from "../types";

export interface JustifiedItem {
  photo: Photo;
  width: number;
  height: number;
}

export interface JustifiedRow {
  id: string;
  items: JustifiedItem[];
  height: number;
}

function photoAspectRatio(photo: Photo): number {
  if (!photo.width || !photo.height) {
    return 4 / 3;
  }

  return photo.width / photo.height;
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

    const totalGap = gap * Math.max(0, rowPhotos.length - 1);
    const aspectSum = rowPhotos.reduce((sum, photo) => sum + photoAspectRatio(photo), 0);
    const rawHeight = (containerWidth - totalGap) / aspectSum;
    const height = isFinalRow ? Math.min(targetRowHeight, rawHeight) : rawHeight;
    const items = rowPhotos.map((photo) => ({
      photo,
      width: Math.max(42, Math.round(height * photoAspectRatio(photo))),
      height: Math.round(height)
    }));

    rows.push({
      id: rowPhotos.map((photo) => photo.id).join(":"),
      items,
      height: Math.round(height)
    });
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
