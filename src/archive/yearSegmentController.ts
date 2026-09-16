import type { GridLayout } from "./yearSegmentLayout";

export type SegmentPosition = -1 | 0 | 1;
export type SegmentStatus = "idle" | "prefetching" | "ready" | "mounted" | "spacer" | "error";

export interface SegmentAnchors {
  top: number;
  bottom: number;
}

export interface RetainedCollection<TCollection> {
  year: string;
  catalogueRevision: string;
  collection: TCollection;
  touchedAt: number;
}

export interface YearSegment<TCollection = unknown, TRowPlan = GridLayout> {
  id: string;
  year: string;
  position: SegmentPosition;
  status: SegmentStatus;
  catalogueRevision: string;
  calculatedWidth: number;
  calculatedHeight: number;
  rowPlan: TRowPlan | null;
  anchors: SegmentAnchors;
  loadGeneration: number;
  retryCount: number;
  errorMessage: string | null;
  containsVisualAnchor: boolean;
  safeToReclaim: boolean;
  mountAfterLoad: boolean;
  spacerHeight: number;
  retainedCollectionKey: string | null;
  collection?: TCollection;
}

export interface YearSegmentControllerState<TCollection = unknown, TRowPlan = GridLayout> {
  catalogueRevision: string;
  activeYear: string;
  years: string[];
  maxMountedSegments: number;
  maxRetainedCollections: number;
  segments: Map<string, YearSegment<TCollection, TRowPlan>>;
  retainedCollections: Map<string, RetainedCollection<TCollection>>;
  clock: number;
}

export interface CreateSegmentControllerOptions {
  years: string[];
  activeYear: string;
  catalogueRevision: string;
  width?: number;
  maxMountedSegments?: number;
  maxRetainedCollections?: number;
}

export interface SegmentLoadRequest {
  year: string;
  segmentId: string;
  generation: number;
  duplicate: boolean;
}

export interface CompleteSegmentLoadInput<TCollection, TRowPlan> {
  year: string;
  generation: number;
  collection: TCollection;
  rowPlan: TRowPlan;
  width: number;
  height: number;
}

export interface SegmentRetryResult<TCollection, TRowPlan> {
  state: YearSegmentControllerState<TCollection, TRowPlan>;
  request: SegmentLoadRequest;
}

export type SegmentReclamationBlockReason =
  | "not-mounted"
  | "active-year"
  | "visual-anchor"
  | "protected-operation"
  | "pending-operation"
  | "inside-viewport"
  | "inside-safety-margin"
  | "missing-geometry"
  | "not-needed";

export interface SegmentReclamationEligibilityInput<TCollection = unknown, TRowPlan = GridLayout> {
  segment: YearSegment<TCollection, TRowPlan> | null | undefined;
  activeYear: string;
  visualAnchorYear: string | null;
  pendingYears?: ReadonlySet<string>;
  protectedYears?: ReadonlySet<string>;
  viewportTop: number;
  viewportBottom: number;
  safetyMargin: number;
  segmentTop: number;
  segmentBottom: number;
  neededForWindow: boolean;
}

export interface SegmentReclamationEligibility {
  eligible: boolean;
  reasons: SegmentReclamationBlockReason[];
}

export function segmentIdentity(year: string, catalogueRevision: string) {
  return `${catalogueRevision}:${year}`;
}

export function collectionIdentity(year: string, catalogueRevision: string) {
  return `${catalogueRevision}:${year}:collection`;
}

function positionForYear(years: readonly string[], activeYear: string, year: string): SegmentPosition {
  const activeIndex = years.indexOf(activeYear);
  const yearIndex = years.indexOf(year);
  if (activeIndex < 0 || yearIndex < 0) return 0;
  const delta = yearIndex - activeIndex;
  return delta < 0 ? -1 : delta > 0 ? 1 : 0;
}

function cloneState<TCollection, TRowPlan>(
  state: YearSegmentControllerState<TCollection, TRowPlan>
): YearSegmentControllerState<TCollection, TRowPlan> {
  return {
    ...state,
    segments: new Map(state.segments),
    retainedCollections: new Map(state.retainedCollections)
  };
}

function createSegment<TCollection, TRowPlan>(
  state: YearSegmentControllerState<TCollection, TRowPlan>,
  year: string
): YearSegment<TCollection, TRowPlan> {
  return {
    id: segmentIdentity(year, state.catalogueRevision),
    year,
    position: positionForYear(state.years, state.activeYear, year),
    status: "idle",
    catalogueRevision: state.catalogueRevision,
    calculatedWidth: 0,
    calculatedHeight: 0,
    rowPlan: null,
    anchors: { top: 0, bottom: 0 },
    loadGeneration: 0,
    retryCount: 0,
    errorMessage: null,
    containsVisualAnchor: year === state.activeYear,
    safeToReclaim: year !== state.activeYear,
    mountAfterLoad: false,
    spacerHeight: 0,
    retainedCollectionKey: null
  };
}

