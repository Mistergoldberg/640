export const DIAGNOSTIC_EVENT_LIMIT = 200;

export type DiagnosticOverlay =
  | "year"
  | "album"
  | "rows"
  | "anchor"
  | "measurement"
  | "scrubber-hit"
  | "scrubber-target"
  | "safe-area";

export interface DiagnosticEvent {
  sequence: number;
  type: string;
  at: string;
  elapsedMs: number;
  data?: Record<string, unknown>;
}

export interface DiagnosticSnapshot {
  schema: "640x480-year-window-qa-v1";
  sessionStartedAt: string;
  buildCommit: string;
  userAgent: string;
  platform: Record<string, unknown>;
  url: string;
  navigationType: string;
  scrollY: number;
  documentHeight: number;
  layoutViewport: { width: number; height: number };
  visualViewport: { width: number; height: number; offsetLeft: number; offsetTop: number; scale: number } | null;
  orientation: string;
  activeYear: string | null;
  activeAlbum: { year: string; id: string } | null;
  loadedYears: string[];
  cachedYears: string[];
  prefetchedYears: string[];
  loadingYears: string[];
  mountedYears: string[];
  yearStates: Record<string, string>;
  virtualRange: Record<string, unknown> | null;
  mountedRows: number;
  mountedPhotos: number;
  loadedImages: number;
  inactiveImageElements: number;
  yearCacheEntries: number;
  retainedYearLayouts: string[];
  stableAnchor: Record<string, unknown> | null;
  restoration: Record<string, unknown> | null;
  restorationTarget: Record<string, unknown> | null;
  scrubber: Record<string, unknown> | null;
  pointerCapture: Record<string, unknown> | null;
  lastProgrammaticScroll: Record<string, unknown> | null;
  lastLayoutCorrection: Record<string, unknown> | null;
  lastResize: Record<string, unknown> | null;
  observerCount: number;
  lastStateTimestamp: string;
  overlays: Record<DiagnosticOverlay, boolean>;
  events: DiagnosticEvent[];
}

const listeners = new Set<() => void>();
const sessionStart = new Date();
const sessionStartPerformance = typeof performance === "undefined" ? 0 : performance.now();
let sequence = 0;
let initialized = false;
let scrollTimer = 0;

export function diagnosticModeEnabled(search = typeof window === "undefined" ? "" : window.location.search) {
  return new URLSearchParams(search).get("debug") === "1";
}

const enabled = diagnosticModeEnabled();

function navigationType() {
  const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return entry?.type || "unknown";
}

function platformInformation(): Record<string, unknown> {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean; platform?: string } };
  return {
    platform: navigator.platform || "unknown",
    maxTouchPoints: navigator.maxTouchPoints || 0,
    language: navigator.language || "unknown",
    standalone: Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
    userAgentData: nav.userAgentData ? { mobile: nav.userAgentData.mobile, platform: nav.userAgentData.platform } : null
  };
}

function readViewport() {
  const visual = window.visualViewport;
  return {
    url: window.location.href,
    scrollY: Math.round(window.scrollY * 100) / 100,
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    layoutViewport: { width: window.innerWidth, height: window.innerHeight },
    visualViewport: visual ? {
      width: Math.round(visual.width * 100) / 100,
      height: Math.round(visual.height * 100) / 100,
      offsetLeft: Math.round(visual.offsetLeft * 100) / 100,
      offsetTop: Math.round(visual.offsetTop * 100) / 100,
      scale: visual.scale
    } : null,
    orientation: screen.orientation?.type || `${window.orientation ?? "unknown"}`
  };
}

const initialOverlays: Record<DiagnosticOverlay, boolean> = {
  year: false,
  album: false,
  rows: false,
  anchor: false,
  measurement: false,
  "scrubber-hit": false,
  "scrubber-target": false,
  "safe-area": false
};

let snapshot: DiagnosticSnapshot = typeof window === "undefined" ? {
  schema: "640x480-year-window-qa-v1",
  sessionStartedAt: sessionStart.toISOString(),
  buildCommit: "unknown",
  userAgent: "unknown",
  platform: {},
  url: "",
  navigationType: "unknown",
  scrollY: 0,
  documentHeight: 0,
  layoutViewport: { width: 0, height: 0 },
  visualViewport: null,
  orientation: "unknown",
  activeYear: null,
  activeAlbum: null,
  loadedYears: [],
  cachedYears: [],
  prefetchedYears: [],
  loadingYears: [],
  mountedYears: [],
  yearStates: {},
  virtualRange: null,
  mountedRows: 0,
  mountedPhotos: 0,
  loadedImages: 0,
  inactiveImageElements: 0,
  yearCacheEntries: 0,
  retainedYearLayouts: [],
  stableAnchor: null,
  restoration: null,
  restorationTarget: null,
  scrubber: null,
  pointerCapture: null,
  lastProgrammaticScroll: null,
  lastLayoutCorrection: null,
  lastResize: null,
  observerCount: 0,
  lastStateTimestamp: sessionStart.toISOString(),
  overlays: initialOverlays,
  events: []
} : {
  schema: "640x480-year-window-qa-v1",
  sessionStartedAt: sessionStart.toISOString(),
  buildCommit: import.meta.env.VITE_BUILD_COMMIT || "local-uncommitted",
  userAgent: navigator.userAgent,
  platform: platformInformation(),
  ...readViewport(),
  navigationType: navigationType(),
  activeYear: null,
  activeAlbum: null,
  loadedYears: [],
  cachedYears: [],
  prefetchedYears: [],
  loadingYears: [],
  mountedYears: [],
  yearStates: {},
  virtualRange: null,
  mountedRows: 0,
  mountedPhotos: 0,
  loadedImages: 0,
  inactiveImageElements: 0,
  yearCacheEntries: 0,
  retainedYearLayouts: [],
  stableAnchor: null,
  restoration: null,
  restorationTarget: null,
  scrubber: null,
  pointerCapture: null,
  lastProgrammaticScroll: null,
  lastLayoutCorrection: null,
  lastResize: null,
  observerCount: 0,
  lastStateTimestamp: sessionStart.toISOString(),
  overlays: initialOverlays,
  events: []
};

