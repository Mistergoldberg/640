import { describe, expect, it } from "vitest";
import {
  PLAYER_ONBOARDING_CONTROL_FRAME_MS,
  PLAYER_ONBOARDING_SEQUENCE_FRAME_MS,
  PLAYER_ONBOARDING_STORAGE_KEY,
  PLAYER_ONBOARDING_STORAGE_VALUE,
  createPlayerOnboardingState,
  playerOnboardingReducer,
  writePlayerOnboardingPreference
} from "./playerOnboarding";

describe("player onboarding preference", () => {
  it("uses 0.7 seconds for browse frames and 1.1 seconds for control frames", () => {
    expect(PLAYER_ONBOARDING_SEQUENCE_FRAME_MS).toBe(700);
    expect(PLAYER_ONBOARDING_CONTROL_FRAME_MS).toBe(1_100);
  });

  it("uses the exact versioned key and value", () => {
    const values = new Map<string, string>();
    const storage = {
      setItem: (key: string, value: string) => { values.set(key, value); }
    };
    expect(writePlayerOnboardingPreference(storage)).toBe(true);
    expect(values.get(PLAYER_ONBOARDING_STORAGE_KEY)).toBe(PLAYER_ONBOARDING_STORAGE_VALUE);
  });

  it("does not throw when storage is unavailable", () => {
    const storage = {
      setItem: () => { throw new DOMException("blocked"); }
    };
    expect(writePlayerOnboardingPreference(storage)).toBe(false);
  });
});

describe("manual replay", () => {
  it("moves through all steps and restores the captured playback policy", () => {
    let state = playerOnboardingReducer(
      createPlayerOnboardingState(false),
      { type: "OPEN_HELP", resumeAfterExit: true }
    );
    expect(state.phase).toBe("paused");
    state = playerOnboardingReducer(state, { type: "PLAYER_PAUSED" });
    state = playerOnboardingReducer(state, { type: "NEXT" });
    state = playerOnboardingReducer(state, { type: "NEXT" });
    expect(state.phase).toBe("instruction-3");
    state = playerOnboardingReducer(state, { type: "EXIT", reason: "escape" });
    expect(state).toMatchObject({ phase: "completed", resumeAfterExit: true });
  });

  it("keeps reduced-motion playback paused unless the final Play action is chosen", () => {
    let state = playerOnboardingReducer(
      createPlayerOnboardingState(true),
      { type: "OPEN_HELP", resumeAfterExit: true }
    );
    state = playerOnboardingReducer(state, { type: "PLAYER_PAUSED" });
    expect(playerOnboardingReducer(state, { type: "EXIT", reason: "escape" }).resumeAfterExit).toBe(false);
    expect(playerOnboardingReducer(state, { type: "EXIT", reason: "skip" }).resumeAfterExit).toBe(false);
    expect(playerOnboardingReducer(state, { type: "EXIT", reason: "auto-complete" }).resumeAfterExit).toBe(false);
    expect(playerOnboardingReducer(state, { type: "EXIT", reason: "complete" }).resumeAfterExit).toBe(true);
  });
});