function getOrCreateSegment<TCollection, TRowPlan>(
  state: YearSegmentControllerState<TCollection, TRowPlan>,
  year: string
) {
  const existing = state.segments.get(year);
  if (existing) return existing;
  const segment = createSegment(state, year);
  state.segments.set(year, segment);
  return segment;
}

function mountedSegments<TCollection, TRowPlan>(state: YearSegmentControllerState<TCollection, TRowPlan>) {
  return [...state.segments.values()].filter((segment) => segment.status === "mounted");
}

function toSpacer<TCollection, TRowPlan>(segment: YearSegment<TCollection, TRowPlan>): YearSegment<TCollection, TRowPlan> {
  return {
    ...segment,
    status: "spacer",
    rowPlan: null,
    collection: undefined,
    safeToReclaim: !segment.containsVisualAnchor,
    spacerHeight: segment.spacerHeight || segment.calculatedHeight
  };
}

function enforceMountedLimit<TCollection, TRowPlan>(state: YearSegmentControllerState<TCollection, TRowPlan>) {
  let mounted = mountedSegments(state);
  while (mounted.length > state.maxMountedSegments) {
    const reclaimable = mounted
      .filter((segment) => !segment.containsVisualAnchor && segment.safeToReclaim)
      .sort((left, right) => Math.abs(right.position) - Math.abs(left.position) || right.year.localeCompare(left.year))[0];
    if (!reclaimable) break;
    state.segments.set(reclaimable.year, toSpacer(reclaimable));
    mounted = mountedSegments(state);
  }
}

function enforceCollectionLimit<TCollection, TRowPlan>(state: YearSegmentControllerState<TCollection, TRowPlan>) {
  while (state.retainedCollections.size > state.maxRetainedCollections) {
    const evictable = [...state.retainedCollections.values()]
      .filter((entry) => {
        const segment = state.segments.get(entry.year);
        return !segment?.containsVisualAnchor && segment?.status !== "mounted";
      })
      .sort((left, right) => left.touchedAt - right.touchedAt)[0] || [...state.retainedCollections.values()].sort((left, right) => left.touchedAt - right.touchedAt)[0];
    if (!evictable) break;
    state.retainedCollections.delete(collectionIdentity(evictable.year, evictable.catalogueRevision));
    const segment = state.segments.get(evictable.year);
    if (segment?.retainedCollectionKey === collectionIdentity(evictable.year, evictable.catalogueRevision)) {
      state.segments.set(evictable.year, { ...segment, retainedCollectionKey: null, collection: undefined });
    }
  }
}

export function createYearSegmentController<TCollection = unknown, TRowPlan = GridLayout>({
  years,
  activeYear,
  catalogueRevision,
  width = 0,
  maxMountedSegments = 2,
  maxRetainedCollections = 3
}: CreateSegmentControllerOptions): YearSegmentControllerState<TCollection, TRowPlan> {
  const state: YearSegmentControllerState<TCollection, TRowPlan> = {
    catalogueRevision,
    activeYear,
    years,
    maxMountedSegments,
    maxRetainedCollections,
    segments: new Map(),
    retainedCollections: new Map(),
    clock: 0
  };
  const active = createSegment<TCollection, TRowPlan>(state, activeYear);
  state.segments.set(activeYear, { ...active, status: "mounted", calculatedWidth: width });
  return state;
}

export function beginSegmentLoad<TCollection, TRowPlan>(
  current: YearSegmentControllerState<TCollection, TRowPlan>,
  year: string
): { state: YearSegmentControllerState<TCollection, TRowPlan>; request: SegmentLoadRequest } {
  const state = cloneState(current);
  const segment = getOrCreateSegment(state, year);
  if (segment.status === "prefetching") {
    return {
      state,
      request: { year, segmentId: segment.id, generation: segment.loadGeneration, duplicate: true }
    };
  }

  const generation = segment.loadGeneration + 1;
  state.segments.set(year, {
    ...segment,
    status: "prefetching",
    loadGeneration: generation,
    errorMessage: null,
    mountAfterLoad: segment.status === "mounted",
    safeToReclaim: !segment.containsVisualAnchor
  });
  return {
    state,
    request: { year, segmentId: segment.id, generation, duplicate: false }
  };
}

export function completeSegmentLoad<TCollection, TRowPlan>(
  current: YearSegmentControllerState<TCollection, TRowPlan>,
  input: CompleteSegmentLoadInput<TCollection, TRowPlan>
): { state: YearSegmentControllerState<TCollection, TRowPlan>; stale: boolean } {
  const state = cloneState(current);
  const segment = getOrCreateSegment(state, input.year);
  if (segment.loadGeneration !== input.generation || segment.status !== "prefetching") {
    return { state, stale: true };
  }

  const retainedCollectionKey = collectionIdentity(input.year, state.catalogueRevision);
  state.clock += 1;
  state.retainedCollections.set(retainedCollectionKey, {
    year: input.year,
    catalogueRevision: state.catalogueRevision,
    collection: input.collection,
    touchedAt: state.clock
  });
  state.segments.set(input.year, {
    ...segment,
    status: segment.mountAfterLoad ? "mounted" : "ready",
    calculatedWidth: input.width,
    calculatedHeight: input.height,
    rowPlan: input.rowPlan,
    anchors: { top: 0, bottom: input.height },
    errorMessage: null,
    mountAfterLoad: false,
    spacerHeight: input.height,
    retainedCollectionKey,
    collection: input.collection,
    safeToReclaim: !segment.containsVisualAnchor
  });
  enforceCollectionLimit(state);
  return { state, stale: false };
}

