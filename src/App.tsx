import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Music, Pause, Play, X } from "lucide-react";
import { assetUrl, mediaUrl } from "./lib/assets";
import { buildJustifiedRows, type JustifiedItem } from "./lib/justifiedRows";
import { useElementWidth } from "./hooks/useElementWidth";
import type { AlbumManifest, AlbumSummary, Catalog, CatalogYear, Photo, PhotoCollection, YearIndex } from "./types";

const CATALOG_URL = assetUrl("data/catalog.json");
const SPEED_OPTIONS = [
  { label: "0.1", value: 100 },
  { label: "0.25", value: 250 },
  { label: "0.5", value: 500 },
  { label: "1", value: 1000 },
  { label: "2", value: 2000 }
];
const PRELOAD_AHEAD = 30;
const PRELOAD_BEHIND = 8;
const GRID_OVERSCAN_PX = 1100;
const ALBUM_GAP_PX = 30;
const ALBUM_HEADING_HEIGHT_PX = 24;
const ALBUM_HEADING_GAP_PX = 9;
const MANUAL_RESUME_DELAY_MS = 5000;
const IMAGE_MODE_STORAGE_KEY = "640x480-player-image-mode";
const SELECTED_YEAR_STORAGE_KEY = "640x480-selected-year";
const YEAR_SCROLL_STORAGE_PREFIX = "640x480-scroll";
const SOUNDCLOUD_WIDGET_API_URL = "https://w.soundcloud.com/player/api.js";
const SOUNDCLOUD_EMBED_URL =
  "https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Fplaylists%2F2293150329&auto_play=true&hide_related=true&show_comments=false&show_user=false&show_reposts=false&show_teaser=false&visual=false&show_artwork=false";

type PauseReason = "explicit" | "temporary" | "ended" | null;
type ImageMode = "fit" | "expanded";

interface SoundCloudWidget {
  bind(eventName: string, listener: () => void): void;
  pause(): void;
  play(): void;
}

interface SoundCloudWidgetFactory {
  (iframe: HTMLIFrameElement): SoundCloudWidget;
  Events: {
    FINISH: string;
    PAUSE: string;
    PLAY: string;
    READY: string;
  };
}

declare global {
  interface Window {
    SC?: {
      Widget: SoundCloudWidgetFactory;
    };
  }
}

interface CacheEntry {
  image: HTMLImageElement;
  ready: boolean;
  failed: boolean;
}

interface LayoutHeading {
  type: "heading";
  id: string;
  top: number;
  height: number;
  album: AlbumSummary;
}

interface LayoutRow {
  type: "row";
  id: string;
  top: number;
  height: number;
  gap: number;
  albumId: string;
  items: JustifiedItem[];
}

type LayoutEntry = LayoutHeading | LayoutRow;

interface GridLayout {
  entries: LayoutEntry[];
  totalHeight: number;
  photoTops: Map<string, number>;
}

type CatalogLoadState =
  | { status: "loading"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: Catalog };

type CollectionLoadState =
  | { status: "loading"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; collection: PhotoCollection };

let soundCloudApiPromise: Promise<void> | null = null;

function sortPhotos(photos: Photo[]) {
  return [...photos].sort((left, right) => left.sortPosition - right.sortPosition);
}

function initialImageMode(): ImageMode {
  if (typeof window === "undefined") {
    return "fit";
  }

  try {
    const stored = window.sessionStorage.getItem(IMAGE_MODE_STORAGE_KEY);
    return stored === "expanded" || stored === "full-width" ? "expanded" : "fit";
  } catch {
    return "fit";
  }
}

function sortCatalogYears(years: CatalogYear[]) {
  return [...years].sort((left, right) => Number(right.year) - Number(left.year));
}

