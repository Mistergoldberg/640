import { describe, expect, it } from "vitest";
import { FRAME_INTERACTION_RESUME_DELAY_MS, MANUAL_RESUME_DELAY_MS, createPlayerState, playerReducer, type PlayerState } from "./playerReducer";

const scope = { type: "year", year: "2013" } as const;

function openPlayer(initialIndex = 0, total = 12) {
  return createPlayerState({ initialIndex, total, scope });
}

function decoded(state: PlayerState) {
  return playerReducer(state, { type: "READY" });
}

describe("playerReducer initial delay", () => {
  it("waits for the first photograph to decode before initial-delay begins", () => {
    const state = openPlayer();

    expect(state.status).toBe("loading");
    expect(state.initialDelayToken).toBe(0);

    const readyState = decoded(state);

    expect(readyState.status).toBe("initial-delay");
    expect(readyState.initialDelayToken).toBe(1);
  });

  it("begins autoplay after the three-second delay completes", () => {
    const state = decoded(openPlayer());

    expect(playerReducer(state, { type: "INITIAL_DELAY_COMPLETE" }).status).toBe("playing");
  });

  it("explicit Pause cancels initial startup", () => {
    const pausedState = playerReducer(decoded(openPlayer()), { type: "PAUSE" });
    const timerState = playerReducer(pausedState, { type: "INITIAL_DELAY_COMPLETE" });

    expect(timerState.status).toBe("explicitly-paused");
  });

  it("Play skips the remaining initial delay", () => {
    const playingState = playerReducer(decoded(openPlayer()), { type: "PLAY" });
    const staleTimerState = playerReducer(playingState, { type: "INITIAL_DELAY_COMPLETE" });

    expect(playingState.status).toBe("playing");
    expect(staleTimerState.status).toBe("playing");
  });

  it("manual navigation replaces the three-second delay with the five-second resume delay", () => {
    const navigatedState = playerReducer(decoded(openPlayer()), { type: "MANUAL_NEXT" });

    expect(navigatedState.status).toBe("temporarily-paused");
    expect(navigatedState.currentIndex).toBe(1);
    expect(navigatedState.resumeToken).toBe(1);
    expect(navigatedState.resumeDelayMs).toBe(MANUAL_RESUME_DELAY_MS);
    expect(playerReducer(navigatedState, { type: "INITIAL_DELAY_COMPLETE" }).status).toBe("temporarily-paused");
    expect(playerReducer(navigatedState, { type: "TEMPORARY_RESUME" }).status).toBe("playing");
  });

  it("repeated manual navigation resets the temporary resume timer", () => {
    const firstNavigation = playerReducer(decoded(openPlayer()), { type: "MANUAL_NEXT" });
    const secondNavigation = playerReducer(firstNavigation, { type: "MANUAL_NEXT" });

    expect(secondNavigation.status).toBe("temporarily-paused");
    expect(secondNavigation.currentIndex).toBe(2);
    expect(secondNavigation.resumeToken).toBe(2);
    expect(secondNavigation.resumeDelayMs).toBe(MANUAL_RESUME_DELAY_MS);
  });

  it("frame gestures suspend autoplay until release, then use the three-second resume delay", () => {
    const playing = playerReducer(decoded(openPlayer(4, 12)), { type: "INITIAL_DELAY_COMPLETE" });
    const started = playerReducer(playing, { type: "FRAME_GESTURE_START" });
    const navigated = playerReducer(started, { type: "FRAME_NEXT" });
    const released = playerReducer(navigated, { type: "FRAME_GESTURE_END" });

    expect(started.status).toBe("temporarily-paused");
    expect(started.resumeDelayMs).toBeNull();
    expect(started.frameGestureActive).toBe(true);
    expect(navigated.currentIndex).toBe(5);
    expect(navigated.frameGestureActive).toBe(true);
    expect(navigated.resumeDelayMs).toBeNull();
    expect(released.status).toBe("temporarily-paused");
    expect(released.frameGestureActive).toBe(false);
    expect(released.resumeDelayMs).toBe(FRAME_INTERACTION_RESUME_DELAY_MS);
    expect(released.resumeToken).toBe(navigated.resumeToken + 1);
  });

  it("frame navigation preserves explicit pause and never schedules resume", () => {
    const playing = playerReducer(decoded(openPlayer(4, 12)), { type: "INITIAL_DELAY_COMPLETE" });
    const paused = playerReducer(playing, { type: "PAUSE" });
    const started = playerReducer(paused, { type: "FRAME_GESTURE_START" });
    const navigated = playerReducer(started, { type: "FRAME_PREVIOUS" });
    const released = playerReducer(navigated, { type: "FRAME_GESTURE_END" });

    expect(started).toEqual(paused);
    expect(released.currentIndex).toBe(3);
    expect(released.status).toBe("explicitly-paused");
    expect(released.resumeDelayMs).toBeNull();
  });

  it("closing during initial delay leaves automatic startup cancelled", () => {
    const closedState = playerReducer(decoded(openPlayer()), { type: "CLOSE" });
    const timerState = playerReducer(closedState, { type: "INITIAL_DELAY_COMPLETE" });

    expect(closedState.status).toBe("explicitly-paused");
    expect(timerState.status).toBe("explicitly-paused");
  });

  it("reopening creates exactly one new initial-delay timer token", () => {
    const firstOpen = decoded(openPlayer());
    const duplicateReady = playerReducer(firstOpen, { type: "READY" });
    const reopened = playerReducer(firstOpen, { type: "RESET", initialIndex: 3, total: 12, scope });
    const reopenedReady = decoded(reopened);
    const duplicateReopenedReady = playerReducer(reopenedReady, { type: "READY" });

    expect(firstOpen.initialDelayToken).toBe(1);
    expect(duplicateReady.initialDelayToken).toBe(1);
    expect(reopenedReady.initialDelayToken).toBe(1);
    expect(duplicateReopenedReady.initialDelayToken).toBe(1);
  });
});

