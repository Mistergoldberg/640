import { useLayoutEffect, useMemo, useState, type CSSProperties, type RefObject } from "react";
import type { Rotation } from "./imageGeometry";
import { PlayerImageArrowIcon } from "./PlayerImageArrowIcon";
import type { RotationDirection } from "./playerRotation";

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface PlayerRotationControlsProps {
  id: string;
  imageRef: RefObject<HTMLImageElement | null>;
  photoId: string;
  rotation: Rotation;
  disabled: boolean;
  onRotate: (direction: RotationDirection) => void;
  onReveal: () => void;
}

export function PlayerRotationControls({
  id,
  imageRef,
  photoId,
  rotation,
  disabled,
  onRotate,
  onReveal
}: PlayerRotationControlsProps) {
  const [imageRect, setImageRect] = useState<TargetRect | null>(null);

  useLayoutEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = imageRef.current?.getBoundingClientRect();
      setImageRect(rect && rect.width > 0 && rect.height > 0
        ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
        : null);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    schedule();
    document.addEventListener("load", schedule, true);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    return () => {
      document.removeEventListener("load", schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [imageRef, photoId, rotation]);

  const imageStyle = useMemo(() => imageRect ? {
    "--player-image-arrow-top": `${imageRect.top}px`,
    "--player-image-arrow-left": `${imageRect.left}px`,
    "--player-image-arrow-width": `${imageRect.width}px`,
    "--player-image-arrow-height": `${imageRect.height}px`
  } as CSSProperties : undefined, [imageRect]);

  const activate = (direction: RotationDirection) => {
    if (disabled) return;
    onReveal();
    onRotate(direction);
  };

  return (
    <div
      id={id}
      className="player-rotation-controls"
      role="group"
      aria-label="Photo rotation controls"
      data-player-rotation={rotation}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {imageRect ? (
        <>
          <div className="player-image-arrow-pair" style={imageStyle}>
            <span className="player-image-arrow-zone player-image-arrow-zone--left">
              <button
                className="player-image-arrow-control player-rotation-controls__button"
                type="button"
                autoFocus
                disabled={disabled}
                onClick={() => activate(-1)}
                aria-label="Rotate photo counterclockwise 90 degrees"
                title="Rotate photo counterclockwise 90 degrees"
              >
                <PlayerImageArrowIcon direction={-1} />
              </button>
            </span>
            <span className="player-image-arrow-zone player-image-arrow-zone--right">
              <button
                className="player-image-arrow-control player-rotation-controls__button"
                type="button"
                disabled={disabled}
                onClick={() => activate(1)}
                aria-label="Rotate photo clockwise 90 degrees"
                title="Rotate photo clockwise 90 degrees"
              >
                <PlayerImageArrowIcon direction={1} />
              </button>
            </span>
          </div>
          <div className="player-rotation-controls__context" style={imageStyle} aria-hidden="true">
            Rotate photo
          </div>
        </>
      ) : null}
    </div>
  );
}
