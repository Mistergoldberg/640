import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { assetUrl, mediaUrl } from "./lib/assets";
import { buildJustifiedRows, type JustifiedItem } from "./lib/justifiedRows";
import { useElementWidth } from "./hooks/useElementWidth";
import { validateCatalog } from "./data/manifestValidation";
import { type LoadedAlbumSummary, type YearCollection } from "./data/useYearCollection";
import { ArchiveScrubber } from "./archive/ArchiveScrubber";
import { useArchiveYearCache, type ArchiveYearState } from "./archive/useArchiveYearCache";
import { archiveRatioForLocation, buildArchiveTimelineModel, orderedArchiveYears, type ArchiveTarget } from "./archive/archiveTimelineModel";
import { historyModeForIntent } from "./archive/archiveHistory";
import {
  ARCHIVE_HISTORY_APP,
  archiveCatalogueIdentity,
  archiveRestorationReducer,
  createArchiveRestorationState,
  createArchiveRestorationTarget,
  createHistoryEntryId,
  createStoredArchiveAnchor,
  ownedLegacyRestorationKeys,
  readArchiveHistoryState,
  resolveAnchorAgainstStableIds,
  resolveNavigationRestoration,
  restorationIsPending,
  type ArchiveHistoryState,
  type ArchiveRestorationState,
  type ArchiveRestorationTarget,
  type StoredArchiveAnchor
} from "./archive/archiveRestoration";
import {
  buildArchiveGeometry,
  activeYearAtScroll,
  stableAnchorCorrection,
  YEAR_HEADING_HEIGHT_PX,
  type ArchiveGeometry
} from "./archive/continuousArchiveLayout";
import { exitDocumentFullscreen, requestDocumentFullscreen } from "./player/fullscreen";
import { PhotoPlayer as PhotoPlayerView } from "./player/PhotoPlayer";
import type { Catalog, Photo } from "./types";

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
const ARCHIVE_JUMP_OFFSET_PX = 196;

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

interface LayoutYearHeading {
  type: "year-heading";
  id: string;
  top: number;
  height: number;
  year: string;
  count: number;
}

interface LayoutYearPlaceholder {
  type: "year-placeholder";
  id: string;
  top: number;
  height: number;
  year: string;
  albumId: string | null;
  folderLabel: string;
  status: ArchiveYearState["status"];
  message?: string;
}

interface MosaicSlot {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  shape: PreviewShape;
}

type LayoutEntry = LayoutHeading | LayoutRow | LayoutMosaic | LayoutAlbumError | LayoutYearHeading | LayoutYearPlaceholder;

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

function sortPhotos(photos: Photo[]) {
  return [...photos].sort((left, right) => left.sortPosition - right.sortPosition);
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
  return folderLabelFromName(album.name, album.year);
}

