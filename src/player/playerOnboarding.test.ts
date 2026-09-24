import { describe, expect, it } from "vitest";
import {
  ONBOARDING_FALLBACK_MS,
  ONBOARDING_MIN_DEMONSTRATION_MS,
  ONBOARDING_MIN_TRANSITIONS,
  PLAYER_ONBOARDING_SEQUENCE_FRAME_MS,
  PLAYER_ONBOARDING_STORAGE_KEY,
  PLAYER_ONBOARDING_STORAGE_VALUE,
  createPlayerOnboardingState,
  playerOnboardingReducer,
  readPlayerOnboardingPreference,
  writePlayerOnboardingPreference
} from "./playerOnboarding";

function eligible(reducedMotion = false) {
  return createPlayerOnboardingState({ automaticEntry: true, preference: "incomplete", reducedMotion });
}

describe("player onboarding preference", () => {
  it("uses 0.7 seconds for each Help sequence frame", () => {
    expect(PLAYER_ONBOARDING_SEQUENCE_FRAME_MS).toBe(700);
  });

  it("uses the exact versioned key and value", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }
    };
    expect(readPlayerOnboardingPreference(storage)).toBe("incomplete");
    expect(writePlayerOnboardingPreference(storage)).toBe(true);
    expect(values.get(PLAYER_ONBOARDING_STORAGE_KEY)).toBe(PLAYER_ONBOARDING_STORAGE_VALUE);
    expect(readPlayerOnboardingPreference(storage)).toBe("complete");
  });

  it("makes unavailable storage ineligible without throwing", () => {
    const storage = {
      getItem: () => { throw new DOMException("blocked"); },
      setItem: () => { throw new DOMException("blocked"); }
    };
    expect(readPlayerOnboardingPreference(storage)).toBe("unavailable");
    expect(writePlayerOnboardingPreference(storage)).toBe(false);
    expect(createPlayerOnboardingState({ automaticEntry: true, preference: "unavailable", reducedMotion: false }).phase)
      .toBe("ineligible");
  });
});

