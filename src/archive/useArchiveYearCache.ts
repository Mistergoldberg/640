import { useCallback, useEffect, useRef, useState } from "react";
import { assetUrl } from "../lib/assets";
import { validateYearIndex } from "../data/manifestValidation";
import {
  buildYearCollection,
  fetchJson,
  isAbortError,
  loadAlbum,
  publicAlbumError,
  replaceAlbumResult,
  type AlbumLoadResult,
  type YearCollection
} from "../data/useYearCollection";
import type { Catalog, YearIndex } from "../types";
import { orderedArchiveYears } from "./archiveTimelineModel";
import {
  requestIsCurrent,
  shouldCancelYearRequest,
  touchBoundedYearCache
} from "./archiveYearCache";
import { recordDiagnostic } from "../debug/archiveDiagnostics";

export type ArchiveYearStatus = "index-loading" | "unloaded" | "loading" | "ready" | "error";

export interface ArchiveYearState {
  year: string;
  index: YearIndex | null;
  collection: YearCollection | null;
  status: ArchiveYearStatus;
  message?: string;
}

export type ArchiveLoadReason = "initial" | "scrub" | "jump" | "boundary" | "history" | "retry";

export interface ArchiveYearCache {
  states: Map<string, ArchiveYearState>;
  indexes: Map<string, YearIndex>;
  collections: Map<string, YearCollection>;
  cachedYears: string[];
  loadingYears: string[];
  loadYear: (year: string, reason?: ArchiveLoadReason) => void;
  retryYear: (year: string) => void;
  retryAlbum: (year: string, albumId: string) => void;
}

interface ActiveRequest {
  controller: AbortController;
  generation: number;
  reason: ArchiveLoadReason;
}

interface RetryRequest {
  year: string;
  controller: AbortController;
  restore: () => void;
}

