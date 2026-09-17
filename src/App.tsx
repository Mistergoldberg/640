import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { assetUrl, mediaUrl } from "./lib/assets";
import { formatPublicArchiveAlbumLabel } from "./lib/archiveAlbumPresentation";
import { useElementWidth } from "./hooks/useElementWidth";
import { validateCatalog } from "./data/manifestValidation";
import { ArchiveScrubber } from "./archive/ArchiveScrubber";
import { useArchiveYearCache, type ArchiveLoadReason, type ArchiveYearState } from "./archive/useArchiveYearCache";
import { archiveRatioForLocation, buildArchiveTimelineModel, orderedArchiveYears, type ArchiveTarget } from "./archive/archiveTimelineModel";
import {
  albumFolderLabel,
  buildYearSegmentLayout,
  type AlbumAnchor,
  type GridLayout,
  type LayoutEntry
} from "./archive/yearSegmentLayout";
import { YearSegmentSpacer } from "./archive/YearSegmentSpacer";
import { SEAMLESS_YEAR_SEGMENTS_ENABLED } from "./archive/seamlessYearSegmentsFlag";
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
import type { Catalog } from "./types";
import { diagnosticsEnabled, getDiagnostics, recordDiagnostic, registerArchiveObserver, updateDiagnostics } from "./debug/archiveDiagnostics";
import { segmentIdentity } from "./archive/yearSegmentController";
import { HOMEPAGE_AUTOPLAYER_ENABLED, isEligibleHomepageAutoplayUrl } from "./player/homepageAutoplay";

const CATALOG_URL = assetUrl("data/catalog.json");
const GRID_MIN_OVERSCAN_PX = 260;
const GRID_SCROLL_AHEAD_PX = 720;
const RESTORE_OFFSET_PX = 112;
const ARCHIVE_JUMP_OFFSET_PX = 196;
const SEGMENT_HANDOFF_HYSTERESIS_PX = 96;
const SEGMENT_PREFETCH_MIN_PX = 560;
const SEGMENT_PREFETCH_MAX_PX = 1600;
const SEGMENT_RECLAIM_SAFETY_MARGIN_PX = 640;
const SEGMENT_ROW_BUDGET = 80;
const SEGMENT_PHOTO_BUDGET = 300;
const SEGMENT_LEAD_IN_ROW_COUNT = 4;

type BoundaryDirection = "newer" | "older";

interface LiveLayoutAnchor {
  year: string;
  photoId: string | null;
  albumId: string | null;
}

interface SegmentSpacerRecord {
  id: string;
  year: string;
  spacerHeight: number;
  width: number;
  generation: number;
  predictedHeight: number;
  renderedHeight: number;
}

interface VisualSegmentAnchor {
  year: string;
  albumId: string | null;
  photoId: string | null;
  rowId: string | null;
  elementId: string;
  elementKind: "photo" | "row" | "album" | "year";
  top: number;
  containerWidth: number;
  scrollY: number;
  generation: number;
  adjustmentPx: number;
}

interface PendingVisualCorrection {
  anchor: VisualSegmentAnchor | null;
  kind: string;
  year: string;
  beforeHeight?: number;
  afterHeight?: number;
  sequence?: number;
}

type CatalogLoadState =
  | { status: "loading"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: Catalog };

