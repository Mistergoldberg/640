export type FrameNavigationDirection = -1 | 1;

export const FRAME_HOLD_THRESHOLD_MS = 275;
export const FRAME_HOLD_REPEAT_MS = 100;
export const FRAME_WHEEL_DELTA_THRESHOLD = 90;
export const FRAME_WHEEL_STEP_COOLDOWN_MS = 120;
export const FRAME_WHEEL_IDLE_RESET_MS = 420;

export interface FrameNavigationActions {
  pause(): void;
  navigate(direction: FrameNavigationDirection): void;
  finish(): void;
}

export interface FrameNavigationTimers {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
  clearInterval(id: ReturnType<typeof setInterval>): void;
}

export interface FrameWheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  viewportHeight: number;
}

interface PointerGesture {
  direction: FrameNavigationDirection;
  didHold: boolean;
  holdTimer: ReturnType<typeof setTimeout> | null;
  repeatTimer: ReturnType<typeof setInterval> | null;
}

const defaultTimers: FrameNavigationTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (id) => clearInterval(id)
};

function normalizeWheelDelta({ deltaX, deltaY, deltaMode, viewportHeight }: FrameWheelInput) {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, viewportHeight) : 1;
  const x = deltaX * unit;
  const y = deltaY * unit;
  const dominant = Math.abs(x) > Math.abs(y) ? x : y;
  return Number.isFinite(dominant) ? dominant : 0;
}

function directionForDelta(delta: number): FrameNavigationDirection {
  return delta < 0 ? -1 : 1;
}

export class PlayerFrameNavigationController {
  private actions: FrameNavigationActions;
  private readonly timers: FrameNavigationTimers;
  private pointer: PointerGesture | null = null;
  private wheelAccumulator = 0;
  private wheelLastEventAt = 0;
  private wheelLastStepAt = -Infinity;

  constructor(actions: FrameNavigationActions, timers: FrameNavigationTimers = defaultTimers) {
    this.actions = actions;
    this.timers = timers;
  }

  setActions(actions: FrameNavigationActions) {
    this.actions = actions;
  }

  startPointer(direction: FrameNavigationDirection) {
    this.cancelPointer(false);
    this.actions.pause();
    this.pointer = {
      direction,
      didHold: false,
      holdTimer: this.timers.setTimeout(() => this.startHold(), FRAME_HOLD_THRESHOLD_MS),
      repeatTimer: null
    };
  }

  releasePointer() {
    const pointer = this.pointer;
    if (!pointer) {
      return false;
    }

    this.clearPointerTimers(pointer);
    this.pointer = null;
    if (!pointer.didHold) {
      this.actions.navigate(pointer.direction);
    }
    this.actions.finish();
    return true;
  }

  cancelPointer(finishGesture = true) {
    const pointer = this.pointer;
    if (!pointer) {
      return false;
    }

    this.clearPointerTimers(pointer);
    this.pointer = null;
    if (finishGesture) {
      this.actions.finish();
    }
    return true;
  }

  isPointerHolding() {
    return this.pointer?.didHold ?? false;
  }

  hasActivePointer() {
    return this.pointer !== null;
  }

  handleWheel(input: FrameWheelInput) {
    if (input.ctrlKey) {
      return false;
    }

    const delta = normalizeWheelDelta(input);
    if (delta === 0) {
      return false;
    }

    const now = this.timers.now();
    if (now - this.wheelLastEventAt > FRAME_WHEEL_IDLE_RESET_MS) {
      this.wheelAccumulator = 0;
    }
    this.wheelLastEventAt = now;

    if (this.wheelAccumulator !== 0 && Math.sign(this.wheelAccumulator) !== Math.sign(delta)) {
      this.wheelAccumulator = 0;
    }
    this.wheelAccumulator += delta;

    this.actions.pause();

    if (Math.abs(this.wheelAccumulator) >= FRAME_WHEEL_DELTA_THRESHOLD && now - this.wheelLastStepAt >= FRAME_WHEEL_STEP_COOLDOWN_MS) {
      const direction = directionForDelta(this.wheelAccumulator);
      this.wheelAccumulator -= direction * FRAME_WHEEL_DELTA_THRESHOLD;
      if (Math.sign(this.wheelAccumulator) !== direction) {
        this.wheelAccumulator = 0;
      }
      this.wheelAccumulator = Math.max(-FRAME_WHEEL_DELTA_THRESHOLD, Math.min(FRAME_WHEEL_DELTA_THRESHOLD, this.wheelAccumulator));
      this.wheelLastStepAt = now;
      this.actions.navigate(direction);
    }

    this.actions.finish();
    return true;
  }

  destroy() {
    this.cancelPointer(false);
    this.wheelAccumulator = 0;
  }

  private startHold() {
    const pointer = this.pointer;
    if (!pointer) {
      return;
    }

    pointer.holdTimer = null;
    pointer.didHold = true;
    this.actions.navigate(pointer.direction);
    pointer.repeatTimer = this.timers.setInterval(() => {
      this.actions.navigate(pointer.direction);
    }, FRAME_HOLD_REPEAT_MS);
  }

  private clearPointerTimers(pointer: PointerGesture) {
    if (pointer.holdTimer !== null) {
      this.timers.clearTimeout(pointer.holdTimer);
      pointer.holdTimer = null;
    }
    if (pointer.repeatTimer !== null) {
      this.timers.clearInterval(pointer.repeatTimer);
      pointer.repeatTimer = null;
    }
  }
}
