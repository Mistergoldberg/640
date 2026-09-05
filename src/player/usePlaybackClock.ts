import { useEffect } from "react";

export function usePlaybackClock({
  isRunning,
  delayMs,
  onTick
}: {
  isRunning: boolean;
  delayMs: number;
  onTick: () => boolean;
}) {
  useEffect(() => {
    if (!isRunning) {
      return;
    }

    let animationFrame = 0;
    let nextFrameAt = performance.now() + delayMs;

    const tick = (now: number) => {
      if (now >= nextFrameAt) {
        const didAdvance = onTick();
        if (didAdvance) {
          nextFrameAt += delayMs;
          while (now >= nextFrameAt + delayMs) {
            nextFrameAt += delayMs;
          }
        } else {
          nextFrameAt = now + Math.min(80, delayMs);
        }
      }

      animationFrame = window.requestAnimationFrame(tick);
    };

    animationFrame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [delayMs, isRunning, onTick]);
}
