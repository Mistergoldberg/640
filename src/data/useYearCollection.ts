import { assetUrl } from "../lib/assets";
import type { AlbumManifest, AlbumSummary, Photo, YearIndex } from "../types";
import { validateAlbumManifest } from "./manifestValidation";

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

export async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) {
    throw new Error(`${response.status}`);
  }

  return response.json();
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function publicAlbumError(error: unknown) {
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

export async function loadAlbum(album: AlbumSummary, signal: AbortSignal): Promise<AlbumLoadResult> {
  const manifest = validateAlbumManifest(await fetchJson(assetUrl(album.manifestUrl), signal));
  return {
    status: "ready",
    album,
    manifest
  };
}

export function replaceAlbumResult(collection: YearCollection, albumId: string, nextResult: AlbumLoadResult) {
  return buildYearCollection(
    collection.years,
    collection.sourceIndex,
    collection.albumResults.map((result) => (result.album.id === albumId ? nextResult : result))
  );
}