export function useArchiveYearCache(catalog: Catalog | null, initialYear: string | null): ArchiveYearCache {
  const [states, setStatesValue] = useState<Map<string, ArchiveYearState>>(new Map());
  const statesRef = useRef(states);
  const lruRef = useRef<string[]>([]);
  const pendingRef = useRef(new Map<string, ArchiveLoadReason>());
  const requestsRef = useRef(new Map<string, ActiveRequest>());
  const generationRef = useRef(new Map<string, number>());
  const retryRequestsRef = useRef(new Map<AbortController, RetryRequest>());

  const setStates = useCallback((updater: (current: Map<string, ArchiveYearState>) => Map<string, ArchiveYearState>) => {
    setStatesValue((current) => {
      const next = updater(current);
      statesRef.current = next;
      return next;
    });
  }, []);

  const cancelRequest = useCallback((year: string) => {
    const active = requestsRef.current.get(year);
    if (!active) return;
    active.controller.abort();
    generationRef.current.set(year, active.generation + 1);
    requestsRef.current.delete(year);
    recordDiagnostic("manifest-load-abort", { year, reason: active.reason });
    setStates((current) => {
      const state = current.get(year);
      if (!state || state.status !== "loading") return current;
      const next = new Map(current);
      next.set(year, { ...state, status: "unloaded", collection: null, message: undefined });
      return next;
    });
  }, [setStates]);

  const cancelObsoleteRequests = useCallback((targetYear: string) => {
    for (const pendingYear of [...pendingRef.current.keys()]) {
      if (shouldCancelYearRequest(pendingYear, targetYear)) pendingRef.current.delete(pendingYear);
    }
    for (const requestYear of [...requestsRef.current.keys()]) {
      if (shouldCancelYearRequest(requestYear, targetYear)) cancelRequest(requestYear);
    }
    for (const [controller, retry] of [...retryRequestsRef.current]) {
      if (!shouldCancelYearRequest(retry.year, targetYear)) continue;
      controller.abort();
      retryRequestsRef.current.delete(controller);
      retry.restore();
      recordDiagnostic("manifest-retry-abort", { year: retry.year });
    }
  }, [cancelRequest]);

  const retainCollection = useCallback((year: string, collection: YearCollection) => {
    const cacheUpdate = touchBoundedYearCache(lruRef.current, year);
    lruRef.current = cacheUpdate.order;
    setStates((current) => {
      const latest = current.get(year);
      if (!latest) return current;
      const next = new Map(current);
      next.set(year, { ...latest, status: "ready", collection, message: undefined });
      for (const evictedYear of cacheUpdate.evicted) {
        const evicted = next.get(evictedYear);
        if (!evicted?.collection) continue;
        next.set(evictedYear, {
          ...evicted,
          collection: null,
          status: evicted.index ? "unloaded" : "index-loading",
          message: undefined
        });
      }
      return next;
    });
    for (const evictedYear of cacheUpdate.evicted) {
      recordDiagnostic("year-cache-evict", { year: evictedYear, retainedYears: cacheUpdate.order });
    }
  }, [setStates]);

  const touchReadyCollection = useCallback((year: string) => {
    const state = statesRef.current.get(year);
    if (!state?.collection) return;
    const cacheUpdate = touchBoundedYearCache(lruRef.current, year);
    lruRef.current = cacheUpdate.order;
    if (!cacheUpdate.evicted.length) return;
    setStates((current) => {
      const next = new Map(current);
      for (const evictedYear of cacheUpdate.evicted) {
        const evicted = next.get(evictedYear);
        if (!evicted?.collection) continue;
        next.set(evictedYear, { ...evicted, collection: null, status: "unloaded", message: undefined });
      }
      return next;
    });
  }, [setStates]);

  const loadYear = useCallback((year: string, reason: ArchiveLoadReason = "jump") => {
    cancelObsoleteRequests(year);
    const state = statesRef.current.get(year);
    if (!state || requestsRef.current.has(year) || state.status === "loading") return;
    if (state.status === "ready" && state.collection) {
      touchReadyCollection(year);
      return;
    }
    if (!state.index) {
      pendingRef.current.set(year, reason);
      return;
    }

    const generation = (generationRef.current.get(year) || 0) + 1;
    generationRef.current.set(year, generation);
    const controller = new AbortController();
    requestsRef.current.set(year, { controller, generation, reason });
    const sourceIndex = state.index;
    const years = [...statesRef.current.keys()];
    recordDiagnostic("manifest-load-start", { year, reason, albumCount: sourceIndex.albums.length });
    setStates((current) => {
      const latest = current.get(year);
      if (!latest) return current;
      const next = new Map(current);
      next.set(year, { ...latest, status: "loading", collection: null, message: `Loading ${year}` });
      return next;
    });

    void Promise.allSettled(sourceIndex.albums.map((album) => loadAlbum(album, controller.signal)))
      .then((settled) => {
        if (!requestIsCurrent(generationRef.current.get(year) || 0, generation, controller.signal.aborted)) return;
        const results = settled.map((result, index): AlbumLoadResult => result.status === "fulfilled"
          ? result.value
          : { status: "error", album: sourceIndex.albums[index], errorMessage: publicAlbumError(result.reason) });
        const collection = buildYearCollection(years, sourceIndex, results);
        recordDiagnostic("manifest-load-complete", {
          year,
          reason,
          albumCount: sourceIndex.albums.length,
          photoCount: collection.photos.length,
          failedAlbumCount: collection.failedAlbumIds.length
        });
        retainCollection(year, collection);
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || !requestIsCurrent(generationRef.current.get(year) || 0, generation)) return;
        recordDiagnostic("manifest-load-error", { year, reason, message: error instanceof Error ? error.message : "Year could not be loaded" });
        setStates((current) => {
          const latest = current.get(year);
          if (!latest) return current;
          const next = new Map(current);
          next.set(year, { ...latest, status: "error", collection: null, message: "Year could not be loaded" });
          return next;
        });
      })
      .finally(() => {
        const current = requestsRef.current.get(year);
        if (current?.generation === generation) requestsRef.current.delete(year);
      });
  }, [cancelObsoleteRequests, retainCollection, setStates, touchReadyCollection]);

  useEffect(() => {
    if (!catalog) return;
    for (const request of requestsRef.current.values()) request.controller.abort();
    for (const retry of retryRequestsRef.current.values()) retry.controller.abort();
    requestsRef.current.clear();
    retryRequestsRef.current.clear();
    generationRef.current.clear();
    pendingRef.current.clear();
    lruRef.current = [];
    const ordered = orderedArchiveYears(catalog);
    const initial = new Map(ordered.map(({ year }) => [year, {
      year,
      index: null,
      collection: null,
      status: "index-loading" as const
    }]));
    statesRef.current = initial;
    setStatesValue(initial);
    const indexController = new AbortController();

    for (const summary of ordered) {
      recordDiagnostic("year-index-load-start", { year: summary.year });
      void fetchJson(assetUrl(summary.indexUrl), indexController.signal)
        .then(validateYearIndex)
        .then((index) => {
          recordDiagnostic("year-index-load-complete", { year: summary.year, albumCount: index.albums.length });
          setStates((current) => {
            const previous = current.get(summary.year);
            if (!previous) return current;
            const next = new Map(current);
            next.set(summary.year, { ...previous, index, status: "unloaded", message: undefined });
            return next;
          });
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return;
          recordDiagnostic("year-index-load-error", { year: summary.year, message: error instanceof Error ? error.message : "Year index could not be loaded" });
          setStates((current) => {
            const previous = current.get(summary.year);
            if (!previous) return current;
            const next = new Map(current);
            next.set(summary.year, { ...previous, status: "error", message: "Year index could not be loaded" });
            return next;
          });
        });
    }

    return () => indexController.abort();
  }, [catalog, setStates]);

  useEffect(() => {
    if (initialYear && !pendingRef.current.has(initialYear)) pendingRef.current.set(initialYear, "initial");
    for (const [year, reason] of [...pendingRef.current]) {
      const state = states.get(year);
      if (state?.index && state.status !== "index-loading") {
        pendingRef.current.delete(year);
        loadYear(year, reason);
      }
    }
  }, [initialYear, loadYear, states]);

  useEffect(() => () => {
    for (const request of requestsRef.current.values()) request.controller.abort();
    for (const retry of retryRequestsRef.current.values()) retry.controller.abort();
    requestsRef.current.clear();
    retryRequestsRef.current.clear();
  }, []);

  const retryYear = useCallback((year: string) => {
    const currentState = statesRef.current.get(year);
    const summary = catalog?.years.find((candidate) => candidate.year === year);
    if (!currentState || !summary) return;
    cancelObsoleteRequests(year);
    pendingRef.current.set(year, "retry");
    if (!currentState.index) {
      const controller = new AbortController();
      retryRequestsRef.current.set(controller, {
        year,
        controller,
        restore: () => setStates((current) => {
          const state = current.get(year);
          if (!state || state.index) return current;
          const next = new Map(current);
          next.set(year, { ...state, status: "error", message: "Year index could not be loaded" });
          return next;
        })
      });
      setStates((current) => {
        const state = current.get(year);
        if (!state) return current;
        const next = new Map(current);
        next.set(year, { ...state, status: "index-loading", message: undefined });
        return next;
      });
      void fetchJson(assetUrl(summary.indexUrl), controller.signal)
        .then(validateYearIndex)
        .then((index) => {
          setStates((current) => {
            const state = current.get(year);
            if (!state) return current;
            const next = new Map(current);
            next.set(year, { ...state, index, status: "unloaded", message: undefined });
            return next;
          });
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return;
          pendingRef.current.delete(year);
          setStates((current) => {
            const state = current.get(year);
            if (!state) return current;
            const next = new Map(current);
            next.set(year, { ...state, status: "error", message: "Year index could not be loaded" });
            return next;
          });
        })
        .finally(() => retryRequestsRef.current.delete(controller));
      return;
    }
    setStates((current) => {
      const state = current.get(year);
      if (!state) return current;
      const next = new Map(current);
      next.set(year, { ...state, status: "unloaded", collection: null, message: undefined });
      return next;
    });
  }, [cancelObsoleteRequests, catalog, setStates]);

  const retryAlbum = useCallback((year: string, albumId: string) => {
    const state = statesRef.current.get(year);
    const target = state?.collection?.albumResults.find((result) => result.album.id === albumId);
    if (!state?.collection || !target || target.status !== "error") return;
    const controller = new AbortController();
    retryRequestsRef.current.set(controller, {
      year,
      controller,
      restore: () => {
        const latest = statesRef.current.get(year);
        const latestTarget = latest?.collection?.albumResults.find((result) => result.album.id === albumId);
        if (!latest?.collection || latestTarget?.status !== "loading") return;
        retainCollection(year, replaceAlbumResult(latest.collection, albumId, target));
      }
    });
    retainCollection(year, replaceAlbumResult(state.collection, albumId, { status: "loading", album: target.album }));
    void loadAlbum(target.album, controller.signal)
      .then((result) => {
        const latest = statesRef.current.get(year);
        if (!latest?.collection) return;
        retainCollection(year, replaceAlbumResult(latest.collection, albumId, result));
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        const latest = statesRef.current.get(year);
        if (!latest?.collection) return;
        retainCollection(year, replaceAlbumResult(latest.collection, albumId, {
          status: "error", album: target.album, errorMessage: publicAlbumError(error)
        }));
      })
      .finally(() => retryRequestsRef.current.delete(controller));
  }, [retainCollection]);

  const indexes = new Map<string, YearIndex>();
  const collections = new Map<string, YearCollection>();
  for (const [year, state] of states) {
    if (state.index) indexes.set(year, state.index);
    if (state.collection) collections.set(year, state.collection);
  }
  const cachedYears = lruRef.current.filter((year) => collections.has(year));
  const loadingYears = [...states].filter(([, state]) => state.status === "loading").map(([year]) => year);

  return { states, indexes, collections, cachedYears, loadingYears, loadYear, retryYear, retryAlbum };
}
