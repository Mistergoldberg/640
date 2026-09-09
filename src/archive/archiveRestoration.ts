import type { Catalog } from "../types";

export const ARCHIVE_RESTORATION_SCHEMA = "year-window-archive-v1";
export const ARCHIVE_HISTORY_APP = "640x480";
export const MAX_ARCHIVE_ANCHOR_ADJUSTMENT_PX = 160;

export type ArchiveRestorationPhase =
  | "idle"
  | "pending-target"
  | "waiting-for-layout"
  | "applying"
  | "settled"
  | "cancelled";

export type ArchiveRestorationSource = "root" | "url" | "history" | "scrub" | "jump" | "boundary" | "photo-close";

export interface StoredArchiveAnchor {
  schema: typeof ARCHIVE_RESTORATION_SCHEMA;
  catalogueId: string;
  entryId: string;
  year: string;
  albumId: string | null;
  photoId: string | null;
  adjustmentPx: number;
}

export interface ArchiveRestorationTarget extends StoredArchiveAnchor {
  source: ArchiveRestorationSource;
  focusPhoto: boolean;
}

export interface ArchiveHistoryState {
  app: typeof ARCHIVE_HISTORY_APP;
  entryId: string;
  year: string;
  photoId: string | null;
  view: "grid" | "photo";
  fromGrid: boolean;
  restoration: StoredArchiveAnchor;
}

export interface ArchiveRestorationState {
  phase: ArchiveRestorationPhase;
  generation: number;
  target: ArchiveRestorationTarget | null;
  settledYear: string | null;
}

export type ArchiveRestorationEvent =
  | { type: "request"; target: ArchiveRestorationTarget }
  | { type: "wait-for-layout"; generation: number }
  | { type: "apply"; generation: number }
  | { type: "settle"; generation: number; visibleYear: string }
  | { type: "cancel"; generation?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function validOptionalId(value: unknown) {
  return value === null || (typeof value === "string" && value.length > 0 && value.length < 256);
}

export function archiveCatalogueIdentity(catalog: Catalog) {
  return `${ARCHIVE_RESTORATION_SCHEMA}:${catalog.years.map(({ year, indexUrl }) => `${year}:${indexUrl}`).join("|")}`;
}

export function createHistoryEntryId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function clampArchiveAdjustment(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_ARCHIVE_ANCHOR_ADJUSTMENT_PX, Math.min(MAX_ARCHIVE_ANCHOR_ADJUSTMENT_PX, Math.round(value)));
}

export function createStoredArchiveAnchor({
  catalogueId,
  entryId,
  year,
  albumId = null,
  photoId = null,
  adjustmentPx = 0
}: Omit<StoredArchiveAnchor, "schema" | "albumId" | "photoId" | "adjustmentPx"> & Partial<Pick<StoredArchiveAnchor, "albumId" | "photoId" | "adjustmentPx">>): StoredArchiveAnchor {
  return {
    schema: ARCHIVE_RESTORATION_SCHEMA,
    catalogueId,
    entryId,
    year,
    albumId,
    photoId,
    adjustmentPx: clampArchiveAdjustment(adjustmentPx)
  };
}

export function readArchiveHistoryState(value: unknown): ArchiveHistoryState | null {
  if (!isRecord(value) || value.app !== ARCHIVE_HISTORY_APP || typeof value.entryId !== "string") return null;
  if (typeof value.year !== "string" || !validOptionalId(value.photoId)) return null;
  if (value.view !== "grid" && value.view !== "photo") return null;
  if (typeof value.fromGrid !== "boolean") return null;
  if (!isRecord(value.restoration)) return null;
  return value as unknown as ArchiveHistoryState;
}

export function validateStoredArchiveAnchor(value: unknown, {
  catalogueId,
  years,
  urlYear,
  entryId
}: {
  catalogueId: string;
  years: readonly string[];
  urlYear?: string | null;
  entryId?: string | null;
}): StoredArchiveAnchor | null {
  if (!isRecord(value) || value.schema !== ARCHIVE_RESTORATION_SCHEMA) return null;
  if (value.catalogueId !== catalogueId || typeof value.entryId !== "string" || !value.entryId) return null;
  if (entryId && value.entryId !== entryId) return null;
  if (typeof value.year !== "string" || !years.includes(value.year)) return null;
  if (urlYear && value.year !== urlYear) return null;
  if (!validOptionalId(value.albumId) || !validOptionalId(value.photoId)) return null;
  if (value.adjustmentPx !== undefined && typeof value.adjustmentPx !== "number") return null;
  return createStoredArchiveAnchor({
    catalogueId,
    entryId: value.entryId,
    year: value.year,
    albumId: value.albumId as string | null,
    photoId: value.photoId as string | null,
    adjustmentPx: typeof value.adjustmentPx === "number" ? value.adjustmentPx : 0
  });
}

