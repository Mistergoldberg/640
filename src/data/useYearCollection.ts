import { useCallback, useEffect, useRef, useState } from "react";
import { assetUrl } from "../lib/assets";
import type { AlbumManifest, AlbumSummary, Catalog, Photo, YearIndex } from "../types";
import { validateAlbumManifest, validateYearIndex } from "./manifestValidation";

export interface LoadedAlbumSummary extends AlbumSummary {
  year: string;
  loadState: "ready" | "loading" | "error";
  errorMessage?: string;
}

export type AlbumLoadResult =
  | { status: "ready"; album: AlbumSummary; manifest: AlbumManifest }
  | { status: "loading"; album: AlbumSummary }
  | { status: "error"; album: AlbumSummary; errorMessage: string };

export interface YearCollection {
  year: string;
  years: string[];
  index: {
    year: string;
    scannedCount: number;
    albums: LoadedAlbumSummary[];
    sequence: { id: string }[];
  };
  sourceIndex: YearIndex;
  albumResults: AlbumLoadResult[];
  albums: AlbumManifest[];
  photos: Photo[];
  expectedCount: number;
  availableCount: number;
  failedAlbumIds: string[];
  loadingAlbumIds: string[];
  isIncomplete: boolean;
}

export type YearLoadState =
  | { status: "loading"; message: string; collection: YearCollection | null }
  | { status: "error"; message: string; collection: YearCollection | null }
  | { status: "ready"; collection: YearCollection };

export interface YearLoaderState {
  state: YearLoadState;
  retry: () => void;
  retryAlbum: (albumId: string) => void;
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) {
    throw new Error(`${response.status}`);
  }

  return response.json();
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function publicAlbumError(error: unknown) {
  if (isAbortError(error)) {
    return "Request was cancelled";
  }

  return "Album could not be loaded";
}

export function buildYearCollection(years: string[], sourceIndex: YearIndex, albumResults: AlbumLoadResult[]): YearCollection {
  const albums = albumResults.flatMap((result) => (result.status === "ready" ? [result.manifest] : []));
  const photosById = new Map<string, Photo>();

  for (const album of albums) {
    for (const photo of album.photos) {
      photosById.set(photo.id, photo);
    }
  }

  const photos = sourceIndex.sequence
    .map((entry) => photosById.get(entry.id))
    .filter((photo): photo is Photo => Boolean(photo));
  const failedAlbumIds = albumResults.flatMap((result) => (result.status === "error" ? [result.album.id] : []));
  const loadingAlbumIds = albumResults.flatMap((result) => (result.status === "loading" ? [result.album.id] : []));
  const albumStateById = new Map(albumResults.map((result) => [result.album.id, result]));

  return {
    year: sourceIndex.year,
    years,
    sourceIndex,
    albumResults,
    albums,
    photos,
    expectedCount: sourceIndex.sequence.length,
    availableCount: photos.length,
    failedAlbumIds,
    loadingAlbumIds,
    isIncomplete: failedAlbumIds.length > 0 || loadingAlbumIds.length > 0,
    index: {
      year: sourceIndex.year,
      scannedCount: sourceIndex.scannedCount,
      sequence: photos.map((photo) => ({ id: photo.id })),
      albums: sourceIndex.albums.map((album) => {
        const state = albumStateById.get(album.id);
        return {
          ...album,
          year: sourceIndex.year,
          loadState: state?.status || "loading",
          errorMessage: state?.status === "error" ? state.errorMessage : undefined
        };
      })
    }
  };
}

async function loadAlbum(album: AlbumSummary, signal: AbortSignal): Promise<AlbumLoadResult> {
  const manifest = validateAlbumManifest(await fetchJson(assetUrl(album.manifestUrl), signal));
  return {
    status: "ready",
    album,
    manifest
  };
}

function replaceAlbumResult(collection: YearCollection, albumId: string, nextResult: AlbumLoadResult) {
  return buildYearCollection(
    collection.years,
    collection.sourceIndex,
    collection.albumResults.map((result) => (result.album.id === albumId ? nextResult : result))
  );
}