export function failSegmentLoad<TCollection, TRowPlan>(
  current: YearSegmentControllerState<TCollection, TRowPlan>,
  year: string,
  generation: number,
  errorMessage: string
) {
  const state = cloneState(current);
  const segment = getOrCreateSegment(state, year);
  if (segment.loadGeneration !== generation) return { state, stale: true };
  state.segments.set(year, {
    ...segment,
    status: "error",
    errorMessage,
    mountAfterLoad: false,
    safeToReclaim: !segment.containsVisualAnchor
  });
  return { state, stale: false };
}

export function retrySegment<TCollection, TRowPlan>(
  current: YearSegmentControllerState<TCollection, TRowPlan>,
  year: string
): SegmentRetryResult<TCollection, TRowPlan> {
  const state = cloneState(current);
  const segment = getOrCreateSegment(state, year);
  state.segments.set(year, { ...segment, retryCount: segment.retryCount + 1, status: "idle", errorMessage: null, mountAfterLoad: false });
  return beginSegmentLoad(state, year);
}

export function mountSegment<TCollection, TRowPlan>(
  current: YearSegmentControllerState<TCollection, TRowPlan>,
  year: string,
  containsVisualAnchor = false
) {
  const state = cloneState(current);
  const segment = getOrCreateSegment(state, year);
  state.segments.set(year, {
    ...segment,
    status: "mounted",
    containsVisualAnchor,
    safeToReclaim: !containsVisualAnchor,
    position: positionForYear(state.years, state.activeYear, year)
  });
  enforceMountedLimit(state);
  return state;
}

export function replaceSegmentWithSpacer<TCollection, TRowPlan>(
  current: YearSegmentControllerState<TCollection, TRowPlan>,
  year: string
): { state: YearSegmentControllerState<TCollection, TRowPlan>; replaced: boolean } {
  const state = cloneState(current);
  const segment = state.segments.get(year);
  if (!segment || segment.containsVisualAnchor || !segment.safeToReclaim) return { state, replaced: false };
  state.segments.set(year, toSpacer(segment));
  return { state, replaced: true };
}

export function restoreSegmentFromSpacer<TCollection, TRowPlan>(
  current: YearSegmentControllerState<TCollection, TRowPlan>,
  year: string,
  rowPlan: TRowPlan
) {
  const state = cloneState(current);
  const segment = state.segments.get(year);
  if (!segment || segment.status !== "spacer") return state;
  state.segments.set(year, {
    ...segment,
    status: "ready",
    rowPlan,
    calculatedHeight: segment.spacerHeight,
    anchors: { top: 0, bottom: segment.spacerHeight }
  });
  return state;
}

export function retainedCollectionCount(state: YearSegmentControllerState) {
  return state.retainedCollections.size;
}

export function mountedSegmentCount(state: YearSegmentControllerState) {
  return mountedSegments(state).length;
}

export function segmentReclamationEligibility<TCollection, TRowPlan>({
  segment,
  activeYear,
  visualAnchorYear,
  pendingYears = new Set(),
  protectedYears = new Set(),
  viewportTop,
  viewportBottom,
  safetyMargin,
  segmentTop,
  segmentBottom,
  neededForWindow
}: SegmentReclamationEligibilityInput<TCollection, TRowPlan>): SegmentReclamationEligibility {
  const reasons: SegmentReclamationBlockReason[] = [];
  if (!segment || segment.status !== "mounted") reasons.push("not-mounted");
  if (segment?.year === activeYear) reasons.push("active-year");
  if ((segment?.year && segment.year === visualAnchorYear) || segment?.containsVisualAnchor) reasons.push("visual-anchor");
  if (segment?.year && protectedYears.has(segment.year)) reasons.push("protected-operation");
  if ((segment?.year && pendingYears.has(segment.year)) || segment?.status === "prefetching") reasons.push("pending-operation");
  const outsideViewport = segmentBottom <= viewportTop || segmentTop >= viewportBottom;
  if (!outsideViewport) reasons.push("inside-viewport");
  const beyondMargin = segmentBottom < viewportTop - safetyMargin || segmentTop > viewportBottom + safetyMargin;
  if (!beyondMargin) reasons.push("inside-safety-margin");
  if (!segment || (segment.calculatedHeight <= 0 && segment.spacerHeight <= 0)) reasons.push("missing-geometry");
  if (!neededForWindow) reasons.push("not-needed");
  return { eligible: reasons.length === 0, reasons };
}