function yearExists(catalog: Catalog, year: string | null) {
  return Boolean(year && catalog.years.some((candidate) => candidate.year === year));
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

function leadInPlanForLayout(layout: GridLayout, maxRows = SEGMENT_LEAD_IN_ROW_COUNT) {
  const selected: LayoutEntry[] = [];
  let rowCount = 0;

  for (const entry of layout.entries) {
    if (entry.type === "album-error") break;
    selected.push(entry);
    if (entry.type === "row") rowCount += 1;
    if (rowCount >= maxRows) break;
  }

  if (!rowCount) return null;
  const height = selected.reduce((bottom, entry) => Math.max(bottom, entry.top + entry.height), 0);
  return {
    entries: selected.map((entry) => ({ ...entry })) as LayoutEntry[],
    height,
    rowCount
  };
}

function App() {
  const catalogState = useCatalog();
  const catalog = catalogState.status === "ready" ? catalogState.catalog : null;
  const catalogueId = useMemo(() => catalog ? archiveCatalogueIdentity(catalog) : "", [catalog]);
  const [activeYear, setActiveYear] = useState<string | null>(null);
  const [restoration, dispatchRestoration] = useReducer(archiveRestorationReducer, undefined, createArchiveRestorationState);
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null);
  const [activePhotoYear, setActivePhotoYear] = useState<string | null>(null);
  const [homepageAutoplayActive, setHomepageAutoplayActive] = useState(false);
  const activeYearRef = useRef<string | null>(null);
  const activePhotoIdRef = useRef<string | null>(null);
  const activePhotoYearRef = useRef<string | null>(null);
  const fullscreenLaunchPhotoIdRef = useRef<string | null>(null);
  const pendingClosePhotoIdRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const homepageAutoplayEligibleRef = useRef(
    HOMEPAGE_AUTOPLAYER_ENABLED
      && typeof window !== "undefined"
      && isEligibleHomepageAutoplayUrl(window.location.href, diagnosticsEnabled())
  );
  const homepageAutoplayPathRef = useRef(
    typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}${window.location.hash}`
  );
  const homepageAutoplayDismissedRef = useRef(false);
  const savedAnchorsRef = useRef(new Map<string, Omit<StoredArchiveAnchor, "schema" | "catalogueId" | "entryId">>());
  const { states, indexes, collections, cachedYears, loadingYears, loadYear, cancelYearLoad, retryYear, retryAlbum } = useArchiveYearCache(
    catalog,
    activeYear,
    { maxConcurrentAlbumRequests: SEAMLESS_YEAR_SEGMENTS_ENABLED ? 3 : undefined }
  );
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

  const passiveHandoffToYear = useCallback((anchor: Omit<StoredArchiveAnchor, "schema" | "catalogueId" | "entryId">) => {
    if (!catalog || !yearExists(catalog, anchor.year) || activeYearRef.current === anchor.year) return;
    const previousYear = activeYearRef.current;
    recordDiagnostic("archive-passive-handoff", {
      previousYear,
      year: anchor.year,
      albumId: anchor.albumId,
      photoId: anchor.photoId,
      adjustmentPx: anchor.adjustmentPx
    });
    updateUrlState(anchor.year, null, "replace", catalogueId, false, anchor);
    activeYearRef.current = anchor.year;
    setActiveYear(anchor.year);
    loadYear(anchor.year, "passive");
    dispatchRestoration({ type: "cancel" });
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
    if (!homepageAutoplayEligibleRef.current || homepageAutoplayDismissedRef.current || homepageAutoplayActive || !activeYear) return;
    const collection = collections.get(activeYear);
    const firstPhoto = collection?.photos[0];
    if (!firstPhoto) return;
    recordDiagnostic("homepage-autoplayer-open", { year: activeYear, photoId: firstPhoto.id });
    setActivePhotoId(firstPhoto.id);
    setActivePhotoYear(activeYear);
    setHomepageAutoplayActive(true);
    window.history.replaceState(window.history.state, "", homepageAutoplayPathRef.current);
  }, [activeYear, collections, homepageAutoplayActive]);

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
    if (homepageAutoplayActive) {
      homepageAutoplayDismissedRef.current = true;
      homepageAutoplayEligibleRef.current = false;
      setHomepageAutoplayActive(false);
    }
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
    if (homepageAutoplayActive) {
      window.history.replaceState(window.history.state, "", homepageAutoplayPathRef.current);
    }
  }, [catalogueId, homepageAutoplayActive, navigateToArchiveTarget]);

  if (catalogState.status === "loading") return <SystemState title="640×480" message={catalogState.message} />;
  if (catalogState.status === "error") return <SystemState title="640×480" message={catalogState.message} />;
  if (!activeYear || !states.size) return <SystemState title="640×480" message="Building archive index" />;

  const ArchiveGrid = SEAMLESS_YEAR_SEGMENTS_ENABLED ? SegmentedYearGrid : YearWindowGrid;

  return (
    <>
      <ArchiveGrid
        years={years}
        states={states}
        timelineModel={timelineModel}
        activeYear={activeYear}
        protectedPhotoYear={activePhotoYear}
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
        onRequestYear={(year, reason) => loadYear(year, reason)}
        onCancelYearRequest={cancelYearLoad}
        onPassiveHandoff={passiveHandoffToYear}
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
          launchMode={homepageAutoplayActive ? "homepage-autoplay" : "standard"}
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

interface YearWindowGridProps {
  years: string[];
  states: Map<string, ArchiveYearState>;
  timelineModel: ReturnType<typeof buildArchiveTimelineModel>;
  activeYear: string;
  protectedPhotoYear: string | null;
  restoration: ArchiveRestorationState;
  onNavigate: (target: ArchiveTarget | ArchiveRestorationTarget, intent: ArchiveNavigationIntent) => void;
  onRestorationWait: (generation: number) => void;
  onRestorationApply: (generation: number) => void;
  onRestorationSettle: (generation: number, visibleYear: string) => void;
  onRestorationCancel: (generation: number) => void;
  onPersistAnchor: (anchor: Omit<StoredArchiveAnchor, "schema" | "catalogueId" | "entryId">) => void;
  onOpenPhoto: (year: string, photoId: string) => void;
  onRequestYear: (year: string, reason: ArchiveLoadReason) => void;
  onCancelYearRequest: (year: string) => void;
  onPassiveHandoff: (anchor: Omit<StoredArchiveAnchor, "schema" | "catalogueId" | "entryId">) => void;
  onRetryYear: (year: string) => void;
  onRetryAlbum: (year: string, albumId: string) => void;
  segmentedMode?: boolean;
}

function SegmentedYearGrid(props: YearWindowGridProps) {
  return <YearWindowGrid {...props} segmentedMode />;
}

function YearWindowGrid({
  years,
  states,
  timelineModel,
  activeYear,
  protectedPhotoYear,
  restoration,
  onNavigate,
  onRestorationWait,
  onRestorationApply,
  onRestorationSettle,
  onRestorationCancel,
  onPersistAnchor,
  onOpenPhoto,
  onRequestYear,
  onCancelYearRequest,
  onPassiveHandoff,
  onRetryYear,
  onRetryAlbum,
  segmentedMode = false
}: YearWindowGridProps) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const chromeRef = useRef<HTMLElement | null>(null);
  const yearHeadingRef = useRef<HTMLElement | null>(null);
  const activeSegmentRef = useRef<HTMLElement | null>(null);
  const adjacentSegmentRefs = useRef(new Map<string, HTMLElement>());
  const adjacentGridRefs = useRef(new Map<string, HTMLDivElement>());
  const spacerRefs = useRef(new Map<string, HTMLElement>());
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const viewport = useViewport();
  const previousLayoutRef = useRef<{ year: string; layout: GridLayout } | null>(null);
  const pendingResizeAnchorRef = useRef<LiveLayoutAnchor | null>(null);
  const pendingVisualCorrectionRef = useRef<PendingVisualCorrection | null>(null);
  const visualCorrectionSequenceRef = useRef(0);
  const previousScrollYRef = useRef(0);
  const scrollDirectionRef = useRef<BoundaryDirection | null>(null);
  const restorationRef = useRef(restoration);
  const diagnosticLayoutSignatureRef = useRef("");
  const diagnosticRangeSignatureRef = useRef("");
  const activeWarningsRef = useRef(new Set<string>());
  const requestedSegmentYearsRef = useRef(new Set<string>());
  const passiveHandoffTargetRef = useRef<string | null>(null);
  const lastPassiveHandoffRef = useRef("");
  const compensatedPrependedYearsRef = useRef(new Set<string>());
  const restoredFromSpacerYearsRef = useRef(new Set<string>());
  const segmentGenerationRef = useRef(0);
  const segmentChromeHeightRef = useRef(0);
  const layoutWidthRef = useRef(0);
  const compactViewportRef = useRef(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [mountedSegmentYears, setMountedSegmentYears] = useState([activeYear]);
  const [spacerSegments, setSpacerSegments] = useState<Map<string, SegmentSpacerRecord>>(new Map());
  const [pendingAdjacent, setPendingAdjacent] = useState<{ year: string; direction: BoundaryDirection; required: boolean } | null>(null);
  const state = states.get(activeYear);
  const collection = state?.status === "ready" ? state.collection : null;
  if (width && width !== layoutWidthRef.current) {
    layoutWidthRef.current = width;
    compactViewportRef.current = viewport.height <= 460 && width >= 620;
  }
  const compactViewport = width >= 620 ? compactViewportRef.current : false;
  const targetHeight = compactViewport ? 184 : width < 520 ? 138 : width < 900 ? 146 : 174;
  const gap = width < 520 ? 3 : 4;
  const layout = useMemo(() => collection
    ? buildYearSegmentLayout({ collection, width, targetRowHeight: targetHeight, gap, compactViewport })
    : { entries: [], totalHeight: 0, photoTops: new Map<string, number>(), albumAnchors: [], yearAnchors: [] },
  [collection, compactViewport, gap, targetHeight, width]);
  const photoAnchors = useMemo(() => [...layout.photoTops].sort((left, right) => left[1] - right[1]), [layout.photoTops]);
  const indexById = useMemo(() => new Map(collection?.photos.map((photo, index) => [photo.id, index]) || []), [collection]);
  const containerTop = ref.current ? ref.current.getBoundingClientRect().top + viewport.scrollY : 0;
  const localViewportTop = viewport.scrollY - containerTop;
  if (viewport.scrollY > previousScrollYRef.current) {
    scrollDirectionRef.current = "older";
  } else if (viewport.scrollY < previousScrollYRef.current) {
    scrollDirectionRef.current = "newer";
  }
  const scrollingDown = scrollDirectionRef.current !== "newer";
  previousScrollYRef.current = viewport.scrollY;
  const trailingOverscan = Math.max(GRID_MIN_OVERSCAN_PX, viewport.height * 0.4);
  const leadingOverscan = Math.max(GRID_SCROLL_AHEAD_PX, viewport.height);
  const visibleTop = localViewportTop - (scrollingDown ? trailingOverscan : leadingOverscan);
  const visibleBottom = localViewportTop + viewport.height + (scrollingDown ? leadingOverscan : trailingOverscan);
  const visibleEntries = layout.entries.filter((entry) => entry.top + entry.height >= visibleTop && entry.top <= visibleBottom);
  const currentAlbum = findAlbumAtTop(layout, localViewportTop + ARCHIVE_JUMP_OFFSET_PX);
  const albumHeadingScreenTop = currentAlbum ? containerTop + currentAlbum.top - viewport.scrollY : -1;
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
  const activeYearIndex = years.indexOf(activeYear);
  const newerMountedYear = segmentedMode
    ? mountedSegmentYears.find((year) => years.indexOf(year) >= 0 && years.indexOf(year) < activeYearIndex) || null
    : null;
  const olderMountedYear = segmentedMode
    ? mountedSegmentYears.find((year) => years.indexOf(year) > activeYearIndex) || null
    : null;
  const segmentPrefetchDistance = Math.round(clamp(viewport.height * 1.5, SEGMENT_PREFETCH_MIN_PX, SEGMENT_PREFETCH_MAX_PX));
  const adjacentLayoutByYear = useMemo(() => {
    const next = new Map<string, GridLayout>();
    if (!segmentedMode) return next;
    for (const year of mountedSegmentYears) {
      if (year === activeYear) continue;
      const adjacentState = states.get(year);
      if (adjacentState?.status !== "ready" || !adjacentState.collection) continue;
      next.set(year, buildYearSegmentLayout({
        collection: adjacentState.collection,
        width,
        targetRowHeight: targetHeight,
        gap,
        compactViewport
      }));
    }
    return next;
  }, [activeYear, compactViewport, gap, mountedSegmentYears, segmentedMode, states, targetHeight, width]);
  const pendingLeadInPreview = useMemo(() => {
    if (!segmentedMode || !pendingAdjacent || pendingAdjacent.direction !== "older") return null;
    if (mountedSegmentYears.includes(pendingAdjacent.year)) return null;
    const pendingState = states.get(pendingAdjacent.year);
    if (!pendingState?.collection || pendingState.status === "error") return null;
    const previewLayout = buildYearSegmentLayout({
      collection: pendingState.collection,
      width,
      targetRowHeight: targetHeight,
      gap,
      compactViewport
    });
    const leadIn = leadInPlanForLayout(previewLayout);
    if (!leadIn) return null;
    return {
      year: pendingAdjacent.year,
      direction: pendingAdjacent.direction,
      collection: pendingState.collection,
      entries: leadIn.entries,
      height: leadIn.height,
      rowCount: leadIn.rowCount
    };
  }, [compactViewport, gap, mountedSegmentYears, pendingAdjacent, segmentedMode, states, targetHeight, width]);
  const mountedOrPreviewYears = useMemo(() => {
    const next = [...mountedSegmentYears];
    if (pendingLeadInPreview && !next.includes(pendingLeadInPreview.year)) {
      next.push(pendingLeadInPreview.year);
    }
    return next.filter((year) => years.includes(year));
  }, [mountedSegmentYears, pendingLeadInPreview, years]);

  const setAdjacentSegmentRef = useCallback((year: string, node: HTMLElement | null) => {
    if (node) adjacentSegmentRefs.current.set(year, node);
    else adjacentSegmentRefs.current.delete(year);
  }, []);

  const setAdjacentGridRef = useCallback((year: string, node: HTMLDivElement | null) => {
    if (node) adjacentGridRefs.current.set(year, node);
    else adjacentGridRefs.current.delete(year);
  }, []);

  const setSpacerRef = useCallback((year: string, node: HTMLElement | null) => {
    if (node) spacerRefs.current.set(year, node);
    else spacerRefs.current.delete(year);
  }, []);

  const adjacentTargetForDirection = useCallback((direction: BoundaryDirection) => (
    direction === "older" ? olderTarget : newerTarget
  ), [newerTarget, olderTarget]);

  const constrainedConnection = useCallback(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    return Boolean(connection?.saveData);
  }, []);

  const requestAdjacentSegment = useCallback((direction: BoundaryDirection, required = false) => {
    if (!segmentedMode) return;
    const target = adjacentTargetForDirection(direction);
    if (!target) return;
    if (!required && constrainedConnection()) return;
    if (mountedSegmentYears.includes(target.year)) return;
    if (mountedSegmentYears.length >= 2) return;
    if (spacerSegments.has(target.year)) restoredFromSpacerYearsRef.current.add(target.year);

    setPendingAdjacent((current) => {
      if (current && current.year !== target.year && !current.required) {
        onCancelYearRequest(current.year);
        requestedSegmentYearsRef.current.delete(current.year);
      }
      return { year: target.year, direction, required: required || current?.year === target.year && current.required || false };
    });

    if (!requestedSegmentYearsRef.current.has(target.year)) {
      requestedSegmentYearsRef.current.add(target.year);
      onRequestYear(target.year, required ? "boundary" : "prefetch");
      recordDiagnostic("year-segment-prefetch-request", { year: target.year, direction, required });
    }
  }, [
    adjacentTargetForDirection,
    constrainedConnection,
    mountedSegmentYears,
    onCancelYearRequest,
    onRequestYear,
    segmentedMode,
    spacerSegments
  ]);

  const collectionForSegment = useCallback((year: string) => (
    year === activeYear ? collection : states.get(year)?.collection || null
  ), [activeYear, collection, states]);

  const layoutForSegment = useCallback((year: string) => (
    year === activeYear ? layout : adjacentLayoutByYear.get(year) || null
  ), [activeYear, adjacentLayoutByYear, layout]);

  const gridForSegment = useCallback((year: string) => (
    year === activeYear ? ref.current : adjacentGridRefs.current.get(year) || null
  ), [activeYear, ref]);

  const sectionForSegment = useCallback((year: string) => (
    year === activeYear ? activeSegmentRef.current : adjacentSegmentRefs.current.get(year) || null
  ), [activeYear]);

  const visibleEntriesForGrid = useCallback((segmentLayout: GridLayout, grid: HTMLElement | null) => {
    if (!grid) return [];
    const segmentTop = grid.getBoundingClientRect().top + viewport.scrollY;
    const segmentViewportTop = viewport.scrollY - segmentTop;
    const segmentVisibleTop = segmentViewportTop - (scrollingDown ? trailingOverscan : leadingOverscan);
    const segmentVisibleBottom = segmentViewportTop + viewport.height + (scrollingDown ? leadingOverscan : trailingOverscan);
    return segmentLayout.entries.filter((entry) => entry.top + entry.height >= segmentVisibleTop && entry.top <= segmentVisibleBottom);
  }, [leadingOverscan, scrollingDown, trailingOverscan, viewport.height, viewport.scrollY]);

  const stableAnchorForSegment = useCallback((year: string) => {
    const segmentLayout = layoutForSegment(year);
    const grid = gridForSegment(year);
    if (!segmentLayout || !grid) {
      return { year, albumId: null, photoId: null, adjustmentPx: 0 };
    }
    const gridTop = grid.getBoundingClientRect().top + window.scrollY;
    const localViewportTop = window.scrollY - gridTop;
    const photoAnchor = nearestPhotoAnchor([...segmentLayout.photoTops].sort((left, right) => left[1] - right[1]), localViewportTop + RESTORE_OFFSET_PX);
    const album = findAlbumAtTop(segmentLayout, localViewportTop + ARCHIVE_JUMP_OFFSET_PX);
    const photoId = photoAnchor?.[0] || null;
    const anchorTop = photoAnchor?.[1] ?? album?.top ?? 0;
    const baseOffset = photoId ? RESTORE_OFFSET_PX : ARCHIVE_JUMP_OFFSET_PX;
    return {
      year,
      albumId: album?.id || null,
      photoId,
      adjustmentPx: localViewportTop - (anchorTop - baseOffset)
    };
  }, [gridForSegment, layoutForSegment]);

  const orderedSegmentYears = useCallback((candidates: Iterable<string>) => (
    [...candidates].filter((year) => years.includes(year)).sort((left, right) => years.indexOf(left) - years.indexOf(right))
  ), [years]);

  const segmentOuterHeight = useCallback((segmentLayout: GridLayout, renderedGridHeight?: number) => {
    const gridHeight = renderedGridHeight ?? segmentLayout.totalHeight;
    return Math.max(0, gridHeight + segmentChromeHeightRef.current);
  }, []);

  const updateSegmentChromeHeight = useCallback((year: string) => {
    const section = sectionForSegment(year);
    const grid = gridForSegment(year);
    if (!section || !grid) return;
    const nextChromeHeight = section.getBoundingClientRect().height - grid.getBoundingClientRect().height;
    if (nextChromeHeight >= 0) segmentChromeHeightRef.current = nextChromeHeight;
  }, [gridForSegment, sectionForSegment]);

  const findVisualAnchorElement = useCallback((anchor: VisualSegmentAnchor) => {
    const segment = document.querySelector<HTMLElement>(`[data-segment-year="${escapeCssAttribute(anchor.year)}"]:not(.year-segment-spacer)`);
    if (!segment) return null;
    if (anchor.photoId) {
      return segment.querySelector<HTMLElement>(`[data-photo-id="${escapeCssAttribute(anchor.photoId)}"]`);
    }
    if (anchor.rowId) {
      return segment.querySelector<HTMLElement>(`[data-row-id="${escapeCssAttribute(anchor.rowId)}"]`);
    }
    if (anchor.albumId) {
      return segment.querySelector<HTMLElement>(`[data-entry-type="heading"][data-album-id="${escapeCssAttribute(anchor.albumId)}"]`);
    }
    return segment.querySelector<HTMLElement>(".archive-year-heading") || segment;
  }, []);

  const captureVisualAnchor = useCallback((excludedYears = new Set<string>()): VisualSegmentAnchor | null => {
    if (!segmentedMode) return null;
    const safeLine = RESTORE_OFFSET_PX;
    const liveSegments = [...document.querySelectorAll<HTMLElement>(".year-segment[data-segment-year]")]
      .filter((segment) => {
        const year = segment.dataset.segmentYear;
        return Boolean(year && !excludedYears.has(year));
      });

    const candidates: Array<{
      element: HTMLElement;
      year: string;
      albumId: string | null;
      photoId: string | null;
      rowId: string | null;
      kind: VisualSegmentAnchor["elementKind"];
      top: number;
      containsSafeLine: boolean;
      distance: number;
    }> = [];

    for (const segment of liveSegments) {
      const year = segment.dataset.segmentYear;
      if (!year) continue;
      const elements = [
        ...segment.querySelectorAll<HTMLElement>(".photo-tile[data-photo-id]"),
        ...segment.querySelectorAll<HTMLElement>("[data-entry-type='row'][data-row-id]"),
        ...segment.querySelectorAll<HTMLElement>("[data-entry-type='heading'][data-album-id]"),
        ...segment.querySelectorAll<HTMLElement>(".archive-year-heading")
      ];
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
        const row = element.closest<HTMLElement>("[data-row-id]");
        const album = element.closest<HTMLElement>("[data-album-id]");
        const photoId = element.dataset.photoId || null;
        const rowId = row?.dataset.rowId || null;
        const albumId = album?.dataset.albumId || null;
        const kind: VisualSegmentAnchor["elementKind"] = photoId
          ? "photo"
          : rowId ? "row" : albumId ? "album" : "year";
        candidates.push({
          element,
          year,
          albumId,
          photoId,
          rowId,
          kind,
          top: rect.top,
          containsSafeLine: rect.top <= safeLine && rect.bottom >= safeLine,
          distance: Math.abs(rect.top - safeLine)
        });
      }
    }

    const selected = candidates.sort((left, right) => {
      if (left.containsSafeLine !== right.containsSafeLine) return left.containsSafeLine ? -1 : 1;
      const kindRank = (kind: VisualSegmentAnchor["elementKind"]) => kind === "photo" ? 0 : kind === "row" ? 1 : kind === "album" ? 2 : 3;
      return left.distance - right.distance || kindRank(left.kind) - kindRank(right.kind);
    })[0];
    if (!selected) return null;

    const segmentLayout = layoutForSegment(selected.year);
    const grid = gridForSegment(selected.year);
    let adjustmentPx = 0;
    if (segmentLayout && grid) {
      const gridTop = grid.getBoundingClientRect().top + window.scrollY;
      const localViewportTop = window.scrollY - gridTop;
      const anchorTop = selected.photoId
        ? segmentLayout.photoTops.get(selected.photoId) ?? 0
        : selected.albumId
          ? segmentLayout.albumAnchors.find((album) => album.id === selected.albumId)?.top ?? 0
          : 0;
      const baseOffset = selected.photoId ? RESTORE_OFFSET_PX : ARCHIVE_JUMP_OFFSET_PX;
      adjustmentPx = localViewportTop - (anchorTop - baseOffset);
    }

    return {
      year: selected.year,
      albumId: selected.albumId,
      photoId: selected.photoId,
      rowId: selected.rowId,
      elementId: selected.photoId || selected.rowId || selected.albumId || selected.year,
      elementKind: selected.kind,
      top: selected.top,
      containerWidth: width,
      scrollY: window.scrollY,
      generation: segmentGenerationRef.current,
      adjustmentPx
    };
  }, [gridForSegment, layoutForSegment, segmentedMode, width]);

  const queueVisualCorrection = useCallback((correction: PendingVisualCorrection) => {
    if (!correction.anchor) return;
    visualCorrectionSequenceRef.current += 1;
    pendingVisualCorrectionRef.current = { ...correction, sequence: visualCorrectionSequenceRef.current };
  }, []);

  useLayoutEffect(() => {
    if (!segmentedMode) return;
    const pending = pendingVisualCorrectionRef.current;
    if (!pending) return;
    pendingVisualCorrectionRef.current = null;
    const anchor = pending.anchor;
    if (!anchor) return;
    const element = findVisualAnchorElement(anchor);
    if (!element) {
      recordDiagnostic("visual-anchor-correction-missing", { kind: pending.kind, year: pending.year, anchor });
      return;
    }
    const afterTop = element.getBoundingClientRect().top;
    const drift = afterTop - anchor.top;
    const correction = Math.abs(drift) > 0.5 ? drift : 0;
    if (correction) {
      window.scrollBy({ top: correction, behavior: "auto" });
    }
    const detail = {
      at: new Date().toISOString(),
      kind: pending.kind,
      year: pending.year,
      anchorYear: anchor.year,
      albumId: anchor.albumId,
      photoId: anchor.photoId,
      rowId: anchor.rowId,
      anchorTopBefore: Math.round(anchor.top * 100) / 100,
      anchorTopAfter: Math.round(afterTop * 100) / 100,
      anchorDrift: Math.round(drift * 100) / 100,
      scrollCorrection: Math.round(correction * 100) / 100,
      scrollYBefore: Math.round(anchor.scrollY),
      scrollYAfter: Math.round(window.scrollY),
      containerWidth: anchor.containerWidth,
      generation: anchor.generation,
      beforeHeight: pending.beforeHeight === undefined ? null : Math.round(pending.beforeHeight),
      afterHeight: pending.afterHeight === undefined ? null : Math.round(pending.afterHeight)
    };
    updateDiagnostics({ lastLayoutCorrection: detail, lastProgrammaticScroll: correction ? { ...detail, kind: `${pending.kind}-scrollBy` } : getDiagnostics().lastProgrammaticScroll }, "visual-anchor-correction", detail);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (pending.sequence !== visualCorrectionSequenceRef.current) return;
      const verified = findVisualAnchorElement(anchor);
      if (!verified) return;
      const verifiedTop = verified.getBoundingClientRect().top;
      recordDiagnostic("visual-anchor-verified", {
        ...detail,
        verifiedTop: Math.round(verifiedTop * 100) / 100,
        finalDrift: Math.round((verifiedTop - anchor.top) * 100) / 100,
        scrollYVerified: Math.round(window.scrollY)
      });
    }));
  });

  useLayoutEffect(() => {
    restorationRef.current = restoration;
  }, [restoration]);

  useEffect(() => {
    if (!segmentedMode) return;
    if (passiveHandoffTargetRef.current === activeYear) {
      passiveHandoffTargetRef.current = null;
      setPendingAdjacent(null);
      setSpacerSegments((current) => {
        if (!current.has(activeYear)) return current;
        const next = new Map(current);
        next.delete(activeYear);
        return next;
      });
      return;
    }
    requestedSegmentYearsRef.current.clear();
    compensatedPrependedYearsRef.current.clear();
    restoredFromSpacerYearsRef.current.clear();
    scrollDirectionRef.current = null;
    setPendingAdjacent(null);
    setSpacerSegments(new Map());
    setMountedSegmentYears([activeYear]);
    lastPassiveHandoffRef.current = "";
  }, [activeYear, segmentedMode]);

  useEffect(() => {
    if (!segmentedMode || !pendingAdjacent) return;
    const pendingState = states.get(pendingAdjacent.year);
    if (pendingState?.status !== "ready" || !pendingState.collection) return;
    const restoringSpacer = spacerSegments.get(pendingAdjacent.year);
    if (restoringSpacer) {
      queueVisualCorrection({
        anchor: captureVisualAnchor(),
        kind: "restore-year-spacer",
        year: pendingAdjacent.year,
        beforeHeight: restoringSpacer.spacerHeight
      });
      setSpacerSegments((current) => {
        if (!current.has(pendingAdjacent.year)) return current;
        const next = new Map(current);
        next.delete(pendingAdjacent.year);
        return next;
      });
      recordDiagnostic("year-segment-spacer-restore", {
        year: pendingAdjacent.year,
        direction: pendingAdjacent.direction,
        width,
        spacerHeight: Math.round(restoringSpacer.spacerHeight)
      });
    }
    setMountedSegmentYears((current) => {
      if (current.includes(pendingAdjacent.year)) return current;
      if (current.length >= 2) return current;
      return [...current, pendingAdjacent.year];
    });
  }, [captureVisualAnchor, pendingAdjacent, queueVisualCorrection, segmentedMode, spacerSegments, states, width]);

  useLayoutEffect(() => {
    if (!segmentedMode) return;
    for (const year of mountedSegmentYears) updateSegmentChromeHeight(year);
  }, [activeYear, adjacentLayoutByYear, layout.totalHeight, mountedSegmentYears, segmentedMode, updateSegmentChromeHeight, width]);

  useLayoutEffect(() => {
    if (!segmentedMode || !newerMountedYear || pendingAdjacent?.year !== newerMountedYear || pendingAdjacent.direction !== "newer") return;
    if (restoredFromSpacerYearsRef.current.has(newerMountedYear)) {
      restoredFromSpacerYearsRef.current.delete(newerMountedYear);
      return;
    }
    if (compensatedPrependedYearsRef.current.has(newerMountedYear)) return;
    const section = adjacentSegmentRefs.current.get(newerMountedYear);
    if (!section) return;
    const height = section.getBoundingClientRect().height;
    if (height <= 0) return;
    compensatedPrependedYearsRef.current.add(newerMountedYear);
    const detail = { at: new Date().toISOString(), kind: "prepend-adjacent-segment", year: newerMountedYear, top: Math.round(height) };
    updateDiagnostics({ lastProgrammaticScroll: detail }, "programmatic-scroll", detail);
    window.scrollBy({ top: height, behavior: "auto" });
  }, [newerMountedYear, pendingAdjacent, segmentedMode]);

  useEffect(() => {
    if (!segmentedMode || !pendingAdjacent || pendingAdjacent.required) return;
    const currentDirection = scrollDirectionRef.current;
    if (!currentDirection || currentDirection === pendingAdjacent.direction) return;
    onCancelYearRequest(pendingAdjacent.year);
    requestedSegmentYearsRef.current.delete(pendingAdjacent.year);
    setPendingAdjacent(null);
    recordDiagnostic("year-segment-prefetch-cancel", { year: pendingAdjacent.year, direction: pendingAdjacent.direction });
  }, [onCancelYearRequest, pendingAdjacent, segmentedMode, viewport.scrollY]);

  useEffect(() => {
    if (!segmentedMode || mountedSegmentYears.length >= 2) return;
    const registrations: Array<() => void> = [];
    const observe = (node: Element | null, direction: BoundaryDirection) => {
      if (!node || !adjacentTargetForDirection(direction)) return;
      const observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (scrollDirectionRef.current !== direction) return;
        requestAdjacentSegment(direction, false);
      }, { root: null, rootMargin: `${segmentPrefetchDistance}px 0px`, threshold: 0 });
      const unregister = registerArchiveObserver(`year-segment-${direction}-sentinel`);
      observer.observe(node);
      registrations.push(() => {
        observer.disconnect();
        unregister();
      });
    };

    observe(topSentinelRef.current, "newer");
    observe(bottomSentinelRef.current, "older");
    return () => {
      for (const unregister of registrations) unregister();
    };
  }, [adjacentTargetForDirection, mountedSegmentYears.length, requestAdjacentSegment, segmentPrefetchDistance, segmentedMode]);

  useEffect(() => {
    if (!segmentedMode || mountedSegmentYears.length >= 2 || !ref.current) return;
    const currentDirection = scrollDirectionRef.current;
    if (!currentDirection) return;
    const gridTop = ref.current.getBoundingClientRect().top + viewport.scrollY;
    const gridBottom = gridTop + layout.totalHeight;
    const triggerDistance = Math.max(48, Math.min(160, viewport.height * 0.18));
    if (currentDirection === "older" && olderTarget && viewport.scrollY + viewport.height >= gridBottom - triggerDistance) {
      requestAdjacentSegment("older", true);
    }
    if (currentDirection === "newer" && newerTarget && viewport.scrollY <= gridTop + triggerDistance) {
      requestAdjacentSegment("newer", true);
    }
  }, [
    layout.totalHeight,
    mountedSegmentYears.length,
    newerTarget,
    olderTarget,
    requestAdjacentSegment,
    segmentedMode,
    viewport.height,
    viewport.scrollY,
    ref
  ]);

  useEffect(() => {
    if (!segmentedMode || mountedSegmentYears.length < 2) return;
    const anchorY = window.scrollY + RESTORE_OFFSET_PX;
    for (const year of mountedSegmentYears) {
      if (year === activeYear) continue;
      const section = sectionForSegment(year);
      if (!section) continue;
      const sectionTop = section.getBoundingClientRect().top + window.scrollY;
      const sectionBottom = sectionTop + section.getBoundingClientRect().height;
      if (anchorY < sectionTop + SEGMENT_HANDOFF_HYSTERESIS_PX || anchorY > sectionBottom - SEGMENT_HANDOFF_HYSTERESIS_PX) continue;
      const signature = `${activeYear}->${year}`;
      if (lastPassiveHandoffRef.current === signature) return;
      lastPassiveHandoffRef.current = signature;
      passiveHandoffTargetRef.current = year;
      onPassiveHandoff(stableAnchorForSegment(year));
      return;
    }
  }, [activeYear, mountedSegmentYears, onPassiveHandoff, sectionForSegment, segmentedMode, stableAnchorForSegment, viewport.scrollY]);

  useLayoutEffect(() => {
    if (!segmentedMode || mountedSegmentYears.length < 2 || restorationPending) return;
    const direction = scrollDirectionRef.current;
    if (!direction) return;
    const target = adjacentTargetForDirection(direction);
    if (!target) return;
    const liveSegmentInTravelDirection = direction === "older" ? olderMountedYear : newerMountedYear;
    if (liveSegmentInTravelDirection) return;
    const reclaimYear = direction === "older" ? newerMountedYear : olderMountedYear;
    if (!reclaimYear || reclaimYear === activeYear) return;
    if (reclaimYear === protectedPhotoYear) return;
    if (pendingAdjacent?.year === reclaimYear) return;
    const reclaimState = states.get(reclaimYear);
    if (reclaimState?.status === "index-loading" || reclaimState?.status === "loading") return;
    if (restoration.target?.year === reclaimYear && restorationIsPending(restoration)) return;
    const section = sectionForSegment(reclaimYear);
    const grid = gridForSegment(reclaimYear);
    const reclaimLayout = layoutForSegment(reclaimYear);
    if (!section || !grid || !reclaimLayout) return;
    const rect = section.getBoundingClientRect();
    const margin = Math.max(SEGMENT_RECLAIM_SAFETY_MARGIN_PX, viewport.height * 0.75);
    const safelyOutsideViewport = direction === "older"
      ? rect.bottom < -margin
      : rect.top > viewport.height + margin;
    if (!safelyOutsideViewport) return;
    const anchor = captureVisualAnchor(new Set([reclaimYear]));
    if (!anchor || anchor.year === reclaimYear) return;
    const renderedHeight = section.getBoundingClientRect().height;
    const renderedGridHeight = grid.getBoundingClientRect().height;
    if (!Number.isFinite(renderedHeight) || renderedHeight <= 0) return;
    const predictedHeight = segmentOuterHeight(reclaimLayout, renderedGridHeight);
    segmentGenerationRef.current += 1;
    queueVisualCorrection({
      anchor,
      kind: "reclaim-year-segment",
      year: reclaimYear,
      beforeHeight: renderedHeight,
      afterHeight: renderedHeight
    });
    setSpacerSegments((current) => {
      const next = new Map(current);
      next.set(reclaimYear, {
        id: segmentIdentity(reclaimYear, years.join(",")),
        year: reclaimYear,
        spacerHeight: renderedHeight,
        width,
        generation: segmentGenerationRef.current,
        predictedHeight,
        renderedHeight
      });
      return next;
    });
    setMountedSegmentYears((current) => current.filter((year) => year !== reclaimYear));
    recordDiagnostic("year-segment-reclaim", {
      year: reclaimYear,
      direction,
      activeYear,
      anchorYear: anchor.year,
      anchorPhotoId: anchor.photoId,
      anchorAlbumId: anchor.albumId,
      width,
      predictedHeight: Math.round(predictedHeight),
      renderedHeight: Math.round(renderedHeight),
      margin: Math.round(margin),
      rectTop: Math.round(rect.top),
      rectBottom: Math.round(rect.bottom)
    });
  }, [
    activeYear,
    adjacentTargetForDirection,
    captureVisualAnchor,
    gridForSegment,
    layoutForSegment,
    mountedSegmentYears,
    newerMountedYear,
    olderMountedYear,
    pendingAdjacent,
    protectedPhotoYear,
    queueVisualCorrection,
    restoration,
    restorationPending,
    sectionForSegment,
    segmentOuterHeight,
    segmentedMode,
    states,
    viewport.height,
    viewport.scrollY,
    width,
    years
  ]);

  const capturePendingResizeAnchor = useCallback(() => {
    if (!ref.current || restorationIsPending(restorationRef.current)) return;
    if (pendingResizeAnchorRef.current?.year === activeYear) return;
    const visibleTiles = [...ref.current.querySelectorAll<HTMLElement>(".photo-tile")]
      .map((tile) => {
        const rect = tile.getBoundingClientRect();
        return {
          tile,
          distance: Math.abs(rect.top - RESTORE_OFFSET_PX),
          visible: rect.bottom > 0 && rect.top < window.innerHeight
        };
      })
      .filter((candidate) => candidate.visible)
      .sort((left, right) => left.distance - right.distance);
    const anchor = visibleTiles[0]?.tile;
    if (!anchor) return;
    pendingResizeAnchorRef.current = {
      year: activeYear,
      photoId: anchor.dataset.photoId || null,
      albumId: anchor.closest<HTMLElement>("[data-album-id]")?.dataset.albumId || null
    };
  }, [activeYear, ref]);

  useEffect(() => {
    window.addEventListener("resize", capturePendingResizeAnchor);
    return () => window.removeEventListener("resize", capturePendingResizeAnchor);
  }, [capturePendingResizeAnchor]);

  useLayoutEffect(() => {
    const previous = previousLayoutRef.current;
    previousLayoutRef.current = { year: activeYear, layout };
    if (restorationPending || !width || !previous || previous.year !== activeYear || !ref.current || previous.layout.totalHeight === layout.totalHeight) return;
    const oldLocalTop = window.scrollY - (ref.current.getBoundingClientRect().top + window.scrollY) + RESTORE_OFFSET_PX;
    const pendingAnchor = pendingResizeAnchorRef.current?.year === activeYear ? pendingResizeAnchorRef.current : null;
    if (pendingAnchor?.photoId) {
      const nextPhotoTop = layout.photoTops.get(pendingAnchor.photoId);
      if (nextPhotoTop !== undefined) {
        const nextTop = ref.current.getBoundingClientRect().top + window.scrollY + nextPhotoTop - RESTORE_OFFSET_PX;
        const detail = { at: new Date().toISOString(), top: Math.max(0, nextTop), anchorPhotoId: pendingAnchor.photoId, anchorAlbumId: pendingAnchor.albumId, year: activeYear };
        updateDiagnostics({ lastLayoutCorrection: detail, lastProgrammaticScroll: { ...detail, kind: "resize-anchor-restoration" } }, "layout-correction", detail);
        window.scrollTo({ top: Math.max(0, nextTop), behavior: "auto" });
        pendingResizeAnchorRef.current = null;
        return;
      }
    }
    const exactPhoto = pendingAnchor?.photoId && previous.layout.photoTops.has(pendingAnchor.photoId)
      ? pendingAnchor.photoId
      : null;
    const fallbackPhoto = nearestPhotoAnchor([...previous.layout.photoTops].sort((left, right) => left[1] - right[1]), oldLocalTop)?.[0] || null;
    const oldPhoto = exactPhoto || fallbackPhoto;
    const exactAlbum = pendingAnchor?.albumId
      ? previous.layout.albumAnchors.find((album) => album.id === pendingAnchor.albumId) || null
      : null;
    const oldAlbum = exactAlbum || findStableAlbumAtTop(previous.layout, oldLocalTop);
    let previousTop: number | undefined;
    let nextTop: number | undefined;
    if (oldPhoto) {
      previousTop = previous.layout.photoTops.get(oldPhoto);
      nextTop = layout.photoTops.get(oldPhoto);
    }
    if (previousTop === undefined || nextTop === undefined) {
      previousTop = oldAlbum?.top;
      nextTop = oldAlbum
        ? layout.albumAnchors.find((album) => album.id === oldAlbum.id)?.top
        : undefined;
    }
    const correction = stableYearLocalCorrection(previousTop, nextTop);
    if (Math.abs(correction) > 0.5) {
      const detail = { at: new Date().toISOString(), top: correction, anchorPhotoId: oldPhoto, anchorAlbumId: oldAlbum?.id || null, year: activeYear };
      updateDiagnostics({ lastLayoutCorrection: detail, lastProgrammaticScroll: { ...detail, kind: "scrollBy" } }, "layout-correction", detail);
      window.scrollBy({ top: correction, behavior: "auto" });
    }
    pendingResizeAnchorRef.current = null;
  }, [activeYear, layout, restorationPending, width]);

  useLayoutEffect(() => {
    if (!segmentedMode || !width || !spacerSegments.size) return;
    let changed = false;
    let maxDelta = 0;
    const next = new Map(spacerSegments);
    for (const spacer of spacerSegments.values()) {
      if (spacer.width === width) continue;
      const spacerState = states.get(spacer.year);
      if (spacerState?.status !== "ready" || !spacerState.collection) continue;
      const nextLayout = buildYearSegmentLayout({
        collection: spacerState.collection,
        width,
        targetRowHeight: targetHeight,
        gap,
        compactViewport
      });
      const predictedHeight = segmentOuterHeight(nextLayout);
      const delta = predictedHeight - spacer.spacerHeight;
      if (Math.abs(delta) <= 0.5) {
        next.set(spacer.year, { ...spacer, width, predictedHeight, renderedHeight: predictedHeight });
        continue;
      }
      changed = true;
      maxDelta = Math.max(maxDelta, Math.abs(delta));
      next.set(spacer.year, {
        ...spacer,
        spacerHeight: predictedHeight,
        width,
        generation: spacer.generation + 1,
        predictedHeight,
        renderedHeight: predictedHeight
      });
      recordDiagnostic("year-segment-spacer-resize", {
        year: spacer.year,
        previousWidth: spacer.width,
        width,
        previousHeight: Math.round(spacer.spacerHeight),
        predictedHeight: Math.round(predictedHeight),
        delta: Math.round(delta)
      });
    }
    if (!changed) {
      if ([...next.values()].some((spacer) => spacer.width === width && spacerSegments.get(spacer.year)?.width !== width)) {
        setSpacerSegments(next);
      }
      return;
    }
    segmentGenerationRef.current += 1;
    queueVisualCorrection({
      anchor: captureVisualAnchor(),
      kind: "resize-year-spacers",
      year: activeYear,
      beforeHeight: maxDelta,
      afterHeight: 0
    });
    setSpacerSegments(next);
  }, [
    activeYear,
    captureVisualAnchor,
    compactViewport,
    gap,
    queueVisualCorrection,
    segmentOuterHeight,
    segmentedMode,
    spacerSegments,
    states,
    targetHeight,
    width
  ]);

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
    const totalSegmentEntries = layout.entries.length + (segmentedMode ? [...adjacentLayoutByYear.values()].reduce((sum, segmentLayout) => sum + segmentLayout.entries.length, 0) : 0);
    const virtualRange = {
      mode: segmentedMode ? "segmented-year-window" : "year-windowed",
      year: activeYear,
      spacerYears: segmentedMode ? orderedSegmentYears(spacerSegments.keys()) : [],
      first: first ? { id: first.id, type: first.type, top: Math.round(first.top) } : null,
      last: last ? { id: last.id, type: last.type, bottom: Math.round(last.top + last.height) } : null,
      renderedEntries: visibleEntries.length,
      totalEntries: totalSegmentEntries,
      totalHeight: Math.round(layout.totalHeight)
    };
    const diagnosticRoot = segmentedMode
      ? activeSegmentRef.current?.closest<HTMLElement>(".collection-shell") || null
      : ref.current;
    const entries = [...(diagnosticRoot?.querySelectorAll<HTMLElement>("[data-entry-type='row']") || [])];
    const rowMountedYears = [...new Set(entries.map((entry) => entry.dataset.year).filter((year): year is string => Boolean(year)))];
    const mountedYears = segmentedMode ? mountedOrPreviewYears : rowMountedYears;
    const rows = entries.length;
    const photos = diagnosticRoot?.querySelectorAll(".photo-tile").length || 0;
    const images = [...(diagnosticRoot?.querySelectorAll<HTMLImageElement>(".photo-tile img") || [])];
    const loadedImages = images.filter((image) => image.complete && image.naturalWidth > 0).length;
    const inactiveImageElements = segmentedMode
      ? images.filter((image) => {
        const year = image.closest<HTMLElement>("[data-year]")?.dataset.year;
        return !year || !mountedOrPreviewYears.includes(year);
      }).length
      : images.filter((image) => image.closest<HTMLElement>("[data-year]")?.dataset.year !== activeYear).length;
    const stableAnchor = nearestPhotoAnchor(photoAnchors, localViewportTop + RESTORE_OFFSET_PX);
    const counts = { mountedYears, mountedRows: rows, mountedPhotos: photos, inactiveImageElements, observerCount: getDiagnostics().observerCount };
    const warnings = segmentedMode
      ? [
        ...(mountedYears.length > 2 ? ["segment-count-bound-exceeded"] : []),
        ...(rows > SEGMENT_ROW_BUDGET ? ["segmented-row-bound-exceeded"] : []),
        ...(photos > SEGMENT_PHOTO_BUDGET ? ["segmented-photo-bound-exceeded"] : []),
        ...(inactiveImageElements > 0 ? ["unmounted-segment-images"] : [])
      ]
      : archiveWindowWarnings(counts);
    updateDiagnostics({
      activeYear,
      activeAlbum: currentAlbum ? { year: activeYear, id: currentAlbum.id } : null,
      mountedYears,
      mountedRows: rows,
      mountedPhotos: photos,
      loadedImages,
      inactiveImageElements,
      retainedYearLayouts: segmentedMode
        ? mountedOrPreviewYears.filter((year) => Boolean(layoutForSegment(year)) || pendingLeadInPreview?.year === year)
        : collection ? [activeYear] : [],
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
  }, [activeRatio, activeYear, adjacentLayoutByYear, collection, currentAlbum, isScrubbing, layout.entries.length, layout.totalHeight, layoutForSegment, localViewportTop, mountedOrPreviewYears, orderedSegmentYears, pendingLeadInPreview, photoAnchors, segmentedMode, spacerSegments, visibleEntries, width]);

  const renderLayoutEntries = (
    year: string,
    segmentCollection: NonNullable<typeof collection>,
    entries: GridLayout["entries"],
    interactive = true
  ) => {
    const segmentIndexById = year === activeYear
      ? indexById
      : new Map(segmentCollection.photos.map((photo, index) => [photo.id, index]));
    return entries.map((entry) => {
      if (entry.type === "heading") {
        return (
          <div className="album-group__heading virtual-entry" data-entry-type={entry.type} data-entry-id={entry.id} data-year={year} data-album-id={entry.album.id} key={`${year}-${entry.id}`} style={{ top: entry.top, height: entry.height }}>
            <h2><span className="album-heading__folder">{albumFolderLabel(entry.album)}</span></h2>
          </div>
        );
      }
      if (entry.type === "album-error") {
        const loading = entry.album.loadState === "loading";
        return (
          <div className={`album-error album-error--${entry.album.loadState} virtual-entry`} data-entry-type={entry.type} data-entry-id={entry.id} data-year={year} data-album-id={entry.album.id} key={`${year}-${entry.id}`} style={{ top: entry.top, height: entry.height }} role={loading ? "status" : "alert"}>
            <span>{loading ? "Loading album" : entry.album.errorMessage || "Album could not be loaded"}</span>
            {!loading ? <button type="button" onClick={() => onRetryAlbum(year, entry.album.id)}>Retry</button> : null}
          </div>
        );
      }
      return (
        <div className={`photo-row photo-row--${entry.tone} virtual-entry`} data-entry-type={entry.type} data-entry-id={entry.id} data-row-id={entry.id} data-row-tone={entry.tone} data-year={year} data-album-id={entry.albumId} key={`${year}-${entry.id}`} style={{ top: entry.top, height: entry.height, gap: entry.gap }}>
          {entry.items.map((item) => (
            <button
              className={`photo-tile photo-tile--${item.photo.orientation}${interactive ? "" : " photo-tile--preview"}`}
              key={item.photo.id}
              type="button"
              data-photo-id={item.photo.id}
              style={{ width: item.width, height: item.height }}
              onClick={interactive ? () => onOpenPhoto(year, item.photo.id) : undefined}
              aria-disabled={interactive ? undefined : true}
              tabIndex={interactive ? undefined : -1}
              aria-label={`Open photo ${(segmentIndexById.get(item.photo.id) || 0) + 1}`}
            >
              <img src={mediaUrl(item.photo.thumbnailKey)} alt="" loading="eager" decoding="async" width={item.photo.width} height={item.photo.height} />
            </button>
          ))}
        </div>
      );
    });
  };

  const renderAdjacentBoundaryState = (direction: BoundaryDirection) => {
    if (!segmentedMode || !pendingAdjacent || pendingAdjacent.direction !== direction) return null;
    if (mountedSegmentYears.includes(pendingAdjacent.year)) return null;
    const pendingState = states.get(pendingAdjacent.year);
    const failed = pendingState?.status === "error";
    if (!failed) return null;
    return (
      <section className={`year-segment-boundary-state year-segment-boundary-state--${failed ? "error" : "loading"}`} role={failed ? "alert" : "status"} aria-live="polite">
        <strong>{pendingAdjacent.year}</strong>
        <span>{failed ? pendingState?.message || "Year could not be loaded" : "Preparing adjacent year"}</span>
        {failed ? <button type="button" onClick={() => onRetryYear(pendingAdjacent.year)}>Retry year</button> : null}
      </section>
    );
  };

  const renderLeadInPreview = (direction: BoundaryDirection) => {
    if (!pendingLeadInPreview || pendingLeadInPreview.direction !== direction) return null;
    return (
      <section
        className={`year-segment-leadin year-segment-leadin--${direction}`}
        data-segment-year={pendingLeadInPreview.year}
        data-year={pendingLeadInPreview.year}
        data-segment-status="lead-in"
        data-lead-in-rows={pendingLeadInPreview.rowCount}
        aria-label={`${pendingLeadInPreview.year} preview`}
      >
        <section className="archive-year-heading archive-year-heading--inline" data-year={pendingLeadInPreview.year} aria-labelledby={`year-${pendingLeadInPreview.year}-lead-in-title`}>
          <h1 id={`year-${pendingLeadInPreview.year}-lead-in-title`}>{pendingLeadInPreview.year}</h1>
        </section>
        <div
          className="virtual-album-stack"
          data-segment-grid={`${pendingLeadInPreview.year}-lead-in`}
          style={{ height: pendingLeadInPreview.height || undefined }}
        >
          {renderLayoutEntries(pendingLeadInPreview.year, pendingLeadInPreview.collection, pendingLeadInPreview.entries, false)}
        </div>
      </section>
    );
  };

  const renderAdjacentSegment = (year: string | null) => {
    if (!segmentedMode || !year) return null;
    const segmentCollection = collectionForSegment(year);
    const segmentLayout = layoutForSegment(year);
    const segmentState = states.get(year);
    if (!segmentCollection || !segmentLayout || segmentState?.status !== "ready") {
      return null;
    }
    const visibleSegmentEntries = visibleEntriesForGrid(segmentLayout, gridForSegment(year));
    return (
      <section
        key={`segment-${year}`}
        className="year-segment year-segment--adjacent"
        data-segment-year={year}
        data-year={year}
        data-segment-status="mounted"
        ref={(node) => setAdjacentSegmentRef(year, node)}
      >
        <section className="archive-year-heading archive-year-heading--inline" data-year={year} aria-labelledby={`year-${year}-segment-title`}>
          <h1 id={`year-${year}-segment-title`}>{year}</h1>
        </section>
        <div
          className="virtual-album-stack"
          data-segment-grid={year}
          ref={(node) => setAdjacentGridRef(year, node)}
          style={{ height: segmentLayout.totalHeight || undefined }}
        >
          {renderLayoutEntries(year, segmentCollection, visibleSegmentEntries)}
        </div>
      </section>
    );
  };

  const renderSpacerSegment = (year: string) => {
    const spacer = spacerSegments.get(year);
    if (!segmentedMode || !spacer) return null;
    return (
      <YearSegmentSpacer
        key={`spacer-${year}`}
        segment={spacer}
        onRef={(node) => setSpacerRef(year, node)}
      />
    );
  };

  const renderSegmentSlot = (year: string) => (
    mountedSegmentYears.includes(year)
      ? renderAdjacentSegment(year)
      : renderSpacerSegment(year)
  );

  const segmentSlotYears = orderedSegmentYears([
    ...mountedSegmentYears.filter((year) => year !== activeYear),
    ...spacerSegments.keys()
  ]);
  const upperSegmentSlotYears = segmentSlotYears.filter((year) => years.indexOf(year) < activeYearIndex);
  const lowerSegmentSlotYears = segmentSlotYears.filter((year) => years.indexOf(year) > activeYearIndex);
  const spacerYears = orderedSegmentYears(spacerSegments.keys());

  const commitBoundary = (target: ArchiveTarget | null) => {
    if (target) onNavigate(target, "boundary");
  };

  return (
    <main
      className="collection-shell"
      data-active-year={activeYear}
      data-mounted-years={segmentedMode ? mountedOrPreviewYears.join(",") : collection ? activeYear : ""}
      data-spacer-years={segmentedMode ? spacerYears.join(",") : ""}
      data-restoration-phase={restoration.phase}
      data-render-mode={segmentedMode ? "segmented-year-window" : "year-windowed"}
    >
      <header className="collection-chrome" ref={chromeRef}>
        <div className="app-bar">
          <div className="app-bar__identity">
            <span className="app-bar__brand">640×480</span>
          </div>
        </div>
        {statusMessage ? (
          <div className={`collection-status collection-status--${state?.status === "error" || failedCount ? "error" : "loading"}`} role={state?.status === "error" || failedCount ? "alert" : "status"}>
            <span>{statusMessage}{targetAlbum ? ` · ${formatPublicArchiveAlbumLabel(targetAlbum.name, activeYear)}` : ""}</span>
            {state?.status === "error" ? <button type="button" onClick={() => onRetryYear(activeYear)}>Retry</button> : null}
          </div>
        ) : (
          <div className={`album-context ${!currentAlbum || albumHeadingIsVisible ? "album-context--hidden" : ""}`} aria-live="polite" aria-hidden={!currentAlbum || albumHeadingIsVisible}>
            <span className="album-context__folder">{currentAlbum?.folderLabel || ""}</span>
          </div>
        )}
      </header>

      {upperSegmentSlotYears.map((year) => renderSegmentSlot(year))}

      {segmentedMode && !newerMountedYear ? (
        <div className="year-boundary-sentinel year-boundary-sentinel--newer" data-boundary-direction="newer" ref={topSentinelRef} aria-hidden="true" />
      ) : null}

      {renderLeadInPreview("newer")}

      {renderAdjacentBoundaryState("newer")}

      {newerTarget ? (
        <nav className="archive-year-boundary archive-year-boundary--newer" aria-label={`Beginning of ${activeYear}`}>
          <button type="button" onClick={() => commitBoundary(newerTarget)}>
            <span aria-hidden="true">↑</span> Newer photos: {newerTarget.year}
          </button>
        </nav>
      ) : null}

      <section className="year-segment year-segment--active" data-segment-year={activeYear} data-year={activeYear} data-segment-status="mounted" ref={activeSegmentRef}>
        <section className="archive-year-heading archive-year-heading--inline" data-year={activeYear} aria-labelledby={`year-${activeYear}-title`} ref={yearHeadingRef}>
          <h1 id={`year-${activeYear}-title`}>{activeYear}</h1>
        </section>

        {!collection ? (
          <section className={`year-window-loading year-window-loading--${state?.status || "index-loading"}`} aria-live="polite">
            <strong>{activeYear}</strong>
            <span>{targetAlbum ? formatPublicArchiveAlbumLabel(targetAlbum.name, activeYear) : "Preparing this year"}</span>
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
          {collection ? renderLayoutEntries(activeYear, collection, visibleEntries) : null}
        </div>
      </section>

      {olderTarget ? (
        <nav className="archive-year-boundary archive-year-boundary--older" aria-label={`End of ${activeYear}`}>
          <button type="button" onClick={() => commitBoundary(olderTarget)}>
            Older photos: {olderTarget.year} <span aria-hidden="true">↓</span>
          </button>
        </nav>
      ) : null}

      {renderLeadInPreview("older")}

      {renderAdjacentBoundaryState("older")}

      {segmentedMode && !olderMountedYear ? (
        <div className="year-boundary-sentinel year-boundary-sentinel--older" data-boundary-direction="older" ref={bottomSentinelRef} aria-hidden="true" />
      ) : null}

      {lowerSegmentSlotYears.map((year) => renderSegmentSlot(year))}

      <ArchiveScrubber
        model={timelineModel}
        activeYear={activeYear}
        activeAlbumId={currentAlbum?.id || null}
        activeRatio={activeRatio}
        formatAlbumName={formatPublicArchiveAlbumLabel}
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
