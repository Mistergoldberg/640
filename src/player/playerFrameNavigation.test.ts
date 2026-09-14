import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FRAME_INTERACTION_RESUME_DELAY_MS,
  createPlayerState,
  playerReducer,
  type PlayerEvent,
  type PlayerState
} from "./playerReducer";
import {
  FRAME_HOLD_REPEAT_MS,
  FRAME_HOLD_THRESHOLD_MS,
  FRAME_WHEEL_DELTA_THRESHOLD,
  PlayerFrameNavigationController,
  type FrameNavigationDirection
} from "./playerFrameNavigation";

const scope = { type: "year", year: "2013" } as const;

function playingState(initialIndex = 4, total = 12) {
  return playerReducer(playerReducer(createPlayerState({ initialIndex, total, scope }), { type: "READY" }), { type: "INITIAL_DELAY_COMPLETE" });
}

function navigationLog() {
  const actions: string[] = [];
  const controller = new PlayerFrameNavigationController({
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
  const controller = new PlayerFrameNavigationController({
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

function wheel(direction: FrameNavigationDirection, delta = FRAME_WHEEL_DELTA_THRESHOLD) {
  return {
    deltaX: 0,
    deltaY: direction * delta,
    deltaMode: 0,
    ctrlKey: false,
    viewportHeight: 900
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PlayerFrameNavigationController pointer gestures", () => {
  it("quick right click moves forward once without hold repetition", () => {
    vi.useFakeTimers();
    const { actions, controller } = navigationLog();

    controller.startPointer(1);
    vi.advanceTimersByTime(FRAME_HOLD_THRESHOLD_MS - 1);
    controller.releasePointer();
    vi.advanceTimersByTime(FRAME_HOLD_REPEAT_MS * 4);

    expect(actions).toEqual(["pause", "next", "finish"]);
  });

  it("quick left click moves back once", () => {
    vi.useFakeTimers();
    const { actions, controller } = navigationLog();

    controller.startPointer(-1);
    controller.releasePointer();

    expect(actions).toEqual(["pause", "previous", "finish"]);
  });

  it("right hold advances repeatedly until release", () => {
    vi.useFakeTimers();
    const { actions, controller } = navigationLog();

    controller.startPointer(1);
    vi.advanceTimersByTime(FRAME_HOLD_THRESHOLD_MS);
    vi.advanceTimersByTime(FRAME_HOLD_REPEAT_MS * 2);
    controller.releasePointer();
    vi.advanceTimersByTime(FRAME_HOLD_REPEAT_MS * 3);

    expect(actions).toEqual(["pause", "next", "next", "next", "finish"]);
  });

  it("left hold reverses repeatedly and release stops immediately", () => {
    vi.useFakeTimers();
    const { actions, controller } = navigationLog();

    controller.startPointer(-1);
    vi.advanceTimersByTime(FRAME_HOLD_THRESHOLD_MS + FRAME_HOLD_REPEAT_MS);
    controller.releasePointer();
    vi.advanceTimersByTime(FRAME_HOLD_REPEAT_MS * 5);

    expect(actions).toEqual(["pause", "previous", "previous", "finish"]);
  });

  it("pointer cancellation and teardown clear active hold timers", () => {
    vi.useFakeTimers();
    const { actions, controller } = navigationLog();

    controller.startPointer(1);
    vi.advanceTimersByTime(FRAME_HOLD_THRESHOLD_MS + FRAME_HOLD_REPEAT_MS);
    controller.cancelPointer();
    vi.advanceTimersByTime(FRAME_HOLD_REPEAT_MS * 4);

    expect(actions).toEqual(["pause", "next", "next", "finish"]);

    controller.startPointer(1);
    controller.destroy();
    vi.advanceTimersByTime(FRAME_HOLD_THRESHOLD_MS + FRAME_HOLD_REPEAT_MS);

    expect(actions).toEqual(["pause", "next", "next", "finish", "pause"]);
  });
});

describe("PlayerFrameNavigationController wheel gestures", () => {
  it("wheel down advances and wheel up reverses without a held mouse button", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { actions, controller } = navigationLog();

    controller.handleWheel(wheel(1));
    vi.advanceTimersByTime(140);
    controller.handleWheel(wheel(-1));

    expect(actions).toEqual(["pause", "next", "finish", "pause", "previous", "finish"]);
  });

  it("accumulates trackpad-like small deltas before navigating", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { actions, controller } = navigationLog();

    controller.handleWheel(wheel(1, 30));
    vi.advanceTimersByTime(40);
    controller.handleWheel(wheel(1, 30));
    vi.advanceTimersByTime(40);
    controller.handleWheel(wheel(1, 30));

    expect(actions).toEqual(["pause", "finish", "pause", "finish", "pause", "next", "finish"]);
  });

  it("bounds high-frequency inertial deltas", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { actions, controller } = navigationLog();

    for (let index = 0; index < 8; index += 1) {
      controller.handleWheel(wheel(1, 120));
      vi.advanceTimersByTime(20);
    }

    expect(actions.filter((action) => action === "next")).toHaveLength(2);
  });

  it("ignores ctrl-wheel pinch gestures", () => {
    vi.useFakeTimers();
    const { actions, controller } = navigationLog();

    expect(controller.handleWheel({ ...wheel(1), ctrlKey: true })).toBe(false);

    expect(actions).toEqual([]);
  });
});

describe("frame gestures and player autoplay state", () => {
  it("autoplay resumes three seconds after release", () => {
    vi.useFakeTimers();
    const harness = stateHarness();

    harness.controller.startPointer(1);
    harness.controller.releasePointer();

    expect(harness.state.currentIndex).toBe(5);
    expect(harness.state.status).toBe("temporarily-paused");
    expect(harness.state.resumeDelayMs).toBe(FRAME_INTERACTION_RESUME_DELAY_MS);

    vi.advanceTimersByTime(FRAME_INTERACTION_RESUME_DELAY_MS - 1);
    expect(harness.state.status).toBe("temporarily-paused");
    vi.advanceTimersByTime(1);
    expect(harness.state.status).toBe("playing");
    harness.dispose();
  });

  it("a new gesture resets the three-second resume timer", () => {
    vi.useFakeTimers();
    const harness = stateHarness();

    harness.controller.startPointer(1);
    harness.controller.releasePointer();
    vi.advanceTimersByTime(2_000);
    harness.controller.startPointer(1);
    harness.controller.releasePointer();
    vi.advanceTimersByTime(FRAME_INTERACTION_RESUME_DELAY_MS - 1);

    expect(harness.state.currentIndex).toBe(6);
    expect(harness.state.status).toBe("temporarily-paused");
    vi.advanceTimersByTime(1);
    expect(harness.state.status).toBe("playing");
    harness.dispose();
  });

  it("explicit pause prevents automatic resume after frame navigation", () => {
    vi.useFakeTimers();
    const harness = stateHarness();
    harness.dispatch({ type: "PAUSE" });

    harness.controller.startPointer(1);
    harness.controller.releasePointer();
    vi.advanceTimersByTime(FRAME_INTERACTION_RESUME_DELAY_MS + 1_000);

    expect(harness.state.currentIndex).toBe(5);
    expect(harness.state.status).toBe("explicitly-paused");
    expect(harness.state.resumeDelayMs).toBeNull();
    harness.dispose();
  });
});
