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
  onCommit: (target: ArchiveTarget, intent: "scrub") => void;
  onScrubStateChange?: (isScrubbing: boolean) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function resolveScrubberCommit(model: ArchiveTimelineModel, ratio: number) {
  return archiveTargetAtRatio(model, ratio, true);
}

export function boundedIndicatorTop(ratio: number, inset: number) {
  return `clamp(${inset}px, ${clamp(ratio, 0, 1) * 100}%, calc(100% - ${inset}px))`;
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

  const cancelActivePointer = useCallback((reason: "pointer-cancel" | "lost-capture" | "viewport-change") => {
    const pointerId = pointerIdRef.current;
    if (pointerId === null) return;
    if (frameRef.current) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    pointerIdRef.current = null;
    pendingRatioRef.current = null;
    if (scrubberRef.current?.hasPointerCapture(pointerId)) {
      scrubberRef.current.releasePointerCapture(pointerId);
    }
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    setIsDragging(false);
    setTarget(null);
    updateDiagnostics({
      pointerCapture: { active: false, pointerId, at: new Date().toISOString(), reason },
      scrubber: { dragging: false, target: null }
    }, "scrubber-pointer-cancel", { pointerId, reason });
    onScrubStateChange?.(false);
  }, [onScrubStateChange]);

  const settle = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    if (frameRef.current) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    const finalTarget = targetFromClientY(event.clientY, true);
    recordDiagnostic("scrubber-commit", {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      year: finalTarget?.year || null,
      albumId: finalTarget?.albumId || null,
      ratio: finalTarget?.ratio || null
    });
    if (finalTarget) {
      setTarget(finalTarget);
      onCommit(finalTarget, "scrub");
    }
    pointerIdRef.current = null;
    pendingRatioRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      updateDiagnostics({ pointerCapture: { active: false, pointerId: event.pointerId, at: new Date().toISOString() } }, "scrubber-pointer-release", { pointerId: event.pointerId });
    }
    setIsDragging(false);
    updateDiagnostics({ scrubber: { dragging: false, target: finalTarget ? { year: finalTarget.year, albumId: finalTarget.albumId, ratio: finalTarget.ratio } : null } });
    onScrubStateChange?.(false);
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setTarget(null), 700);
  }, [onCommit, onScrubStateChange, targetFromClientY]);

  useEffect(() => {
    if (!isDragging) return;
    const cancelForViewportChange = () => cancelActivePointer("viewport-change");
    window.addEventListener("resize", cancelForViewportChange);
    window.addEventListener("orientationchange", cancelForViewportChange);
    return () => {
      window.removeEventListener("resize", cancelForViewportChange);
      window.removeEventListener("orientationchange", cancelForViewportChange);
    };
  }, [cancelActivePointer, isDragging]);

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

  const commitAnchor = (ratio: number) => {
    const nextTarget = resolveScrubberCommit(model, ratio);
    if (!nextTarget) return;
    setTarget(nextTarget);
    recordDiagnostic("scrubber-commit", { input: "keyboard", year: nextTarget.year, albumId: nextTarget.albumId, ratio: nextTarget.ratio });
    onCommit(nextTarget, "scrub");
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setTarget(null), 700);
  };

  return (
    <div className={`archive-timeline ${isDragging ? "is-dragging" : ""}`}>
      <div
        ref={scrubberRef}
        className="archive-timeline__scrubber"
        role="slider"
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
          if (!event.isPrimary || pointerIdRef.current !== null) return;
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
        onPointerCancel={(event) => {
          if (pointerIdRef.current === event.pointerId) cancelActivePointer("pointer-cancel");
        }}
        onLostPointerCapture={(event) => {
          if (pointerIdRef.current !== event.pointerId) return;
          cancelActivePointer("lost-capture");
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse" && pointerIdRef.current === null) setTarget(null);
        }}
      >
        <div className="archive-timeline__track" aria-hidden="true">
          {model.years.map((year) => <span className={`archive-timeline__year-tick ${year.year === activeYear ? "is-active" : ""}`} key={year.year} style={{ top: boundedIndicatorTop(year.start, 1) }} />)}
          {model.years.flatMap((year) => year.albums.slice(1).map((album) => (
            <span
              className={`archive-timeline__tick ${year.year === activeYear && album.id === activeAlbumId ? "is-active" : ""}`}
              key={`${year.year}:${album.id}`}
              style={{ top: `${album.start * 100}%` }}
            />
          )))}
          <span className="archive-timeline__thumb" style={{ top: boundedIndicatorTop(displayRatio, 14) }} />
          <span className="archive-diagnostic-scrubber-target" style={{ top: boundedIndicatorTop(labelTarget?.ratio ?? activeRatio, 1) }} />
        </div>
        {isDragging || target ? (
          <div className="archive-timeline__label" style={{ top: boundedIndicatorTop(labelTarget?.ratio ?? activeRatio, 22) }}>
            <span>{label}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
