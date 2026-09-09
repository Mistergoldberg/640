import { Component, useState, useSyncExternalStore, type ErrorInfo, type ReactNode } from "react";
import {
  diagnosticsEnabled,
  diagnosticsJson,
  getDiagnostics,
  recordDiagnostic,
  resetDiagnostics,
  setDiagnosticOverlay,
  subscribeDiagnostics,
  type DiagnosticOverlay
} from "./archiveDiagnostics";

const overlayLabels: Array<[DiagnosticOverlay, string]> = [
  ["year", "Year boundaries"],
  ["album", "Album boundaries"],
  ["rows", "Virtual row bounds"],
  ["anchor", "Current anchor"],
  ["measurement", "Estimated / measured"],
  ["scrubber-hit", "Scrubber hit area"],
  ["scrubber-target", "Scrubber target"],
  ["safe-area", "Safe-area bounds"]
];

function value(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("Copy was not available");
}

export function ArchiveDiagnosticsPanel() {
  const snapshot = useSyncExternalStore(subscribeDiagnostics, getDiagnostics, getDiagnostics);
  const [expanded, setExpanded] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  if (!diagnosticsEnabled()) return null;

  const rows: Array<[string, unknown]> = [
    ["Build", snapshot.buildCommit],
    ["UA", snapshot.userAgent],
    ["Platform", snapshot.platform],
    ["URL", snapshot.url],
    ["Navigation", snapshot.navigationType],
    ["Scroll Y / document", `${snapshot.scrollY} / ${snapshot.documentHeight}`],
    ["Layout viewport", snapshot.layoutViewport],
    ["Visual viewport", snapshot.visualViewport],
    ["Orientation", snapshot.orientation],
    ["Active year", snapshot.activeYear],
    ["Active album", snapshot.activeAlbum],
    ["Cached years", snapshot.cachedYears],
    ["Prefetched years", snapshot.prefetchedYears],
    ["Loading years", snapshot.loadingYears],
    ["Mounted years", snapshot.mountedYears],
    ["Year states", snapshot.yearStates],
    ["Virtual range", snapshot.virtualRange],
    ["Mounted rows / photos", `${snapshot.mountedRows} / ${snapshot.mountedPhotos}`],
    ["Loaded images", snapshot.loadedImages],
    ["Inactive images", snapshot.inactiveImageElements],
    ["Year cache entries", snapshot.yearCacheEntries],
    ["Retained year layouts", snapshot.retainedYearLayouts],
    ["Stable anchor", snapshot.stableAnchor],
    ["Restoration", snapshot.restoration],
    ["Restoration target", snapshot.restorationTarget],
    ["Scrubber", snapshot.scrubber],
    ["Pointer capture", snapshot.pointerCapture],
    ["Programmatic scroll", snapshot.lastProgrammaticScroll],
    ["Layout correction", snapshot.lastLayoutCorrection],
    ["Last resize", snapshot.lastResize],
    ["Archive observers", snapshot.observerCount],
    ["Last state change", snapshot.lastStateTimestamp]
  ];

  const copy = async () => {
    try {
      await copyText(diagnosticsJson());
      setActionStatus("Copied");
      recordDiagnostic("diagnostics-copy");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Copy failed");
      recordDiagnostic("diagnostics-copy-failed");
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([diagnosticsJson()], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `640x480-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setActionStatus("Downloaded");
    recordDiagnostic("diagnostics-download");
  };

  return (
    <>
      <aside className={`archive-diagnostics ${expanded ? "is-expanded" : ""}`} aria-label="Archive diagnostics">
        <button className="archive-diagnostics__toggle" type="button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
          <span>Archive QA</span>
          <span>{expanded ? "Collapse" : "Expand"}</span>
        </button>
        {expanded ? (
          <div className="archive-diagnostics__body">
            <div className="archive-diagnostics__actions">
              <button type="button" onClick={() => void copy()}>Copy diagnostics</button>
              <button type="button" onClick={download}>Download diagnostics</button>
              <button type="button" onClick={() => { resetDiagnostics(); setActionStatus("Reset"); }}>Reset diagnostics</button>
            </div>
            <span className="archive-diagnostics__status" role="status">{actionStatus} · {snapshot.events.length}/{200} events</span>
            <details>
              <summary>Layout overlays</summary>
              <div className="archive-diagnostics__overlays">
                {overlayLabels.map(([name, label]) => (
                  <label key={name}>
                    <input type="checkbox" checked={snapshot.overlays[name]} onChange={(event) => setDiagnosticOverlay(name, event.currentTarget.checked)} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </details>
            <dl>
              {rows.map(([label, fieldValue]) => (
                <div key={label}><dt>{label}</dt><dd>{value(fieldValue)}</dd></div>
              ))}
            </dl>
            <details>
              <summary>Recent events ({snapshot.events.length})</summary>
              <ol className="archive-diagnostics__events">
                {[...snapshot.events].reverse().map((event) => (
                  <li key={event.sequence}><time>{event.elapsedMs} ms</time> <strong>{event.type}</strong> {event.data ? value(event.data) : ""}</li>
                ))}
              </ol>
            </details>
          </div>
        ) : null}
      </aside>
      <div className="archive-diagnostic-safe-area" aria-hidden="true" />
    </>
  );
}

interface DiagnosticErrorBoundaryState {
  error: string | null;
}

export class DiagnosticErrorBoundary extends Component<{ children: ReactNode }, DiagnosticErrorBoundaryState> {
  state: DiagnosticErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): DiagnosticErrorBoundaryState {
    return { error: error.message || "Application render failed" };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    recordDiagnostic("react-error-boundary", {
      name: error.name,
      message: error.message,
      componentStack: info.componentStack?.slice(0, 2000)
    });
  }

  render() {
    if (this.state.error) return <main className="system-state"><h1>640×480</h1><p>Application render failed. Export the diagnostic report.</p></main>;
    return this.props.children;
  }
}
