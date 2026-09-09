import { useCallback, useEffect, useRef, useState } from "react";
import {
  archiveTargetAtRatio,
  nearestAnchorIndex,
  type ArchiveTarget,
  type ArchiveTimelineModel
} from "./archiveTimelineModel";
import { recordDiagnostic, updateDiagnostics } from "../debug/archiveDiagnostics";

interface ArchiveScrubberProps {
  model: ArchiveTimelineModel;
  activeYear: string;
  activeAlbumId: string | null;
  activeRatio: number;
  formatAlbumName: (name: string, year: string) => string;
  onCommit: (target: ArchiveTarget, intent: "scrub" | "jump") => void;
  onScrubStateChange?: (isScrubbing: boolean) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function resolveScrubberCommit(model: ArchiveTimelineModel, ratio: number) {
  return archiveTargetAtRatio(model, ratio, true);
}

export function ArchiveScrubber({
  model,
  activeYear,
  activeAlbumId,
  activeRatio,
  formatAlbumName,
  onCommit,
  onScrubStateChange
}: ArchiveScrubberProps) {
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const frameRef = useRef(0);
  const pendingRatioRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [target, setTarget] = useState<ArchiveTarget | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const targetFromClientY = useCallback((clientY: number, snap = false) => {
    const rect = scrubberRef.current?.getBoundingClientRect();
    if (!rect?.height) return null;
    return archiveTargetAtRatio(model, (clientY - rect.top) / rect.height, snap);
  }, [model]);

  const previewTarget = useCallback((next: ArchiveTarget | null) => {
    if (!next) return;
    setTarget(next);
  }, []);

  const flushPointer = useCallback(() => {
    frameRef.current = 0;
    if (pendingRatioRef.current === null) return;
    const ratio = pendingRatioRef.current;
    const next = archiveTargetAtRatio(model, ratio);
    updateDiagnostics({ scrubber: { dragging: true, target: next ? { year: next.year, albumId: next.albumId, ratio: next.ratio } : null } }, "scrubber-pointer-move", {
      pointerId: pointerIdRef.current,
      ratio: Math.round(ratio * 1000) / 1000,
      year: next?.year || null,
      albumId: next?.albumId || null
    });
    previewTarget(next);
  }, [model, previewTarget]);

  const settle = useCallback((event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (pointerIdRef.current !== event.pointerId) return;
    if (frameRef.current) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    const finalTarget = cancelled ? target : targetFromClientY(event.clientY, true);
    recordDiagnostic(cancelled ? "scrubber-pointer-cancel" : "scrubber-commit", {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      year: finalTarget?.year || null,
      albumId: finalTarget?.albumId || null,
      ratio: finalTarget?.ratio || null
    });
    if (!cancelled && finalTarget) {
      setTarget(finalTarget);
      onCommit(finalTarget, "scrub");
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      updateDiagnostics({ pointerCapture: { active: false, pointerId: event.pointerId, at: new Date().toISOString() } }, "scrubber-pointer-release", { pointerId: event.pointerId });
    }
    pointerIdRef.current = null;
    pendingRatioRef.current = null;
    setIsDragging(false);
    updateDiagnostics({ scrubber: { dragging: false, target: finalTarget ? { year: finalTarget.year, albumId: finalTarget.albumId, ratio: finalTarget.ratio } : null } });
    onScrubStateChange?.(false);
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setTarget(null), cancelled ? 0 : 700);
  }, [onCommit, onScrubStateChange, target, targetFromClientY]);

  useEffect(() => () => {
    if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
  }, []);

  if (!model.years.length) return null;

  const labelTarget = target || archiveTargetAtRatio(model, activeRatio);
  const displayRatio = isDragging && target ? target.ratio : activeRatio;
  const valueNow = Math.round(clamp(displayRatio, 0, 1) * 100);
  const label = labelTarget
    ? `${labelTarget.year}${labelTarget.albumName ? ` · ${formatAlbumName(labelTarget.albumName, labelTarget.year)}` : ""}`
    : activeYear;

