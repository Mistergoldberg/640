import { afterEach, describe, expect, it, vi } from "vitest";
import { FRAME_HOLD_REPEAT_MS, FRAME_HOLD_THRESHOLD_MS, type FrameNavigationDirection } from "./playerFrameNavigation";
import {
  FRAME_INTERACTION_RESUME_DELAY_MS,
  createPlayerState,
  playerReducer,
  type PlayerEvent,
  type PlayerState
} from "./playerReducer";
import {
  PlayerTouchNavigationController,
  TOUCH_MOVE_CANCEL_DISTANCE_PX,
  directionFromClientX,
  isWithinMobileLandscapeRail,
  movementCancelsTouchNavigation,
  shouldSuppressSyntheticClick
} from "./playerTouchNavigation";

const scope = { type: "year", year: "2013" } as const;

function playingState(initialIndex = 4, total = 12) {
  return playerReducer(playerReducer(createPlayerState({ initialIndex, total, scope }), { type: "READY" }), { type: "INITIAL_DELAY_COMPLETE" });
}

function navigationLog() {
  const actions: string[] = [];
  const controller = new PlayerTouchNavigationController({
    pause: () => actions.push("pause"),
    navigate: (direction) => actions.push(direction > 0 ? "next" : "previous"),
    finish: () => actions.push("finish")
  });
  return { actions, controller };
}

function stateHarness(initial: PlayerState = playingState()) {
  let state = initial;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  const dispatch = (event: PlayerEvent) => {
    if (resumeTimer !== null) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
    state = playerReducer(state, event);
    if (state.status === "temporarily-paused" && state.resumeDelayMs !== null) {
      resumeTimer = setTimeout(() => dispatch({ type: "TEMPORARY_RESUME" }), state.resumeDelayMs);
    }
  };
  const controller = new PlayerTouchNavigationController({
    pause: () => dispatch({ type: "FRAME_GESTURE_START" }),
    navigate: (direction) => dispatch({ type: direction > 0 ? "FRAME_NEXT" : "FRAME_PREVIOUS" }),
    finish: () => dispatch({ type: "FRAME_GESTURE_END" })
  });

  return {
    controller,
    dispatch,
    dispose: () => {
      controller.destroy();
      if (resumeTimer !== null) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
    },
    get state() {
      return state;
    }
  };
}

function start(direction: FrameNavigationDirection, pointerId = 11) {
  return { pointerId, clientX: direction > 0 ? 80 : 20, clientY: 50, direction, activeTouchCount: 1, isPrimary: true };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PlayerTouchNavigationController", () => {
  it("quick right and left taps navigate exactly once", () => {
    vi.useFakeTimers();
    const { actions, controller } = navigationLog();

    controller.start(start(1));
    vi.advanceTimersByTime(FRAME_HOLD_THRESHOLD_MS - 1);
    controller.release({ pointerId: 11 });
    controller.start(start(-1, 12));
    controller.release({ pointerId: 12 });

    expect(actions).toEqual(["pause", "next", "finish", "pause", "previous", "finish"]);
  });

  it("touch hold repeats on the accepted desktop cadence and release does not add a tap", () => {
    vi.useFakeTimers();
    const { actions, controller } = navigationLog();

    controller.start(start(1));
    vi.advanceTimersByTime(FRAME_HOLD_THRESHOLD_MS);
    vi.advanceTimersByTime(FRAME_HOLD_REPEAT_MS * 2);
    controller.release({ pointerId: 11 });
    vi.advanceTimersByTime(FRAME_HOLD_REPEAT_MS * 3);

    expect(actions).toEqual(["pause", "next", "next", "next", "finish"]);
  });

  it("release stops rapid navigation immediately", () => {
    vi.useFakeTimers();
    const { actions, controller } = navigationLog();

    controller.start(start(-1));
    vi.advanceTimersByTime(FRAME_HOLD_THRESHOLD_MS + FRAME_HOLD_REPEAT_MS);
    controller.release({ pointerId: 11 });
    vi.advanceTimersByTime(FRAME_HOLD_REPEAT_MS * 5);

    expect(actions).toEqual(["pause", "previous", "previous", "finish"]);
  });

  it("keeps the starting direction even after crossing the midpoint during a hold", () => {
    vi.useFakeTimers();
    const { actions, controller } = navigationLog();

    controller.start(start(1));
    vi.advanceTimersByTime(FRAME_HOLD_THRESHOLD_MS);
    controller.move({ pointerId: 11, clientX: 5, clientY: 50 });
    vi.advanceTimersByTime(FRAME_HOLD_REPEAT_MS);
    controller.release({ pointerId: 11 });

    expect(actions).toEqual(["pause", "next", "next", "finish"]);
  });

  it("allows minor drift but cancels pre-hold scroll or abandoned movement without advancing", () => {
    vi.useFakeTimers();
    const { actions, controller } = navigationLog();

    controller.start(start(1));
    controller.move({ pointerId: 11, clientX: 90, clientY: 58 });
    controller.release({ pointerId: 11 });
    controller.start(start(1, 12));
    controller.move({ pointerId: 12, clientX: 80, clientY: 50 + TOUCH_MOVE_CANCEL_DISTANCE_PX + 1 });
    vi.advanceTimersByTime(FRAME_HOLD_THRESHOLD_MS + FRAME_HOLD_REPEAT_MS);
    controller.release({ pointerId: 12 });

    expect(actions).toEqual(["pause", "next", "finish", "pause", "finish"]);
  });

  it("cancels multi-touch without advancing", () => {
    vi.useFakeTimers();
    const { actions, controller } = navigationLog();

    controller.start(start(1));
    controller.start({ ...start(1, 12), activeTouchCount: 2, isPrimary: false });
    vi.advanceTimersByTime(FRAME_HOLD_THRESHOLD_MS + FRAME_HOLD_REPEAT_MS);
    controller.release({ pointerId: 11 });

    expect(actions).toEqual(["pause", "finish"]);
  });

  it("pointer cancellation, lost capture, blur, close, and unmount style teardown clear hold timers", () => {
    vi.useFakeTimers();
    const { actions, controller } = navigationLog();

    controller.start(start(1));
    controller.cancel();
    vi.advanceTimersByTime(FRAME_HOLD_THRESHOLD_MS + FRAME_HOLD_REPEAT_MS);
    controller.start(start(-1, 12));
    controller.destroy();
    vi.advanceTimersByTime(FRAME_HOLD_THRESHOLD_MS + FRAME_HOLD_REPEAT_MS);

    expect(actions).toEqual(["pause", "finish", "pause"]);
  });
});

