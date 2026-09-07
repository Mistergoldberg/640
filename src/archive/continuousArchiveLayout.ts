import type { YearIndex } from "../types";

export const YEAR_HEADING_HEIGHT_PX = 58;
export const YEAR_SECTION_GAP_PX = 38;

export interface RelativeAlbumGeometry {
  id: string;
  folderLabel: string;
  top: number;
  bottom: number;
  count: number;
}

export interface ArchiveYearLayoutInput {
  year: string;
  index: YearIndex | null;
  loadedHeight?: number;
  loadedAlbums?: RelativeAlbumGeometry[];
}

export interface ArchiveAlbumGeometry extends RelativeAlbumGeometry {
  year: string;
}

export interface ArchiveYearGeometry {
  year: string;
  top: number;
  headingBottom: number;
  bottom: number;
  isEstimated: boolean;
  albums: ArchiveAlbumGeometry[];
}

export interface ArchiveGeometry {
  totalHeight: number;
  years: ArchiveYearGeometry[];
  albums: ArchiveAlbumGeometry[];
}

export function estimateYearBodyHeight(index: YearIndex | null, width: number, targetRowHeight: number) {
  const count = Math.max(1, index?.sequence.length || index?.scannedCount || index?.albums.reduce((sum, album) => sum + album.count, 0) || 1);
  const averageAspect = 1.34;
  const photosPerRow = Math.max(1.8, width / (targetRowHeight * averageAspect));
  const rows = count / photosPerRow;
  const headings = Math.max(1, index?.albums.length || 1) * 51;
  return Math.max(280, Math.round(rows * (targetRowHeight + 4) + headings));
}

export function buildArchiveGeometry(inputs: ArchiveYearLayoutInput[], width: number, targetRowHeight: number): ArchiveGeometry {
  let top = 0;
  const albums: ArchiveAlbumGeometry[] = [];
  const years = inputs.map((input, inputIndex): ArchiveYearGeometry => {
    if (inputIndex) {
      top += YEAR_SECTION_GAP_PX;
    }
    const yearTop = top;
    const headingBottom = yearTop + YEAR_HEADING_HEIGHT_PX;
    const bodyHeight = input.loadedHeight ?? estimateYearBodyHeight(input.index, width, targetRowHeight);
    const isEstimated = input.loadedHeight === undefined;
    const bodyTop = headingBottom;
    const yearBottom = bodyTop + bodyHeight;
    let yearAlbums: ArchiveAlbumGeometry[];

    if (input.loadedAlbums?.length) {
      yearAlbums = input.loadedAlbums.map((album) => ({
        ...album,
        year: input.year,
        top: bodyTop + album.top,
        bottom: bodyTop + album.bottom
      }));
    } else {
      const sourceAlbums = input.index?.albums || [];
      const total = Math.max(1, sourceAlbums.reduce((sum, album) => sum + Math.max(0, album.count), 0));
      let albumTop = bodyTop;
      yearAlbums = sourceAlbums.map((album, albumIndex) => {
        const nextTop = albumIndex === sourceAlbums.length - 1
          ? yearBottom
          : albumTop + (bodyHeight * Math.max(0, album.count)) / total;
        const result = {
          id: album.id,
          year: input.year,
          folderLabel: album.name,
          top: albumTop,
          bottom: nextTop,
          count: album.count
        };
        albumTop = nextTop;
        return result;
      });
    }

    albums.push(...yearAlbums);
    top = yearBottom;
    return { year: input.year, top: yearTop, headingBottom, bottom: yearBottom, isEstimated, albums: yearAlbums };
  });

  return { totalHeight: Math.max(0, top), years, albums };
}

export function activeYearAtScroll(years: ArchiveYearGeometry[], virtualTop: number) {
  if (!years.length) {
    return null;
  }
  let active = years[0];
  for (const year of years) {
    if (virtualTop < year.top) break;
    active = year;
    if (virtualTop <= year.bottom) break;
  }
  return active.year;
}

export interface StableArchiveAnchor {
  year: string;
  albumId?: string | null;
  photoId?: string | null;
  viewportOffset: number;
}

export function stableAnchorCorrection(previousTop: number | undefined, nextTop: number | undefined) {
  if (previousTop === undefined || nextTop === undefined) return 0;
  return nextTop - previousTop;
}
