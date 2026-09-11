import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { assetUrl, mediaUrl } from "./lib/assets";
import { buildEditorialRows, type JustifiedItem, type JustifiedRowTone } from "./lib/justifiedRows";
import { useElementWidth } from "./hooks/useElementWidth";
import { validateCatalog } from "./data/manifestValidation";
import { type LoadedAlbumSummary, type YearCollection } from "./data/useYearCollection";
import { ArchiveScrubber } from "./archive/ArchiveScrubber";
import { useArchiveYearCache, type ArchiveYearState } from "./archive/useArchiveYearCache";
import { archiveRatioForLocation, buildArchiveTimelineModel, orderedArchiveYears, type ArchiveTarget } from "./archive/archiveTimelineModel";
import {
  archiveWindowWarnings,
  boundaryArchiveTarget,
  createArchiveNavigationPlan,
  stableYearLocalCorrection,
  type ArchiveNavigationIntent
} from "./archive/archiveNavigation";
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
import { exitDocumentFullscreen, requestDocumentFullscreen } from "./player/fullscreen";
import { PhotoPlayer as PhotoPlayerView } from "./player/PhotoPlayer";
import type { Catalog, Photo } from "./types";
import { diagnosticsEnabled, getDiagnostics, recordDiagnostic, registerArchiveObserver, updateDiagnostics } from "./debug/archiveDiagnostics";

const CATALOG_URL = assetUrl("data/catalog.json");
const GRID_MIN_OVERSCAN_PX = 260;
const GRID_SCROLL_AHEAD_PX = 720;
const ALBUM_GAP_PX = 18;
const ALBUM_HEADING_HEIGHT_PX = 24;
const ALBUM_HEADING_GAP_PX = 9;
const ALBUM_ERROR_HEIGHT_PX = 52;
const RESTORE_OFFSET_PX = 112;
const ARCHIVE_JUMP_OFFSET_PX = 196;

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
  tone: JustifiedRowTone;
  year: string;
  albumId: string;
  items: JustifiedItem[];
}

interface LayoutAlbumError {
  type: "album-error";
  id: string;
  top: number;
  height: number;
  year: string;
  album: LoadedAlbumSummary;
}