describe("touch frame navigation helpers", () => {
  it("uses the full frame halves for touch direction", () => {
    expect(directionFromClientX(49, { left: 0, width: 100 })).toBe(-1);
    expect(directionFromClientX(50, { left: 0, width: 100 })).toBe(1);
    expect(directionFromClientX(590, { left: 120, width: 960 })).toBe(-1);
  });

  it("scopes synthetic-click suppression and mobile landscape rail exclusion", () => {
    expect(shouldSuppressSyntheticClick(1_450, 1_000)).toBe(true);
    expect(shouldSuppressSyntheticClick(1_450, 1_450)).toBe(false);
    expect(isWithinMobileLandscapeRail(838, 800)).toBe(true);
    expect(isWithinMobileLandscapeRail(780, 800)).toBe(false);
    expect(isWithinMobileLandscapeRail(838, null)).toBe(false);
  });

  it("keeps the movement threshold deterministic", () => {
    expect(movementCancelsTouchNavigation({ clientX: 10, clientY: 10 }, { clientX: 10, clientY: 41 })).toBe(false);
    expect(movementCancelsTouchNavigation({ clientX: 10, clientY: 10 }, { clientX: 10, clientY: 43 })).toBe(true);
  });
});

describe("touch gestures and player autoplay state", () => {
  it("autoplay resumes three seconds after a touch tap", () => {
    vi.useFakeTimers();
    const harness = stateHarness();

    harness.controller.start(start(1));
    harness.controller.release({ pointerId: 11 });

    expect(harness.state.currentIndex).toBe(5);
    expect(harness.state.status).toBe("temporarily-paused");
    expect(harness.state.resumeDelayMs).toBe(FRAME_INTERACTION_RESUME_DELAY_MS);

    vi.advanceTimersByTime(FRAME_INTERACTION_RESUME_DELAY_MS - 1);
    expect(harness.state.status).toBe("temporarily-paused");
    vi.advanceTimersByTime(1);
    expect(harness.state.status).toBe("playing");
    harness.dispose();
  });

  it("does not resume autoplay while a touch hold remains active", () => {
    vi.useFakeTimers();
    const harness = stateHarness(playingState(20, 100));

    harness.controller.start(start(1));
    vi.advanceTimersByTime(FRAME_HOLD_THRESHOLD_MS);
    vi.advanceTimersByTime(FRAME_INTERACTION_RESUME_DELAY_MS + FRAME_HOLD_REPEAT_MS);

    expect(harness.state.currentIndex).toBeGreaterThan(20);
    expect(harness.state.status).toBe("temporarily-paused");
    expect(harness.state.resumeDelayMs).toBeNull();

    harness.controller.release({ pointerId: 11 });
    expect(harness.state.resumeDelayMs).toBe(FRAME_INTERACTION_RESUME_DELAY_MS);
    vi.advanceTimersByTime(FRAME_INTERACTION_RESUME_DELAY_MS);
    expect(harness.state.status).toBe("playing");
    harness.dispose();
  });

  it("a new touch gesture resets the pending three-second resume timer", () => {
    vi.useFakeTimers();
    const harness = stateHarness();

    harness.controller.start(start(1));
    harness.controller.release({ pointerId: 11 });
    vi.advanceTimersByTime(2_000);
    harness.controller.start(start(1, 12));
    harness.controller.release({ pointerId: 12 });
    vi.advanceTimersByTime(FRAME_INTERACTION_RESUME_DELAY_MS - 1);

    expect(harness.state.currentIndex).toBe(6);
    expect(harness.state.status).toBe("temporarily-paused");
    vi.advanceTimersByTime(1);
    expect(harness.state.status).toBe("playing");
    harness.dispose();
  });

  it("explicit pause prevents automatic resume after touch frame navigation", () => {
    vi.useFakeTimers();
    const harness = stateHarness();
    harness.dispatch({ type: "PAUSE" });

    harness.controller.start(start(1));
    harness.controller.release({ pointerId: 11 });
    vi.advanceTimersByTime(FRAME_INTERACTION_RESUME_DELAY_MS + 1_000);

    expect(harness.state.currentIndex).toBe(5);
    expect(harness.state.status).toBe("explicitly-paused");
    expect(harness.state.resumeDelayMs).toBeNull();
    harness.dispose();
  });
});