function emit() {
  for (const listener of listeners) listener();
}

function normalizeData(data: Record<string, unknown> | undefined) {
  if (!data) return undefined;
  return JSON.parse(JSON.stringify(data, (_key, value) => {
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    return value;
  })) as Record<string, unknown>;
}

export function boundedDiagnosticEvents(events: DiagnosticEvent[], event: DiagnosticEvent, limit = DIAGNOSTIC_EVENT_LIMIT) {
  return [...events, event].slice(-limit);
}

export function updateDiagnostics(fields: Partial<Omit<DiagnosticSnapshot, "events" | "overlays">>, eventType?: string, data?: Record<string, unknown>) {
  if (!enabled) return;
  const timestamp = new Date().toISOString();
  let events = snapshot.events;
  if (eventType) {
    events = boundedDiagnosticEvents(events, {
      sequence: ++sequence,
      type: eventType,
      at: timestamp,
      elapsedMs: Math.round((performance.now() - sessionStartPerformance) * 100) / 100,
      data: normalizeData(data)
    });
  }
  snapshot = { ...snapshot, ...(typeof window === "undefined" ? {} : readViewport()), ...fields, events, lastStateTimestamp: timestamp };
  emit();
}

export function recordDiagnostic(type: string, data?: Record<string, unknown>) {
  updateDiagnostics({}, type, data);
}

export function setDiagnosticOverlay(name: DiagnosticOverlay, active: boolean) {
  if (!enabled) return;
  document.documentElement.toggleAttribute(`data-debug-${name}`, active);
  snapshot = {
    ...snapshot,
    overlays: { ...snapshot.overlays, [name]: active },
    lastStateTimestamp: new Date().toISOString()
  };
  recordDiagnostic("overlay-change", { name, active });
}

export function getDiagnostics() {
  return snapshot;
}

export function subscribeDiagnostics(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetDiagnostics() {
  if (!enabled) return;
  sequence = 0;
  snapshot = { ...snapshot, events: [], lastStateTimestamp: new Date().toISOString() };
  recordDiagnostic("diagnostics-reset");
}

export function diagnosticsJson() {
  return JSON.stringify({ exportedAt: new Date().toISOString(), ...snapshot }, null, 2);
}

export function registerArchiveObserver(kind: string) {
  if (!enabled) return () => undefined;
  updateDiagnostics({ observerCount: snapshot.observerCount + 1 }, "observer-register", { kind });
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    updateDiagnostics({ observerCount: Math.max(0, snapshot.observerCount - 1) }, "observer-release", { kind });
  };
}

function errorDetails(reason: unknown) {
  if (reason instanceof Error) return { name: reason.name, message: reason.message };
  return { message: typeof reason === "string" ? reason.slice(0, 500) : "Non-Error rejection" };
}

export function initializeDiagnostics() {
  if (!enabled || initialized) return;
  initialized = true;
  recordDiagnostic("init", { buildCommit: snapshot.buildCommit, navigationType: snapshot.navigationType });

  const sampleScroll = () => {
    if (scrollTimer) return;
    scrollTimer = window.setTimeout(() => {
      scrollTimer = 0;
      updateDiagnostics(readViewport(), "native-scroll", { scrollY: window.scrollY });
    }, 250);
  };
  const viewportResize = () => {
    const fields = readViewport();
    const resize = { at: new Date().toISOString(), source: "layout-viewport", ...fields.layoutViewport, visualViewport: fields.visualViewport };
    updateDiagnostics({ ...fields, lastResize: resize }, "viewport-resize", resize);
  };
  const visualViewportChange = () => {
    const fields = readViewport();
    const resize = { at: new Date().toISOString(), source: "visual-viewport", visualViewport: fields.visualViewport };
    updateDiagnostics({ ...fields, lastResize: resize }, "visual-viewport-change", resize);
  };
  window.addEventListener("scroll", sampleScroll, { passive: true });
  window.addEventListener("resize", viewportResize, { passive: true });
  window.addEventListener("orientationchange", () => updateDiagnostics(readViewport(), "orientation-change", { orientation: readViewport().orientation }), { passive: true });
  window.visualViewport?.addEventListener("resize", visualViewportChange, { passive: true });
  window.visualViewport?.addEventListener("scroll", visualViewportChange, { passive: true });
  window.addEventListener("error", (event) => recordDiagnostic("unhandled-error", errorDetails(event.error || event.message)));
  window.addEventListener("unhandledrejection", (event) => recordDiagnostic("unhandled-rejection", errorDetails(event.reason)));
}

export function diagnosticsEnabled() {
  return enabled;
}
