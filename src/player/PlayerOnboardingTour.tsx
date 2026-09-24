import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Play,
} from "lucide-react";
import {
  PLAYER_ONBOARDING_SEQUENCE_FRAME_MS,
  type PlayerOnboardingExitReason
} from "./playerOnboarding";

interface PlayerOnboardingProps {
  step: 1 | 2 | 3;
  desktopInstructions: boolean;
  reducedMotion: boolean;
  targetRef: RefObject<HTMLElement | null>;
  descriptionId: string;
  onDemonstrate: (direction: -1 | 1) => void;
  onNext: () => void;
  onExit: (reason: PlayerOnboardingExitReason) => void;
}

interface TutorialCopy {
  title: string;
  mobile: string;
  desktop: string;
}

const COPY: Record<1 | 2 | 3, TutorialCopy> = {
  1: {
    title: "Browse photos",
    mobile: "Tap either side to browse. Press and hold to keep moving.",
    desktop: "Click either side or use ← →. Hold to keep moving; scroll works too."
  },
  2: {
    title: "Set the pace",
    mobile: "0.1s is fastest. 2s is slowest.",
    desktop: "0.1s is fastest. 2s is slowest."
  },
  3: {
    title: "Add music",
    mobile: "Optional. Music starts only when you tap it.",
    desktop: "Optional. Music starts only when you choose Play music."
  }
};

const BROWSE_SEQUENCE = [
  { frame: "next-1", direction: 1 as const, label: "Next" },
  { frame: "previous-1", direction: -1 as const, label: "Previous" },
  { frame: "next-2", direction: 1 as const, label: "Next" },
  { frame: "previous-2", direction: -1 as const, label: "Previous" }
];

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function focusableElements(panel: HTMLElement, target: HTMLElement | null) {
  const menuButtons = Array.from(document.querySelectorAll<HTMLElement>(".speed-menu button:not(:disabled)"));
  const panelElements = Array.from(panel.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]:not([tabindex='-1'])"));
  return [target, ...menuButtons, ...panelElements].filter((element, index, values): element is HTMLElement =>
    Boolean(element) && !element!.hasAttribute("disabled") && values.indexOf(element) === index
  );
}