type LayoutEntry = LayoutHeading | LayoutRow | LayoutAlbumError;

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

  const currentAnchor = currentState?.restoration;
  const isSettledDuplicate = nextPath === currentPath()
    && currentState?.view === nextState.view
    && currentAnchor?.year === restoration.year
    && currentAnchor?.albumId === restoration.albumId
    && currentAnchor?.photoId === restoration.photoId;
  if (isSettledDuplicate && currentAnchor) return currentAnchor;
  window.history.pushState(nextState, "", nextPath);
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
    recordDiagnostic("catalogue-load-start");

    async function loadCatalog() {
      const catalog = validateCatalog(await fetchJson(CATALOG_URL));
      const years = orderedArchiveYears(catalog);
      if (!years.length) {
        throw new Error("No imported years are available in the catalogue");
      }

      if (isMounted) {
        recordDiagnostic("catalogue-load-complete", { yearCount: years.length });
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
        recordDiagnostic("catalogue-load-error", { message: error instanceof Error ? error.message : "Catalogue could not be loaded" });
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

interface ViewportSnapshot {
  scrollY: number;
  height: number;
}

const serverViewport: ViewportSnapshot = { scrollY: 0, height: 800 };
let viewportSnapshot = serverViewport;

function readViewportSnapshot() {
  if (typeof window === "undefined") return serverViewport;
  const scrollY = window.scrollY;
  const height = window.innerHeight;
  if (viewportSnapshot.scrollY !== scrollY || viewportSnapshot.height !== height) {
    viewportSnapshot = { scrollY, height };
  }
  return viewportSnapshot;
}

function subscribeViewport(onStoreChange: () => void) {
  const unregister = registerArchiveObserver("archive-viewport");
  window.addEventListener("scroll", onStoreChange, { passive: true });
  window.addEventListener("resize", onStoreChange);
  return () => {
    window.removeEventListener("scroll", onStoreChange);
    window.removeEventListener("resize", onStoreChange);
    unregister();
  };
}

function useViewport() {
  return useSyncExternalStore(subscribeViewport, readViewportSnapshot, () => serverViewport);
}

function buildGridLayout(collection: YearCollection, width: number, targetRowHeight: number, gap: number, compactViewport = false): GridLayout {
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

function escapeCssAttribute(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function archiveTargetFromRestoration(target: ArchiveRestorationTarget): ArchiveTarget {
  return {
    year: target.year,
    albumId: target.albumId,
    albumName: null,
    ratio: 0,
    sectionRatio: 0
  };
}

function nearestPhotoAnchor(photoTops: Array<[string, number]>, targetTop: number) {
  if (!photoTops.length) return null;
  let low = 0;
  let high = photoTops.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (photoTops[middle][1] < targetTop) low = middle + 1;
    else high = middle;
  }
  const after = photoTops[low];
  const before = photoTops[Math.max(0, low - 1)];
  return Math.abs(before[1] - targetTop) <= Math.abs(after[1] - targetTop) ? before : after;
}

function App() {
  const catalogState = useCatalog();
  const catalog = catalogState.status === "ready" ? catalogState.catalog : null;
  const catalogueId = useMemo(() => catalog ? archiveCatalogueIdentity(catalog) : "", [catalog]);
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
  const savedAnchorsRef = useRef(new Map<string, Omit<StoredArchiveAnchor, "schema" | "catalogueId" | "entryId">>());
  const { states, indexes, collections, cachedYears, loadingYears, loadYear, retryYear, retryAlbum } = useArchiveYearCache(catalog, activeYear);
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

  const navigateToArchiveTarget = useCallback((input: ArchiveTarget | ArchiveRestorationTarget, intent: ArchiveNavigationIntent) => {
    if (!catalog || !yearExists(catalog, input.year)) return;
    const target = "source" in input ? archiveTargetFromRestoration(input) : input;
    const plan = createArchiveNavigationPlan(target, intent);
    const previousYear = activeYearRef.current;
    const storedInput = "entryId" in input ? input : null;
    const savedBoundaryAnchor = intent === "boundary" && target.sectionRatio >= 0.999
      ? savedAnchorsRef.current.get(target.year) || null
      : null;
    const preferredAnchor = savedBoundaryAnchor || {
      year: target.year,
      albumId: storedInput?.albumId ?? target.albumId,
      photoId: storedInput?.photoId ?? null,
      adjustmentPx: storedInput?.adjustmentPx ?? 0
    };
    let restorationTarget: ArchiveRestorationTarget;

    if (intent === "history" && storedInput) {
      restorationTarget = storedInput;
    } else {
      const initialUrlPhotoId = intent === "initial" ? readUrlPhotoId() : null;
      const stored = updateUrlState(
        target.year,
        initialUrlPhotoId,
        plan.historyMode || "replace",
        catalogueId,
        Boolean(initialUrlPhotoId && readArchiveHistoryState(window.history.state)?.fromGrid),
        preferredAnchor
      );
      const source = storedInput?.source || (intent === "initial" ? "url" : intent);
      restorationTarget = createArchiveRestorationTarget(stored, source, Boolean(storedInput?.focusPhoto));
    }

    recordDiagnostic("archive-navigation", {
      intent,
      previousYear,
      year: target.year,
      albumId: restorationTarget.albumId,
      photoId: restorationTarget.photoId,
      historyMode: plan.historyMode,
      loadReason: plan.loadReason
    });
    activeYearRef.current = target.year;
    setActiveYear(target.year);
    loadYear(target.year, plan.loadReason);
    dispatchRestoration({ type: "request", target: restorationTarget });
    if (previousYear && previousYear !== target.year) {
      const detail = { at: new Date().toISOString(), kind: "year-window-replace", top: 0, previousYear, year: target.year };
      updateDiagnostics({ lastProgrammaticScroll: detail }, "programmatic-scroll", detail);
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }, [catalog, catalogueId, loadYear]);

  useEffect(() => {
    const yearStates = Object.fromEntries([...states].map(([year, state]) => [year, state.status]));
    updateDiagnostics({
      activeYear,
      loadedYears: cachedYears,
      cachedYears,
      prefetchedYears: cachedYears.filter((year) => year !== activeYear),
      yearCacheEntries: cachedYears.length,
      loadingYears,
      yearStates,
      restoration: { phase: restoration.phase, generation: restoration.generation, settledYear: restoration.settledYear },
      restorationTarget: restoration.target ? {
        year: restoration.target.year,
        albumId: restoration.target.albumId,
        photoId: restoration.target.photoId,
        adjustmentPx: restoration.target.adjustmentPx,
        source: restoration.target.source,
        focusPhoto: restoration.target.focusPhoto
      } : null
    });
  }, [activeYear, cachedYears, loadingYears, restoration, states]);

  useEffect(() => {
    recordDiagnostic("restoration-transition", {
      phase: restoration.phase,
      generation: restoration.generation,
      targetYear: restoration.target?.year || null,
      targetAlbumId: restoration.target?.albumId || null,
      targetPhotoId: restoration.target?.photoId || null,
      source: restoration.target?.source || null
    });
  }, [restoration.generation, restoration.phase, restoration.settledYear, restoration.target]);

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
    navigateToArchiveTarget(target, "initial");
    if (photoId) {
      setActivePhotoId(photoId);
      setActivePhotoYear(target.year);
    }
  }, [catalog, navigateToArchiveTarget]);

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
      navigateToArchiveTarget(target, "history");
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
  }, [catalog, catalogueId, navigateToArchiveTarget]);

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

  const openPhoto = useCallback((year: string, photoId: string) => {
    const collection = collections.get(year);
    if (!collection?.photos.some((photo) => photo.id === photoId)) return;
    recordDiagnostic("player-open", { year, photoId });
    fullscreenLaunchPhotoIdRef.current = photoId;
    void requestDocumentFullscreen().then((entered) => {
      if (entered && fullscreenLaunchPhotoIdRef.current !== photoId) void exitDocumentFullscreen();
    });
    setActivePhotoId(photoId);
    setActivePhotoYear(year);
    updateUrlState(year, photoId, "push", catalogueId, true, { photoId });
  }, [catalogueId, collections]);

  const closePlayer = useCallback((photoId: string) => {
    fullscreenLaunchPhotoIdRef.current = null;
    const restoreId = photoId || activePhotoIdRef.current;
    const year = activePhotoYearRef.current || activeYearRef.current;
    recordDiagnostic("player-close", { year, photoId: restoreId });
    pendingClosePhotoIdRef.current = restoreId;
    const historyState = readArchiveHistoryState(window.history.state);
    if (readUrlPhotoId() && historyState?.view === "photo" && historyState.fromGrid) {
      window.history.back();
      return;
    }
    if (year) {
      const entryId = historyState?.entryId || createHistoryEntryId();
      const anchor = createStoredArchiveAnchor({ catalogueId, entryId, year, photoId: restoreId });
      navigateToArchiveTarget(createArchiveRestorationTarget(anchor, "photo-close", true), "photo-close");
    }
    setActivePhotoId(null);
    setActivePhotoYear(null);
    pendingClosePhotoIdRef.current = null;
  }, [catalogueId, navigateToArchiveTarget]);

  if (catalogState.status === "loading") return <SystemState title="640×480" message={catalogState.message} />;
  if (catalogState.status === "error") return <SystemState title="640×480" message={catalogState.message} />;
  if (!activeYear || !states.size) return <SystemState title="640×480" message="Building archive index" />;

  return (
    <>
      <YearWindowGrid
        years={years}
        states={states}
        timelineModel={timelineModel}
        activeYear={activeYear}
        restoration={restoration}
        onNavigate={navigateToArchiveTarget}
        onRestorationWait={(generation) => dispatchRestoration({ type: "wait-for-layout", generation })}
        onRestorationApply={(generation) => dispatchRestoration({ type: "apply", generation })}
        onRestorationSettle={(generation, visibleYear) => dispatchRestoration({ type: "settle", generation, visibleYear })}
        onRestorationCancel={(generation) => dispatchRestoration({ type: "cancel", generation })}
        onPersistAnchor={(anchor) => {
          savedAnchorsRef.current.set(anchor.year, anchor);
          if (!activePhotoIdRef.current) replaceCurrentHistoryAnchor(catalogueId, anchor);
        }}
        onOpenPhoto={openPhoto}
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

function YearWindowGrid({
  years,
  states,
  timelineModel,
  activeYear,
  restoration,
  onNavigate,
  onRestorationWait,
  onRestorationApply,
  onRestorationSettle,
  onRestorationCancel,
  onPersistAnchor,
  onOpenPhoto,
  onRetryYear,
  onRetryAlbum
}: {
  years: string[];
  states: Map<string, ArchiveYearState>;
  timelineModel: ReturnType<typeof buildArchiveTimelineModel>;
  activeYear: string;
  restoration: ArchiveRestorationState;
  onNavigate: (target: ArchiveTarget | ArchiveRestorationTarget, intent: ArchiveNavigationIntent) => void;
  onRestorationWait: (generation: number) => void;
  onRestorationApply: (generation: number) => void;
  onRestorationSettle: (generation: number, visibleYear: string) => void;
  onRestorationCancel: (generation: number) => void;
  onPersistAnchor: (anchor: Omit<StoredArchiveAnchor, "schema" | "catalogueId" | "entryId">) => void;
  onOpenPhoto: (year: string, photoId: string) => void;
  onRetryYear: (year: string) => void;
  onRetryAlbum: (year: string, albumId: string) => void;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const chromeRef = useRef<HTMLElement | null>(null);
  const yearHeadingRef = useRef<HTMLElement | null>(null);
  const viewport = useViewport();
  const previousLayoutRef = useRef<{ year: string; layout: GridLayout } | null>(null);
  const previousScrollYRef = useRef(0);
  const restorationRef = useRef(restoration);
  const diagnosticLayoutSignatureRef = useRef("");
  const diagnosticRangeSignatureRef = useRef("");
  const activeWarningsRef = useRef(new Set<string>());
  const [isScrubbing, setIsScrubbing] = useState(false);
  const state = states.get(activeYear);
  const collection = state?.status === "ready" ? state.collection : null;
  const compactViewport = viewport.height <= 460 && width >= 620;
  const targetHeight = compactViewport ? 184 : width < 520 ? 138 : width < 900 ? 146 : 174;
  const gap = width < 520 ? 3 : 4;
  const layout = useMemo(() => collection
    ? buildGridLayout(collection, width, targetHeight, gap, compactViewport)
    : { entries: [], totalHeight: 0, photoTops: new Map<string, number>(), albumAnchors: [], yearAnchors: [] },
  [collection, compactViewport, gap, targetHeight, width]);
  const photoAnchors = useMemo(() => [...layout.photoTops].sort((left, right) => left[1] - right[1]), [layout.photoTops]);
  const indexById = useMemo(() => new Map(collection?.photos.map((photo, index) => [photo.id, index]) || []), [collection]);
  const containerTop = ref.current ? ref.current.getBoundingClientRect().top + viewport.scrollY : 0;
  const localViewportTop = viewport.scrollY - containerTop;
  const scrollingDown = viewport.scrollY >= previousScrollYRef.current;
  previousScrollYRef.current = viewport.scrollY;
  const trailingOverscan = Math.max(GRID_MIN_OVERSCAN_PX, viewport.height * 0.4);
  const leadingOverscan = Math.max(GRID_SCROLL_AHEAD_PX, viewport.height);
  const visibleTop = localViewportTop - (scrollingDown ? trailingOverscan : leadingOverscan);
  const visibleBottom = localViewportTop + viewport.height + (scrollingDown ? leadingOverscan : trailingOverscan);
  const visibleEntries = layout.entries.filter((entry) => entry.top + entry.height >= visibleTop && entry.top <= visibleBottom);
  const currentAlbum = findAlbumAtTop(layout, localViewportTop + ARCHIVE_JUMP_OFFSET_PX);
  const albumHeadingScreenTop = currentAlbum ? containerTop + currentAlbum.top - viewport.scrollY : -1;
  const chromeBottom = chromeRef.current?.getBoundingClientRect().bottom || 82;
  const yearHeadingRect = yearHeadingRef.current?.getBoundingClientRect();
  const yearHeadingIsVisible = yearHeadingRect
    ? yearHeadingRect.bottom > chromeBottom && yearHeadingRect.top < viewport.height
    : localViewportTop < 36;
  const albumHeadingIsVisible = albumHeadingScreenTop >= 88 && albumHeadingScreenTop <= 240;
  const failedCount = collection?.failedAlbumIds.length || 0;
  const statusMessage = state?.status === "index-loading" ? `Loading ${activeYear} index`
    : state?.status === "unloaded" || state?.status === "loading" ? `Loading ${activeYear}`
      : state?.status === "error" ? state.message || `${activeYear} could not load`
        : failedCount ? `${failedCount} album${failedCount === 1 ? "" : "s"} could not load` : null;
  const activeAlbumProgress = currentAlbum
    ? clamp((localViewportTop + ARCHIVE_JUMP_OFFSET_PX - currentAlbum.top) / Math.max(1, currentAlbum.bottom - currentAlbum.top), 0, 1)
    : 0;
  const activeRatio = archiveRatioForLocation(timelineModel, activeYear, currentAlbum?.id || null, activeAlbumProgress);
  const restorationPending = restorationIsPending(restoration);
  const targetAlbum = restoration.target?.year === activeYear && restoration.target.albumId
    ? state?.index?.albums.find((album) => album.id === restoration.target?.albumId) || null
    : null;
  const olderTarget = boundaryArchiveTarget(timelineModel, activeYear, "older");
  const newerTarget = boundaryArchiveTarget(timelineModel, activeYear, "newer");

  useLayoutEffect(() => {
    restorationRef.current = restoration;
  }, [restoration]);

  useLayoutEffect(() => {
    const previous = previousLayoutRef.current;
    previousLayoutRef.current = { year: activeYear, layout };
    if (restorationPending || !width || !previous || previous.year !== activeYear || !ref.current || previous.layout.totalHeight === layout.totalHeight) return;
    const oldLocalTop = window.scrollY - (ref.current.getBoundingClientRect().top + window.scrollY) + RESTORE_OFFSET_PX;
    const oldAlbum = findStableAlbumAtTop(previous.layout, oldLocalTop);
    const oldPhoto = nearestPhotoAnchor([...previous.layout.photoTops].sort((left, right) => left[1] - right[1]), oldLocalTop)?.[0] || null;
    const previousTop = oldPhoto ? previous.layout.photoTops.get(oldPhoto) : oldAlbum?.top;
    const nextTop = oldPhoto ? layout.photoTops.get(oldPhoto) : oldAlbum
      ? layout.albumAnchors.find((album) => album.id === oldAlbum.id)?.top
      : undefined;
    const correction = stableYearLocalCorrection(previousTop, nextTop);
    if (Math.abs(correction) > 0.5) {
      const detail = { at: new Date().toISOString(), top: correction, anchorPhotoId: oldPhoto, anchorAlbumId: oldAlbum?.id || null, year: activeYear };
      updateDiagnostics({ lastLayoutCorrection: detail, lastProgrammaticScroll: { ...detail, kind: "scrollBy" } }, "layout-correction", detail);
      window.scrollBy({ top: correction, behavior: "auto" });
    }
  }, [activeYear, layout, restorationPending, width]);

  useLayoutEffect(() => {
    if (restoration.phase === "pending-target") onRestorationWait(restoration.generation);
  }, [onRestorationWait, restoration.generation, restoration.phase]);

  useLayoutEffect(() => {
    if (restoration.phase !== "waiting-for-layout" || !restoration.target || restoration.target.year !== activeYear || !ref.current || !width) return;
    const sourceTarget = restoration.target;
    const layoutReady = state?.status === "ready" || state?.status === "error";
    const resolved = resolveAnchorAgainstStableIds(sourceTarget, {
      layoutReady,
      albumIds: new Set(state?.index?.albums.map(({ id }) => id) || []),
      photoIds: new Set(collection?.photos.map(({ id }) => id) || [])
    });
    if (resolved.status === "waiting") return;
    const target = resolved.anchor;
    let virtualTop: number | undefined;
    if (target.photoId) virtualTop = layout.photoTops.get(target.photoId);
    if (virtualTop === undefined && target.albumId) virtualTop = layout.albumAnchors.find((album) => album.id === target.albumId)?.top;
    if (virtualTop === undefined) virtualTop = 0;
    const generation = restoration.generation;
    const baseOffset = target.photoId ? RESTORE_OFFSET_PX : ARCHIVE_JUMP_OFFSET_PX;
    const firstAlbumId = layout.albumAnchors[0]?.id || null;
    const enteringAtYearStart = !target.photoId && (!target.albumId || target.albumId === firstAlbumId);
    const headingTop = yearHeadingRef.current
      ? yearHeadingRef.current.getBoundingClientRect().top + window.scrollY
      : undefined;
    const stickyHeight = chromeRef.current?.getBoundingClientRect().height || 0;
    const nextTop = enteringAtYearStart && headingTop !== undefined
      ? headingTop - stickyHeight - 6
      : ref.current.getBoundingClientRect().top + window.scrollY + virtualTop - baseOffset + target.adjustmentPx;
    const frame = window.requestAnimationFrame(() => {
      if (restorationRef.current.generation !== generation || restorationRef.current.phase === "cancelled") return;
      onRestorationApply(generation);
      updateDiagnostics({ lastProgrammaticScroll: { at: new Date().toISOString(), kind: "year-local-restoration", top: Math.max(0, nextTop), generation, year: activeYear } }, "programmatic-scroll", { kind: "year-local-restoration", top: Math.max(0, nextTop), generation, year: activeYear });
      window.scrollTo({ top: Math.max(0, nextTop), behavior: "auto" });
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (restorationRef.current.generation !== generation || restorationRef.current.phase === "cancelled" || !ref.current) return;
        if (sourceTarget.focusPhoto && target.photoId) {
          ref.current.querySelector<HTMLButtonElement>(`[data-photo-id="${escapeCssAttribute(target.photoId)}"]`)?.focus({ preventScroll: true });
        }
        onRestorationSettle(generation, activeYear);
      }));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeYear, collection, layout.albumAnchors, layout.photoTops, onRestorationApply, onRestorationSettle, restoration.generation, restoration.phase, restoration.target, state, width]);

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

  const persistLiveViewportAnchor = useCallback(() => {
    if (!collection || !ref.current) return;
    const liveContainerTop = ref.current.getBoundingClientRect().top + window.scrollY;
    const liveLocalViewportTop = window.scrollY - liveContainerTop;
    const liveAlbum = findAlbumAtTop(layout, liveLocalViewportTop + ARCHIVE_JUMP_OFFSET_PX);
    const nearestPhoto = nearestPhotoAnchor(photoAnchors, liveLocalViewportTop + RESTORE_OFFSET_PX);
    const photoId = nearestPhoto?.[0] || null;
    const anchorTop = nearestPhoto?.[1] ?? liveAlbum?.top ?? 0;
    const baseOffset = photoId ? RESTORE_OFFSET_PX : ARCHIVE_JUMP_OFFSET_PX;
    onPersistAnchor({
      year: activeYear,
      albumId: liveAlbum?.id || null,
      photoId,
      adjustmentPx: liveLocalViewportTop - (anchorTop - baseOffset)
    });
  }, [activeYear, collection, layout, onPersistAnchor, photoAnchors, ref]);

  useEffect(() => {
    if (restoration.phase !== "settled" && restoration.phase !== "cancelled") return;
    const timer = window.setTimeout(persistLiveViewportAnchor, 90);
    return () => window.clearTimeout(timer);
  }, [localViewportTop, persistLiveViewportAnchor, restoration.phase]);

  useEffect(() => {
    if (restoration.phase !== "settled" && restoration.phase !== "cancelled") return;
    const flush = () => persistLiveViewportAnchor();
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, [persistLiveViewportAnchor, restoration.phase]);

  useLayoutEffect(() => {
    if (!diagnosticsEnabled()) return;
    const first = visibleEntries[0];
    const last = visibleEntries[visibleEntries.length - 1];
    const virtualRange = {
      mode: "year-windowed",
      year: activeYear,
      first: first ? { id: first.id, type: first.type, top: Math.round(first.top) } : null,
      last: last ? { id: last.id, type: last.type, bottom: Math.round(last.top + last.height) } : null,
      renderedEntries: visibleEntries.length,
      totalEntries: layout.entries.length,
      totalHeight: Math.round(layout.totalHeight)
    };
    const entries = [...(ref.current?.querySelectorAll<HTMLElement>("[data-entry-type='row']") || [])];
    const mountedYears = [...new Set(entries.map((entry) => entry.dataset.year).filter((year): year is string => Boolean(year)))];
    const rows = entries.length;
    const photos = ref.current?.querySelectorAll(".photo-tile").length || 0;
    const images = [...(ref.current?.querySelectorAll<HTMLImageElement>(".photo-tile img") || [])];
    const loadedImages = images.filter((image) => image.complete && image.naturalWidth > 0).length;
    const inactiveImageElements = images.filter((image) => image.closest<HTMLElement>("[data-year]")?.dataset.year !== activeYear).length;
    const stableAnchor = nearestPhotoAnchor(photoAnchors, localViewportTop + RESTORE_OFFSET_PX);
    const counts = { mountedYears, mountedRows: rows, mountedPhotos: photos, inactiveImageElements, observerCount: getDiagnostics().observerCount };
    const warnings = archiveWindowWarnings(counts);
    updateDiagnostics({
      activeYear,
      activeAlbum: currentAlbum ? { year: activeYear, id: currentAlbum.id } : null,
      mountedYears,
      mountedRows: rows,
      mountedPhotos: photos,
      loadedImages,
      inactiveImageElements,
      retainedYearLayouts: collection ? [activeYear] : [],
      stableAnchor: stableAnchor ? { year: activeYear, albumId: currentAlbum?.id || null, photoId: stableAnchor[0], adjustmentPx: Math.round(localViewportTop + RESTORE_OFFSET_PX - stableAnchor[1]) } : null,
      virtualRange,
      scrubber: { ...getDiagnostics().scrubber, dragging: isScrubbing, activeRatio: Math.round(activeRatio * 100000) / 100000 }
    });
    for (const warning of warnings) {
      if (!activeWarningsRef.current.has(warning)) recordDiagnostic("archive-bound-warning", { warning, ...counts, activeYear });
    }
    activeWarningsRef.current = new Set(warnings);
    const rangeSignature = JSON.stringify(virtualRange);
    if (rangeSignature !== diagnosticRangeSignatureRef.current) {
      diagnosticRangeSignatureRef.current = rangeSignature;
      recordDiagnostic("virtual-range-change", virtualRange);
    }
    const layoutSignature = `${activeYear}:${width}:${layout.totalHeight}:${layout.entries.length}`;
    if (layoutSignature !== diagnosticLayoutSignatureRef.current) {
      diagnosticLayoutSignatureRef.current = layoutSignature;
      recordDiagnostic("year-layout-construction", { year: activeYear, width, totalHeight: Math.round(layout.totalHeight), entryCount: layout.entries.length });
    }
  }, [activeRatio, activeYear, collection, currentAlbum, isScrubbing, layout.entries.length, layout.totalHeight, localViewportTop, photoAnchors, visibleEntries, width]);

  const commitBoundary = (target: ArchiveTarget | null) => {
    if (target) onNavigate(target, "boundary");
  };

  const commitYearJump = (year: string) => {
    const yearRange = timelineModel.years.find((candidate) => candidate.year === year);
    if (!yearRange) return;
    const album = yearRange.albums[0] || null;
    onNavigate({
      year,
      albumId: album?.id || null,
      albumName: album?.name || null,
      ratio: yearRange.start,
      sectionRatio: 0
    }, "jump");
  };

  return (
    <main
      className="collection-shell"
      data-active-year={activeYear}
      data-mounted-years={collection ? activeYear : ""}
      data-restoration-phase={restoration.phase}
      data-render-mode="year-windowed"
    >
      <header className="collection-chrome" ref={chromeRef}>
        <div className="app-bar">
          <div className="app-bar__identity">
            <span className="app-bar__brand">640×480</span>
          </div>
          <nav className="year-selector" aria-label="Archive years">
            {timelineModel.years.map((year) => (
              <button
                key={year.year}
                className={`${year.year === activeYear ? "is-selected" : ""} ${yearHeadingIsVisible && year.year === activeYear ? "is-inline-current" : ""}`}
                type="button"
                aria-current={year.year === activeYear ? "true" : undefined}
                aria-label={`Jump to ${year.year}`}
                onClick={() => commitYearJump(year.year)}
              >
                {year.year}
              </button>
            ))}
          </nav>
        </div>
        {statusMessage ? (
          <div className={`collection-status collection-status--${state?.status === "error" || failedCount ? "error" : "loading"}`} role={state?.status === "error" || failedCount ? "alert" : "status"}>
            <span>{statusMessage}{targetAlbum ? ` · ${folderLabelFromName(targetAlbum.name, activeYear)}` : ""}</span>
            {state?.status === "error" ? <button type="button" onClick={() => onRetryYear(activeYear)}>Retry</button> : null}
          </div>
        ) : (
          <div className={`album-context ${!currentAlbum || albumHeadingIsVisible ? "album-context--hidden" : ""}`} aria-live="polite" aria-hidden={!currentAlbum || albumHeadingIsVisible}>
            <span className="album-context__folder">{currentAlbum?.folderLabel || ""}</span>
          </div>
        )}
      </header>

      {newerTarget ? (
        <nav className="archive-year-boundary archive-year-boundary--newer" aria-label={`Beginning of ${activeYear}`}>
          <button type="button" onClick={() => commitBoundary(newerTarget)}>
            <span aria-hidden="true">↑</span> Newer photos: {newerTarget.year}
          </button>
        </nav>
      ) : null}

      <section className="archive-year-heading archive-year-heading--inline" data-year={activeYear} aria-labelledby={`year-${activeYear}-title`} ref={yearHeadingRef}>
        <h1 id={`year-${activeYear}-title`}>{activeYear}</h1>
        <span>{(state?.index?.sequence.length || state?.index?.scannedCount || 0).toLocaleString()} photographs</span>
      </section>

      {!collection ? (
        <section className={`year-window-loading year-window-loading--${state?.status || "index-loading"}`} aria-live="polite">
          <strong>{activeYear}</strong>
          <span>{targetAlbum ? folderLabelFromName(targetAlbum.name, activeYear) : "Preparing this year"}</span>
          {state?.status === "error" ? <button type="button" onClick={() => onRetryYear(activeYear)}>Retry year</button> : null}
        </section>
      ) : null}

      <div id="photo-grid" className="virtual-album-stack" ref={ref} style={{ height: layout.totalHeight || undefined }}>
        {diagnosticsEnabled() && collection ? (
          <div className="archive-diagnostic-overlays" aria-hidden="true">
            <div className="archive-diagnostic-boundary archive-diagnostic-boundary--year archive-diagnostic-boundary--measured" style={{ top: 0, height: Math.max(1, layout.totalHeight) }}>
              <span>{activeYear} · mounted year window</span>
            </div>
            {layout.albumAnchors.map((album) => (
              <div className="archive-diagnostic-boundary archive-diagnostic-boundary--album" key={`debug-album-${activeYear}-${album.id}`} style={{ top: album.top, height: Math.max(1, album.bottom - album.top) }}>
                <span>{activeYear} · {album.id}</span>
              </div>
            ))}
            <div className="archive-diagnostic-anchor" style={{ top: Math.max(0, localViewportTop + RESTORE_OFFSET_PX) }}><span>stable local anchor</span></div>
          </div>
        ) : null}
        {visibleEntries.map((entry) => {
          if (entry.type === "heading") {
            return (
              <div className="album-group__heading virtual-entry" data-entry-type={entry.type} data-year={activeYear} data-album-id={entry.album.id} key={entry.id} style={{ top: entry.top, height: entry.height }}>
                <h2><span className="album-heading__folder">{albumFolderLabel(entry.album)}</span></h2><span>{entry.album.count}</span>
              </div>
            );
          }
          if (entry.type === "album-error") {
            const loading = entry.album.loadState === "loading";
            return (
              <div className={`album-error album-error--${entry.album.loadState} virtual-entry`} data-entry-type={entry.type} data-year={activeYear} data-album-id={entry.album.id} key={entry.id} style={{ top: entry.top, height: entry.height }} role={loading ? "status" : "alert"}>
                <span>{loading ? "Loading album" : entry.album.errorMessage || "Album could not be loaded"}</span>
                {!loading ? <button type="button" onClick={() => onRetryAlbum(activeYear, entry.album.id)}>Retry</button> : null}
              </div>
            );
          }
          return (
            <div className={`photo-row photo-row--${entry.tone} virtual-entry`} data-entry-type={entry.type} data-row-tone={entry.tone} data-year={activeYear} data-album-id={entry.albumId} key={entry.id} style={{ top: entry.top, height: entry.height, gap: entry.gap }}>
              {entry.items.map((item) => (
                <button className={`photo-tile photo-tile--${item.photo.orientation}`} key={item.photo.id} type="button" data-photo-id={item.photo.id} style={{ width: item.width, height: item.height }} onClick={() => onOpenPhoto(activeYear, item.photo.id)} aria-label={`Open photo ${(indexById.get(item.photo.id) || 0) + 1} of ${collection?.photos.length || 0}`}>
                  <img src={mediaUrl(item.photo.thumbnailKey)} alt="" loading="eager" decoding="async" width={item.photo.width} height={item.photo.height} />
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {olderTarget ? (
        <nav className="archive-year-boundary archive-year-boundary--older" aria-label={`End of ${activeYear}`}>
          <button type="button" onClick={() => commitBoundary(olderTarget)}>
            Older photos: {olderTarget.year} <span aria-hidden="true">↓</span>
          </button>
        </nav>
      ) : null}

      <ArchiveScrubber
        model={timelineModel}
        activeYear={activeYear}
        activeAlbumId={currentAlbum?.id || null}
        activeRatio={activeRatio}
        formatAlbumName={folderLabelFromName}
        onCommit={(target, intent) => onNavigate(target, intent)}
        onScrubStateChange={(next) => {
          setIsScrubbing(next);
          if (next && restorationPending) onRestorationCancel(restoration.generation);
        }}
      />
    </main>
  );
}

export default App;
