import type { Catalog, YearIndex } from "../types";

export const MIN_YEAR_SHARE = 0.075;
export const YEAR_SNAP_RANGE = 0.018;

export interface ArchiveAlbumRange {
  id: string;
  name: string;
  count: number;
  start: number;
  end: number;
}

export interface ArchiveYearRange {
  year: string;
  count: number;
  start: number;
  end: number;
  albums: ArchiveAlbumRange[];
}

export interface ArchiveTimelineModel {
  years: ArchiveYearRange[];
  anchors: Array<{ year: string; albumId: string | null; ratio: number }>;
}

export interface ArchiveTarget {
  year: string;
  albumId: string | null;
  albumName: string | null;
  ratio: number;
  sectionRatio: number;
}

export function orderedArchiveYears(catalog: Catalog) {
  return [...catalog.years].sort((left, right) => Number(right.year) - Number(left.year));
}

export function buildArchiveTimelineModel(catalog: Catalog, indexes: Map<string, YearIndex>): ArchiveTimelineModel {
  const ordered = orderedArchiveYears(catalog);
  if (!ordered.length) {
    return { years: [], anchors: [] };
  }

  const rawCounts = ordered.map(({ year }) => {
    const index = indexes.get(year);
    return Math.max(1, index?.sequence.length || index?.scannedCount || index?.albums.reduce((sum, album) => sum + album.count, 0) || 1);
  });
  const total = rawCounts.reduce((sum, count) => sum + count, 0);
  const minimumWeight = total * MIN_YEAR_SHARE;
  const weights = rawCounts.map((count) => Math.max(count, minimumWeight));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;

  const years = ordered.map(({ year }, yearIndex): ArchiveYearRange => {
    const index = indexes.get(year);
    const start = cursor;
    cursor = yearIndex === ordered.length - 1 ? 1 : cursor + weights[yearIndex] / weightTotal;
    const end = cursor;
    const albumTotal = Math.max(1, index?.albums.reduce((sum, album) => sum + Math.max(0, album.count), 0) || rawCounts[yearIndex]);
    let albumCursor = start;
    const albums = (index?.albums || []).map((album, albumIndex): ArchiveAlbumRange => {
      const albumStart = albumCursor;
      albumCursor = albumIndex === (index?.albums.length || 0) - 1
        ? end
        : albumCursor + ((end - start) * Math.max(0, album.count)) / albumTotal;
      return { id: album.id, name: album.name, count: album.count, start: albumStart, end: albumCursor };
    });

    return { year, count: rawCounts[yearIndex], start, end, albums };
  });

  const anchors = years.flatMap((year) => [
    { year: year.year, albumId: null, ratio: year.start },
    ...year.albums.slice(1).map((album) => ({ year: year.year, albumId: album.id, ratio: album.start }))
  ]);

  return { years, anchors };
}

function clampRatio(ratio: number) {
  return Math.min(1, Math.max(0, ratio));
}

export function archiveTargetAtRatio(model: ArchiveTimelineModel, ratio: number, snapToYear = false): ArchiveTarget | null {
  if (!model.years.length) {
    return null;
  }

  let bounded = clampRatio(ratio);
  if (snapToYear) {
    const nearestBoundary = model.years
      .map((year) => year.start)
      .reduce((nearest, boundary) => Math.abs(boundary - bounded) < Math.abs(nearest - bounded) ? boundary : nearest, 0);
    if (Math.abs(nearestBoundary - bounded) <= YEAR_SNAP_RANGE) {
      bounded = nearestBoundary;
    }
  }

  const year = model.years.find((candidate) => bounded >= candidate.start && bounded < candidate.end) || model.years[model.years.length - 1];
  const album = year.albums.find((candidate) => bounded >= candidate.start && bounded < candidate.end) || year.albums[year.albums.length - 1] || null;
  const span = Math.max(Number.EPSILON, year.end - year.start);

  return {
    year: year.year,
    albumId: album?.id || null,
    albumName: album?.name || null,
    ratio: bounded,
    sectionRatio: clampRatio((bounded - year.start) / span)
  };
}

export function archiveRatioForLocation(model: ArchiveTimelineModel, year: string, albumId: string | null, progress = 0) {
  const yearRange = model.years.find((candidate) => candidate.year === year);
  if (!yearRange) {
    return 0;
  }

  const album = albumId ? yearRange.albums.find((candidate) => candidate.id === albumId) : null;
  const start = album?.start ?? yearRange.start;
  const end = album?.end ?? yearRange.end;
  return clampRatio(start + (end - start) * clampRatio(progress));
}

export function nearestAnchorIndex(model: ArchiveTimelineModel, ratio: number) {
  if (!model.anchors.length) {
    return -1;
  }
  return model.anchors.reduce(
    (nearest, anchor, index) => Math.abs(anchor.ratio - ratio) < Math.abs(model.anchors[nearest].ratio - ratio) ? index : nearest,
    0
  );
}
