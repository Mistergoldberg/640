export const DIAGNOSTIC_EVENT_LIMIT = 200;
const REDACTED = "[redacted]";

export type DiagnosticOverlay =
  | "year" | "album" | "rows" | "anchor" | "measurement"
  | "scrubber-hit" | "scrubber-target" | "safe-area";

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
  capabilities: { maxTouchPoints: number; standalone: boolean; mobile: boolean };
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
let scrollTimer = 0;

export function diagnosticModeEnabled(search = typeof window === "undefined" ? "" : window.location.search) {
  return new URLSearchParams(search).get("debug") === "1";
}

const enabled = diagnosticModeEnabled();

export function redactDiagnosticUrl(value: string) {
  try {
    const url = new URL(value, "https://pixilation.org");
    const redacted = new URL(`${url.origin}${url.pathname}`);
    for (const key of [...new Set(url.searchParams.keys())].sort()) redacted.searchParams.set(key, REDACTED);
    return `${redacted.origin}${redacted.pathname}${redacted.search}`;
  } catch {
    return REDACTED;
  }
}

const sensitiveKey = /(?:authorization|cookie|credential|email|error|exception|href|message|password|path|query|reason|secret|stack|token|url)/i;

function sanitizedValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (sensitiveKey.test(key)) {
    if (/(?:href|url)/i.test(key) && typeof value === "string") return redactDiagnosticUrl(value);
    return REDACTED;
  }
  if (value instanceof Error) return { name: value.name, detail: REDACTED };
  if (typeof value === "string") {
    if (/^(?:https?:\/\/|file:\/\/)/i.test(value)) return redactDiagnosticUrl(value);
    if (/(?:\/Users\/|\\Users\\|\/home\/)/i.test(value)) return REDACTED;
    return value.slice(0, 240);
  }
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (Array.isArray(value)) return value.slice(0, 250).map((entry) => sanitizedValue(entry, "", depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, sanitizedValue(entry, entryKey, depth + 1)]));
  }
  return value;
}

export function sanitizeDiagnosticData(data: Record<string, unknown> | undefined) {
  return data ? sanitizedValue(data) as Record<string, unknown> : undefined;
}

function navigationType() {
  const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return entry?.type || "unknown";
}

function browserCapabilities() {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean; platform?: string } };
  return {
    maxTouchPoints: navigator.maxTouchPoints || 0,
    standalone: Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
    mobile: Boolean(nav.userAgentData?.mobile)
  };
}

function readViewport() {
  const visual = window.visualViewport;
  return {
    url: redactDiagnosticUrl(window.location.href),
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
  year: false, album: false, rows: false, anchor: false, measurement: false,
  "scrubber-hit": false, "scrubber-target": false, "safe-area": false
};

const emptySnapshot = {
  activeYear: null, activeAlbum: null, loadedYears: [], cachedYears: [], prefetchedYears: [], loadingYears: [], mountedYears: [],
  yearStates: {}, virtualRange: null, mountedRows: 0, mountedPhotos: 0, loadedImages: 0, inactiveImageElements: 0,
  yearCacheEntries: 0, retainedYearLayouts: [], stableAnchor: null, restoration: null, restorationTarget: null, scrubber: null,
  pointerCapture: null, lastProgrammaticScroll: null, lastLayoutCorrection: null, lastResize: null, observerCount: 0,
  lastStateTimestamp: sessionStart.toISOString(), overlays: initialOverlays, events: []
};

let snapshot: DiagnosticSnapshot = typeof window === "undefined" ? {
  schema: "640x480-year-window-qa-v1", sessionStartedAt: sessionStart.toISOString(), buildCommit: "unknown",
  capabilities: { maxTouchPoints: 0, standalone: false, mobile: false }, url: "", navigationType: "unknown", scrollY: 0, documentHeight: 0, layoutViewport: { width: 0, height: 0 },
  visualViewport: null, orientation: "unknown", ...emptySnapshot
} : {
  schema: "640x480-year-window-qa-v1", sessionStartedAt: sessionStart.toISOString(), buildCommit: import.meta.env.VITE_BUILD_COMMIT || "local-uncommitted",
  capabilities: browserCapabilities(), ...readViewport(), navigationType: navigationType(), ...emptySnapshot
};

function publishDiagnosticsSnapshot() {
  if (typeof window === "undefined" || !enabled) return;
  (window as typeof window & { __PIXILATION_ARCHIVE_DIAGNOSTICS__?: DiagnosticSnapshot }).__PIXILATION_ARCHIVE_DIAGNOSTICS__ = snapshot;
}

function emit() {
  for (const listener of listeners) listener();
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
      data: sanitizeDiagnosticData(data)
    });
  }
  const viewport = typeof window === "undefined" ? {} : readViewport();
  const safeFields = sanitizedValue(fields) as Partial<Omit<DiagnosticSnapshot, "events" | "overlays">>;
  snapshot = { ...snapshot, ...viewport, ...safeFields, url: typeof window === "undefined" ? snapshot.url : (viewport as ReturnType<typeof readViewport>).url, events, lastStateTimestamp: timestamp };
  publishDiagnosticsSnapshot();
  emit();
}