export function PlayerOnboardingTour({
  step,
  desktopInstructions,
  reducedMotion,
  targetRef,
  descriptionId,
  onDemonstrate,
  onNext,
  onExit
}: PlayerOnboardingProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement | null>(null);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [browseSequenceIndex, setBrowseSequenceIndex] = useState(0);
  const [showPlayPrompt, setShowPlayPrompt] = useState(false);
  const copy = COPY[step];
  const instruction = desktopInstructions ? copy.desktop : copy.mobile;
  const nextLabel = step === 1 ? "Speed" : step === 2 ? "Music" : "Play";
  const browseSequenceFrame = BROWSE_SEQUENCE[browseSequenceIndex];
  const sequenceFrame = step === 1
    ? reducedMotion ? "browse" : browseSequenceFrame.frame
    : step === 2 ? "speed" : showPlayPrompt ? "play" : "music";
  const sequencePosition = step === 1 ? browseSequenceIndex + 1 : step === 2 ? 5 : showPlayPrompt ? 7 : 6;
  const centerPrompt = step === 2 ? "Adjust Speed" : step === 3 ? showPlayPrompt ? "Tap to play" : "Add Music" : null;
  const accessibleTitle = showPlayPrompt ? "Tap to play" : copy.title;
  const accessibleInstruction = showPlayPrompt ? "Start the slideshow." : instruction;

  useEffect(() => {
    if (step !== 1 || reducedMotion) return;

    let sequenceIndex = 0;
    let frame = 0;
    let timer = 0;
    const presentFrame = () => {
      setBrowseSequenceIndex(sequenceIndex);
      frame = window.requestAnimationFrame(() => onDemonstrate(BROWSE_SEQUENCE[sequenceIndex].direction));
      timer = window.setTimeout(() => {
        sequenceIndex += 1;
        if (sequenceIndex < BROWSE_SEQUENCE.length) presentFrame();
        else onNext();
      }, PLAYER_ONBOARDING_SEQUENCE_FRAME_MS);
    };
    presentFrame();
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [onDemonstrate, onNext, reducedMotion, step]);

  useEffect(() => {
    if (reducedMotion || step === 1) return;
    if (step === 2) {
      const timer = window.setTimeout(onNext, PLAYER_ONBOARDING_SEQUENCE_FRAME_MS);
      return () => window.clearTimeout(timer);
    }

    setShowPlayPrompt(false);
    const promptTimer = window.setTimeout(() => setShowPlayPrompt(true), PLAYER_ONBOARDING_SEQUENCE_FRAME_MS);
    const completeTimer = window.setTimeout(() => onExit("complete"), PLAYER_ONBOARDING_SEQUENCE_FRAME_MS * 2);
    return () => {
      window.clearTimeout(promptTimer);
      window.clearTimeout(completeTimer);
    };
  }, [onExit, onNext, reducedMotion, step]);

  useEffect(() => {
    if (!showPlayPrompt) return;
    const frame = window.requestAnimationFrame(() => primaryActionRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [showPlayPrompt]);

  useLayoutEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = targetRef.current?.getBoundingClientRect();
      setTargetRect(rect && rect.width > 0 && rect.height > 0
        ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
        : null);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [step, targetRef]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => targetRef.current?.focus({ preventScroll: true }));
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onExit("escape");
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = focusableElements(panelRef.current, targetRef.current);
      if (!focusable.length) return;
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (current <= 0 ? focusable.length - 1 : current - 1)
        : (current < 0 || current >= focusable.length - 1 ? 0 : current + 1);
      event.preventDefault();
      focusable[next]?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onExit, step, targetRef]);

  const spotlightStyle = useMemo(() => targetRect ? {
    "--onboarding-target-top": `${targetRect.top}px`,
    "--onboarding-target-left": `${targetRect.left}px`,
    "--onboarding-target-width": `${targetRect.width}px`,
    "--onboarding-target-height": `${targetRect.height}px`
  } as CSSProperties : undefined, [targetRect]);

  return (
    <div
      className={`player-onboarding player-onboarding--step-${step} player-onboarding--${desktopInstructions ? "desktop" : "mobile"}${step === 1 && !reducedMotion ? " is-auto-sequencing" : ""}`}
      data-onboarding-step={step}
      data-onboarding-frame={sequenceFrame}
    >
      {step === 1 ? (
        <div className="player-onboarding__frame-zones" aria-hidden="true">
          <span className={`player-onboarding__frame-zone player-onboarding__frame-zone--back${browseSequenceFrame.direction < 0 && !reducedMotion ? " is-demo-active" : ""}`}>
            <span className={`player-onboarding__gesture-cue${browseSequenceFrame.direction < 0 && !reducedMotion ? " is-demo-active" : ""}`}>
              <span className="player-onboarding__gesture-icon"><ArrowLeft size={21} strokeWidth={2} /></span>
              {!desktopInstructions ? (
                <span className="player-onboarding__gesture-copy"><strong>Previous</strong><small>Tap or hold</small></span>
              ) : null}
            </span>
          </span>
          <span className={`player-onboarding__frame-zone player-onboarding__frame-zone--forward${browseSequenceFrame.direction > 0 && !reducedMotion ? " is-demo-active" : ""}`}>
            <span className={`player-onboarding__gesture-cue${browseSequenceFrame.direction > 0 && !reducedMotion ? " is-demo-active" : ""}`}>
              <span className="player-onboarding__gesture-icon"><ArrowRight size={21} strokeWidth={2} /></span>
              {!desktopInstructions ? (
                <span className="player-onboarding__gesture-copy"><strong>Next</strong><small>Tap or hold</small></span>
              ) : null}
            </span>
          </span>
        </div>
      ) : targetRect && !showPlayPrompt ? (
        <>
          <div className="player-onboarding__spotlight" style={spotlightStyle} aria-hidden="true" />
        </>
      ) : null}

      {centerPrompt ? (
        <div className="player-onboarding__center-prompt" aria-hidden="true">{centerPrompt}</div>
      ) : null}

      <section
        ref={panelRef}
        className="player-onboarding__action-bar"
        role="dialog"
        aria-modal="false"
        aria-labelledby={`${descriptionId}-title`}
        aria-describedby={descriptionId}
      >
        <h2 className="sr-only" id={`${descriptionId}-title`}>{accessibleTitle}</h2>
        <p className="sr-only" id={descriptionId}>{accessibleInstruction}</p>
        <button type="button" onClick={() => onExit("skip")} className="player-onboarding__skip">Skip</button>
        <button
          ref={primaryActionRef}
          type="button"
          onClick={step < 3 ? onNext : () => onExit("complete")}
          className="player-onboarding__primary"
          aria-label={step === 3 ? "Play slideshow" : nextLabel}
        >
          {nextLabel}
          {step < 3
            ? <ArrowRight aria-hidden="true" size={18} />
            : <Play aria-hidden="true" size={17} fill="currentColor" />}
        </button>
      </section>
      <span className="sr-only" role="status" aria-live="polite">
        {reducedMotion
          ? `Step ${step} of 3, ${copy.title}`
          : `Step ${sequencePosition} of 7, ${step === 1 ? browseSequenceFrame.label : centerPrompt}`}
      </span>
    </div>
  );
}