export function createArchiveRestorationTarget(anchor: StoredArchiveAnchor, source: ArchiveRestorationSource, focusPhoto = false): ArchiveRestorationTarget {
  return { ...anchor, source, focusPhoto };
}

export function resolveNavigationRestoration({
  catalog,
  href,
  historyState,
  navigationType,
  entryId = createHistoryEntryId()
}: {
  catalog: Catalog;
  href: string;
  historyState: unknown;
  navigationType: "navigate" | "reload" | "back_forward" | "prerender";
  entryId?: string;
}): ArchiveRestorationTarget {
  const years = catalog.years.map(({ year }) => year);
  const newestYear = years[0];
  if (!newestYear) throw new Error("Archive catalogue has no years");
  const catalogueId = archiveCatalogueIdentity(catalog);
  const url = new URL(href);
  const requestedYear = url.searchParams.get("year");
  const explicitYear = requestedYear && years.includes(requestedYear) ? requestedYear : null;
  const explicitPhoto = explicitYear ? url.searchParams.get("photo") : null;
  const state = readArchiveHistoryState(historyState);
  const stored = state
    ? validateStoredArchiveAnchor(state.restoration, { catalogueId, years, urlYear: explicitYear, entryId: state.entryId })
    : null;
  const mayRestoreEntry = navigationType === "reload" || navigationType === "back_forward";

  if (explicitYear) {
    if (stored && mayRestoreEntry && (!explicitPhoto || stored.photoId === explicitPhoto)) {
      return createArchiveRestorationTarget(stored, "history", false);
    }
    return createArchiveRestorationTarget(createStoredArchiveAnchor({
      catalogueId,
      entryId: state?.entryId || entryId,
      year: explicitYear,
      photoId: explicitPhoto
    }), "url", false);
  }

  if (stored && mayRestoreEntry) return createArchiveRestorationTarget(stored, "history", false);
  return createArchiveRestorationTarget(createStoredArchiveAnchor({ catalogueId, entryId, year: newestYear }), "root", false);
}

export function resolveAnchorAgainstStableIds(anchor: StoredArchiveAnchor, {
  layoutReady,
  albumIds,
  photoIds
}: {
  layoutReady: boolean;
  albumIds: ReadonlySet<string>;
  photoIds: ReadonlySet<string>;
}): { status: "waiting" | "ready"; anchor: StoredArchiveAnchor } {
  if (!layoutReady) return { status: "waiting", anchor };
  if (anchor.photoId && !photoIds.has(anchor.photoId)) {
    return { status: "ready", anchor: createStoredArchiveAnchor({ ...anchor, albumId: null, photoId: null, adjustmentPx: 0 }) };
  }
  if (anchor.albumId && !albumIds.has(anchor.albumId)) {
    return { status: "ready", anchor: createStoredArchiveAnchor({ ...anchor, albumId: null, adjustmentPx: 0 }) };
  }
  return { status: "ready", anchor };
}

export function createArchiveRestorationState(): ArchiveRestorationState {
  return { phase: "idle", generation: 0, target: null, settledYear: null };
}

export function archiveRestorationReducer(state: ArchiveRestorationState, event: ArchiveRestorationEvent): ArchiveRestorationState {
  if (event.type === "request") {
    return { phase: "pending-target", generation: state.generation + 1, target: event.target, settledYear: null };
  }
  if (event.generation !== undefined && event.generation !== state.generation) return state;
  if (event.type === "wait-for-layout" && state.target && state.phase === "pending-target") {
    return { ...state, phase: "waiting-for-layout" };
  }
  if (event.type === "apply" && state.target && (state.phase === "pending-target" || state.phase === "waiting-for-layout")) {
    return { ...state, phase: "applying" };
  }
  if (event.type === "settle" && state.target && state.phase === "applying") {
    return { ...state, phase: "settled", settledYear: event.visibleYear };
  }
  if (event.type === "cancel" && (state.phase === "pending-target" || state.phase === "waiting-for-layout" || state.phase === "applying")) {
    return { ...state, phase: "cancelled" };
  }
  return state;
}

export function restorationIsPending(state: ArchiveRestorationState) {
  return state.phase === "pending-target" || state.phase === "waiting-for-layout" || state.phase === "applying";
}

export function ownedLegacyRestorationKeys(years: readonly string[]) {
  return [
    "640x480-selected-year",
    ...years.flatMap((year) => [`640x480-scroll:${year}`, `640x480-anchor:${year}`])
  ];
}
