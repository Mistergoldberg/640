import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assetUrl, mediaUrl } from "./lib/assets";
import { buildJustifiedRows, type JustifiedItem } from "./lib/justifiedRows";
import { useElementWidth } from "./hooks/useElementWidth";
import { validateCatalog } from "./data/manifestValidation";
import { type LoadedAlbumSummary, type YearCollection, useYearCollection } from "./data/useYearCollection";
import { PhotoPlayer as PhotoPlayerView } from "./player/PhotoPlayer";
import type { Catalog, CatalogYear, Photo } from "./types";

const CATALOG_URL = assetUrl("data/catalog.json");
const GRID_OVERSCAN_PX = 1100;
const ALBUM_GAP_PX = 18;
const ALBUM_HEADING_HEIGHT_PX = 24;
const ALBUM_HEADING_GAP_PX = 9;
const ALBUM_ERROR_HEIGHT_PX = 52;
const PREVIEW_MIN_REMAINING_PHOTOS = 8;
const STREAM_MOSAIC_MIN_WINDOW_PHOTOS = 24;
const STREAM_MOSAIC_MAX_WINDOW_PHOTOS = 44;
const RESTORE_OFFSET_PX = 112;
const APP_HISTORY_KEY = "640x480";
const SCRUBBER_KEY_STEP_PX = 560;
const SCRUBBER_PAGE_STEP_RATIO = 0.12;
const SELECTED_YEAR_STORAGE_KEY = "640x480-selected-year";
const YEAR_SCROLL_STORAGE_PREFIX = "640x480-scroll";

type PreviewShape = "square" | "landscape" | "portrait";

interface LayoutHeading {
  type: "heading";
  id: string;
  top: number;
  height: number;
  year: string;
  album: LoadedAlbumSummary;
}

interface LayoutRow {
  type: "row";
  id: string;
  top: number;
  height: number;
  gap: number;
  year: string;
  albumId: string;
  items: JustifiedItem[];
}

interface MosaicItem {
  photo: Photo;
  shape: PreviewShape;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface LayoutMosaic {
  type: "mosaic";
  id: string;
  top: number;
  height: number;
  year: string;
  albumId: string;
  items: MosaicItem[];
}

interface LayoutAlbumError {
  type: "album-error";
  id: string;
  top: number;
  height: number;
  year: string;
  album: LoadedAlbumSummary;
}

interface MosaicSlot {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  shape: PreviewShape;
}

type LayoutEntry = LayoutHeading | LayoutRow | LayoutMosaic | LayoutAlbumError;

interface AlbumAnchor {
  id: string;
  year: string;
  folderLabel: string;
  top: number;
  bottom: number;
  count: number;
}

interface YearAnchor {
  year: string;
  top: number;
  bottom: number;
  albums: AlbumAnchor[];
}

interface GridLayout {
  entries: LayoutEntry[];
  totalHeight: number;
  photoTops: Map<string, number>;
  albumAnchors: AlbumAnchor[];
  yearAnchors: YearAnchor[];
}

type CatalogLoadState =
  | { status: "loading"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: Catalog };

interface AppHistoryState {
  app?: string;
  year?: string;
  photoId?: string | null;
  view?: "grid" | "photo";
  fromGrid?: boolean;
}

function sortPhotos(photos: Photo[]) {
  return [...photos].sort((left, right) => left.sortPosition - right.sortPosition);
}

function sortCatalogYears(years: CatalogYear[]) {
  return [...years].sort((left, right) => Number(right.year) - Number(left.year));
}

function yearExists(catalog: Catalog, year: string | null) {
  return Boolean(year && catalog.years.some((candidate) => candidate.year === year));
}

function displayAlbumName(name: string) {
  if (name === "2013-10-09/edit") {
    return "2013-10-09 · Edit";
  }

  if (name === "2013-10-09/pixel") {
    return "2013-10-09 · Pixel";
  }

  if (name === "2002-Thialand") {
    return "2002-Thailand";
  }

  return name;
}

function yearFromAlbumName(name: string, fallbackYear = "") {
  return name.match(/^(\d{4})/)?.[1] || fallbackYear;
}

function albumFolderLabel(album: LoadedAlbumSummary) {
  const displayName = displayAlbumName(album.name);
  const yearPrefix = `${album.year}-`;

  if (displayName.startsWith(yearPrefix)) {
    return displayName.slice(yearPrefix.length);
  }

  if (displayName.startsWith(`${album.year}/`)) {
    return displayName.slice(album.year.length + 1);
  }

  return displayName;
}

function timelineAlbumLabel(album: AlbumAnchor) {
  return `${album.year} ${album.folderLabel}`.trim();
}

function newestCatalogYear(catalog: Catalog) {
  return sortCatalogYears(catalog.years)[0]?.year || null;
}

function readUrlYear(catalog: Catalog) {
  if (typeof window === "undefined") {
    return null;
  }

  const year = new URL(window.location.href).searchParams.get("year");
  return yearExists(catalog, year) ? year : null;
}

function readUrlPhotoId() {
  if (typeof window === "undefined") {
    return null;
  }

  return new URL(window.location.href).searchParams.get("photo");
}

function currentPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function updateUrlState(year: string, photoId: string | null, mode: "push" | "replace", fromGrid = false) {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("year", year);

  if (photoId) {
    nextUrl.searchParams.set("photo", photoId);
  } else {
    nextUrl.searchParams.delete("photo");
  }

  const nextPath = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  const nextState: AppHistoryState = {
    app: APP_HISTORY_KEY,
    year,
    photoId,
    view: photoId ? "photo" : "grid",
    fromGrid: Boolean(photoId && fromGrid)
  };

  if (mode === "replace") {
    window.history.replaceState(nextState, "", nextPath);
    return;
  }

  if (nextPath !== currentPath()) {
    window.history.pushState(nextState, "", nextPath);
  }
}

function readStoredYear(catalog: Catalog) {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const year = window.localStorage.getItem(SELECTED_YEAR_STORAGE_KEY);
    return yearExists(catalog, year) ? year : null;
  } catch {
    return null;
  }
}