export function useYearCollection(catalog: Catalog | null, selectedYear: string | null): YearLoaderState {
  const [retryNonce, setRetryNonce] = useState(0);
  const requestIdRef = useRef(0);
  const stateRef = useRef<YearLoadState>({
    status: "loading",
    message: "Loading year",
    collection: null
  });
  const retryControllersRef = useRef(new Set<AbortController>());
  const [state, setStateValue] = useState<YearLoadState>(stateRef.current);

  const setState = useCallback((nextState: YearLoadState | ((current: YearLoadState) => YearLoadState)) => {
    setStateValue((current) => {
      const resolved = typeof nextState === "function" ? nextState(current) : nextState;
      stateRef.current = resolved;
      return resolved;
    });
  }, []);

  useEffect(() => {
    let isCancelled = false;
    const controller = new AbortController();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isCurrentRequest = () => !isCancelled && requestId === requestIdRef.current && !controller.signal.aborted;

    async function loadYear() {
      if (!catalog || !selectedYear) {
        setState({ status: "loading", message: "Loading year", collection: null });
        return;
      }

      const years = catalog.years.map((year) => year.year);
      const yearSummary = catalog.years.find((year) => year.year === selectedYear);
      if (!yearSummary) {
        setState({ status: "error", message: "Year is not available", collection: null });
        return;
      }

      setState({ status: "loading", message: `Loading ${selectedYear}`, collection: null });
      const sourceIndex = validateYearIndex(await fetchJson(assetUrl(yearSummary.indexUrl), controller.signal));
      if (!isCurrentRequest()) {
        return;
      }

      const loadingCollection = buildYearCollection(
        years,
        sourceIndex,
        sourceIndex.albums.map((album) => ({ status: "loading", album }))
      );
      setState({ status: "loading", message: `Loading ${selectedYear} albums`, collection: loadingCollection });

      const settledAlbums = await Promise.allSettled(sourceIndex.albums.map((album) => loadAlbum(album, controller.signal)));
      if (!isCurrentRequest()) {
        return;
      }

      const albumResults = settledAlbums.map((result, index): AlbumLoadResult => {
        if (result.status === "fulfilled") {
          return result.value;
        }

        return {
          status: "error",
          album: sourceIndex.albums[index],
          errorMessage: publicAlbumError(result.reason)
        };
      });
      const collection = buildYearCollection(years, sourceIndex, albumResults);
      setState({ status: "ready", collection });
    }

    loadYear().catch((error: unknown) => {
      if (isAbortError(error) || !isCurrentRequest()) {
        return;
      }

      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Year could not be loaded",
        collection: null
      });
    });

    return () => {
      isCancelled = true;
      controller.abort();
    };
  }, [catalog, retryNonce, selectedYear, setState]);

  useEffect(() => {
    return () => {
      for (const controller of retryControllersRef.current) {
        controller.abort();
      }
      retryControllersRef.current.clear();
    };
  }, []);

  const retry = useCallback(() => {
    setRetryNonce((current) => current + 1);
  }, []);

  const retryAlbum = useCallback(
    (albumId: string) => {
      const activeCollection = stateRef.current.collection;
      const target = activeCollection?.albumResults.find((result) => result.album.id === albumId);
      if (!activeCollection || !target || target.status !== "error") {
        return;
      }

      const controller = new AbortController();
      retryControllersRef.current.add(controller);
      setState((current) => {
        if (!current.collection || current.collection.year !== activeCollection.year) {
          return current;
        }

        const collection = replaceAlbumResult(current.collection, albumId, { status: "loading", album: target.album });
        return {
          status: "loading",
          message: "Retrying album",
          collection
        };
      });

      loadAlbum(target.album, controller.signal)
        .then((result) => {
          setState((current) => {
            if (!current.collection || current.collection.year !== activeCollection.year) {
              return current;
            }

            return {
              status: "ready",
              collection: replaceAlbumResult(current.collection, albumId, result)
            };
          });
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) {
            return;
          }

          setState((current) => {
            if (!current.collection || current.collection.year !== activeCollection.year) {
              return current;
            }

            return {
              status: "ready",
              collection: replaceAlbumResult(current.collection, albumId, {
                status: "error",
                album: target.album,
                errorMessage: publicAlbumError(error)
              })
            };
          });
        })
        .finally(() => {
          retryControllersRef.current.delete(controller);
        });
    },
    [setState]
  );

  return {
    state,
    retry,
    retryAlbum
  };
}
