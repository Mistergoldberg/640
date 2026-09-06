import { useEffect, useId, useRef } from "react";
import { Check, ChevronLeft, ChevronRight, Gauge, Maximize2, Minimize2, Music, Pause, Play, Share2 } from "lucide-react";
import { PLAYER_SPEED_OPTIONS, speedOption } from "./playerControlState";

interface PlayerControlsProps {
  atStart: boolean;
  atEnd: boolean;
  primaryActionLabel: "Play" | "Pause";
  delayMs: number;
  speedMenuOpen: boolean;
  musicActionLabel: "Play music" | "Stop music";
  musicIsActive: boolean;
  shareActionLabel: "Share player link" | "Link copied" | "Share failed";
  shareIsActive: boolean;
  screenModeActive: boolean;
  onPrevious: () => void;
  onTogglePlayback: () => void;
  onNext: () => void;
  onToggleSpeedMenu: () => void;
  onCloseSpeedMenu: () => void;
  onSelectSpeed: (delayMs: number) => void;
  onToggleMusic: () => void;
  onShare: () => void;
  onToggleScreenMode: () => void;
  onReveal: () => void;
}

export function PlayerControls({
  atStart,
  atEnd,
  primaryActionLabel,
  delayMs,
  speedMenuOpen,
  musicActionLabel,
  musicIsActive,
  shareActionLabel,
  shareIsActive,
  screenModeActive,
  onPrevious,
  onTogglePlayback,
  onNext,
  onToggleSpeedMenu,
  onCloseSpeedMenu,
  onSelectSpeed,
  onToggleMusic,
  onShare,
  onToggleScreenMode,
  onReveal
}: PlayerControlsProps) {
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const speedTriggerRef = useRef<HTMLButtonElement | null>(null);
  const speedMenuRef = useRef<HTMLDivElement | null>(null);
  const speedMenuId = useId();
  const selectedSpeed = speedOption(delayMs);

  useEffect(() => {
    if (!speedMenuOpen) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      speedMenuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    });
    const closeForViewportChange = () => onCloseSpeedMenu();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || controlsRef.current?.contains(target)) {
        return;
      }

      onCloseSpeedMenu();
      if (target.closest(".player-topbar")) {
        return;
      }

      speedTriggerRef.current?.blur();
      event.preventDefault();
      event.stopPropagation();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseSpeedMenu();
        speedTriggerRef.current?.focus({ preventScroll: true });
        return;
      }

      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        return;
      }

      const options = Array.from(speedMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') || []);
      const currentIndex = options.findIndex((option) => option === document.activeElement);
      if (currentIndex < 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : (currentIndex + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[nextIndex]?.click();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeForViewportChange);
    window.addEventListener("orientationchange", closeForViewportChange);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeForViewportChange);
      window.removeEventListener("orientationchange", closeForViewportChange);
    };
  }, [onCloseSpeedMenu, speedMenuOpen]);

  const runAction = (action: () => void) => {
    onCloseSpeedMenu();
    onReveal();
    action();
  };

  return (
    <div
      ref={controlsRef}
      className={`player-controls ${speedMenuOpen ? "is-speed-menu-open" : ""}`}
      role="toolbar"
      aria-label="Player controls"
      onPointerDown={(event) => {
        event.stopPropagation();
        onReveal();
      }}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        className="icon-button"
        data-player-control="back"
        type="button"
        onClick={() => runAction(onPrevious)}
        disabled={atStart}
        aria-label="Previous photo"
        title="Previous photo"
      >
        <ChevronLeft aria-hidden="true" size={20} strokeWidth={2.25} />
      </button>
      <button
        className="icon-button icon-button--primary"
        data-player-control="playback"
        type="button"
        onClick={() => runAction(onTogglePlayback)}
        aria-label={primaryActionLabel}
        title={primaryActionLabel}
      >
        {primaryActionLabel === "Pause" ? (
          <Pause aria-hidden="true" size={20} strokeWidth={2.4} />
        ) : (
          <Play aria-hidden="true" size={20} strokeWidth={2.4} />
        )}
      </button>
      <button
        className="icon-button"
        data-player-control="forward"
        type="button"
        onClick={() => runAction(onNext)}
        disabled={atEnd}
        aria-label="Next photo"
        title="Next photo"
      >
        <ChevronRight aria-hidden="true" size={20} strokeWidth={2.25} />
      </button>
      <button
        ref={speedTriggerRef}
        className={`icon-button icon-button--speed ${speedMenuOpen ? "is-selected" : ""}`}
        data-player-control="speed"
        type="button"
        onClick={() => {
          onReveal();
          onToggleSpeedMenu();
        }}
        aria-label={`Playback speed: ${selectedSpeed.accessibleLabel}`}
        aria-controls={speedMenuId}
        aria-expanded={speedMenuOpen}
        title={`Playback speed: ${selectedSpeed.accessibleLabel}`}
      >
        <Gauge aria-hidden="true" size={18} strokeWidth={2.25} />
        <span className="speed-trigger__value" aria-hidden="true">{selectedSpeed.shortLabel}</span>
      </button>
      <button
        className={`icon-button icon-button--music ${musicIsActive ? "is-selected" : ""}`}
        data-player-control="music"
        type="button"
        onClick={() => runAction(onToggleMusic)}
        aria-label={musicActionLabel}
        aria-pressed={musicIsActive}
        title={musicActionLabel}
      >
        <Music aria-hidden="true" size={19} strokeWidth={2.3} />
      </button>
      <button
        className={`icon-button icon-button--share ${shareIsActive ? "is-selected" : ""}`}
        data-player-control="share"
        type="button"
        onClick={() => runAction(onShare)}
        aria-label={shareActionLabel}
        aria-pressed={shareIsActive}
        title={shareActionLabel}
      >
        {shareIsActive ? (
          <Check aria-hidden="true" size={19} strokeWidth={2.3} />
        ) : (
          <Share2 aria-hidden="true" size={19} strokeWidth={2.3} />
        )}
      </button>
      <button
        className={`icon-button icon-button--screen ${screenModeActive ? "is-selected" : ""}`}
        data-player-control="screen-mode"
        type="button"
        onClick={() => runAction(onToggleScreenMode)}
        aria-label={screenModeActive ? "Exit full screen" : "Full screen"}
        aria-pressed={screenModeActive}
        title={screenModeActive ? "Exit full screen" : "Full screen"}
      >
        {screenModeActive ? (
          <Minimize2 aria-hidden="true" size={18} strokeWidth={2.3} />
        ) : (
          <Maximize2 aria-hidden="true" size={18} strokeWidth={2.3} />
        )}
      </button>

      {speedMenuOpen ? (
        <div
          ref={speedMenuRef}
          id={speedMenuId}
          className="speed-menu"
          role="radiogroup"
          aria-label="Playback speed"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {PLAYER_SPEED_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={option.value === delayMs ? "is-selected" : ""}
              type="button"
              role="radio"
              aria-checked={option.value === delayMs}
              tabIndex={option.value === delayMs ? 0 : -1}
              aria-label={option.accessibleLabel}
              title={option.accessibleLabel}
              onClick={() => {
                onSelectSpeed(option.value);
                speedTriggerRef.current?.focus({ preventScroll: true });
                onReveal();
              }}
            >
              {option.shortLabel}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
