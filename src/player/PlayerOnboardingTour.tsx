import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  ArrowLeft,
  ArrowRight,
} from "lucide-react";
import {
  PLAYER_ONBOARDING_CONTROL_FRAME_MS,
  PLAYER_ONBOARDING_SEQUENCE_FRAME_MS,
  type PlayerOnboardingExitReason
} from "./playerOnboarding";

interface PlayerOnboardingProps {
  step: 1 | 2 | 3;
  desktopInstructions: boolean;
  reducedMotion: boolean;
  imageRef: RefObject<HTMLImageElement | null>;
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

export function PlayerOnboardingTour({
  step,
  desktopInstructions,
  reducedMotion,
  imageRef,
  targetRef,
  descriptionId,
  onDemonstrate,
  onNext,
  onExit
}: PlayerOnboardingProps) {
  const desktopPromptRef = useRef<HTMLButtonElement | null>(null);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [imageRect, setImageRect] = useState<TargetRect | null>(null);
  const [browseSequenceIndex, setBrowseSequenceIndex] = useState(0);
  const copy = COPY[step];
  const instruction = desktopInstructions ? copy.desktop : copy.mobile;
  const browseSequenceFrame = BROWSE_SEQUENCE[browseSequenceIndex];
  const sequenceFrame = step === 1
    ? reducedMotion ? "browse" : browseSequenceFrame.frame
    : step === 2 ? "speed" : "music";
  const sequencePosition = step === 1 ? browseSequenceIndex + 1 : step + 3;
  const prompt = step === 1 ? "Tap to play" : step === 2 ? "Adjust Speed" : "Add Music";
  const mobileInstructions = !desktopInstructions;

  useEffect(() => {
    if (step !== 1 || (reducedMotion && !mobileInstructions)) return;

    let sequenceIndex = 0;
    let frame = 0;
    let timer = 0;
    const presentFrame = () => {
      setBrowseSequenceIndex(sequenceIndex);
      if (!reducedMotion) {
        frame = window.requestAnimationFrame(() => onDemonstrate(BROWSE_SEQUENCE[sequenceIndex].direction));
      }
      timer = window.setTimeout(() => {
        sequenceIndex += 1;
        if (sequenceIndex < BROWSE_SEQUENCE.length) presentFrame();
        else if (mobileInstructions) onNext();
      }, PLAYER_ONBOARDING_SEQUENCE_FRAME_MS);
    };
    presentFrame();
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [mobileInstructions, onDemonstrate, onNext, reducedMotion, step]);

  useEffect(() => {
    if (!mobileInstructions || step === 1) return;
    const timer = window.setTimeout(() => {
      if (step === 2) onNext();
      else onExit(reducedMotion ? "auto-complete" : "complete");
    }, PLAYER_ONBOARDING_CONTROL_FRAME_MS);
    return () => window.clearTimeout(timer);
  }, [mobileInstructions, onExit, onNext, reducedMotion, step]);

  useLayoutEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = targetRef.current?.getBoundingClientRect();
      const photoRect = imageRef.current?.getBoundingClientRect();
      setTargetRect(rect && rect.width > 0 && rect.height > 0
        ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
        : null);
      setImageRect(photoRect && photoRect.width > 0 && photoRect.height > 0
        ? { top: photoRect.top, left: photoRect.left, width: photoRect.width, height: photoRect.height }
        : null);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    if (step === 1 && targetRef.current) observer.observe(targetRef.current, { childList: true, subtree: true });
    document.addEventListener("load", schedule, true);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      document.removeEventListener("load", schedule, true);
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [imageRef, step, targetRef]);

  useEffect(() => {
    const focusTarget = () => desktopInstructions ? desktopPromptRef.current : targetRef.current;
    const frame = window.requestAnimationFrame(() => focusTarget()?.focus({ preventScroll: true }));
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onExit("escape");
        return;
      }
      if (event.key !== "Tab" || !desktopInstructions || !desktopPromptRef.current) return;
      event.preventDefault();
      desktopPromptRef.current.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [desktopInstructions, onExit, step, targetRef]);

  const spotlightStyle = useMemo(() => targetRect ? {
    "--onboarding-target-top": `${targetRect.top}px`,
    "--onboarding-target-left": `${targetRect.left}px`,
    "--onboarding-target-width": `${targetRect.width}px`,
    "--onboarding-target-height": `${targetRect.height}px`
  } as CSSProperties : undefined, [targetRect]);
  const imageStyle = useMemo(() => imageRect ? {
    "--onboarding-image-top": `${imageRect.top}px`,
    "--onboarding-image-left": `${imageRect.left}px`,
    "--onboarding-image-width": `${imageRect.width}px`,
    "--onboarding-image-height": `${imageRect.height}px`
  } as CSSProperties : undefined, [imageRect]);

  return (
    <div
      className={`player-onboarding${desktopInstructions ? "" : " player-onboarding--mobile"}${step === 1 && !reducedMotion ? " is-auto-sequencing" : ""}`}
      data-onboarding-frame={sequenceFrame}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${descriptionId}-title`}
      aria-describedby={descriptionId}
    >
      <h2 className="sr-only" id={`${descriptionId}-title`}>{copy.title}</h2>
      <p className="sr-only" id={descriptionId}>{instruction}</p>

      {step === 1 ? (
        <div className="player-onboarding__frame-zones" style={imageStyle} aria-hidden="true">
          <span className={`player-onboarding__frame-zone player-onboarding__frame-zone--back${browseSequenceFrame.direction < 0 && !reducedMotion ? " is-demo-active" : ""}`}>
            <span className={`player-onboarding__gesture-cue${browseSequenceFrame.direction < 0 && !reducedMotion ? " is-demo-active" : ""}`}>
              <span className="player-onboarding__gesture-icon"><ArrowLeft size={21} strokeWidth={2} /></span>
            </span>
          </span>
          <span className={`player-onboarding__frame-zone player-onboarding__frame-zone--forward${browseSequenceFrame.direction > 0 && !reducedMotion ? " is-demo-active" : ""}`}>
            <span className={`player-onboarding__gesture-cue${browseSequenceFrame.direction > 0 && !reducedMotion ? " is-demo-active" : ""}`}>
              <span className="player-onboarding__gesture-icon"><ArrowRight size={21} strokeWidth={2} /></span>
            </span>
          </span>
        </div>
      ) : targetRect ? (
        <>
          <div className="player-onboarding__spotlight" style={spotlightStyle} aria-hidden="true" />
        </>
      ) : null}

      {desktopInstructions && step === 1 ? (
        <button
          ref={desktopPromptRef}
          className="player-onboarding__center-prompt player-onboarding__center-prompt--browse player-onboarding__center-prompt--interactive"
          style={imageStyle}
          type="button"
          onClick={() => onExit("complete")}
          aria-describedby={descriptionId}
        >
          Tap to play
        </button>
      ) : (
        <div
          className={`player-onboarding__center-prompt player-onboarding__center-prompt--${step === 1 ? "browse" : "controls"}`}
          style={step === 1 ? imageStyle : undefined}
          aria-hidden="true"
        >
          {prompt}
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {desktopInstructions
          ? "Tap to play"
          : reducedMotion
          ? `Step ${step} of 3, ${copy.title}`
          : `Step ${sequencePosition} of 6, ${step === 1 ? `${browseSequenceFrame.label}, Tap to play` : prompt}`}
      </span>
    </div>
  );
}