function folderLabelFromName(name: string, year: string) {
  const displayName = displayAlbumName(name);
  const yearPrefix = `${year}-`;

  if (displayName.startsWith(yearPrefix)) {
    return displayName.slice(yearPrefix.length);
  }

  if (displayName.startsWith(`${year}/`)) {
    return displayName.slice(year.length + 1);
  }

  return displayName;
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

function updateUrlState(
  year: string,
  photoId: string | null,
  mode: "push" | "replace",
  catalogueId: string,
  fromGrid = false,
  anchor?: Partial<Pick<StoredArchiveAnchor, "entryId" | "albumId" | "photoId" | "adjustmentPx">>
) {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("year", year);

  if (photoId) {
    nextUrl.searchParams.set("photo", photoId);
  } else {
    nextUrl.searchParams.delete("photo");
  }

  const nextPath = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  const currentState = readArchiveHistoryState(window.history.state);
  const entryId = anchor?.entryId || (mode === "replace" ? currentState?.entryId : null) || createHistoryEntryId();
  const restoration = createStoredArchiveAnchor({
    catalogueId,
    entryId,
    year,
    albumId: anchor?.albumId || null,
    photoId: anchor?.photoId === undefined ? photoId : anchor.photoId,
    adjustmentPx: anchor?.adjustmentPx || 0
  });
  const nextState: ArchiveHistoryState = {
    app: ARCHIVE_HISTORY_APP,
    entryId,
    year,
    photoId,
    view: photoId ? "photo" : "grid",
    fromGrid: Boolean(photoId && fromGrid),
    restoration
  };

  if (mode === "replace") {
    window.history.replaceState(nextState, "", nextPath);
    return restoration;
  }

  if (nextPath !== currentPath()) {
    window.history.pushState(nextState, "", nextPath);
  }

  return restoration;
}

function replaceCurrentHistoryAnchor(catalogueId: string, anchor: Omit<StoredArchiveAnchor, "schema" | "catalogueId" | "entryId">) {
  const state = readArchiveHistoryState(window.history.state);
  if (!state || state.restoration.catalogueId !== catalogueId || state.view !== "grid") return;
  const restoration = createStoredArchiveAnchor({ ...anchor, catalogueId, entryId: state.entryId });
  window.history.replaceState({ ...state, year: anchor.year, restoration }, "", currentPath());
}

function clearOwnedLegacyRestorationState(years: readonly string[]) {
  try {
    window.localStorage.removeItem("640x480-selected-year");
  } catch {
    // Storage may be disabled; legacy values are ignored regardless.
  }
  try {
    for (const key of ownedLegacyRestorationKeys(years).slice(1)) window.sessionStorage.removeItem(key);
  } catch {
    // Storage may be disabled; legacy values are ignored regardless.
  }
}

function navigationType() {
  const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return entry?.type || "navigate";
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
      const years = orderedArchiveYears(catalog);
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

function buildContinuousGridLayout(
  years: string[],
  states: Map<string, ArchiveYearState>,
  width: number,
  targetRowHeight: number,
  gap: number
): { layout: GridLayout; geometry: ArchiveGeometry } {
  const loadedLayouts = new Map<string, GridLayout>();
  for (const year of years) {
    const state = states.get(year);
    if (state?.status === "ready" && state.collection) {
      loadedLayouts.set(year, buildGridLayout(state.collection, width, targetRowHeight, gap));
    }
  }

  const geometry = buildArchiveGeometry(years.map((year) => {
    const state = states.get(year);
    const loaded = loadedLayouts.get(year);
    return {
      year,
      index: state?.index || null,
      loadedHeight: loaded?.totalHeight,
      loadedAlbums: loaded?.albumAnchors.map((album) => ({
        id: album.id,
        folderLabel: album.folderLabel,
        top: album.top,
        bottom: album.bottom,
        count: album.count
      }))
    };
  }), width, targetRowHeight);

  const entries: LayoutEntry[] = [];
  const photoTops = new Map<string, number>();
  for (const yearGeometry of geometry.years) {
    const state = states.get(yearGeometry.year);
    const loaded = loadedLayouts.get(yearGeometry.year);
    entries.push({
      type: "year-heading",
      id: `year-${yearGeometry.year}`,
      top: yearGeometry.top,
      height: YEAR_HEADING_HEIGHT_PX,
      year: yearGeometry.year,
      count: state?.index?.sequence.length || state?.index?.scannedCount || 0
    });

    if (loaded) {
      for (const entry of loaded.entries) entries.push({ ...entry, top: yearGeometry.headingBottom + entry.top });
      for (const [photoId, top] of loaded.photoTops) photoTops.set(photoId, yearGeometry.headingBottom + top);
    } else if (yearGeometry.albums.length) {
      for (const album of yearGeometry.albums) {
        entries.push({
          type: "year-placeholder",
          id: `placeholder-${yearGeometry.year}-${album.id}`,
          top: album.top,
          height: Math.max(54, album.bottom - album.top),
          year: yearGeometry.year,
          albumId: album.id,
          folderLabel: folderLabelFromName(album.folderLabel, yearGeometry.year),
          status: state?.status || "index-loading",
          message: state?.message
        });
      }
    } else {
      entries.push({
        type: "year-placeholder",
        id: `placeholder-${yearGeometry.year}`,
        top: yearGeometry.headingBottom,
        height: 54,
        year: yearGeometry.year,
        albumId: null,
        folderLabel: "Archive index",
        status: state?.status || "index-loading",
        message: state?.message
      });
    }
  }

  const albumAnchors: AlbumAnchor[] = geometry.albums.map((album) => ({ ...album }));
  const yearAnchors: YearAnchor[] = geometry.years.map((year) => ({
    year: year.year,
    top: year.top,
    bottom: year.bottom,
    albums: albumAnchors.filter((album) => album.year === year.year)
  }));
  return {
    geometry,
    layout: { entries, totalHeight: geometry.totalHeight, photoTops, albumAnchors, yearAnchors }
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
  let activeAlbum: AlbumAnchor | null = null;

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

function findStableAlbumAtTop(layout: GridLayout, virtualTop: number) {
  return layout.albumAnchors.find((album) => virtualTop >= album.top && virtualTop <= album.bottom) || null;
}

function findStablePhotoAtTop(layout: GridLayout, virtualTop: number) {
  const entry = layout.entries.find((candidate) =>
    (candidate.type === "row" || candidate.type === "mosaic") &&
    virtualTop >= candidate.top &&
    virtualTop <= candidate.top + candidate.height
  );
  return entry && (entry.type === "row" || entry.type === "mosaic") ? entry.items[0]?.photo.id || null : null;
}

function escapeCssAttribute(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function App() {
  const catalogState = useCatalog();
  const catalog = catalogState.status === "ready" ? catalogState.catalog : null;
  const catalogueId = useMemo(() => catalog ? archiveCatalogueIdentity(catalog) : "", [catalog]);
  const [archiveStartYear, setArchiveStartYear] = useState<string | null>(null);
  const [activeYear, setActiveYear] = useState<string | null>(null);
  const [restoration, dispatchRestoration] = useReducer(archiveRestorationReducer, undefined, createArchiveRestorationState);
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null);
  const [activePhotoYear, setActivePhotoYear] = useState<string | null>(null);
  const activeYearRef = useRef<string | null>(null);
  const activePhotoIdRef = useRef<string | null>(null);
  const activePhotoYearRef = useRef<string | null>(null);
  const fullscreenLaunchPhotoIdRef = useRef<string | null>(null);
  const pendingClosePhotoIdRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const { states, indexes, collections, loadYear, retryYear, retryAlbum } = useArchiveYearCache(catalog, archiveStartYear);
  const years = useMemo(() => catalog ? orderedArchiveYears(catalog).map((year) => year.year) : [], [catalog]);
  const timelineModel = useMemo(
    () => catalog ? buildArchiveTimelineModel(catalog, indexes) : { years: [], anchors: [] },
    [catalog, indexes]
  );
  const playerCollection = activePhotoYear ? collections.get(activePhotoYear) || null : null;
  const activePhotoIndex = useMemo(() => {
    if (!playerCollection || !activePhotoId) return null;
    const index = playerCollection.photos.findIndex((photo) => photo.id === activePhotoId);
    return index >= 0 ? index : null;
  }, [activePhotoId, playerCollection]);

  useEffect(() => { activeYearRef.current = activeYear; }, [activeYear]);
  useEffect(() => { activePhotoIdRef.current = activePhotoId; }, [activePhotoId]);
  useEffect(() => { activePhotoYearRef.current = activePhotoYear; }, [activePhotoYear]);

  useEffect(() => {
    if (!catalog || initializedRef.current) return;
    const target = resolveNavigationRestoration({
      catalog,
      href: window.location.href,
      historyState: window.history.state,
      navigationType: navigationType()
    });
    const photoId = readUrlPhotoId();
    initializedRef.current = true;
    clearOwnedLegacyRestorationState(catalog.years.map(({ year }) => year));
    setArchiveStartYear(target.year);
    setActiveYear(target.year);
    dispatchRestoration({ type: "request", target });
    if (photoId) {
      setActivePhotoId(photoId);
      setActivePhotoYear(target.year);
    }
    const previousState = readArchiveHistoryState(window.history.state);
    updateUrlState(target.year, photoId, "replace", catalogueId, Boolean(previousState?.fromGrid), target);
  }, [catalog]);

  useEffect(() => {
    if (!catalog) return;
    const handlePopState = () => {
      fullscreenLaunchPhotoIdRef.current = null;
      const photoId = readUrlPhotoId();
      let target = resolveNavigationRestoration({
        catalog,
        href: window.location.href,
        historyState: window.history.state,
        navigationType: "back_forward"
      });
      const restoreId = !photoId ? pendingClosePhotoIdRef.current || activePhotoIdRef.current : null;
      if (restoreId) {
        target = createArchiveRestorationTarget(createStoredArchiveAnchor({
          catalogueId,
          entryId: target.entryId,
          year: target.year,
          photoId: restoreId
        }), "photo-close", true);
      }
      loadYear(target.year, "history");
      setActiveYear(target.year);
      dispatchRestoration({ type: "request", target });
      if (photoId) {
        setActivePhotoId(photoId);
        setActivePhotoYear(target.year);
      } else {
        setActivePhotoId(null);
        setActivePhotoYear(null);
      }
      pendingClosePhotoIdRef.current = null;
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [catalog, catalogueId, loadYear]);

  useEffect(() => {
    if (!activePhotoId || !activePhotoYear) return;
    const state = states.get(activePhotoYear);
    if (!state || state.status === "index-loading" || state.status === "unloaded" || state.status === "loading") {
      loadYear(activePhotoYear, "history");
      return;
    }
    if (!state.collection) return;
    if (!state.collection.photos.some((photo) => photo.id === activePhotoId)) {
      setActivePhotoId(null);
      setActivePhotoYear(null);
      updateUrlState(activePhotoYear, null, "replace", catalogueId);
    }
  }, [activePhotoId, activePhotoYear, catalogueId, loadYear, states]);

  const handleVisibleYearChange = useCallback((year: string, shouldLoad = true) => {
    if (!catalog || !yearExists(catalog, year)) return;
    if (year !== activeYearRef.current) {
      activeYearRef.current = year;
      setActiveYear(year);
      if (!readUrlPhotoId()) updateUrlState(year, null, "replace", catalogueId);
    }
    if (shouldLoad) loadYear(year, "adjacent");
  }, [catalog, catalogueId, loadYear]);

  const openPhoto = useCallback((year: string, photoId: string) => {
    const collection = collections.get(year);
    if (!collection?.photos.some((photo) => photo.id === photoId)) return;
    fullscreenLaunchPhotoIdRef.current = photoId;
    void requestDocumentFullscreen().then((entered) => {
      if (entered && fullscreenLaunchPhotoIdRef.current !== photoId) void exitDocumentFullscreen();
    });
    setActivePhotoId(photoId);
    setActivePhotoYear(year);
    updateUrlState(year, photoId, historyModeForIntent("photo"), catalogueId, true, { photoId });
  }, [catalogueId, collections]);

  const closePlayer = useCallback((photoId: string) => {
    fullscreenLaunchPhotoIdRef.current = null;
    const restoreId = photoId || activePhotoIdRef.current;
    const year = activePhotoYearRef.current || activeYearRef.current;
    pendingClosePhotoIdRef.current = restoreId;
    const historyState = readArchiveHistoryState(window.history.state);
    if (readUrlPhotoId() && historyState?.view === "photo" && historyState.fromGrid) {
      window.history.back();
      return;
    }
    if (year) {
      const anchor = updateUrlState(year, null, "replace", catalogueId, false, { photoId: restoreId });
      dispatchRestoration({ type: "request", target: createArchiveRestorationTarget(anchor, "photo-close", true) });
    }
    setActivePhotoId(null);
    setActivePhotoYear(null);
    pendingClosePhotoIdRef.current = null;
  }, [catalogueId]);

  if (catalogState.status === "loading") return <SystemState title="640×480" message={catalogState.message} />;
  if (catalogState.status === "error") return <SystemState title="640×480" message={catalogState.message} />;
  if (!archiveStartYear || !activeYear || !states.size) return <SystemState title="640×480" message="Building archive index" />;

  return (
    <>
      <ContinuousCollectionGrid
        years={years}
        states={states}
        timelineModel={timelineModel}
        activeYear={activeYear}
        restoration={restoration}
        onRestorationWait={(generation) => dispatchRestoration({ type: "wait-for-layout", generation })}
        onRestorationApply={(generation) => dispatchRestoration({ type: "apply", generation })}
        onRestorationSettle={(generation, visibleYear) => {
          dispatchRestoration({ type: "settle", generation, visibleYear });
          handleVisibleYearChange(visibleYear, false);
        }}
        onRestorationCancel={(generation) => dispatchRestoration({ type: "cancel", generation })}
        onPersistAnchor={(anchor) => {
          if (!activePhotoIdRef.current) replaceCurrentHistoryAnchor(catalogueId, anchor);
        }}
        onPushArchiveTarget={(target) => updateUrlState(target.year, null, historyModeForIntent("jump"), catalogueId, false, {
          albumId: target.albumId,
          photoId: null
        })}
        onVisibleYearChange={handleVisibleYearChange}
        onOpenPhoto={openPhoto}
        onRequestYear={(year, reason) => loadYear(year, reason)}
        onRetryYear={retryYear}
        onRetryAlbum={retryAlbum}
      />
      {activePhotoId && activePhotoIndex !== null && playerCollection ? (
        <PhotoPlayerView
          key={`${playerCollection.year}:${activePhotoId}`}
          photos={playerCollection.photos}
          initialIndex={activePhotoIndex}
          openInFullscreen={fullscreenLaunchPhotoIdRef.current === activePhotoId}
          scope={{ type: "year", year: playerCollection.year }}
          onClose={closePlayer}
        />
      ) : null}
    </>
  );
}

function SystemState({ title, message, actionLabel, onAction }: { title: string; message: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <main className="system-state">
      <h1>{title}</h1>
      <p>{message}</p>
      {actionLabel && onAction ? <button type="button" onClick={onAction}>{actionLabel}</button> : null}
    </main>
  );
}

function ContinuousCollectionGrid({
  years,
  states,
  timelineModel,
  activeYear,
  restoration,
  onRestorationWait,
  onRestorationApply,
  onRestorationSettle,
  onRestorationCancel,
  onPersistAnchor,
  onPushArchiveTarget,
  onVisibleYearChange,
  onOpenPhoto,
  onRequestYear,
  onRetryYear,
  onRetryAlbum
}: {
  years: string[];
  states: Map<string, ArchiveYearState>;
  timelineModel: ReturnType<typeof buildArchiveTimelineModel>;
  activeYear: string;
  restoration: ArchiveRestorationState;
  onRestorationWait: (generation: number) => void;
  onRestorationApply: (generation: number) => void;
  onRestorationSettle: (generation: number, visibleYear: string) => void;
  onRestorationCancel: (generation: number) => void;
  onPersistAnchor: (anchor: Omit<StoredArchiveAnchor, "schema" | "catalogueId" | "entryId">) => void;
  onPushArchiveTarget: (target: ArchiveTarget) => void;
  onVisibleYearChange: (year: string, shouldLoad?: boolean) => void;
  onOpenPhoto: (year: string, photoId: string) => void;
  onRequestYear: (year: string, reason: "adjacent" | "scrub" | "history") => void;
  onRetryYear: (year: string) => void;
  onRetryAlbum: (year: string, albumId: string) => void;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const viewport = useViewport();
  const previousLayoutRef = useRef<GridLayout | null>(null);
  const restorationRef = useRef(restoration);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const targetHeight = width < 520 ? 118 : width < 900 ? 146 : 174;
  const gap = width < 520 ? 3 : 4;
  const { layout, geometry } = useMemo(
    () => buildContinuousGridLayout(years, states, width, targetHeight, gap),
    [gap, states, targetHeight, width, years]
  );
  const indexByYear = useMemo(() => {
    const result = new Map<string, Map<string, number>>();
    for (const [year, state] of states) {
      if (!state.collection) continue;
      result.set(year, new Map(state.collection.photos.map((photo, index) => [photo.id, index])));
    }
    return result;
  }, [states]);
  const containerTop = ref.current ? ref.current.getBoundingClientRect().top + viewport.scrollY : 0;
  const localViewportTop = viewport.scrollY - containerTop;
  const visibleTop = localViewportTop - GRID_OVERSCAN_PX;
  const visibleBottom = localViewportTop + viewport.height + GRID_OVERSCAN_PX;
  const visibleEntries = layout.entries.filter((entry) => entry.top + entry.height >= visibleTop && entry.top <= visibleBottom);
  const currentYear = activeYearAtScroll(geometry.years, localViewportTop + ARCHIVE_JUMP_OFFSET_PX) || activeYear;
  const currentYearAnchor = layout.yearAnchors.find((year) => year.year === currentYear) || layout.yearAnchors[0] || null;
  const currentAlbum = findAlbumAtTop(layout, localViewportTop + ARCHIVE_JUMP_OFFSET_PX);
  const yearHeadingScreenTop = currentYearAnchor ? containerTop + currentYearAnchor.top - viewport.scrollY : -1;
  const albumHeadingScreenTop = currentAlbum ? containerTop + currentAlbum.top - viewport.scrollY : -1;
  const yearHeadingIsVisible = yearHeadingScreenTop >= 88 && yearHeadingScreenTop <= 220;
  const albumHeadingIsVisible = albumHeadingScreenTop >= 88 && albumHeadingScreenTop <= 240;
  const state = states.get(currentYear);
  const failedCount = state?.collection?.failedAlbumIds.length || 0;
  const statusMessage = state?.status === "loading" ? `Loading ${currentYear}`
    : state?.status === "error" ? state.message || `${currentYear} could not load`
      : failedCount ? `${failedCount} album${failedCount === 1 ? "" : "s"} could not load` : null;
  const activeAlbumProgress = currentAlbum
    ? Math.max(0, Math.min(1, (localViewportTop + ARCHIVE_JUMP_OFFSET_PX - currentAlbum.top) / Math.max(1, currentAlbum.bottom - currentAlbum.top)))
    : 0;
  const activeRatio = archiveRatioForLocation(timelineModel, currentYear, currentAlbum?.id || null, activeAlbumProgress);
  const restorationPending = restorationIsPending(restoration);
  const allIndexesSettled = years.every((year) => states.get(year)?.status !== "index-loading");

  useLayoutEffect(() => {
    restorationRef.current = restoration;
  }, [restoration]);

  useLayoutEffect(() => {
    const previous = previousLayoutRef.current;
    previousLayoutRef.current = layout;
    // Partial indexes can put the first known album in a later year. Until the
    // authoritative target settles, those estimates are not a visible anchor.
    if (restorationPending || !width || !previous || !ref.current || previous.totalHeight === layout.totalHeight) return;
    const oldLocalTop = window.scrollY - (ref.current.getBoundingClientRect().top + window.scrollY) + ARCHIVE_JUMP_OFFSET_PX;
    const oldAlbum = findStableAlbumAtTop(previous, oldLocalTop);
    const oldPhoto = findStablePhotoAtTop(previous, oldLocalTop);
    const previousTop = oldPhoto ? previous.photoTops.get(oldPhoto) : oldAlbum?.top;
    const nextTop = oldPhoto ? layout.photoTops.get(oldPhoto) : oldAlbum
      ? layout.albumAnchors.find((album) => album.year === oldAlbum.year && album.id === oldAlbum.id)?.top
      : undefined;
    const correction = stableAnchorCorrection(previousTop, nextTop);
    if (Math.abs(correction) > 0.5) window.scrollBy({ top: correction, behavior: "auto" });
  }, [layout, restorationPending, width]);

  useEffect(() => {
    if (currentYear && !restorationPending) onVisibleYearChange(currentYear, !isScrubbing);
  }, [currentYear, isScrubbing, onVisibleYearChange, restorationPending]);

  useEffect(() => {
    if (!width) return;
    const activeIndex = geometry.years.findIndex((year) => year.year === currentYear);
    const activeGeometry = geometry.years[activeIndex];
    if (!activeGeometry || states.get(currentYear)?.status !== "ready") return;
    const preloadDistance = Math.max(1200, viewport.height * 1.4);
    const next = geometry.years[activeIndex + 1];
    const previous = geometry.years[activeIndex - 1];
    const distanceToBottom = activeGeometry.bottom - (localViewportTop + viewport.height);
    if (next && distanceToBottom >= 0 && distanceToBottom < preloadDistance) onRequestYear(next.year, "adjacent");
    const distanceFromTop = localViewportTop - activeGeometry.top;
    if (previous && distanceFromTop >= 0 && distanceFromTop < preloadDistance) onRequestYear(previous.year, "adjacent");
  }, [currentYear, geometry.years, localViewportTop, onRequestYear, states, viewport.height, width]);

  useLayoutEffect(() => {
    if (restoration.phase === "pending-target") onRestorationWait(restoration.generation);
  }, [onRestorationWait, restoration.generation, restoration.phase]);

  useLayoutEffect(() => {
    if (restoration.phase !== "waiting-for-layout" || !restoration.target || !ref.current || !width || !allIndexesSettled) return;
    const sourceTarget = restoration.target;
    const targetState = states.get(sourceTarget.year);
    const layoutReady = targetState?.status === "ready" || targetState?.status === "error";
    const resolved = resolveAnchorAgainstStableIds(sourceTarget, {
      layoutReady,
      albumIds: new Set(targetState?.index?.albums.map(({ id }) => id) || []),
      photoIds: new Set(targetState?.collection?.photos.map(({ id }) => id) || [])
    });
    if (resolved.status === "waiting") return;
    const target = resolved.anchor;
    let virtualTop: number | undefined;
    if (target.photoId) virtualTop = layout.photoTops.get(target.photoId);
    if (virtualTop === undefined && target.albumId) {
      virtualTop = layout.albumAnchors.find((album) => album.year === target.year && album.id === target.albumId)?.top;
    }
    if (virtualTop === undefined) virtualTop = layout.yearAnchors.find((year) => year.year === target.year)?.top;
    if (virtualTop === undefined) return;
    const generation = restoration.generation;
    const baseOffset = target.photoId ? RESTORE_OFFSET_PX : ARCHIVE_JUMP_OFFSET_PX;
    const nextTop = ref.current.getBoundingClientRect().top + window.scrollY + virtualTop - baseOffset + target.adjustmentPx;
    const frame = window.requestAnimationFrame(() => {
      if (restorationRef.current.generation !== generation || restorationRef.current.phase === "cancelled") return;
      onRestorationApply(generation);
      window.scrollTo({ top: Math.max(0, nextTop), behavior: "auto" });
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (restorationRef.current.generation !== generation || restorationRef.current.phase === "cancelled" || !ref.current) return;
        const settledContainerTop = ref.current.getBoundingClientRect().top + window.scrollY;
        const settledLocalTop = window.scrollY - settledContainerTop;
        const visibleYear = activeYearAtScroll(geometry.years, settledLocalTop + ARCHIVE_JUMP_OFFSET_PX) || target.year;
        if (sourceTarget.focusPhoto && target.photoId) {
          ref.current.querySelector<HTMLButtonElement>(`[data-photo-id="${escapeCssAttribute(target.photoId)}"]`)?.focus({ preventScroll: true });
        }
        onRestorationSettle(generation, visibleYear);
      }));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [allIndexesSettled, geometry.years, layout.albumAnchors, layout.photoTops, layout.yearAnchors, onRestorationApply, onRestorationSettle, restoration.generation, restoration.phase, restoration.target, states, width]);

  useEffect(() => {
    if (!restorationPending) return;
    const generation = restoration.generation;
    const cancel = () => onRestorationCancel(generation);
    const cancelFromKey = (event: KeyboardEvent) => {
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) cancel();
    };
    window.addEventListener("wheel", cancel, { passive: true });
    window.addEventListener("touchstart", cancel, { passive: true });
    window.addEventListener("pointerdown", cancel, { passive: true });
    window.addEventListener("keydown", cancelFromKey);
    return () => {
      window.removeEventListener("wheel", cancel);
      window.removeEventListener("touchstart", cancel);
      window.removeEventListener("pointerdown", cancel);
      window.removeEventListener("keydown", cancelFromKey);
    };
  }, [onRestorationCancel, restoration.generation, restorationPending]);

  useEffect(() => {
    if (!currentYear || (restoration.phase !== "settled" && restoration.phase !== "cancelled")) return;
    const yearPhotos = indexByYear.get(currentYear);
    const nearestPhoto = [...layout.photoTops]
      .filter(([photoId]) => yearPhotos?.has(photoId))
      .sort((left, right) => Math.abs(left[1] - (localViewportTop + RESTORE_OFFSET_PX)) - Math.abs(right[1] - (localViewportTop + RESTORE_OFFSET_PX)))[0];
    const photoId = nearestPhoto?.[0] || null;
    const anchorTop = nearestPhoto?.[1] ?? currentAlbum?.top ?? currentYearAnchor?.top ?? 0;
    const baseOffset = photoId ? RESTORE_OFFSET_PX : ARCHIVE_JUMP_OFFSET_PX;
    onPersistAnchor({
      year: currentYear,
      albumId: currentAlbum?.id || null,
      photoId,
      adjustmentPx: localViewportTop - (anchorTop - baseOffset)
    });
  }, [currentAlbum?.id, currentAlbum?.top, currentYear, currentYearAnchor?.top, indexByYear, layout.photoTops, localViewportTop, onPersistAnchor, restoration.phase]);

  const navigateToTarget = useCallback((target: ArchiveTarget, intent: "scrub" | "jump") => {
    if (!ref.current) return;
    const yearGeometry = geometry.years.find((year) => year.year === target.year);
    if (!yearGeometry) return;
    const modelYear = timelineModel.years.find((year) => year.year === target.year);
    const modelAlbum = target.albumId ? modelYear?.albums.find((album) => album.id === target.albumId) : null;
    const album = target.albumId ? yearGeometry.albums.find((candidate) => candidate.id === target.albumId) : null;
    let virtualTop = yearGeometry.top;
    if (album && modelAlbum) {
      const fraction = Math.max(0, Math.min(1, (target.ratio - modelAlbum.start) / Math.max(Number.EPSILON, modelAlbum.end - modelAlbum.start)));
      virtualTop = album.top + fraction * Math.max(0, album.bottom - album.top - viewport.height * 0.35);
    } else if (target.sectionRatio > 0) {
      virtualTop = yearGeometry.headingBottom + target.sectionRatio * Math.max(0, yearGeometry.bottom - yearGeometry.headingBottom - viewport.height * 0.35);
    }
    const absoluteTop = ref.current.getBoundingClientRect().top + window.scrollY + virtualTop - ARCHIVE_JUMP_OFFSET_PX;
    window.scrollTo({ top: Math.max(0, absoluteTop), behavior: "auto" });
    if (intent === "jump") onPushArchiveTarget(target);
  }, [geometry.years, onPushArchiveTarget, timelineModel.years, viewport.height]);

  return (
    <main className="collection-shell" data-restoration-phase={restoration.phase}>
      <header className="collection-chrome">
        <div className="app-bar">
          <div className="app-bar__identity">
            <span className="app-bar__brand">640×480</span>
            <span className={`app-bar__year ${yearHeadingIsVisible ? "is-inline" : ""}`}>{currentYear}</span>
          </div>
          <span className="app-bar__range">{years[0]}-{years[years.length - 1]}</span>
        </div>
        {statusMessage ? (
          <div className={`collection-status collection-status--${state?.status === "error" || failedCount ? "error" : "loading"}`} role={state?.status === "error" || failedCount ? "alert" : "status"}>
            <span>{statusMessage}</span>
            {state?.status === "error" ? <button type="button" onClick={() => onRetryYear(currentYear)}>Retry</button> : null}
          </div>
        ) : (
          <div className={`album-context ${!currentAlbum || albumHeadingIsVisible || state?.status !== "ready" ? "album-context--hidden" : ""}`} aria-live="polite" aria-hidden={!currentAlbum || albumHeadingIsVisible || state?.status !== "ready"}>
            <span className="album-context__year">{currentAlbum?.year || currentYear}</span>
            <span className="album-context__folder">{currentAlbum?.folderLabel || ""}</span>
          </div>
        )}
      </header>

      <div id="photo-grid" className="virtual-album-stack" ref={ref} style={{ height: layout.totalHeight || undefined }}>
        {visibleEntries.map((entry) => {
          if (entry.type === "year-heading") {
            return (
              <section className="archive-year-heading virtual-entry" key={entry.id} style={{ top: entry.top, height: entry.height }} aria-labelledby={`${entry.id}-title`}>
                <h1 id={`${entry.id}-title`}>{entry.year}</h1><span>{entry.count.toLocaleString()} photographs</span>
              </section>
            );
          }
          if (entry.type === "year-placeholder") {
            const stateLabel = entry.status === "loading" ? "Loading"
              : entry.status === "error" ? entry.message || "Could not load"
                : entry.status === "index-loading" ? "Indexing" : "Loads on demand";
            return (
              <div className={`archive-year-placeholder archive-year-placeholder--${entry.status} virtual-entry`} key={entry.id} style={{ top: entry.top, height: entry.height }}>
                <div className="archive-year-placeholder__context">
                  <span><strong>{entry.folderLabel}</strong> · {stateLabel}</span>
                  {entry.status === "error" ? <button type="button" onClick={() => onRetryYear(entry.year)}>Retry year</button> : null}
                </div>
              </div>
            );
          }
          if (entry.type === "heading") {
            return (
              <div className="album-group__heading virtual-entry" key={entry.id} style={{ top: entry.top, height: entry.height }}>
                <h2><span className="album-heading__folder">{albumFolderLabel(entry.album)}</span></h2><span>{entry.album.count}</span>
              </div>
            );
          }
          if (entry.type === "album-error") {
            const loading = entry.album.loadState === "loading";
            return (
              <div className={`album-error album-error--${entry.album.loadState} virtual-entry`} key={entry.id} style={{ top: entry.top, height: entry.height }} role={loading ? "status" : "alert"}>
                <span>{loading ? "Loading album" : entry.album.errorMessage || "Album could not be loaded"}</span>
                {!loading ? <button type="button" onClick={() => onRetryAlbum(entry.year, entry.album.id)}>Retry</button> : null}
              </div>
            );
          }
          const collection = states.get(entry.year)?.collection;
          const indexById = indexByYear.get(entry.year);
          if (entry.type === "mosaic") {
            return (
              <div className="photo-mosaic virtual-entry" key={entry.id} style={{ top: entry.top, height: entry.height }}>
                {entry.items.map((item) => (
                  <button className={`photo-tile photo-tile--mosaic photo-tile--preview-${item.shape} photo-tile--${item.photo.orientation}`} key={item.photo.id} type="button" data-photo-id={item.photo.id} style={{ left: item.left, top: item.top, width: item.width, height: item.height }} onClick={() => onOpenPhoto(entry.year, item.photo.id)} aria-label={`Open featured photo ${(indexById?.get(item.photo.id) || 0) + 1} of ${collection?.photos.length || 0}`}>
                    <img src={mediaUrl(item.photo.thumbnailKey)} alt="" loading="lazy" decoding="async" width={item.photo.width} height={item.photo.height} />
                  </button>
                ))}
              </div>
            );
          }
          return (
            <div className="photo-row virtual-entry" key={entry.id} style={{ top: entry.top, height: entry.height, gap: entry.gap }}>
              {entry.items.map((item) => (
                <button className={`photo-tile photo-tile--${item.photo.orientation}`} key={item.photo.id} type="button" data-photo-id={item.photo.id} style={{ width: item.width, height: item.height }} onClick={() => onOpenPhoto(entry.year, item.photo.id)} aria-label={`Open photo ${(indexById?.get(item.photo.id) || 0) + 1} of ${collection?.photos.length || 0}`}>
                  <img src={mediaUrl(item.photo.thumbnailKey)} alt="" loading="lazy" decoding="async" width={item.photo.width} height={item.photo.height} />
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <ArchiveScrubber
        model={timelineModel}
        activeYear={currentYear}
        activeAlbumId={currentAlbum?.id || null}
        activeRatio={activeRatio}
        formatAlbumName={folderLabelFromName}
        onNavigate={navigateToTarget}
        onRequestYear={(year) => onRequestYear(year, "scrub")}
        onScrubStateChange={(next) => {
          setIsScrubbing(next);
          if (next && restorationPending) onRestorationCancel(restoration.generation);
        }}
      />
    </main>
  );
}

export default App;