describe("playerReducer speed changes", () => {
  it("changes only delay during the initial startup delay", () => {
    const before = decoded(openPlayer());

    expect(playerReducer(before, { type: "CHANGE_SPEED", delayMs: 500 })).toEqual({
      ...before,
      delayMs: 500
    });
  });

  it("does not reset a temporary resume or move the current photo", () => {
    const before = playerReducer(decoded(openPlayer()), { type: "MANUAL_NEXT" });
    const changed = playerReducer(before, { type: "CHANGE_SPEED", delayMs: 1000 });

    expect(changed).toEqual({ ...before, delayMs: 1000 });
    expect(playerReducer(changed, { type: "TEMPORARY_RESUME" }).status).toBe("playing");
  });

  it("does not resume or move an explicitly paused player", () => {
    const playing = playerReducer(decoded(openPlayer(4, 12)), { type: "INITIAL_DELAY_COMPLETE" });
    const paused = playerReducer(playing, { type: "PAUSE" });
    const changed = playerReducer(paused, { type: "CHANGE_SPEED", delayMs: 250 });

    expect(changed).toEqual({ ...paused, delayMs: 250 });
    expect(changed.currentIndex).toBe(4);
    expect(changed.status).toBe("explicitly-paused");
  });

  it("preserves active playback and natural end behavior", () => {
    const playing = playerReducer(decoded(openPlayer(10, 12)), { type: "INITIAL_DELAY_COMPLETE" });
    const changed = playerReducer(playing, { type: "CHANGE_SPEED", delayMs: 2000 });
    const ended = playerReducer(playerReducer(changed, { type: "ADVANCE" }), { type: "ADVANCE" });

    expect(changed).toEqual({ ...playing, delayMs: 2000 });
    expect(ended.currentIndex).toBe(11);
    expect(ended.status).toBe("ended");
  });
});
