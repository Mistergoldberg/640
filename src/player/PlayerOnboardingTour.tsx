import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { X } from "lucide-react";
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

const COPY = {
  1: {
    title: "Play the pictures",
    mobile: "Tap the right half to move forward. Tap the left half to move back. Press and hold either half to keep moving.",
    desktop: "Press → to move forward and ← to move back. Hold either key to keep moving. You can also click or hold either half of the picture, or scroll over it: down or right moves forward; up or left moves back."
  },
  2: {
    title: "Set the speed",
    mobile: "Playback speed is seconds per photo. Choose 0.1s, 0.25s, 0.5s, 1s, or 2s. Smaller numbers play faster.",
    desktop: "Playback speed is seconds per photo. Choose 0.1s, 0.25s, 0.5s, 1s, or 2s. Smaller numbers play faster."
  },
  3: {
    title: "Add music",
    mobile: "Music is optional. Choose Play music to load and start the soundtrack. Pixilation never starts music on its own.",
    desktop: "Music is optional. Choose Play music to load and start the soundtrack. Pixilation never starts music on its own."
  }
} as const;

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
  const body = desktopInstructions ? copy.desktop : copy.mobile;

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
    <div className={`player-onboarding player-onboarding--step-${step}`} data-onboarding-step={step}>
      {step === 1 ? (
        <div className="player-onboarding__frame-zones" aria-hidden="true">
          <span className="player-onboarding__frame-zone player-onboarding__frame-zone--back"><span>←</span></span>
          <span className="player-onboarding__frame-zone player-onboarding__frame-zone--forward"><span>→</span></span>
        </div>
      ) : targetRect ? <div className="player-onboarding__spotlight" style={spotlightStyle} aria-hidden="true" /> : null}

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
        <div className="player-onboarding__step-label">Step {step} of 3</div>
        <div className="player-onboarding__progress" aria-hidden="true">
          {[1, 2, 3].map((indicator) => (
            <span key={indicator} className={indicator === step ? "is-current" : indicator < step ? "is-complete" : ""}>{indicator}</span>
          ))}
        </div>
        <h2 id={`${descriptionId}-title`}>{copy.title}</h2>
        <p id={descriptionId}>{body}</p>
        <div className="player-onboarding__actions">
          <button type="button" onClick={() => onExit("skip")} className="player-onboarding__skip">Skip</button>
          <div className="player-onboarding__navigation">
            {step > 1 ? <button type="button" onClick={onBack}>Back</button> : null}
            {step < 3 ? (
              <button type="button" onClick={onNext} className="player-onboarding__primary">Next</button>
            ) : (
              <button type="button" onClick={() => onExit("complete")} className="player-onboarding__primary">Play the pictures</button>
            )}
          </div>
        </div>
      </section>
      <span className="sr-only" role="status" aria-live="polite">Step {step} of 3, {copy.title}</span>
    </div>
  );
}
