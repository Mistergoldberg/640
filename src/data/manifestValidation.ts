import { inspectMediaKey } from "../../scripts/media-contract.mjs";
import type { AlbumManifest, AlbumSummary, Catalog, CatalogYear, Orientation, Photo, PhotoSequenceItem, YearIndex } from "../types";

export const MANIFEST_LIMITS = {
  catalogYears: 200,
  albumsPerYear: 10_000,
  photosPerYear: 1_000_000,
  displayWidth: 640,
  displayHeight: 480
} as const;

const YEAR_PATTERN = /^(?:19|20)\d{2}$/;
const PHOTO_ID_PATTERN = /^(?:19|20)\d{2}-[a-f0-9]{14}$/;
const ALBUM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

export class ManifestValidationError extends Error {
  readonly code: string;
  readonly publicMessage: string;

  constructor(scope: "catalogue" | "year" | "album", code: string) {
    const publicMessage = scope === "catalogue"
      ? "Catalogue data could not be loaded"
      : scope === "year"
        ? "Year index could not be loaded"
        : "Album could not be loaded";
    super(publicMessage);
    this.name = "ManifestValidationError";
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

function invalid(scope: "catalogue" | "year" | "album", code: string): never {
  throw new ManifestValidationError(scope, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function isPositiveInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= maximum;
}

function isOrientation(value: unknown): value is Orientation {
  return value === "landscape" || value === "portrait" || value === "square";
}

function unique(values: readonly string[]) {
  return new Set(values).size === values.length;
}

function validateCatalogYear(value: unknown): CatalogYear {
  if (!isRecord(value) || typeof value.year !== "string" || !YEAR_PATTERN.test(value.year)) {
    invalid("catalogue", "invalid-year");
  }
  if (value.indexUrl !== `data/${value.year}/index.json`) {
    invalid("catalogue", "invalid-index-path");
  }
  return { year: value.year, indexUrl: value.indexUrl as string };
}

function validateAlbumSummary(value: unknown, year: string): AlbumSummary {
  if (!isRecord(value) || typeof value.id !== "string" || !ALBUM_ID_PATTERN.test(value.id)) {
    invalid("year", "invalid-album-id");
  }
  if (!isNonEmptyString(value.name) || !isNonNegativeInteger(value.count, MANIFEST_LIMITS.photosPerYear)) {
    invalid("year", "invalid-album-summary");
  }
  if (value.manifestUrl !== `data/${year}/albums/${value.id}.json`) {
    invalid("year", "invalid-album-path");
  }
  return { id: value.id, name: value.name, count: value.count, manifestUrl: value.manifestUrl as string };
}

function validatePhotoSequenceItem(value: unknown, year: string): PhotoSequenceItem {
  if (!isRecord(value) || typeof value.id !== "string" || !PHOTO_ID_PATTERN.test(value.id) || !value.id.startsWith(`${year}-`)) {
    invalid("year", "invalid-sequence-photo-id");
  }
  return { id: value.id };
}

export interface AlbumValidationContext {
  year: string;
  album: AlbumSummary;
  sequence: readonly PhotoSequenceItem[];
}

function validatePhoto(value: unknown, context: AlbumValidationContext): Photo {
  if (!isRecord(value) || typeof value.id !== "string" || !PHOTO_ID_PATTERN.test(value.id) || !value.id.startsWith(`${context.year}-`)) {
    invalid("album", "invalid-photo-id");
  }
  if (value.albumId !== context.album.id) invalid("album", "album-membership-mismatch");
  if (!isPositiveInteger(value.width, MANIFEST_LIMITS.displayWidth) || !isPositiveInteger(value.height, MANIFEST_LIMITS.displayHeight)) {
    invalid("album", "invalid-display-dimensions");
  }
  if (!isOrientation(value.orientation)) invalid("album", "invalid-orientation");
  if (!isNonNegativeInteger(value.sortPosition, context.sequence.length - 1) || !isNonNegativeInteger(value.albumSortPosition, context.album.count - 1)) {
    invalid("album", "invalid-sort-position");
  }
  if (!context.sequence.some((entry) => entry.id === value.id)) invalid("album", "photo-missing-from-sequence");
  const thumbnail = inspectMediaKey(value.thumbnailKey, { year: context.year, photoId: value.id, derivative: "thumbs" });
  const display = inspectMediaKey(value.displayKey, { year: context.year, photoId: value.id, derivative: "display" });
  if (!thumbnail.valid || !display.valid) invalid("album", "invalid-media-key");

  return {
    id: value.id,
    thumbnailKey: value.thumbnailKey as string,
    displayKey: value.displayKey as string,
    albumId: value.albumId,
    width: value.width,
    height: value.height,
    orientation: value.orientation,
    sortPosition: value.sortPosition,
    albumSortPosition: value.albumSortPosition
  };
}

export function validateCatalog(value: unknown): Catalog {
  if (!isRecord(value) || !Array.isArray(value.years) || value.years.length < 1 || value.years.length > MANIFEST_LIMITS.catalogYears) {
    invalid("catalogue", "invalid-year-list");
  }
  const years = value.years.map(validateCatalogYear);
  if (!unique(years.map(({ year }) => year))) invalid("catalogue", "duplicate-year");
  return { years };
}

export function validateYearIndex(value: unknown, expectedYear?: string): YearIndex {
  if (!isRecord(value) || typeof value.year !== "string" || !YEAR_PATTERN.test(value.year) || (expectedYear && value.year !== expectedYear)) {
    invalid("year", "year-identity-mismatch");
  }
  if (!isNonNegativeInteger(value.scannedCount, MANIFEST_LIMITS.photosPerYear) || !Array.isArray(value.albums) || !Array.isArray(value.sequence)) {
    invalid("year", "invalid-index-shape");
  }
  if (value.albums.length > MANIFEST_LIMITS.albumsPerYear || value.sequence.length > MANIFEST_LIMITS.photosPerYear) {
    invalid("year", "index-limit-exceeded");
  }
  const albums = value.albums.map((album) => validateAlbumSummary(album, value.year as string));
  const sequence = value.sequence.map((entry) => validatePhotoSequenceItem(entry, value.year as string));
  if (!unique(albums.map(({ id }) => id))) invalid("year", "duplicate-album-id");
  if (!unique(sequence.map(({ id }) => id))) invalid("year", "duplicate-sequence-photo-id");
  const albumPhotoCount = albums.reduce((total, album) => total + album.count, 0);
  if (albumPhotoCount !== sequence.length || Number(value.scannedCount) < sequence.length) invalid("year", "index-count-mismatch");
  return { year: value.year, scannedCount: value.scannedCount, albums, sequence };
}

export function validateAlbumManifest(value: unknown, context?: AlbumValidationContext): AlbumManifest {
  if (!isRecord(value) || !Array.isArray(value.photos)) invalid("album", "invalid-manifest-shape");
  if (!context) invalid("album", "missing-validation-context");
  if (value.photos.length !== context.album.count) invalid("album", "album-count-mismatch");
  const photos = value.photos.map((photo) => validatePhoto(photo, context));
  if (!unique(photos.map(({ id }) => id))) invalid("album", "duplicate-photo-id");
  if (!unique(photos.map(({ albumSortPosition }) => String(albumSortPosition)))) invalid("album", "duplicate-album-position");
  if (!unique(photos.map(({ sortPosition }) => String(sortPosition)))) invalid("album", "duplicate-global-position");
  const sequencePositions = new Map(context.sequence.map((entry, index) => [entry.id, index]));
  for (const [albumPosition, photo] of photos.entries()) {
    if (photo.albumSortPosition !== albumPosition || photo.sortPosition !== sequencePositions.get(photo.id)) {
      invalid("album", "position-membership-mismatch");
    }
  }
  return { photos };
}