  const commitAnchor = (ratio: number, intent: "scrub" | "jump" = "scrub") => {
    const nextTarget = resolveScrubberCommit(model, ratio);
    if (!nextTarget) return;
    setTarget(nextTarget);
    recordDiagnostic("scrubber-commit", { input: intent, year: nextTarget.year, albumId: nextTarget.albumId, ratio: nextTarget.ratio });
    onCommit(nextTarget, intent);
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setTarget(null), 700);
  };

  return (
    <div className={`archive-timeline ${isDragging ? "is-dragging" : ""}`}>
      <div className="archive-timeline__years" aria-label="Archive years">
        {model.years.map((year) => (
          <button
            key={year.year}
            className={year.year === activeYear ? "is-active" : ""}
            type="button"
            style={{ top: `${clamp(year.start, 0.035, 0.965) * 100}%` }}
            onClick={() => commitAnchor(year.start, "jump")}
            aria-current={year.year === activeYear ? "true" : undefined}
            aria-label={`Jump to ${year.year}`}
          >
            {year.year}
          </button>
        ))}
      </div>
      <div
        ref={scrubberRef}
        className="archive-timeline__scrubber"
        role="scrollbar"
        aria-label="Complete archive timeline"
        aria-controls="photo-grid"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={valueNow}
        aria-valuetext={label}
        tabIndex={0}
        onKeyDown={(event) => {
          const anchorIndex = nearestAnchorIndex(model, activeRatio);
          let ratio: number | null = null;
          if (event.key === "ArrowDown" || event.key === "ArrowRight") ratio = model.anchors[Math.min(model.anchors.length - 1, anchorIndex + 1)]?.ratio ?? 1;
          else if (event.key === "ArrowUp" || event.key === "ArrowLeft") ratio = model.anchors[Math.max(0, anchorIndex - 1)]?.ratio ?? 0;
          else if (event.key === "PageDown") {
            const yearIndex = Math.max(0, model.years.findIndex((year) => year.year === activeYear));
            ratio = model.years[Math.min(model.years.length - 1, yearIndex + 1)].start;
          } else if (event.key === "PageUp") {
            const yearIndex = Math.max(0, model.years.findIndex((year) => year.year === activeYear));
            ratio = model.years[Math.max(0, yearIndex - 1)].start;
          } else if (event.key === "Home") ratio = 0;
          else if (event.key === "End") ratio = 1;
          if (ratio === null) return;
          event.preventDefault();
          commitAnchor(ratio);
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse" && pointerIdRef.current === null) setTarget(targetFromClientY(event.clientY));
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          event.preventDefault();
          if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
          event.currentTarget.setPointerCapture(event.pointerId);
          const nextTarget = targetFromClientY(event.clientY, event.pointerType === "mouse");
          updateDiagnostics({
            pointerCapture: { active: true, pointerId: event.pointerId, pointerType: event.pointerType, at: new Date().toISOString() },
            scrubber: { dragging: true, target: nextTarget ? { year: nextTarget.year, albumId: nextTarget.albumId, ratio: nextTarget.ratio } : null }
          }, "scrubber-pointer-down", { pointerId: event.pointerId, pointerType: event.pointerType, clientY: Math.round(event.clientY) });
          pointerIdRef.current = event.pointerId;
          setIsDragging(true);
          onScrubStateChange?.(true);
          previewTarget(nextTarget);
        }}
        onPointerMove={(event) => {
          if (pointerIdRef.current === event.pointerId) {
            const rect = event.currentTarget.getBoundingClientRect();
            pendingRatioRef.current = clamp((event.clientY - rect.top) / rect.height, 0, 1);
            if (!frameRef.current) frameRef.current = window.requestAnimationFrame(flushPointer);
          } else if (event.pointerType === "mouse") {
            setTarget(targetFromClientY(event.clientY));
          }
        }}
        onPointerUp={(event) => settle(event)}
        onPointerCancel={(event) => settle(event, true)}
        onLostPointerCapture={(event) => {
          if (pointerIdRef.current !== event.pointerId) return;
          updateDiagnostics({ pointerCapture: { active: false, pointerId: event.pointerId, at: new Date().toISOString(), reason: "lost" } }, "scrubber-pointer-capture-lost", { pointerId: event.pointerId });
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse" && pointerIdRef.current === null) setTarget(null);
        }}
      >
        <div className="archive-timeline__track" aria-hidden="true">
          {model.years.map((year) => <span className="archive-timeline__year-tick" key={year.year} style={{ top: `${year.start * 100}%` }} />)}
          {model.years.flatMap((year) => year.albums.slice(1).map((album) => (
            <span
              className={`archive-timeline__tick ${year.year === activeYear && album.id === activeAlbumId ? "is-active" : ""}`}
              key={`${year.year}:${album.id}`}
              style={{ top: `${album.start * 100}%` }}
            />
          )))}
          <span className="archive-timeline__thumb" style={{ top: `${clamp(displayRatio, 0, 1) * 100}%` }} />
          <span className="archive-diagnostic-scrubber-target" style={{ top: `${clamp(labelTarget?.ratio ?? activeRatio, 0, 1) * 100}%` }} />
        </div>
        {isDragging || target ? (
          <div className="archive-timeline__label" style={{ top: `${clamp(labelTarget?.ratio ?? activeRatio, 0.06, 0.94) * 100}%` }}>
            <strong>{labelTarget?.year || activeYear}</strong>
            {labelTarget?.albumName ? <span>{formatAlbumName(labelTarget.albumName, labelTarget.year)}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