describe("automatic player onboarding", () => {
  it("stays inactive when onboarding is Help-only even without a completion preference", () => {
    expect(createPlayerOnboardingState({
      automaticEntry: false,
      preference: "incomplete",
      reducedMotion: false
    })).toMatchObject({ phase: "ineligible", source: null });
  });

  it("waits for a painted replacement frame before demonstrating", () => {
    const first = playerOnboardingReducer(eligible(), { type: "FRAME_PRESENTED", photoId: "a", foregroundElapsedMs: 0 });
    expect(first.phase).toBe("waiting-for-player");
    const transition = playerOnboardingReducer(first, { type: "FRAME_PRESENTED", photoId: "b", foregroundElapsedMs: 0 });
    expect(transition.phase).toBe("demonstrating");
    expect(transition.successfulTransitions).toBe(1);
  });

  it("requires both the minimum foreground time and successful transition count", () => {
    let state = playerOnboardingReducer(eligible(), { type: "FRAME_PRESENTED", photoId: "initial", foregroundElapsedMs: 0 });
    for (let index = 1; index <= ONBOARDING_MIN_TRANSITIONS; index += 1) {
      state = playerOnboardingReducer(state, {
        type: "FRAME_PRESENTED",
        photoId: `photo-${index}`,
        foregroundElapsedMs: index === ONBOARDING_MIN_TRANSITIONS ? ONBOARDING_MIN_DEMONSTRATION_MS - 1 : index * 100
      });
    }
    expect(state.phase).toBe("demonstrating");
    state = playerOnboardingReducer(state, {
      type: "FRAME_PRESENTED",
      photoId: "qualifying-photo",
      foregroundElapsedMs: ONBOARDING_MIN_DEMONSTRATION_MS
    });
    expect(state.phase).toBe("paused");
  });

  it("uses the slow-delivery fallback only after two successful transitions", () => {
    let state = playerOnboardingReducer(eligible(), { type: "FRAME_PRESENTED", photoId: "a", foregroundElapsedMs: 0 });
    state = playerOnboardingReducer(state, { type: "FRAME_PRESENTED", photoId: "b", foregroundElapsedMs: 0 });
    expect(playerOnboardingReducer(state, { type: "DEMONSTRATION_FALLBACK" }).phase).toBe("demonstrating");
    state = playerOnboardingReducer(state, { type: "FRAME_PRESENTED", photoId: "c", foregroundElapsedMs: ONBOARDING_FALLBACK_MS });
    expect(playerOnboardingReducer(state, { type: "DEMONSTRATION_FALLBACK" }).phase).toBe("paused");
  });

  it("treats trusted demonstration interaction as completion without requesting resume", () => {
    let state = playerOnboardingReducer(eligible(), { type: "FRAME_PRESENTED", photoId: "a", foregroundElapsedMs: 0 });
    state = playerOnboardingReducer(state, { type: "FRAME_PRESENTED", photoId: "b", foregroundElapsedMs: 0 });
    state = playerOnboardingReducer(state, { type: "TRUSTED_INTERACTION" });
    expect(state).toMatchObject({ phase: "completed", completionReason: "interacted", resumeAfterExit: false });
  });

  it("uses a static first frame for reduced motion and only final completion requests play", () => {
    let state = playerOnboardingReducer(eligible(true), { type: "FRAME_PRESENTED", photoId: "a", foregroundElapsedMs: 0 });
    expect(state.phase).toBe("paused");
    state = playerOnboardingReducer(state, { type: "PLAYER_PAUSED" });
    expect(state.phase).toBe("instruction-1");
    const skipped = playerOnboardingReducer(state, { type: "EXIT", reason: "skip" });
    expect(skipped.resumeAfterExit).toBe(false);
    const completed = playerOnboardingReducer(state, { type: "EXIT", reason: "complete" });
    expect(completed.resumeAfterExit).toBe(true);
  });
});

describe("manual replay", () => {
  it("moves through all steps and restores the captured playback policy", () => {
    let state = playerOnboardingReducer(
      createPlayerOnboardingState({ automaticEntry: false, preference: "complete", reducedMotion: false }),
      { type: "OPEN_HELP", resumeAfterExit: true }
    );
    expect(state.phase).toBe("paused");
    state = playerOnboardingReducer(state, { type: "PLAYER_PAUSED" });
    state = playerOnboardingReducer(state, { type: "NEXT" });
    state = playerOnboardingReducer(state, { type: "NEXT" });
    expect(state.phase).toBe("instruction-3");
    state = playerOnboardingReducer(state, { type: "BACK" });
    expect(state.phase).toBe("instruction-2");
    state = playerOnboardingReducer(state, { type: "EXIT", reason: "close" });
    expect(state).toMatchObject({ phase: "completed", resumeAfterExit: true, completionReason: "close" });
  });

  it("keeps reduced-motion playback paused unless the final Play action is chosen", () => {
    let state = playerOnboardingReducer(
      createPlayerOnboardingState({ automaticEntry: false, preference: "complete", reducedMotion: true }),
      { type: "OPEN_HELP", resumeAfterExit: true }
    );
    state = playerOnboardingReducer(state, { type: "PLAYER_PAUSED" });
    expect(playerOnboardingReducer(state, { type: "EXIT", reason: "close" }).resumeAfterExit).toBe(false);
    expect(playerOnboardingReducer(state, { type: "EXIT", reason: "escape" }).resumeAfterExit).toBe(false);
    expect(playerOnboardingReducer(state, { type: "EXIT", reason: "skip" }).resumeAfterExit).toBe(false);
    expect(playerOnboardingReducer(state, { type: "EXIT", reason: "complete" }).resumeAfterExit).toBe(true);
  });
});
