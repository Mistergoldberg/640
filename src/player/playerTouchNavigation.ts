import {
  PlayerFrameNavigationController,
  type FrameNavigationActions,
  type FrameNavigationDirection,
  type FrameNavigationTimers
} from "./playerFrameNavigation";

export const TOUCH_MOVE_CANCEL_DISTANCE_PX = 32;
export const TOUCH_SYNTHETIC_CLICK_SUPPRESSION_MS = 450;
export const MOBILE_LANDSCAPE_RAIL_GUTTER_PX = 8;

export interface TouchPoint {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export interface TouchNavigationStart extends TouchPoint {
  direction: FrameNavigationDirection;
  activeTouchCount?: number;
  isPrimary?: boolean;
}

interface TouchGesture {
  pointerId: number;
  startX: number;
  startY: number;
}

interface NavigationRect {
  left: number;
  width: number;
}

export function directionFromClientX(clientX: number, rect: NavigationRect): FrameNavigationDirection {
  return clientX < rect.left + rect.width / 2 ? -1 : 1;
}

export function movementCancelsTouchNavigation(
  start: { clientX: number; clientY: number },
  current: { clientX: number; clientY: number },
  thresholdPx = TOUCH_MOVE_CANCEL_DISTANCE_PX
) {
  return Math.hypot(current.clientX - start.clientX, current.clientY - start.clientY) > thresholdPx;
}

export function shouldSuppressSyntheticClick(untilMs: number, nowMs = Date.now()) {
  return nowMs < untilMs;
}

export function isWithinMobileLandscapeRail(clientX: number, railLeft: number | null) {
  return railLeft !== null && clientX >= railLeft - MOBILE_LANDSCAPE_RAIL_GUTTER_PX;
}

export class PlayerTouchNavigationController {
  private readonly frameNavigation: PlayerFrameNavigationController;
  private gesture: TouchGesture | null = null;

  constructor(actions: FrameNavigationActions, timers?: FrameNavigationTimers) {
    this.frameNavigation = new PlayerFrameNavigationController(actions, timers);
  }

  setActions(actions: FrameNavigationActions) {
    this.frameNavigation.setActions(actions);
  }

  start(input: TouchNavigationStart) {
    if (input.isPrimary === false || (input.activeTouchCount ?? 1) > 1) {
      this.cancel();
      return false;
    }

    this.cancel(false);
    this.gesture = {
      pointerId: input.pointerId,
      startX: input.clientX,
      startY: input.clientY
    };
    this.frameNavigation.startPointer(input.direction);
    return true;
  }

  move(input: TouchPoint) {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== input.pointerId) {
      return false;
    }

    if (this.frameNavigation.isPointerHolding()) {
      return true;
    }

    if (
      movementCancelsTouchNavigation(
        { clientX: gesture.startX, clientY: gesture.startY },
        { clientX: input.clientX, clientY: input.clientY }
      )
    ) {
      this.cancel();
      return false;
    }

    return true;
  }

  release(input: Pick<TouchPoint, "pointerId">) {
    if (!this.gesture || this.gesture.pointerId !== input.pointerId) {
      return false;
    }

    this.gesture = null;
    return this.frameNavigation.releasePointer();
  }

  cancel(finishGesture = true) {
    const hadGesture = this.gesture !== null || this.frameNavigation.hasActivePointer();
    this.gesture = null;
    this.frameNavigation.cancelPointer(finishGesture);
    return hadGesture;
  }

  destroy() {
    this.gesture = null;
    this.frameNavigation.destroy();
  }

  hasActiveGesture() {
    return this.gesture !== null;
  }

  isHolding() {
    return this.frameNavigation.isPointerHolding();
  }
}