function resolveInitialYear(catalog: Catalog) {
  return readUrlYear(catalog) || readStoredYear(catalog) || newestCatalogYear(catalog);
}

function writeStoredYear(year: string) {
  try {
    window.localStorage.setItem(SELECTED_YEAR_STORAGE_KEY, year);
  } catch {
    // Local storage may be disabled; URL state still carries the selected year.
  }
}

function scrollStorageKey(year: string) {
  return `${YEAR_SCROLL_STORAGE_PREFIX}:${year}`;
}

function readStoredScrollPosition(year: string) {
  try {
    const value = window.sessionStorage.getItem(scrollStorageKey(year));
    const parsed = value === null ? 0 : Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  } catch {
    return 0;
  }
}

function writeStoredScrollPosition(year: string, scrollY: number) {
  try {
    window.sessionStorage.setItem(scrollStorageKey(year), String(Math.max(0, Math.round(scrollY))));
  } catch {
    // Session storage may be disabled; year switching still works.
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }

  return response.json();
}

function useCatalog(): CatalogLoadState {
  const [state, setState] = useState<CatalogLoadState>({ status: "loading", message: "Loading catalogue" });

  useEffect(() => {
    let isMounted = true;

    async function loadCatalog() {
      const catalog = validateCatalog(await fetchJson(CATALOG_URL));
      const years = sortCatalogYears(catalog.years || []);
      if (!years.length) {
        throw new Error("No imported years are available in the catalogue");
      }

      if (isMounted) {
        setState({
          status: "ready",
          catalog: {
            ...catalog,
            years
          }
        });
      }
    }

    loadCatalog().catch((error: unknown) => {
      if (isMounted) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Catalogue could not be loaded"
        });
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  return state;
}

function useViewport() {
  const [viewport, setViewport] = useState(() => ({
    scrollY: typeof window === "undefined" ? 0 : window.scrollY,
    height: typeof window === "undefined" ? 800 : window.innerHeight
  }));

  useEffect(() => {
    let frame = 0;

    const update = () => {
      frame = 0;
      setViewport({
        scrollY: window.scrollY,
        height: window.innerHeight
      });
    };

    const schedule = () => {
      if (frame) {
        return;
      }

      frame = window.requestAnimationFrame(update);
    };

    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return viewport;
}

function normalizeMosaicSlots(slots: MosaicSlot[]) {
  return [...slots].sort((left, right) => left.row - right.row || left.col - right.col);
}

function hashString(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function seededRandom(seed: string) {
  let state = hashString(seed) || 1;

  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomInt(random: () => number, min: number, max: number) {
  return Math.floor(random() * (max - min + 1)) + min;
}

function previewColumnCount(width: number) {
  if (width >= 1180) {
    return 6;
  }

  if (width >= 900) {
    return 5;
  }

  if (width >= 560) {
    return 4;
  }

  return 3;
}

function previewMosaicTemplates(width: number): MosaicSlot[][] {
  let templates: MosaicSlot[][];

  if (width >= 1180) {
    templates = [
      [
        { col: 0, row: 0, colSpan: 2, rowSpan: 2, shape: "square" },
        { col: 2, row: 0, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 3, row: 0, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 5, row: 0, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 3, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 4, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 5, row: 1, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 0, row: 2, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 2, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 3, row: 2, colSpan: 2, rowSpan: 1, shape: "landscape" }
      ],
      [
        { col: 0, row: 0, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 2, row: 0, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 3, row: 0, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 4, row: 0, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 5, row: 0, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 1, row: 1, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 2, row: 1, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 5, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 2, row: 2, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 4, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 5, row: 2, colSpan: 1, rowSpan: 1, shape: "square" }
      ],
      [
        { col: 0, row: 0, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 1, row: 0, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 3, row: 0, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 4, row: 0, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 5, row: 0, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 1, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 2, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 3, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 5, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 1, row: 2, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 2, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 3, row: 2, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 5, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 3, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 2, row: 3, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 4, row: 3, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 5, row: 3, colSpan: 1, rowSpan: 1, shape: "square" }
      ]
    ];
  } else if (width >= 900) {
    templates = [
      [
        { col: 0, row: 0, colSpan: 2, rowSpan: 2, shape: "square" },
        { col: 2, row: 0, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 3, row: 0, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 3, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 4, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 2, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 2, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 3, row: 2, colSpan: 2, rowSpan: 1, shape: "landscape" }
      ],
      [
        { col: 0, row: 0, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 2, row: 0, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 3, row: 0, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 4, row: 0, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 1, row: 1, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 4, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 1, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 2, row: 2, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 4, row: 2, colSpan: 1, rowSpan: 1, shape: "square" }
      ],
      [
        { col: 0, row: 0, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 1, row: 0, colSpan: 2, rowSpan: 2, shape: "square" },
        { col: 3, row: 0, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 3, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 4, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 2, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 2, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 3, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 4, row: 2, colSpan: 1, rowSpan: 1, shape: "square" }
      ]
    ];
  } else if (width >= 560) {
    templates = [
      [
        { col: 0, row: 0, colSpan: 2, rowSpan: 2, shape: "square" },
        { col: 2, row: 0, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 3, row: 0, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 3, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 2, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 2, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 3, row: 2, colSpan: 1, rowSpan: 1, shape: "square" }
      ],
      [
        { col: 0, row: 0, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 2, row: 0, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 3, row: 0, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 1, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 3, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 1, row: 2, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 3, row: 2, colSpan: 1, rowSpan: 1, shape: "square" }
      ],
      [
        { col: 0, row: 0, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 1, row: 0, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 3, row: 0, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 1, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 2, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 3, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 2, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 2, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 3, row: 2, colSpan: 1, rowSpan: 1, shape: "square" }
      ]
    ];
  } else {
    templates = [
      [
        { col: 0, row: 0, colSpan: 2, rowSpan: 2, shape: "square" },
        { col: 2, row: 0, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 0, row: 2, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 2, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 3, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 1, row: 3, colSpan: 2, rowSpan: 1, shape: "landscape" }
      ],
      [
        { col: 0, row: 0, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 2, row: 0, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 0, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 1, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 1, row: 2, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 0, row: 3, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 1, row: 3, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 2, row: 3, colSpan: 1, rowSpan: 1, shape: "square" }
      ],
      [
        { col: 0, row: 0, colSpan: 1, rowSpan: 2, shape: "portrait" },
        { col: 1, row: 0, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 1, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 2, row: 1, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 2, colSpan: 2, rowSpan: 1, shape: "landscape" },
        { col: 2, row: 2, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 0, row: 3, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 1, row: 3, colSpan: 1, rowSpan: 1, shape: "square" },
        { col: 2, row: 3, colSpan: 1, rowSpan: 1, shape: "square" }
      ]
    ];
  }

  return templates.map(normalizeMosaicSlots);
}

function streamMosaicWindowSize(slotCount: number, random: () => number) {
  const minWindow = Math.max(STREAM_MOSAIC_MIN_WINDOW_PHOTOS, slotCount + PREVIEW_MIN_REMAINING_PHOTOS);
  const maxWindow = Math.max(minWindow, STREAM_MOSAIC_MAX_WINDOW_PHOTOS);

  return randomInt(random, minWindow, maxWindow);
}

function buildPreviewMosaic(photos: Photo[], width: number, gap: number, seed: string) {
  const columns = previewColumnCount(width);
  const templates = previewMosaicTemplates(width).filter((template) => photos.length >= template.length + PREVIEW_MIN_REMAINING_PHOTOS);
  if (!templates.length) {
    return null;
  }

  const random = seededRandom(seed);
  const slots = templates[randomInt(random, 0, templates.length - 1)];
  const mosaicPhotos = photos.slice(0, slots.length);

  const cellSize = (width - gap * (columns - 1)) / columns;
  const rowCount = Math.max(...slots.map((slot) => slot.row + slot.rowSpan));

  return {
    height: Math.round(rowCount * cellSize + gap * Math.max(0, rowCount - 1)),
    items: slots.map((slot, index) => ({
      photo: mosaicPhotos[index],
      shape: slot.shape,
      left: Math.round(slot.col * (cellSize + gap)),
      top: Math.round(slot.row * (cellSize + gap)),
      width: Math.round(slot.colSpan * cellSize + gap * Math.max(0, slot.colSpan - 1)),
      height: Math.round(slot.rowSpan * cellSize + gap * Math.max(0, slot.rowSpan - 1))
    })),
    usedCount: mosaicPhotos.length
  };
}

function buildGridLayout(collection: YearCollection, width: number, targetRowHeight: number, gap: number): GridLayout {
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

    const templates = previewMosaicTemplates(width);
    const smallestMosaicSlotCount = Math.min(...templates.map((template) => template.length));
    let photoIndex = 0;
    let chunkIndex = 0;
    let albumHasPhotoEntries = false;

    while (photoIndex < photos.length) {
      const remainingPhotoCount = photos.length - photoIndex;
      const canBuildMosaic = remainingPhotoCount >= smallestMosaicSlotCount + PREVIEW_MIN_REMAINING_PHOTOS;
      const seedBase = `${album.id}:${albumYear}:${previewColumnCount(width)}:${chunkIndex}`;
      const chunkSize = canBuildMosaic
        ? Math.min(remainingPhotoCount, streamMosaicWindowSize(smallestMosaicSlotCount, seededRandom(`${seedBase}:window`)))
        : remainingPhotoCount;
      const chunkPhotos = photos.slice(photoIndex, photoIndex + chunkSize);
      const previewMosaic = canBuildMosaic ? buildPreviewMosaic(chunkPhotos, width, gap, `${seedBase}:mosaic`) : null;

      if (previewMosaic) {
        entries.push({
          type: "mosaic",
          id: `mosaic-${album.id}-${chunkIndex}`,
          top,
          height: previewMosaic.height,
          year: albumYear,
          albumId: album.id,
          items: previewMosaic.items
        });

        previewMosaic.items.forEach((item) => {
          photoTops.set(item.photo.id, top + item.top);
        });
        top += previewMosaic.height + gap;
        albumHasPhotoEntries = true;
      }

      const rowPhotos = previewMosaic ? chunkPhotos.slice(previewMosaic.usedCount) : chunkPhotos;
      const rows = buildJustifiedRows(rowPhotos, width, targetRowHeight, gap);
      rows.forEach((row) => {
        entries.push({
          type: "row",
          id: `${album.id}-${chunkIndex}-${row.id}`,
          top,
          height: row.height,
          gap,
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

      photoIndex += chunkSize;
      chunkIndex += 1;
    }

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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function findAlbumAtTop(layout: GridLayout, virtualTop: number) {
  if (!layout.albumAnchors.length) {
    return null;
  }

  const boundedTop = clamp(virtualTop, 0, Math.max(0, layout.totalHeight));
  let activeAlbum = layout.albumAnchors[0];

  for (const album of layout.albumAnchors) {
    if (boundedTop < album.top) {
      break;
    }

    activeAlbum = album;
    if (boundedTop <= album.bottom) {
      break;
    }
  }

  return activeAlbum;
}

function findYearAtTop(layout: GridLayout, virtualTop: number) {
  if (!layout.yearAnchors.length) {
    return null;
  }

  const boundedTop = clamp(virtualTop, 0, Math.max(0, layout.totalHeight));
  let activeYear = layout.yearAnchors[0];

  for (const year of layout.yearAnchors) {
    if (boundedTop < year.top) {
      break;
    }

    activeYear = year;
    if (boundedTop <= year.bottom) {
      break;
    }
  }

  return activeYear;
}

function escapeCssAttribute(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function App() {
  const catalogState = useCatalog();
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const [scrollTargetYear, setScrollTargetYear] = useState<string | null>(null);
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null);
  const [restorePhotoId, setRestorePhotoId] = useState<string | null>(null);
  const selectedYearRef = useRef<string | null>(null);
  const activePhotoIdRef = useRef<string | null>(null);
  const pendingClosePhotoIdRef = useRef<string | null>(null);
  const initializedYearRef = useRef(false);

  const catalog = catalogState.status === "ready" ? catalogState.catalog : null;
  const yearLoader = useYearCollection(catalog, selectedYear);
  const loadState = yearLoader.state;
  const displayCollection = loadState.collection;
  const activePhotoIndex = useMemo(() => {
    if (!displayCollection || !activePhotoId) {
      return null;
    }

    const index = displayCollection.photos.findIndex((photo) => photo.id === activePhotoId);
    return index >= 0 ? index : null;
  }, [activePhotoId, displayCollection]);

  useEffect(() => {
    selectedYearRef.current = selectedYear;
  }, [selectedYear]);

  useEffect(() => {
    activePhotoIdRef.current = activePhotoId;
  }, [activePhotoId]);

  const saveCurrentScrollPosition = useCallback(() => {
    const year = selectedYearRef.current;
    if (year) {
      writeStoredScrollPosition(year, window.scrollY);
    }
  }, []);

  useEffect(() => {
    if (!catalog) {
      return;
    }

    const nextYear = selectedYear && yearExists(catalog, selectedYear) ? selectedYear : resolveInitialYear(catalog);
    if (!nextYear) {
      return;
    }

    if (nextYear !== selectedYear) {
      setSelectedYear(nextYear);
    }

    writeStoredYear(nextYear);
    if (!initializedYearRef.current) {
      initializedYearRef.current = true;
      setScrollTargetYear(nextYear);
      updateUrlState(nextYear, readUrlPhotoId(), "replace", Boolean((window.history.state as AppHistoryState | null)?.fromGrid));
    }
  }, [catalog, selectedYear]);

  useEffect(() => {
    if (!catalog) {
      return;
    }

    const handlePopState = () => {
      const nextYear = readUrlYear(catalog) || selectedYearRef.current || readStoredYear(catalog) || newestCatalogYear(catalog);
      const nextPhotoId = readUrlPhotoId();
      const previousActivePhotoId = activePhotoIdRef.current;

      if (!nextYear) {
        return;
      }

      saveCurrentScrollPosition();
      setSelectedYear(nextYear);

      if (nextPhotoId) {
        setActivePhotoId(nextPhotoId);
        setRestorePhotoId(nextPhotoId);
      } else {
        const restoreId = pendingClosePhotoIdRef.current || previousActivePhotoId;
        setActivePhotoId(null);
        setRestorePhotoId(restoreId);
        if (!restoreId) {
          setScrollTargetYear(nextYear);
        }
      }

      pendingClosePhotoIdRef.current = null;
      writeStoredYear(nextYear);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [catalog, saveCurrentScrollPosition]);

  useEffect(() => {
    if (!displayCollection || loadState.status !== "ready" || !selectedYear || displayCollection.year !== selectedYear) {
      return;
    }

    const urlPhotoId = readUrlPhotoId();
    if (!urlPhotoId) {
      if (activePhotoId && !displayCollection.photos.some((photo) => photo.id === activePhotoId)) {
        setActivePhotoId(null);
      }
      return;
    }

    const photo = displayCollection.photos.find((candidate) => candidate.id === urlPhotoId);
    if (!photo) {
      setActivePhotoId(null);
      setRestorePhotoId(null);
      updateUrlState(selectedYear, null, "replace");
      return;
    }

    setActivePhotoId(urlPhotoId);
    setRestorePhotoId(urlPhotoId);

    const historyState = window.history.state as AppHistoryState | null;
    if (historyState?.app !== APP_HISTORY_KEY || historyState.year !== selectedYear || historyState.photoId !== urlPhotoId) {
      updateUrlState(selectedYear, urlPhotoId, "replace", Boolean(historyState?.fromGrid));
    }
  }, [activePhotoId, displayCollection, loadState.status, selectedYear]);

  useEffect(() => {
    const handlePageHide = () => saveCurrentScrollPosition();
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [saveCurrentScrollPosition]);

  const handleVisibleYearChange = useCallback(
    (year: string) => {
      if (!catalog || year === selectedYearRef.current || !yearExists(catalog, year)) {
        return;
      }

      setSelectedYear(year);
      writeStoredYear(year);
      if (!readUrlPhotoId()) {
        updateUrlState(year, null, "replace");
      }
    },
    [catalog]
  );

  const selectYear = useCallback(
    (year: string) => {
      if (!catalog || !yearExists(catalog, year)) {
        return;
      }

      saveCurrentScrollPosition();
      setActivePhotoId(null);
      setRestorePhotoId(null);
      setSelectedYear(year);
      setScrollTargetYear(year);
      writeStoredYear(year);
      updateUrlState(year, null, "push");
    },
    [catalog, saveCurrentScrollPosition]
  );

  const openPhoto = useCallback(
    (index: number) => {
      if (!displayCollection) {
        return;
      }

      const photo = displayCollection.photos[index];
      if (!photo) {
        return;
      }

      const photoYear = displayCollection.year;
      setRestorePhotoId(photo.id);
      setActivePhotoId(photo.id);
      setSelectedYear(photoYear);
      writeStoredYear(photoYear);
      updateUrlState(photoYear, photo.id, "push", true);
    },
    [displayCollection]
  );

  const closePlayer = useCallback((photoId: string) => {
    const restoreId = photoId || activePhotoIdRef.current;
    pendingClosePhotoIdRef.current = restoreId;
    const historyState = window.history.state as AppHistoryState | null;

    if (readUrlPhotoId() && historyState?.app === APP_HISTORY_KEY && historyState.view === "photo" && historyState.fromGrid) {
      window.history.back();
      return;
    }

    if (selectedYearRef.current) {
      updateUrlState(selectedYearRef.current, null, "replace");
    }

    setActivePhotoId(null);
    setRestorePhotoId(restoreId);
    pendingClosePhotoIdRef.current = null;
  }, []);

  if (catalogState.status === "loading") {
    return <SystemState title="640×480" message={catalogState.message} />;
  }

  if (catalogState.status === "error") {
    return <SystemState title="640×480" message={catalogState.message} />;
  }

  if (!selectedYear) {
    return <SystemState title="640×480" message="Selecting year" />;
  }

  if (!displayCollection && loadState.status === "loading") {
    return <SystemState title={selectedYear} message={loadState.message} />;
  }

  if (!displayCollection && loadState.status === "error") {
    return <SystemState title={selectedYear} message={loadState.message} actionLabel="Retry" onAction={yearLoader.retry} />;
  }

  if (!displayCollection) {
    return <SystemState title={selectedYear} message="No imported photos" />;
  }

  if (!displayCollection.photos.length && !displayCollection.index.albums.length) {
    return <SystemState title={selectedYear} message="No imported photos" />;
  }

  const failedAlbumCount = displayCollection.failedAlbumIds.length;
  const statusMessage =
    loadState.status === "loading" && displayCollection
      ? loadState.message
      : loadState.status === "error"
        ? loadState.message
        : failedAlbumCount
          ? `${failedAlbumCount} album${failedAlbumCount === 1 ? "" : "s"} could not load`
          : null;
  const statusTone = loadState.status === "error" || failedAlbumCount ? "error" : "loading";

  return (
    <>
      <CollectionGrid
        collection={displayCollection}
        selectedYear={selectedYear}
        scrollTargetYear={scrollTargetYear}
        statusMessage={statusMessage}
        statusTone={statusTone}
        restorePhotoId={restorePhotoId}
        onRestoreComplete={() => setRestorePhotoId(null)}
        onScrollTargetComplete={() => setScrollTargetYear(null)}
        onVisibleYearChange={handleVisibleYearChange}
        onOpenPhoto={openPhoto}
        onRetry={loadState.status === "error" ? yearLoader.retry : undefined}
        onRetryAlbum={yearLoader.retryAlbum}
        onSelectYear={selectYear}
      />
      {activePhotoId && activePhotoIndex !== null ? (
        <PhotoPlayerView
          key={`${displayCollection.year}:${activePhotoId}`}
          photos={displayCollection.photos}
          initialIndex={activePhotoIndex}
          scope={{ type: "year", year: displayCollection.year }}
          onClose={closePlayer}
        />
      ) : null}
    </>
  );
}

function SystemState({
  title,
  message,
  actionLabel,
  onAction
}: {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <main className="system-state">
      <h1>{title}</h1>
      <p>{message}</p>
      {actionLabel && onAction ? (
        <button type="button" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </main>
  );
}

function CollectionGrid({
  collection,
  selectedYear,
  scrollTargetYear,
  statusMessage,
  statusTone,
  restorePhotoId,
  onRestoreComplete,
  onScrollTargetComplete,
  onVisibleYearChange,
  onOpenPhoto,
  onRetry,
  onRetryAlbum,
  onSelectYear
}: {
  collection: YearCollection;
  selectedYear: string;
  scrollTargetYear: string | null;
  statusMessage: string | null;
  statusTone: "loading" | "error";
  restorePhotoId: string | null;
  onRestoreComplete: () => void;
  onScrollTargetComplete: () => void;
  onVisibleYearChange: (year: string) => void;
  onOpenPhoto: (index: number) => void;
  onRetry?: () => void;
  onRetryAlbum: (albumId: string) => void;
  onSelectYear: (year: string) => void;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const viewport = useViewport();
  const restoredScrollYearRef = useRef<string | null>(null);
  const previousWidthRef = useRef(0);
  const visibleAnchorPhotoIdRef = useRef<string | null>(null);
  const targetHeight = width < 520 ? 118 : width < 900 ? 146 : 174;
  const gap = width < 520 ? 3 : 4;
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    collection.photos.forEach((photo, index) => map.set(photo.id, index));
    return map;
  }, [collection.photos]);
  const layout = useMemo(() => buildGridLayout(collection, width, targetHeight, gap), [collection, gap, targetHeight, width]);

  const containerTop = ref.current ? ref.current.getBoundingClientRect().top + viewport.scrollY : 0;
  const localViewportTop = viewport.scrollY - containerTop;
  const visibleTop = localViewportTop - GRID_OVERSCAN_PX;
  const visibleBottom = localViewportTop + viewport.height + GRID_OVERSCAN_PX;
  const visibleEntries = layout.entries.filter((entry) => entry.top + entry.height >= visibleTop && entry.top <= visibleBottom);
  const currentAlbum = findAlbumAtTop(layout, localViewportTop + 56);
  const currentYear = findYearAtTop(layout, localViewportTop + 56)?.year || selectedYear;
  const albumHeadingIsVisible = Boolean(
    currentAlbum && localViewportTop < currentAlbum.top + ALBUM_HEADING_HEIGHT_PX + ALBUM_HEADING_GAP_PX + 88
  );
  const showAlbumContext = Boolean(currentAlbum && !albumHeadingIsVisible);
  const visibleAnchorPhotoId = useMemo(() => {
    const firstVisiblePhotoEntry = layout.entries.find(
      (entry): entry is LayoutMosaic | LayoutRow =>
        (entry.type === "mosaic" || entry.type === "row") && entry.top + entry.height >= Math.max(0, localViewportTop)
    );

    return firstVisiblePhotoEntry?.items[0]?.photo.id || null;
  }, [layout.entries, localViewportTop]);

  useEffect(() => {
    if (!width || !previousWidthRef.current) {
      previousWidthRef.current = width;
      return;
    }

    const previousWidth = previousWidthRef.current;
    previousWidthRef.current = width;
    const anchorPhotoId = visibleAnchorPhotoIdRef.current;
    if (previousWidth === width || !anchorPhotoId || !layout.photoTops.has(anchorPhotoId) || !ref.current) {
      return;
    }

    const nextTop = ref.current.getBoundingClientRect().top + window.scrollY + (layout.photoTops.get(anchorPhotoId) || 0) - RESTORE_OFFSET_PX;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: Math.max(0, nextTop), behavior: "auto" });
    });
  }, [layout.photoTops, width]);

  useEffect(() => {
    visibleAnchorPhotoIdRef.current = visibleAnchorPhotoId;
  }, [visibleAnchorPhotoId]);

  useEffect(() => {
    if (currentYear && !scrollTargetYear) {
      onVisibleYearChange(currentYear);
    }
  }, [currentYear, onVisibleYearChange, scrollTargetYear]);

  useEffect(() => {
    if (!scrollTargetYear || !ref.current || !width) {
      return;
    }

    const target = layout.yearAnchors.find((year) => year.year === scrollTargetYear);
    if (!target) {
      return;
    }

    const nextTop = ref.current.getBoundingClientRect().top + window.scrollY + target.top - 8;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: Math.max(0, nextTop), behavior: "auto" });
      restoredScrollYearRef.current = collection.year;
      onScrollTargetComplete();
    });
  }, [collection.year, layout.yearAnchors, onScrollTargetComplete, scrollTargetYear, width]);

  useEffect(() => {
    if (!ref.current || !width || restorePhotoId || scrollTargetYear || restoredScrollYearRef.current === collection.year) {
      return;
    }

    restoredScrollYearRef.current = collection.year;
    const nextTop = readStoredScrollPosition(collection.year);
    window.requestAnimationFrame(() => {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: clamp(nextTop, 0, maxScroll), behavior: "auto" });
    });
  }, [collection.year, layout.totalHeight, restorePhotoId, scrollTargetYear, width]);

  useEffect(() => {
    if (!restorePhotoId || !ref.current || !layout.photoTops.has(restorePhotoId)) {
      return;
    }

    const nextTop = ref.current.getBoundingClientRect().top + window.scrollY + (layout.photoTops.get(restorePhotoId) || 0) - RESTORE_OFFSET_PX;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: Math.max(0, nextTop), behavior: "auto" });
      window.requestAnimationFrame(() => {
        const selector = `[data-photo-id="${escapeCssAttribute(restorePhotoId)}"]`;
        ref.current?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
        restoredScrollYearRef.current = collection.year;
        onRestoreComplete();
      });
    });
  }, [collection.year, layout, onRestoreComplete, restorePhotoId, width]);

  return (
    <main className="collection-shell">
      <header className="collection-chrome">
        <div className="app-bar">
          <div className="app-bar__identity">
            <span className="app-bar__brand">640×480</span>
            <span className="app-bar__year">{currentYear}</span>
          </div>
          <span className="app-bar__range">{collection.years[0]}-{collection.years[collection.years.length - 1]}</span>
        </div>
        <div className={`album-context ${showAlbumContext ? "" : "album-context--hidden"}`} aria-live="polite" aria-hidden={!showAlbumContext}>
          <span className="album-context__year">{currentAlbum?.year || currentYear}</span>
          <span className="album-context__folder">{currentAlbum?.folderLabel || ""}</span>
        </div>
        {statusMessage ? (
          <div className={`collection-status collection-status--${statusTone}`} role={statusTone === "error" ? "alert" : "status"}>
            <span>{statusMessage}</span>
            {onRetry ? (
              <button type="button" onClick={onRetry}>
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      <div id="photo-grid" className="virtual-album-stack" ref={ref} style={{ height: layout.totalHeight || undefined }}>
        {visibleEntries.map((entry) => {
          if (entry.type === "heading") {
            return (
              <div className="album-group__heading virtual-entry" key={entry.id} style={{ top: entry.top, height: entry.height }}>
                <h2>
                  <span className="album-heading__year">{entry.year}</span>
                  <span className="album-heading__folder">{albumFolderLabel(entry.album)}</span>
                </h2>
                <span>{entry.album.count}</span>
              </div>
            );
          }

          if (entry.type === "mosaic") {
            return (
              <div className="photo-mosaic virtual-entry" key={entry.id} style={{ top: entry.top, height: entry.height }}>
                {entry.items.map((item) => (
                  <button
                    className={`photo-tile photo-tile--mosaic photo-tile--preview-${item.shape} photo-tile--${item.photo.orientation}`}
                    key={item.photo.id}
                    type="button"
                    data-photo-id={item.photo.id}
                    style={{ left: item.left, top: item.top, width: item.width, height: item.height }}
                    onClick={() => {
                      const index = indexById.get(item.photo.id);
                      if (typeof index === "number") {
                        onOpenPhoto(index);
                      }
                    }}
                    aria-label={`Open featured ${item.shape} photo ${(indexById.get(item.photo.id) || 0) + 1} of ${collection.photos.length}`}
                  >
                    <img
                      src={mediaUrl(item.photo.thumbnailKey)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      width={item.photo.width}
                      height={item.photo.height}
                    />
                  </button>
                ))}
              </div>
            );
          }

          if (entry.type === "album-error") {
            const isLoading = entry.album.loadState === "loading";
            return (
              <div
                className={`album-error album-error--${entry.album.loadState} virtual-entry`}
                key={entry.id}
                style={{ top: entry.top, height: entry.height }}
                role={isLoading ? "status" : "alert"}
              >
                <span>{isLoading ? "Loading album" : entry.album.errorMessage || "Album could not be loaded"}</span>
                {!isLoading ? (
                  <button type="button" onClick={() => onRetryAlbum(entry.album.id)}>
                    Retry
                  </button>
                ) : null}
              </div>
            );
          }

          return (
            <div className="photo-row virtual-entry" key={entry.id} style={{ top: entry.top, height: entry.height, gap: entry.gap }}>
              {entry.items.map((item) => (
                <button
                  className={`photo-tile photo-tile--${item.photo.orientation}`}
                  key={item.photo.id}
                  type="button"
                  data-photo-id={item.photo.id}
                  style={{ width: item.width, height: item.height }}
                  onClick={() => {
                    const index = indexById.get(item.photo.id);
                    if (typeof index === "number") {
                      onOpenPhoto(index);
                    }
                  }}
                  aria-label={`Open photo ${(indexById.get(item.photo.id) || 0) + 1} of ${collection.photos.length}`}
                >
                  <img
                    src={mediaUrl(item.photo.thumbnailKey)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width={item.photo.width}
                    height={item.photo.height}
                  />
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <ArchiveTimeline
        layout={layout}
        years={collection.years}
        viewport={viewport}
        containerTop={containerTop}
        activeYear={currentYear}
        activeAlbumId={currentAlbum?.id || null}
        onSelectYear={onSelectYear}
      />
    </main>
  );
}

function ArchiveTimeline({
  layout,
  years,
  viewport,
  containerTop,
  activeYear,
  activeAlbumId,
  onSelectYear
}: {
  layout: GridLayout;
  years: string[];
  viewport: { scrollY: number; height: number };
  containerTop: number;
  activeYear: string;
  activeAlbumId: string | null;
  onSelectYear: (year: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const pendingClientYRef = useRef<number | null>(null);
  const frameRef = useRef(0);
  const labelTimerRef = useRef<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const [hoverAlbum, setHoverAlbum] = useState<AlbumAnchor | null>(null);

  const maxVirtualScroll = Math.max(0, layout.totalHeight - viewport.height);
  const localScrollTop = clamp(viewport.scrollY - containerTop, 0, maxVirtualScroll);
  const progress = maxVirtualScroll > 0 ? clamp(localScrollTop / maxVirtualScroll, 0, 1) : 0;
  const activeAlbum = findAlbumAtTop(layout, localScrollTop + 56);
  const valueNow = Math.round(progress * 100);
  const timelineTop = useCallback(
    (virtualTop: number) => `${clamp(maxVirtualScroll > 0 ? virtualTop / maxVirtualScroll : 0, 0, 1) * 100}%`,
    [maxVirtualScroll]
  );
  const timelineLabelTop = useCallback(
    (virtualTop: number) => `${clamp(maxVirtualScroll > 0 ? virtualTop / maxVirtualScroll : 0, 0.04, 0.96) * 100}%`,
    [maxVirtualScroll]
  );
  const activeLabelTop = `${clamp(progress, 0.08, 0.92) * 100}%`;
  const previewLabel = dragLabel || (hoverAlbum ? timelineAlbumLabel(hoverAlbum) : null);
  const previewLabelTop = dragLabel ? activeLabelTop : hoverAlbum ? timelineLabelTop(hoverAlbum.top) : activeLabelTop;
  const yearLabelTop = useCallback(
    (index: number) => {
      if (years.length <= 1) {
        return "50%";
      }

      return `${clamp(index / (years.length - 1), 0.04, 0.96) * 100}%`;
    },
    [years.length]
  );

  const scrollToVirtualTop = useCallback(
    (virtualTop: number) => {
      const nextVirtualTop = clamp(virtualTop, 0, maxVirtualScroll);
      const nextAlbum = findAlbumAtTop(layout, nextVirtualTop + 56);
      window.scrollTo({ top: Math.max(0, containerTop + nextVirtualTop), behavior: "auto" });
      setDragLabel(nextAlbum ? timelineAlbumLabel(nextAlbum) : null);
    },
    [containerTop, layout, maxVirtualScroll]
  );

  const resolveClientY = useCallback(
    (clientY: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.height <= 0) {
        return null;
      }

      const ratio = clamp((clientY - rect.top) / rect.height, 0, 1);
      const virtualTop = ratio * maxVirtualScroll;
      return {
        album: findAlbumAtTop(layout, virtualTop + 56),
        virtualTop
      };
    },
    [layout, maxVirtualScroll]
  );

  const previewClientY = useCallback(
    (clientY: number) => {
      setHoverAlbum(resolveClientY(clientY)?.album || null);
    },
    [resolveClientY]
  );

  const updateFromClientY = useCallback(
    (clientY: number, snapToAlbum = false) => {
      const target = resolveClientY(clientY);
      if (!target) {
        return;
      }

      setHoverAlbum(target.album);
      scrollToVirtualTop(snapToAlbum && target.album ? target.album.top : target.virtualTop);
    },
    [resolveClientY, scrollToVirtualTop]
  );

  const flushPendingPointer = useCallback(() => {
    frameRef.current = 0;
    if (pendingClientYRef.current === null) {
      return;
    }

    updateFromClientY(pendingClientYRef.current);
  }, [updateFromClientY]);

  const schedulePointerUpdate = useCallback(
    (clientY: number) => {
      pendingClientYRef.current = clientY;
      if (!frameRef.current) {
        frameRef.current = window.requestAnimationFrame(flushPendingPointer);
      }
    },
    [flushPendingPointer]
  );

  const hideDragLabelSoon = useCallback(() => {
    if (labelTimerRef.current !== null) {
      window.clearTimeout(labelTimerRef.current);
    }

    labelTimerRef.current = window.setTimeout(() => {
      setDragLabel(null);
      labelTimerRef.current = null;
    }, 700);
  }, []);

  const completeDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (pointerIdRef.current !== event.pointerId) {
        return;
      }

      event.currentTarget.releasePointerCapture(event.pointerId);
      pointerIdRef.current = null;
      setIsDragging(false);
      hideDragLabelSoon();
    },
    [hideDragLabelSoon]
  );

  useEffect(() => {
    return () => {
      if (frameRef.current) {
        window.cancelAnimationFrame(frameRef.current);
      }

      if (labelTimerRef.current !== null) {
        window.clearTimeout(labelTimerRef.current);
      }
    };
  }, []);

  if (layout.totalHeight <= viewport.height || !layout.albumAnchors.length) {
    return null;
  }

  return (
    <div className={`archive-timeline ${isDragging ? "is-dragging" : ""}`}>
      <div className="archive-timeline__years" aria-label="Years">
        {years.map((year, index) => (
          <button
            key={year}
            className={year === activeYear ? "is-active" : ""}
            type="button"
            style={{ top: yearLabelTop(index) }}
            onClick={() => onSelectYear(year)}
            aria-current={year === activeYear ? "true" : undefined}
            aria-label={`Jump to ${year}`}
          >
            {year}
          </button>
        ))}
      </div>
      <div
        className="archive-timeline__scrubber"
        role="scrollbar"
        aria-label="Archive timeline"
        aria-controls="photo-grid"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={valueNow}
        aria-valuetext={`${valueNow}%${activeAlbum ? `, ${timelineAlbumLabel(activeAlbum)}` : ""}`}
        tabIndex={0}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") {
            previewClientY(event.clientY);
          }
        }}
        onKeyDown={(event) => {
          let nextTop: number | null = null;

          if (event.key === "ArrowDown" || event.key === "ArrowRight") {
            nextTop = localScrollTop + SCRUBBER_KEY_STEP_PX;
          } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
            nextTop = localScrollTop - SCRUBBER_KEY_STEP_PX;
          } else if (event.key === "PageDown") {
            nextTop = localScrollTop + maxVirtualScroll * SCRUBBER_PAGE_STEP_RATIO;
          } else if (event.key === "PageUp") {
            nextTop = localScrollTop - maxVirtualScroll * SCRUBBER_PAGE_STEP_RATIO;
          } else if (event.key === "Home") {
            nextTop = 0;
          } else if (event.key === "End") {
            nextTop = maxVirtualScroll;
          }

          if (nextTop === null) {
            return;
          }

          event.preventDefault();
          scrollToVirtualTop(nextTop);
          hideDragLabelSoon();
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) {
            return;
          }

          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          pointerIdRef.current = event.pointerId;
          setIsDragging(true);
          previewClientY(event.clientY);
          if (labelTimerRef.current !== null) {
            window.clearTimeout(labelTimerRef.current);
            labelTimerRef.current = null;
          }
          updateFromClientY(event.clientY, event.pointerType === "mouse");
        }}
        onPointerMove={(event) => {
          if (pointerIdRef.current === event.pointerId) {
            schedulePointerUpdate(event.clientY);
          } else if (event.pointerType === "mouse") {
            previewClientY(event.clientY);
          }
        }}
        onPointerUp={completeDrag}
        onPointerCancel={completeDrag}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse" && pointerIdRef.current === null) {
            setHoverAlbum(null);
          }
        }}
      >
        <div className="archive-timeline__track" ref={trackRef} aria-hidden="true">
          {layout.albumAnchors.map((album) => (
            <span
              className={`archive-timeline__tick ${album.id === activeAlbumId ? "is-active" : ""}`}
              key={album.id}
              style={{ top: timelineTop(album.top) }}
            />
          ))}
          <span className="archive-timeline__thumb" style={{ top: `${progress * 100}%` }} />
        </div>
        {isDragging || previewLabel ? (
          <div className="archive-timeline__label" style={{ top: previewLabelTop }}>
            {previewLabel || (activeAlbum ? timelineAlbumLabel(activeAlbum) : null)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default App;
