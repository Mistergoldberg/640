import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Play,
  X,
} from "lucide-react";
import type { PlayerOnboardingExitReason } from "./playerOnboarding";

interface PlayerOnboardingProps {
  step: 1 | 2 | 3;
  desktopInstructions: boolean;
  targetRef: RefObject<HTMLElement | null>;
  descriptionId: string;
  onBack: () => void;
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
  targetRef,
  descriptionId,
  onBack,
  onNext,
  onExit
}: PlayerOnboardingProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const copy = COPY[step];
  const instruction = desktopInstructions ? copy.desktop : copy.mobile;

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
      className={`player-onboarding player-onboarding--step-${step} player-onboarding--${desktopInstructions ? "desktop" : "mobile"}`}
      data-onboarding-step={step}
    >
      {step === 1 ? (
        <div className="player-onboarding__frame-zones" aria-hidden="true">
          <span className="player-onboarding__frame-zone player-onboarding__frame-zone--back">
            <span className="player-onboarding__gesture-cue">
              <span className="player-onboarding__gesture-icon"><ArrowLeft size={21} strokeWidth={2} /></span>
              {!desktopInstructions ? (
                <span className="player-onboarding__gesture-copy"><strong>Previous</strong><small>Tap or hold</small></span>
              ) : null}
            </span>
          </span>
          <span className="player-onboarding__frame-zone player-onboarding__frame-zone--forward">
            <span className="player-onboarding__gesture-cue">
              <span className="player-onboarding__gesture-icon"><ArrowRight size={21} strokeWidth={2} /></span>
              {!desktopInstructions ? (
                <span className="player-onboarding__gesture-copy"><strong>Next</strong><small>Tap or hold</small></span>
              ) : null}
            </span>
          </span>
        </div>
      ) : targetRect ? (
        <>
          <div className="player-onboarding__spotlight" style={spotlightStyle} aria-hidden="true" />
          {!desktopInstructions ? (
            <div className="player-onboarding__target-hint" style={spotlightStyle} aria-hidden="true">
              <span className="player-onboarding__target-hint-dot" />
              {step === 2 ? "Tap to choose speed" : "Tap to add music"}
            </div>
          ) : null}
        </>
      ) : null}

      <section
        ref={panelRef}
        className="player-onboarding__card"
        role="dialog"
        aria-modal="false"
        aria-labelledby={`${descriptionId}-title`}
        aria-describedby={descriptionId}
      >
        <button
          className="player-onboarding__close"
          type="button"
          onClick={() => onExit("close")}
          aria-label="Close tutorial"
          title="Close tutorial"
        >
          <X aria-hidden="true" size={20} strokeWidth={2.2} />
        </button>
        <div className="player-onboarding__step-label">Quick tour</div>
        <div className="player-onboarding__progress" data-step={step} aria-hidden="true">
          {[1, 2, 3].map((indicator) => (
            <span
              key={indicator}
              className={indicator === step ? "is-current" : indicator < step ? "is-complete" : ""}
            />
          ))}
        </div>
        <h2 id={`${descriptionId}-title`}>{copy.title}</h2>
        <p className="player-onboarding__summary" id={descriptionId}>{instruction}</p>
        <div className="player-onboarding__actions">
          <button type="button" onClick={() => onExit("skip")} className="player-onboarding__skip">Skip</button>
          <div className="player-onboarding__navigation">
            {step > 1 ? (
              <button type="button" onClick={onBack} className="player-onboarding__back">
                <ArrowLeft aria-hidden="true" size={17} /> Back
              </button>
            ) : null}
            {step < 3 ? (
              <button type="button" onClick={onNext} className="player-onboarding__primary">
                {step === 1 ? "Speed" : "Music"} <ArrowRight aria-hidden="true" size={18} />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onExit("complete")}
                className="player-onboarding__primary"
                aria-label="Start slideshow"
              >
                Start <Play aria-hidden="true" size={17} fill="currentColor" />
              </button>
            )}
          </div>
        </div>
      </section>
      <span className="sr-only" role="status" aria-live="polite">Step {step} of 3, {copy.title}</span>
    </div>
  );
}