export function recordDiagnostic(type: string, data?: Record<string, unknown>) {
  updateDiagnostics({}, type, data);
}

export function setDiagnosticOverlay(name: DiagnosticOverlay, active: boolean) {
  if (!enabled) return;
  document.documentElement.toggleAttribute(`data-debug-${name}`, active);
  snapshot = { ...snapshot, overlays: { ...snapshot.overlays, [name]: active }, lastStateTimestamp: new Date().toISOString() };
  recordDiagnostic("overlay-change", { name, active });
}

export function getDiagnostics() { return snapshot; }

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

export function diagnosticsExport(source: DiagnosticSnapshot = snapshot) {
  return {
    exportedAt: new Date().toISOString(),
    schema: source.schema,
    sessionStartedAt: source.sessionStartedAt,
    buildCommit: source.buildCommit,
    capabilities: source.capabilities,
    url: redactDiagnosticUrl(source.url),
    navigationType: source.navigationType,
    scrollY: source.scrollY,
    documentHeight: source.documentHeight,
    layoutViewport: source.layoutViewport,
    visualViewport: source.visualViewport,
    orientation: source.orientation,
    activeYear: source.activeYear,
    activeAlbum: source.activeAlbum,
    loadedYears: source.loadedYears,
    cachedYears: source.cachedYears,
    loadingYears: source.loadingYears,
    mountedYears: source.mountedYears,
    yearStates: source.yearStates,
    virtualRange: sanitizeDiagnosticData(source.virtualRange || undefined) || null,
    mountedRows: source.mountedRows,
    mountedPhotos: source.mountedPhotos,
    loadedImages: source.loadedImages,
    inactiveImageElements: source.inactiveImageElements,
    yearCacheEntries: source.yearCacheEntries,
    retainedYearLayouts: source.retainedYearLayouts,
    stableAnchor: sanitizeDiagnosticData(source.stableAnchor || undefined) || null,
    restoration: sanitizeDiagnosticData(source.restoration || undefined) || null,
    restorationTarget: sanitizeDiagnosticData(source.restorationTarget || undefined) || null,
    observerCount: source.observerCount,
    lastStateTimestamp: source.lastStateTimestamp,
    overlays: source.overlays,
    events: source.events.map((event) => ({ ...event, data: sanitizeDiagnosticData(event.data) }))
  };
}

export function diagnosticsJson() {
  return JSON.stringify(diagnosticsExport(), null, 2);
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
  return { name: reason instanceof Error ? reason.name : "NonErrorRejection", detail: REDACTED };
}

export function createIdempotentSetup(setup: () => () => void) {
  let active = false;
  let cleanup: (() => void) | null = null;
  const dispose = () => {
    if (!active) return;
    active = false;
    const current = cleanup;
    cleanup = null;
    current?.();
  };
  return () => {
    if (!active) {
      active = true;
      cleanup = setup();
    }
    return dispose;
  };
}

const initializeDiagnosticListeners = createIdempotentSetup(() => {
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
  const orientationChange = () => updateDiagnostics(readViewport(), "orientation-change", { orientation: readViewport().orientation });
  const unhandledError = (event: ErrorEvent) => recordDiagnostic("unhandled-error", errorDetails(event.error || event.message));
  const unhandledRejection = (event: PromiseRejectionEvent) => recordDiagnostic("unhandled-rejection", errorDetails(event.reason));

  window.addEventListener("scroll", sampleScroll, { passive: true });
  window.addEventListener("resize", viewportResize, { passive: true });
  window.addEventListener("orientationchange", orientationChange, { passive: true });
  window.visualViewport?.addEventListener("resize", visualViewportChange, { passive: true });
  window.visualViewport?.addEventListener("scroll", visualViewportChange, { passive: true });
  window.addEventListener("error", unhandledError);
  window.addEventListener("unhandledrejection", unhandledRejection);

  return () => {
    window.removeEventListener("scroll", sampleScroll);
    window.removeEventListener("resize", viewportResize);
    window.removeEventListener("orientationchange", orientationChange);
    window.visualViewport?.removeEventListener("resize", visualViewportChange);
    window.visualViewport?.removeEventListener("scroll", visualViewportChange);
    window.removeEventListener("error", unhandledError);
    window.removeEventListener("unhandledrejection", unhandledRejection);
    if (scrollTimer) window.clearTimeout(scrollTimer);
    scrollTimer = 0;
  };
});

export function initializeDiagnostics() {
  if (!enabled) return () => undefined;
  const dispose = initializeDiagnosticListeners();
  if (snapshot.events.every((event) => event.type !== "init")) {
    recordDiagnostic("init", { buildCommit: snapshot.buildCommit, navigationType: snapshot.navigationType });
  }
  return dispose;
}

export function diagnosticsEnabled() { return enabled; }
