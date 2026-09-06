import { describe, expect, it } from "vitest";
import { createPlayerState, playerReducer, type PlayerState } from "./playerReducer";

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
    expect(playerReducer(navigatedState, { type: "INITIAL_DELAY_COMPLETE" }).status).toBe("temporarily-paused");
    expect(playerReducer(navigatedState, { type: "TEMPORARY_RESUME" }).status).toBe("playing");
  });

  it("repeated manual navigation resets the temporary resume timer", () => {
    const firstNavigation = playerReducer(decoded(openPlayer()), { type: "MANUAL_NEXT" });
    const secondNavigation = playerReducer(firstNavigation, { type: "MANUAL_NEXT" });

    expect(secondNavigation.status).toBe("temporarily-paused");
    expect(secondNavigation.currentIndex).toBe(2);
    expect(secondNavigation.resumeToken).toBe(2);
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

  it("preserves active playback and natural end behavior", () => {
    const playing = playerReducer(decoded(openPlayer(10, 12)), { type: "INITIAL_DELAY_COMPLETE" });
    const changed = playerReducer(playing, { type: "CHANGE_SPEED", delayMs: 2000 });
    const ended = playerReducer(playerReducer(changed, { type: "ADVANCE" }), { type: "ADVANCE" });

    expect(changed).toEqual({ ...playing, delayMs: 2000 });
    expect(ended.currentIndex).toBe(11);
    expect(ended.status).toBe("ended");
  });
});
