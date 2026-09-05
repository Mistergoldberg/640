import type { AlbumManifest, AlbumSummary, Catalog, CatalogYear, Orientation, Photo, PhotoSequenceItem, YearIndex } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOrientation(value: unknown): value is Orientation {
  return value === "landscape" || value === "portrait" || value === "square";
}

function validationError(scope: string): Error {
  return new Error(`${scope} data is malformed`);
}

function validateCatalogYear(value: unknown): CatalogYear {
  if (!isRecord(value) || !isString(value.year) || !isString(value.indexUrl)) {
    throw validationError("Catalogue");
  }

  return {
    year: value.year,
    indexUrl: value.indexUrl
  };
}

function validateAlbumSummary(value: unknown): AlbumSummary {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.name) ||
    !isFiniteNumber(value.count) ||
    !isString(value.manifestUrl)
  ) {
    throw validationError("Year index");
  }

  return {
    id: value.id,
    name: value.name,
    count: value.count,
    manifestUrl: value.manifestUrl
  };
}

function validatePhotoSequenceItem(value: unknown): PhotoSequenceItem {
  if (!isRecord(value) || !isString(value.id)) {
    throw validationError("Year index");
  }

  return {
    id: value.id
  };
}

function validatePhoto(value: unknown): Photo {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.thumbnailKey) ||
    !isString(value.displayKey) ||
    !isString(value.albumId) ||
    !isFiniteNumber(value.width) ||
    !isFiniteNumber(value.height) ||
    !isOrientation(value.orientation) ||
    !isFiniteNumber(value.sortPosition) ||
    !isFiniteNumber(value.albumSortPosition)
  ) {
    throw validationError("Album manifest");
  }

  return {
    id: value.id,
    thumbnailKey: value.thumbnailKey,
    displayKey: value.displayKey,
    albumId: value.albumId,
    width: value.width,
    height: value.height,
    orientation: value.orientation,
    sortPosition: value.sortPosition,
    albumSortPosition: value.albumSortPosition
  };
}

export function validateCatalog(value: unknown): Catalog {
  if (!isRecord(value) || !Array.isArray(value.years)) {
    throw validationError("Catalogue");
  }

  return {
    years: value.years.map(validateCatalogYear)
  };
}

export function validateYearIndex(value: unknown): YearIndex {
  if (
    !isRecord(value) ||
    !isString(value.year) ||
    !isFiniteNumber(value.scannedCount) ||
    !Array.isArray(value.albums) ||
    !Array.isArray(value.sequence)
  ) {
    throw validationError("Year index");
  }

  return {
    year: value.year,
    scannedCount: value.scannedCount,
    albums: value.albums.map(validateAlbumSummary),
    sequence: value.sequence.map(validatePhotoSequenceItem)
  };
}

export function validateAlbumManifest(value: unknown): AlbumManifest {
  if (!isRecord(value) || !Array.isArray(value.photos)) {
    throw validationError("Album manifest");
  }

  return {
    photos: value.photos.map(validatePhoto)
  };
}