function yearExists(catalog: Catalog, year: string | null) {
  return Boolean(year && catalog.years.some((candidate) => candidate.year === year));
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

function updateUrlYear(year: string, mode: "push" | "replace") {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("year", year);
  const nextPath = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  if (nextPath === `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    return;
  }

  if (mode === "replace") {
    window.history.replaceState({ year }, "", nextPath);
  } else {
    window.history.pushState({ year }, "", nextPath);
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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function loadSoundCloudApi() {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  if (window.SC?.Widget) {
    return Promise.resolve();
  }

  if (soundCloudApiPromise) {
    return soundCloudApiPromise;
  }

  soundCloudApiPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>('script[data-soundcloud-widget-api="true"]');
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("SoundCloud widget API failed to load")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.src = SOUNDCLOUD_WIDGET_API_URL;
    script.dataset.soundcloudWidgetApi = "true";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("SoundCloud widget API failed to load")), { once: true });
    document.head.appendChild(script);
  });

  return soundCloudApiPromise;
}

function useCatalog(): CatalogLoadState {
  const [state, setState] = useState<CatalogLoadState>({ status: "loading", message: "Loading catalogue" });

  useEffect(() => {
    let isMounted = true;

    async function loadCatalog() {
      const catalog = await fetchJson<Catalog>(CATALOG_URL);
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

function usePhotoCollection(year: CatalogYear | null): CollectionLoadState {
  const [state, setState] = useState<CollectionLoadState>({ status: "loading", message: "Loading year" });

  useEffect(() => {
    let isMounted = true;

    async function loadCollection() {
      if (!year) {
        setState({ status: "loading", message: "Loading year" });
        return;
      }

      setState({ status: "loading", message: `Loading ${year.year} index` });
      const index = await fetchJson<YearIndex>(assetUrl(year.indexUrl));

      if (isMounted) {
        setState({ status: "loading", message: `Loading ${year.year} albums` });
      }

      const albums = await Promise.all(index.albums.map((album) => fetchJson<AlbumManifest>(assetUrl(album.manifestUrl))));
      const photosById = new Map<string, Photo>();
      for (const album of albums) {
        for (const photo of album.photos) {
          photosById.set(photo.id, photo);
        }
      }

      const photos = index.sequence
        .map((entry) => photosById.get(entry.id))
        .filter((photo): photo is Photo => Boolean(photo));

      if (isMounted) {
        setState({
          status: "ready",
          collection: {
            year: index.year,
            index,
            albums,
            photos
          }
        });
      }
    }

    loadCollection().catch((error: unknown) => {
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
  }, [year]);

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

function buildGridLayout(collection: PhotoCollection, width: number, targetRowHeight: number, gap: number): GridLayout {
  if (!width) {
    return {
      entries: [],
      totalHeight: 0,
      photoTops: new Map()
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
  let top = 0;

  collection.index.albums.forEach((album, albumIndex) => {
    const photos = photosByAlbum.get(album.id) || [];
    if (!photos.length) {
      return;
    }

    if (albumIndex > 0) {
      top += ALBUM_GAP_PX;
    }

    entries.push({
      type: "heading",
      id: `heading-${album.id}`,
      top,
      height: ALBUM_HEADING_HEIGHT_PX,
      album
    });
    top += ALBUM_HEADING_HEIGHT_PX + ALBUM_HEADING_GAP_PX;

    const rows = buildJustifiedRows(photos, width, targetRowHeight, gap);
    rows.forEach((row) => {
      entries.push({
        type: "row",
        id: `${album.id}-${row.id}`,
        top,
        height: row.height,
        gap,
        albumId: album.id,
        items: row.items
      });

      row.items.forEach((item) => {
        photoTops.set(item.photo.id, top);
      });
      top += row.height + gap;
    });

    top -= gap;
  });

  return {
    entries,
    totalHeight: Math.max(0, top),
    photoTops
  };
}

function App() {
  const catalogState = useCatalog();
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const [activePhotoIndex, setActivePhotoIndex] = useState<number | null>(null);
  const [restorePhotoId, setRestorePhotoId] = useState<string | null>(null);
  const selectedYearRef = useRef<string | null>(null);

  const catalog = catalogState.status === "ready" ? catalogState.catalog : null;
  const selectedYearMeta = catalog?.years.find((year) => year.year === selectedYear) || null;
  const loadState = usePhotoCollection(selectedYearMeta);

  useEffect(() => {
    selectedYearRef.current = selectedYear;
  }, [selectedYear]);

  const saveCurrentScrollPosition = useCallback(() => {
    if (selectedYearRef.current) {
      writeStoredScrollPosition(selectedYearRef.current, window.scrollY);
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
    updateUrlYear(nextYear, "replace");
  }, [catalog, selectedYear]);

  useEffect(() => {
    if (!catalog) {
      return;
    }

    const handlePopState = () => {
      const nextYear = readUrlYear(catalog) || readStoredYear(catalog) || newestCatalogYear(catalog);
      if (!nextYear || nextYear === selectedYearRef.current) {
        return;
      }

      saveCurrentScrollPosition();
      setActivePhotoIndex(null);
      setRestorePhotoId(null);
      setSelectedYear(nextYear);
      writeStoredYear(nextYear);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [catalog, saveCurrentScrollPosition]);

  useEffect(() => {
    const handlePageHide = () => saveCurrentScrollPosition();
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [saveCurrentScrollPosition]);

  const selectYear = useCallback(
    (year: string) => {
      if (!catalog || year === selectedYearRef.current || !yearExists(catalog, year)) {
        return;
      }

      saveCurrentScrollPosition();
      setActivePhotoIndex(null);
      setRestorePhotoId(null);
      setSelectedYear(year);
      writeStoredYear(year);
      updateUrlYear(year, "push");
    },
    [catalog, saveCurrentScrollPosition]
  );

  const openPhoto = useCallback(
    (index: number) => {
      if (loadState.status !== "ready") {
        return;
      }

      setRestorePhotoId(loadState.collection.photos[index]?.id || null);
      setActivePhotoIndex(index);
    },
    [loadState]
  );

  const closePlayer = useCallback((photoId: string) => {
    setActivePhotoIndex(null);
    setRestorePhotoId(photoId);
  }, []);

  if (catalogState.status === "loading") {
    return <SystemState title="640x480" message={catalogState.message} />;
  }

  if (catalogState.status === "error") {
    return <SystemState title="640x480" message={catalogState.message} />;
  }

  if (!selectedYear || !selectedYearMeta) {
    return <SystemState title="640x480" message="Selecting year" />;
  }

  if (loadState.status === "loading") {
    return <SystemState title={selectedYear} message={loadState.message} />;
  }

  if (loadState.status === "error") {
    return <SystemState title={selectedYear} message={loadState.message} />;
  }

  const { collection } = loadState;
  if (!collection.photos.length) {
    return <SystemState title={selectedYear} message="No imported photos" />;
  }

  return (
    <>
      <CollectionGrid
        catalog={catalogState.catalog}
        collection={collection}
        selectedYear={selectedYear}
        restorePhotoId={restorePhotoId}
        onRestoreComplete={() => setRestorePhotoId(null)}
        onOpenPhoto={openPhoto}
        onSelectYear={selectYear}
      />
      {activePhotoIndex !== null ? (
        <PhotoPlayer key={collection.year} photos={collection.photos} initialIndex={activePhotoIndex} onClose={closePlayer} />
      ) : null}
    </>
  );
}

function SystemState({ title, message }: { title: string; message: string }) {
  return (
    <main className="system-state">
      <h1>{title}</h1>
      <p>{message}</p>
    </main>
  );
}

function CollectionGrid({
  catalog,
  collection,
  selectedYear,
  restorePhotoId,
  onRestoreComplete,
  onOpenPhoto,
  onSelectYear
}: {
  catalog: Catalog;
  collection: PhotoCollection;
  selectedYear: string;
  restorePhotoId: string | null;
  onRestoreComplete: () => void;
  onOpenPhoto: (index: number) => void;
  onSelectYear: (year: string) => void;
}) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const viewport = useViewport();
  const restoredScrollYearRef = useRef<string | null>(null);
  const targetHeight = width < 520 ? 118 : width < 900 ? 146 : 174;
  const gap = width < 520 ? 3 : 4;
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    collection.photos.forEach((photo, index) => map.set(photo.id, index));
    return map;
  }, [collection.photos]);
  const layout = useMemo(() => buildGridLayout(collection, width, targetHeight, gap), [collection, gap, targetHeight, width]);

  const containerTop = ref.current ? ref.current.getBoundingClientRect().top + viewport.scrollY : 0;
  const visibleTop = viewport.scrollY - containerTop - GRID_OVERSCAN_PX;
  const visibleBottom = viewport.scrollY + viewport.height - containerTop + GRID_OVERSCAN_PX;
  const visibleEntries = layout.entries.filter((entry) => entry.top + entry.height >= visibleTop && entry.top <= visibleBottom);

  useEffect(() => {
    if (!ref.current || !width || restorePhotoId || restoredScrollYearRef.current === collection.year) {
      return;
    }

    restoredScrollYearRef.current = collection.year;
    const nextTop = readStoredScrollPosition(collection.year);
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: Math.max(0, Math.min(nextTop, layout.totalHeight)), behavior: "auto" });
    });
  }, [collection.year, layout.totalHeight, restorePhotoId, width]);

  useEffect(() => {
    if (!restorePhotoId || !ref.current || !layout.photoTops.has(restorePhotoId)) {
      return;
    }

    const nextTop = ref.current.getBoundingClientRect().top + window.scrollY + (layout.photoTops.get(restorePhotoId) || 0) - 112;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: Math.max(0, nextTop), behavior: "auto" });
      restoredScrollYearRef.current = collection.year;
      onRestoreComplete();
    });
  }, [collection.year, layout, onRestoreComplete, restorePhotoId, width]);

  return (
    <main className="collection-shell">
      <header className="collection-header">
        <div>
          <h1>{collection.year}</h1>
          <p>
            {collection.photos.length} photographs from {collection.index.albums.length} folders
          </p>
        </div>
        <div className="collection-header__controls">
          <div className="year-selector" aria-label="Select year">
            {catalog.years.map((year) => (
              <button
                key={year.year}
                className={year.year === selectedYear ? "is-selected" : ""}
                type="button"
                onClick={() => onSelectYear(year.year)}
                aria-pressed={year.year === selectedYear}
              >
                {year.year}
              </button>
            ))}
          </div>
          <span className="collection-header__meta">{collection.index.scannedCount} scanned</span>
        </div>
      </header>

      <div className="virtual-album-stack" ref={ref} style={{ height: layout.totalHeight || undefined }}>
        {visibleEntries.map((entry) => {
          if (entry.type === "heading") {
            return (
              <div className="album-group__heading virtual-entry" key={entry.id} style={{ top: entry.top, height: entry.height }}>
                <h2>{entry.album.name}</h2>
                <span>{entry.album.count}</span>
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
                  style={{ width: item.width, height: item.height }}
                  onClick={() => {
                    const index = indexById.get(item.photo.id);
                    if (typeof index === "number") {
                      onOpenPhoto(index);
                    }
                  }}
                  aria-label="Open photo"
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
    </main>
  );
}

function PhotoPlayer({ photos, initialIndex, onClose }: { photos: Photo[]; initialIndex: number; onClose: (photoId: string) => void }) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [isPlaying, setIsPlaying] = useState(true);
  const [delayMs, setDelayMs] = useState(100);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isBuffering, setIsBuffering] = useState(false);
  const [temporaryResumePending, setTemporaryResumePendingState] = useState(false);
  const [imageMode, setImageMode] = useState<ImageMode>(initialImageMode);
  const [hasMusicLoaded, setHasMusicLoaded] = useState(false);
  const [shouldPlayMusic, setShouldPlayMusic] = useState(false);
  const [isMusicWidgetReady, setIsMusicWidgetReady] = useState(false);
  const [isMusicPlaying, setIsMusicPlaying] = useState(false);
  const cacheRef = useRef(new Map<number, CacheEntry>());
  const musicIframeRef = useRef<HTMLIFrameElement | null>(null);
  const soundCloudWidgetRef = useRef<SoundCloudWidget | null>(null);
  const currentIndexRef = useRef(currentIndex);
  const delayRef = useRef(delayMs);
  const playingRef = useRef(isPlaying);
  const controlsTimerRef = useRef<number | null>(null);
  const resumeTimerRef = useRef<number | null>(null);
  const temporaryResumePendingRef = useRef(false);
  const pauseReasonRef = useRef<PauseReason>(null);
  const ignoreSyntheticClickUntilRef = useRef(0);
  const touchStartRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const surfaceRef = useRef<HTMLButtonElement | null>(null);

  const currentPhoto = photos[currentIndex];
  const atStart = currentIndex <= 0;
  const atEnd = currentIndex >= photos.length - 1;

  const setTemporaryResumePending = useCallback((pending: boolean) => {
    temporaryResumePendingRef.current = pending;
    setTemporaryResumePendingState(pending);
  }, []);

  const cancelPendingResume = useCallback(() => {
    if (resumeTimerRef.current !== null) {
      window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }

    setTemporaryResumePending(false);
  }, [setTemporaryResumePending]);

  const close = useCallback(() => {
    cancelPendingResume();
    onClose(photos[currentIndexRef.current]?.id || photos[initialIndex]?.id || "");
  }, [cancelPendingResume, initialIndex, onClose, photos]);

  const preloadPhoto = useCallback(
    (index: number) => {
      if (index < 0 || index >= photos.length) {
        return null;
      }

      const existing = cacheRef.current.get(index);
      if (existing) {
        return existing;
      }

      const image = new Image();
      const entry: CacheEntry = {
        image,
        ready: false,
        failed: false
      };

      image.decoding = "async";
      image.onload = () => {
        entry.ready = true;
      };
      image.onerror = () => {
        entry.failed = true;
      };
      image.src = mediaUrl(photos[index].displayKey);

      if (typeof image.decode === "function") {
        image.decode().then(
          () => {
            entry.ready = true;
          },
          () => {
            entry.failed = !image.complete || image.naturalWidth === 0;
          }
        );
      }

      cacheRef.current.set(index, entry);
      return entry;
    },
    [photos]
  );

  const warmBuffer = useCallback(
    (index: number) => {
      for (let offset = 0; offset <= PRELOAD_AHEAD; offset += 1) {
        preloadPhoto(index + offset);
      }

      for (const cachedIndex of Array.from(cacheRef.current.keys())) {
        if (cachedIndex < index - PRELOAD_BEHIND || cachedIndex > index + PRELOAD_AHEAD + 12) {
          cacheRef.current.delete(cachedIndex);
        }
      }
    },
    [preloadPhoto]
  );

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimerRef.current !== null) {
      window.clearTimeout(controlsTimerRef.current);
    }

    controlsTimerRef.current = window.setTimeout(() => setControlsVisible(false), 1800);
  }, []);

  const goToIndex = useCallback(
    (index: number) => {
      const boundedIndex = Math.max(0, Math.min(index, photos.length - 1));
      currentIndexRef.current = boundedIndex;
      setCurrentIndex(boundedIndex);
      setIsBuffering(false);
      warmBuffer(boundedIndex);
    },
    [photos.length, warmBuffer]
  );

  const pauseExplicitly = useCallback(() => {
    cancelPendingResume();
    pauseReasonRef.current = "explicit";
    playingRef.current = false;
    setIsPlaying(false);
    setIsBuffering(false);
  }, [cancelPendingResume]);

  const playExplicitly = useCallback(() => {
    cancelPendingResume();
    if (currentIndexRef.current >= photos.length - 1) {
      pauseReasonRef.current = "ended";
      playingRef.current = false;
      setIsPlaying(false);
      return;
    }

    pauseReasonRef.current = null;
    warmBuffer(currentIndexRef.current);
    playingRef.current = true;
    setIsPlaying(true);
    setIsBuffering(false);
  }, [cancelPendingResume, photos.length, warmBuffer]);

  const scheduleTemporaryResume = useCallback(
    (selectedIndex: number) => {
      cancelPendingResume();

      if (selectedIndex >= photos.length - 1) {
        pauseReasonRef.current = "ended";
        return;
      }

      pauseReasonRef.current = "temporary";
      setTemporaryResumePending(true);
      resumeTimerRef.current = window.setTimeout(() => {
        resumeTimerRef.current = null;
        setTemporaryResumePending(false);

        if (pauseReasonRef.current !== "temporary") {
          return;
        }

        if (currentIndexRef.current >= photos.length - 1) {
          pauseReasonRef.current = "ended";
          playingRef.current = false;
          setIsPlaying(false);
          return;
        }

        pauseReasonRef.current = null;
        warmBuffer(currentIndexRef.current);
        playingRef.current = true;
        setIsPlaying(true);
        setIsBuffering(false);
      }, MANUAL_RESUME_DELAY_MS);
    },
    [cancelPendingResume, photos.length, setTemporaryResumePending, warmBuffer]
  );

  const navigateManually = useCallback(
    (direction: number) => {
      revealControls();

      const fromIndex = currentIndexRef.current;
      const nextIndex = Math.max(0, Math.min(fromIndex + direction, photos.length - 1));
      if (nextIndex === fromIndex) {
        return;
      }

      const shouldResume = playingRef.current || temporaryResumePendingRef.current || pauseReasonRef.current === "temporary";
      goToIndex(nextIndex);

      if (!shouldResume) {
        return;
      }

      playingRef.current = false;
      setIsPlaying(false);
      setIsBuffering(false);
      scheduleTemporaryResume(nextIndex);
    },
    [goToIndex, photos.length, revealControls, scheduleTemporaryResume]
  );

  const step = useCallback(
    (direction: number) => {
      goToIndex(currentIndexRef.current + direction);
    },
    [goToIndex]
  );

  const toggleFromPrimaryControl = useCallback(() => {
    revealControls();

    if (isPlaying || temporaryResumePendingRef.current) {
      pauseExplicitly();
    } else {
      playExplicitly();
    }
  }, [isPlaying, pauseExplicitly, playExplicitly, revealControls]);

  const toggleFromPhotoSurface = useCallback(() => {
    revealControls();

    if (temporaryResumePendingRef.current) {
      playExplicitly();
    } else if (isPlaying) {
      pauseExplicitly();
    } else {
      playExplicitly();
    }
  }, [isPlaying, pauseExplicitly, playExplicitly, revealControls]);

  const toggleMusic = useCallback(() => {
    revealControls();
    const nextValue = !shouldPlayMusic;
    if (nextValue) {
      setHasMusicLoaded(true);
    }

    setShouldPlayMusic(nextValue);
    if (nextValue) {
      soundCloudWidgetRef.current?.play();
    } else {
      soundCloudWidgetRef.current?.pause();
    }
  }, [revealControls, shouldPlayMusic]);

  const attemptAdvance = useCallback(() => {
    const nextIndex = currentIndexRef.current + 1;
    if (nextIndex >= photos.length) {
      cancelPendingResume();
      pauseReasonRef.current = "ended";
      setIsPlaying(false);
      playingRef.current = false;
      return false;
    }

    const nextEntry = preloadPhoto(nextIndex);
    if (nextEntry && !nextEntry.ready && !nextEntry.failed) {
      setIsBuffering(true);
      return false;
    }

    goToIndex(nextIndex);
    if (nextIndex >= photos.length - 1) {
      cancelPendingResume();
      pauseReasonRef.current = "ended";
      setIsPlaying(false);
      playingRef.current = false;
    } else {
      pauseReasonRef.current = null;
    }

    return true;
  }, [cancelPendingResume, goToIndex, photos.length, preloadPhoto]);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  useEffect(() => {
    delayRef.current = delayMs;
  }, [delayMs]);

  useEffect(() => {
    playingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    currentIndexRef.current = initialIndex;
    cancelPendingResume();
    pauseReasonRef.current = null;
    setCurrentIndex(initialIndex);
    setIsPlaying(true);
    playingRef.current = true;
    setIsBuffering(false);
    warmBuffer(initialIndex);
    revealControls();

    window.requestAnimationFrame(() => {
      surfaceRef.current?.focus({ preventScroll: true });
    });
  }, [cancelPendingResume, initialIndex, revealControls, warmBuffer]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(IMAGE_MODE_STORAGE_KEY, imageMode);
    } catch {
      // Session storage may be blocked; the toggle still works for this player instance.
    }
  }, [imageMode]);

  useEffect(() => {
    if (!hasMusicLoaded) {
      return;
    }

    let isMounted = true;
    setIsMusicWidgetReady(false);

    loadSoundCloudApi()
      .then(() => {
        if (!isMounted || !window.SC?.Widget || !musicIframeRef.current) {
          return;
        }

        const widget = window.SC.Widget(musicIframeRef.current);
        const events = window.SC.Widget.Events;
        soundCloudWidgetRef.current = widget;

        widget.bind(events.READY, () => {
          if (isMounted) {
            setIsMusicWidgetReady(true);
          }
        });
        widget.bind(events.PLAY, () => {
          if (isMounted) {
            setIsMusicPlaying(true);
          }
        });
        widget.bind(events.PAUSE, () => {
          if (isMounted) {
            setIsMusicPlaying(false);
          }
        });
        widget.bind(events.FINISH, () => {
          if (isMounted) {
            setShouldPlayMusic(false);
            setIsMusicPlaying(false);
          }
        });
      })
      .catch(() => {
        if (isMounted) {
          setShouldPlayMusic(false);
          setIsMusicPlaying(false);
        }
      });

    return () => {
      isMounted = false;
      soundCloudWidgetRef.current?.pause();
      soundCloudWidgetRef.current = null;
    };
  }, [hasMusicLoaded]);

  useEffect(() => {
    if (!isMusicWidgetReady) {
      return;
    }

    if (shouldPlayMusic) {
      soundCloudWidgetRef.current?.play();
    } else {
      soundCloudWidgetRef.current?.pause();
    }
  }, [isMusicWidgetReady, shouldPlayMusic]);

  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }

    let animationFrame = 0;
    let nextFrameAt = performance.now() + delayRef.current;

    const tick = (now: number) => {
      if (!playingRef.current) {
        return;
      }

      if (now >= nextFrameAt) {
        const didAdvance = attemptAdvance();
        if (didAdvance) {
          nextFrameAt += delayRef.current;
          while (now >= nextFrameAt + delayRef.current) {
            nextFrameAt += delayRef.current;
          }
        } else {
          nextFrameAt = now + Math.min(80, delayRef.current);
        }
      }

      animationFrame = window.requestAnimationFrame(tick);
    };

    animationFrame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [attemptAdvance, isPlaying]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      revealControls();

      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }

      if (event.key === " ") {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(".player-topbar button, .player-controls button:not(.icon-button--primary)")) {
          return;
        }

        event.preventDefault();
        if (isPlaying || temporaryResumePendingRef.current) {
          pauseExplicitly();
        } else {
          playExplicitly();
        }
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigateManually(-1);
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        navigateManually(1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close, isPlaying, navigateManually, pauseExplicitly, playExplicitly, revealControls]);

  useEffect(() => {
    revealControls();
    return () => {
      if (controlsTimerRef.current !== null) {
        window.clearTimeout(controlsTimerRef.current);
      }
      cancelPendingResume();
    };
  }, [cancelPendingResume, revealControls]);

  if (!currentPhoto) {
    return null;
  }

  const primaryActionLabel = isPlaying || temporaryResumePending ? "Pause" : "Play";
  const surfaceActionLabel = temporaryResumePending ? "Play" : primaryActionLabel;
  const fullscreenActionLabel = imageMode === "expanded" ? "Exit full screen" : "Full screen";
  const musicIsActive = shouldPlayMusic || isMusicPlaying;
  const musicActionLabel = musicIsActive ? "Stop music" : "Play music";

  return (
    <div
      className={`player-overlay ${controlsVisible ? "has-visible-controls" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Photo player"
      onMouseMove={revealControls}
      onTouchStart={revealControls}
    >
      <button
        ref={surfaceRef}
        className={`player-surface player-surface--${imageMode}`}
        type="button"
        onPointerDown={(event) => {
          if (event.pointerType === "touch") {
            touchStartRef.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY
            };
          }
        }}
        onPointerUp={(event) => {
          if (event.pointerType !== "touch" || touchStartRef.current?.id !== event.pointerId) {
            return;
          }

          const startedAt = touchStartRef.current;
          touchStartRef.current = null;
          ignoreSyntheticClickUntilRef.current = Date.now() + 450;
          event.preventDefault();
          event.stopPropagation();

          const movedX = Math.abs(event.clientX - startedAt.x);
          const movedY = Math.abs(event.clientY - startedAt.y);
          if (movedX > 18 || movedY > 18) {
            return;
          }

          const imageRect = event.currentTarget.querySelector("img")?.getBoundingClientRect();
          if (
            imageRect &&
            (event.clientX < imageRect.left ||
              event.clientX > imageRect.right ||
              event.clientY < imageRect.top ||
              event.clientY > imageRect.bottom)
          ) {
            return;
          }

          const navigationRect = imageRect || event.currentTarget.getBoundingClientRect();
          navigateManually(event.clientX < navigationRect.left + navigationRect.width / 2 ? -1 : 1);
        }}
        onPointerCancel={(event) => {
          if (event.pointerType === "touch") {
            touchStartRef.current = null;
            ignoreSyntheticClickUntilRef.current = Date.now() + 450;
          }
        }}
        onClick={(event) => {
          if (Date.now() < ignoreSyntheticClickUntilRef.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }

          toggleFromPhotoSurface();
        }}
        aria-label={surfaceActionLabel}
      >
        <img
          src={mediaUrl(currentPhoto.displayKey)}
          alt=""
          className={`player-image player-image--${currentPhoto.orientation} player-image--${imageMode}`}
          decoding="async"
          onError={() => {
            if (!atEnd) {
              step(1);
            } else {
              cancelPendingResume();
              pauseReasonRef.current = "ended";
              setIsPlaying(false);
            }
          }}
        />
      </button>

      <div className="player-topbar">
        <button className="icon-button" type="button" onClick={close} aria-label="Close" title="Close">
          <X size={22} strokeWidth={2.2} />
        </button>
        <div className="player-counter" aria-live="polite">
          {currentIndex + 1} / {photos.length}
          {temporaryResumePending ? <span className="player-counter__status">resumes</span> : null}
        </div>
      </div>

      <div className="player-controls">
        <button
          className="icon-button"
          type="button"
          onClick={() => navigateManually(-1)}
          disabled={atStart}
          aria-label="Previous photo"
          title="Previous photo"
        >
          <ChevronLeft size={24} strokeWidth={2.2} />
        </button>
        <button
          className="icon-button icon-button--primary"
          type="button"
          onClick={toggleFromPrimaryControl}
          aria-label={primaryActionLabel}
          title={primaryActionLabel}
        >
          {primaryActionLabel === "Pause" ? <Pause size={22} strokeWidth={2.4} /> : <Play size={22} strokeWidth={2.4} />}
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={() => navigateManually(1)}
          disabled={atEnd}
          aria-label="Next photo"
          title="Next photo"
        >
          <ChevronRight size={24} strokeWidth={2.2} />
        </button>
        <button
          className={`icon-button icon-button--music ${musicIsActive ? "is-selected" : ""}`}
          type="button"
          onClick={toggleMusic}
          aria-label={musicActionLabel}
          aria-pressed={musicIsActive}
          title={musicActionLabel}
        >
          <Music size={21} strokeWidth={2.35} />
        </button>

        <div className="speed-control" aria-label="Seconds per photo">
          {SPEED_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={option.value === delayMs ? "is-selected" : ""}
              type="button"
              onClick={() => {
                setDelayMs(option.value);
                revealControls();
              }}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="image-mode-control" role="group" aria-label="Image sizing">
          <button
            className={imageMode === "expanded" ? "is-selected" : ""}
            type="button"
            onClick={() => {
              setImageMode((currentMode) => (currentMode === "expanded" ? "fit" : "expanded"));
              revealControls();
            }}
            aria-pressed={imageMode === "expanded"}
          >
            {fullscreenActionLabel}
          </button>
        </div>
      </div>

      <div className="player-progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${photos.length <= 1 ? 1 : currentIndex / (photos.length - 1)})` }} />
      </div>

      {hasMusicLoaded ? (
        <iframe
          ref={musicIframeRef}
          className="player-music-frame"
          src={SOUNDCLOUD_EMBED_URL}
          title="640 SoundCloud playlist"
          allow="autoplay; encrypted-media"
          aria-hidden="true"
          tabIndex={-1}
        />
      ) : null}

      {isBuffering ? <div className="player-buffer">Buffering</div> : null}
    </div>
  );
}

export default App;
