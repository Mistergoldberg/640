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
import { requestIsCurrent } from "./archiveYearCache";
import { recordDiagnostic } from "../debug/archiveDiagnostics";

export type ArchiveYearStatus = "index-loading" | "unloaded" | "loading" | "ready" | "error";

export interface ArchiveYearState {
  year: string;
  index: YearIndex | null;
  collection: YearCollection | null;
  status: ArchiveYearStatus;
  message?: string;
}

export type ArchiveLoadReason = "initial" | "adjacent" | "scrub" | "history" | "retry";

export interface ArchiveYearCache {
  states: Map<string, ArchiveYearState>;
  indexes: Map<string, YearIndex>;
  collections: Map<string, YearCollection>;
  loadYear: (year: string, reason?: ArchiveLoadReason) => void;
  retryYear: (year: string) => void;
  retryAlbum: (year: string, albumId: string) => void;
}

interface ActiveRequest {
  controller: AbortController;
  generation: number;
  reason: ArchiveLoadReason;
}

export function useArchiveYearCache(catalog: Catalog | null, initialYear: string | null): ArchiveYearCache {
  const [states, setStatesValue] = useState<Map<string, ArchiveYearState>>(new Map());
  const statesRef = useRef(states);
  const pendingRef = useRef(new Map<string, ArchiveLoadReason>());
  const requestsRef = useRef(new Map<string, ActiveRequest>());
  const generationRef = useRef(new Map<string, number>());
  const retryControllersRef = useRef(new Set<AbortController>());

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
    setStates((current) => {
      const state = current.get(year);
      if (!state || state.status !== "loading") return current;
      const next = new Map(current);
      next.set(year, { ...state, status: "unloaded", collection: null, message: undefined });
      return next;
    });
  }, [setStates]);

  const loadYear = useCallback((year: string, reason: ArchiveLoadReason = "adjacent") => {
    const state = statesRef.current.get(year);
    if (requestsRef.current.has(year)) return;
    if (!state || state.status === "ready" || state.status === "loading") return;
    if (!state.index) {
      pendingRef.current.set(year, reason);
      return;
    }

    if (reason === "scrub" || reason === "history") {
      for (const [requestYear, request] of requestsRef.current) {
        if (requestYear !== year && request.reason === "scrub") cancelRequest(requestYear);
      }
    }

    const generation = (generationRef.current.get(year) || 0) + 1;
    generationRef.current.set(year, generation);
    const controller = new AbortController();
    requestsRef.current.set(year, { controller, generation, reason });
    const years = [...statesRef.current.keys()];
    const sourceIndex = state.index;
    recordDiagnostic("manifest-load-start", { year, reason, albumCount: sourceIndex.albums.length });
    setStates((current) => {
      const next = new Map(current);
      next.set(year, { ...state, status: "loading", collection: null, message: `Loading ${year}` });
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
        setStates((current) => {
          const latest = current.get(year);
          if (!latest || !requestIsCurrent(generationRef.current.get(year) || 0, generation)) return current;
          const next = new Map(current);
          next.set(year, { ...latest, status: "ready", collection, message: undefined });
          return next;
        });
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
  }, [cancelRequest, setStates]);

  useEffect(() => {
    if (!catalog) return;
    for (const request of requestsRef.current.values()) request.controller.abort();
    requestsRef.current.clear();
    generationRef.current.clear();
    pendingRef.current.clear();
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
            next.set(summary.year, { ...previous, index, status: "unloaded" });
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
    if (initialYear) pendingRef.current.set(initialYear, "initial");
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
    for (const controller of retryControllersRef.current) controller.abort();
    requestsRef.current.clear();
    retryControllersRef.current.clear();
  }, []);

  const retryYear = useCallback((year: string) => {
    const currentState = statesRef.current.get(year);
    const summary = catalog?.years.find((candidate) => candidate.year === year);
    if (!currentState || !summary) return;
    pendingRef.current.set(year, "retry");
    if (!currentState.index) {
      const controller = new AbortController();
      retryControllersRef.current.add(controller);
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
        .finally(() => retryControllersRef.current.delete(controller));
      return;
    }
    setStates((current) => {
      const state = current.get(year);
      if (!state) return current;
      const next = new Map(current);
      next.set(year, { ...state, status: state.index ? "unloaded" : "index-loading", message: undefined });
      return next;
    });
  }, [catalog, setStates]);

  const retryAlbum = useCallback((year: string, albumId: string) => {
    const state = statesRef.current.get(year);
    const target = state?.collection?.albumResults.find((result) => result.album.id === albumId);
    if (!state?.collection || !target || target.status !== "error") return;
    const controller = new AbortController();
    retryControllersRef.current.add(controller);
    const loadingCollection = replaceAlbumResult(state.collection, albumId, { status: "loading", album: target.album });
    setStates((current) => {
      const latest = current.get(year);
      if (!latest) return current;
      const next = new Map(current);
      next.set(year, { ...latest, collection: loadingCollection });
      return next;
    });
    void loadAlbum(target.album, controller.signal)
      .then((result) => {
        setStates((current) => {
          const latest = current.get(year);
          if (!latest?.collection) return current;
          const next = new Map(current);
          next.set(year, { ...latest, collection: replaceAlbumResult(latest.collection, albumId, result) });
          return next;
        });
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setStates((current) => {
          const latest = current.get(year);
          if (!latest?.collection) return current;
          const next = new Map(current);
          next.set(year, { ...latest, collection: replaceAlbumResult(latest.collection, albumId, {
            status: "error", album: target.album, errorMessage: publicAlbumError(error)
          }) });
          return next;
        });
      })
      .finally(() => retryControllersRef.current.delete(controller));
  }, [setStates]);

  const indexes = new Map<string, YearIndex>();
  const collections = new Map<string, YearCollection>();
  for (const [year, state] of states) {
    if (state.index) indexes.set(year, state.index);
    if (state.collection) collections.set(year, state.collection);
  }

  return { states, indexes, collections, loadYear, retryYear, retryAlbum };
}
