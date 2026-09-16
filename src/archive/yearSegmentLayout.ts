import { type LoadedAlbumSummary, type YearCollection } from "../data/useYearCollection";
import { buildEditorialRows, type JustifiedItem, type JustifiedRowTone } from "../lib/justifiedRows";
import { formatPublicArchiveAlbumLabel } from "../lib/archiveAlbumPresentation";
import type { Photo } from "../types";

export const ALBUM_GAP_PX = 18;
export const ALBUM_HEADING_HEIGHT_PX = 24;
export const ALBUM_HEADING_GAP_PX = 9;
export const ALBUM_ERROR_HEIGHT_PX = 52;

export interface LayoutHeading {
  type: "heading";
  id: string;
  top: number;
  height: number;
  year: string;
  album: LoadedAlbumSummary;
}

export interface LayoutRow {
  type: "row";
  id: string;
  top: number;
  height: number;
  gap: number;
  tone: JustifiedRowTone;
  year: string;
  albumId: string;
  items: JustifiedItem[];
}

export interface LayoutAlbumError {
  type: "album-error";
  id: string;
  top: number;
  height: number;
  year: string;
  album: LoadedAlbumSummary;
}

export type LayoutEntry = LayoutHeading | LayoutRow | LayoutAlbumError;

export interface AlbumAnchor {
  id: string;
  year: string;
  folderLabel: string;
  top: number;
  bottom: number;
  count: number;
}

export interface YearAnchor {
  year: string;
  top: number;
  bottom: number;
  albums: AlbumAnchor[];
}

export interface GridLayout {
  entries: LayoutEntry[];
  totalHeight: number;
  photoTops: Map<string, number>;
  albumAnchors: AlbumAnchor[];
  yearAnchors: YearAnchor[];
}

export interface YearSegmentLayoutInput {
  collection: YearCollection;
  width: number;
  targetRowHeight: number;
  gap: number;
  compactViewport?: boolean;
}

function sortPhotos(photos: Photo[]) {
  return [...photos].sort((left, right) => left.sortPosition - right.sortPosition);
}

function yearFromAlbumName(name: string, fallbackYear = "") {
  return name.match(/^(\d{4})/)?.[1] || fallbackYear;
}

export function albumFolderLabel(album: LoadedAlbumSummary) {
  return formatPublicArchiveAlbumLabel(album.name, album.year);
}

export function buildYearSegmentLayout({
  collection,
  width,
  targetRowHeight,
  gap,
  compactViewport = false
}: YearSegmentLayoutInput): GridLayout {
  if (!width) {
    return {
      entries: [],
      totalHeight: 0,
      photoTops: new Map(),
      albumAnchors: [],
      yearAnchors: []
    };
  }

  const photosByAlbum = new Map<string, Photo[]>();
  for (const photo of sortPhotos(collection.photos)) {
    if (!photosByAlbum.has(photo.albumId)) {
      photosByAlbum.set(photo.albumId, []);
    }

    photosByAlbum.get(photo.albumId)?.push(photo);
  }

  const entries: LayoutEntry[] = [];
  const photoTops = new Map<string, number>();
  const albumAnchors: AlbumAnchor[] = [];
  const yearAnchors: YearAnchor[] = [];
  let activeYear = "";
  let activeYearAnchor: YearAnchor | null = null;
  let top = 0;

  collection.index.albums.forEach((album) => {
    const photos = photosByAlbum.get(album.id) || [];
    if (!photos.length && album.loadState === "ready") {
      return;
    }

    const albumYear = album.year || yearFromAlbumName(album.name, activeYear);
    if (albumYear !== activeYear) {
      if (activeYearAnchor) {
        activeYearAnchor.bottom = top;
      }

      if (entries.length) {
        top += ALBUM_GAP_PX;
      }

      activeYear = albumYear;
      const yearTop = top;
      activeYearAnchor = {
        year: albumYear,
        top: yearTop,
        bottom: yearTop,
        albums: []
      };
      yearAnchors.push(activeYearAnchor);
    } else if (entries.length) {
      top += ALBUM_GAP_PX;
    }

    const albumTop = top;
    entries.push({
      type: "heading",
      id: `heading-${album.id}`,
      top,
      height: ALBUM_HEADING_HEIGHT_PX,
      year: albumYear,
      album
    });
    top += ALBUM_HEADING_HEIGHT_PX + ALBUM_HEADING_GAP_PX;

    if (album.loadState !== "ready") {
      entries.push({
        type: "album-error",
        id: `album-error-${album.id}`,
        top,
        height: ALBUM_ERROR_HEIGHT_PX,
        year: albumYear,
        album
      });
      top += ALBUM_ERROR_HEIGHT_PX;
      const albumAnchor = {
        id: album.id,
        year: albumYear,
        folderLabel: albumFolderLabel(album),
        top: albumTop,
        bottom: top,
        count: photos.length
      };
      albumAnchors.push(albumAnchor);
      activeYearAnchor?.albums.push(albumAnchor);
      return;
    }

    let albumHasPhotoEntries = false;

    buildEditorialRows(photos, width, targetRowHeight, gap, compactViewport).forEach((row, rowIndex) => {
      entries.push({
        type: "row",
        id: `${album.id}-${rowIndex}-${row.id}`,
        top,
        height: row.height,
        gap,
        tone: row.tone || "standard",
        year: albumYear,
        albumId: album.id,
        items: row.items
      });

      row.items.forEach((item) => {
        photoTops.set(item.photo.id, top);
      });
      top += row.height + gap;
      albumHasPhotoEntries = true;
    });

    if (albumHasPhotoEntries) {
      top -= gap;
    }

    const albumAnchor = {
      id: album.id,
      year: albumYear,
      folderLabel: albumFolderLabel(album),
      top: albumTop,
      bottom: top,
      count: photos.length
    };
    albumAnchors.push(albumAnchor);
    activeYearAnchor?.albums.push(albumAnchor);
  });

  const finalYearAnchor = yearAnchors[yearAnchors.length - 1];
  if (finalYearAnchor) {
    finalYearAnchor.bottom = top;
  }

  return {
    entries,
    totalHeight: Math.max(0, top),
    photoTops,
    albumAnchors,
    yearAnchors
  };
}

export function segmentHeightFromRowPlan(layout: Pick<GridLayout, "totalHeight">) {
  return layout.totalHeight;
}
