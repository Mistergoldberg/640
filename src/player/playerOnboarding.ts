export const PLAYER_ONBOARDING_STORAGE_KEY = "pixilation-player-onboarding-v1";
export const PLAYER_ONBOARDING_STORAGE_VALUE = "1";
export const PLAYER_ONBOARDING_SEQUENCE_FRAME_MS = 700;

export const ONBOARDING_MIN_DEMONSTRATION_MS = 2_400;
export const ONBOARDING_MIN_TRANSITIONS = 12;
export const ONBOARDING_FALLBACK_MS = 5_000;
export const ONBOARDING_STALL_MS = 8_000;
export const ONBOARDING_WAITING_TIMEOUT_MS = 15_000;

export type PlayerOnboardingPhase =
  | "ineligible"
  | "waiting-for-player"
  | "demonstrating"
  | "paused"
  | "instruction-1"
  | "instruction-2"
  | "instruction-3"
  | "completed";

export type PlayerOnboardingSource = "automatic" | "manual" | null;
export type PlayerOnboardingExitReason = "complete" | "skip" | "close" | "escape";

export interface PlayerOnboardingState {
  phase: PlayerOnboardingPhase;
  source: PlayerOnboardingSource;
  reducedMotion: boolean;
  firstPresentedPhotoId: string | null;
  lastPresentedPhotoId: string | null;
  successfulTransitions: number;
  resumeAfterExit: boolean;
  completionReason: PlayerOnboardingExitReason | "interacted" | null;
}

export type PlayerOnboardingEvent =
  | { type: "FRAME_PRESENTED"; photoId: string; foregroundElapsedMs: number }
  | { type: "DEMONSTRATION_FALLBACK" }
  | { type: "DEMONSTRATION_STALLED" }
  | { type: "WAITING_TIMED_OUT" }
  | { type: "PLAYER_PAUSED" }
  | { type: "TRUSTED_INTERACTION" }
  | { type: "OPEN_HELP"; resumeAfterExit: boolean }
  | { type: "NEXT" }
  | { type: "BACK" }
  | { type: "EXIT"; reason: PlayerOnboardingExitReason }
  | { type: "REDUCED_MOTION_CHANGED"; reducedMotion: boolean };

export type PlayerOnboardingPreference = "complete" | "incomplete" | "unavailable";

export function readPlayerOnboardingPreference(storage: Pick<Storage, "getItem"> | null | undefined): PlayerOnboardingPreference {
  if (!storage) return "unavailable";
  try {
    return storage.getItem(PLAYER_ONBOARDING_STORAGE_KEY) === PLAYER_ONBOARDING_STORAGE_VALUE
      ? "complete"
      : "incomplete";
  } catch {
    return "unavailable";
  }
}

export function writePlayerOnboardingPreference(storage: Pick<Storage, "setItem"> | null | undefined) {
  if (!storage) return false;
  try {
    storage.setItem(PLAYER_ONBOARDING_STORAGE_KEY, PLAYER_ONBOARDING_STORAGE_VALUE);
    return true;
  } catch {
    return false;
  }
}

export function createPlayerOnboardingState({
  automaticEntry,
  preference,
  reducedMotion
}: {
  automaticEntry: boolean;
  preference: PlayerOnboardingPreference;
  reducedMotion: boolean;
}): PlayerOnboardingState {
  const eligible = automaticEntry && preference === "incomplete";
  return {
    phase: eligible ? "waiting-for-player" : "ineligible",
    source: eligible ? "automatic" : null,
    reducedMotion,
    firstPresentedPhotoId: null,
    lastPresentedPhotoId: null,
    successfulTransitions: 0,
    resumeAfterExit: false,
    completionReason: null
  };
}

export function isPlayerOnboardingInstructionPhase(phase: PlayerOnboardingPhase) {
  return phase === "instruction-1" || phase === "instruction-2" || phase === "instruction-3";
}

export function playerOnboardingStep(phase: PlayerOnboardingPhase): 1 | 2 | 3 | null {
  if (phase === "instruction-1") return 1;
  if (phase === "instruction-2") return 2;
  if (phase === "instruction-3") return 3;
  return null;
}

export function shouldPauseOnboardingDemonstration(successfulTransitions: number, foregroundElapsedMs: number) {
  return successfulTransitions >= ONBOARDING_MIN_TRANSITIONS
    && foregroundElapsedMs >= ONBOARDING_MIN_DEMONSTRATION_MS;
}

function instructionPhase(step: 1 | 2 | 3): PlayerOnboardingPhase {
  return `instruction-${step}` as PlayerOnboardingPhase;
}

export function playerOnboardingReducer(
  state: PlayerOnboardingState,
  event: PlayerOnboardingEvent
): PlayerOnboardingState {
  switch (event.type) {
    case "FRAME_PRESENTED": {
      if (state.phase !== "waiting-for-player" && state.phase !== "demonstrating") return state;
      if (!state.firstPresentedPhotoId) {
        return {
          ...state,
          phase: state.reducedMotion ? "paused" : state.phase,
          firstPresentedPhotoId: event.photoId,
          lastPresentedPhotoId: event.photoId,
          resumeAfterExit: false
        };
      }
      if (event.photoId === state.lastPresentedPhotoId) return state;
      const successfulTransitions = state.successfulTransitions + 1;
      const shouldPause = state.phase === "demonstrating"
        && shouldPauseOnboardingDemonstration(successfulTransitions, event.foregroundElapsedMs);
      return {
        ...state,
        phase: shouldPause ? "paused" : "demonstrating",
        lastPresentedPhotoId: event.photoId,
        successfulTransitions,
        resumeAfterExit: true
      };
    }
    case "DEMONSTRATION_FALLBACK":
      if (state.phase !== "demonstrating" || state.successfulTransitions < 2) return state;
      return { ...state, phase: "paused", resumeAfterExit: true };
    case "DEMONSTRATION_STALLED":
      if (state.phase !== "demonstrating") return state;
      return { ...state, phase: "ineligible", source: null, resumeAfterExit: false };
    case "WAITING_TIMED_OUT":
      if (state.phase !== "waiting-for-player") return state;
      return { ...state, phase: "ineligible", source: null };
    case "PLAYER_PAUSED":
      if (state.phase !== "paused") return state;
      return { ...state, phase: "instruction-1" };
    case "TRUSTED_INTERACTION":
      if (state.phase !== "waiting-for-player" && state.phase !== "demonstrating") return state;
      return {
        ...state,
        phase: "completed",
        source: null,
        resumeAfterExit: false,
        completionReason: "interacted"
      };
    case "OPEN_HELP":
      return {
        ...state,
        phase: "paused",
        source: "manual",
        resumeAfterExit: event.resumeAfterExit,
        completionReason: null
      };
    case "NEXT": {
      const step = playerOnboardingStep(state.phase);
      if (step === null || step >= 3) return state;
      return { ...state, phase: instructionPhase((step + 1) as 2 | 3) };
    }
    case "BACK": {
      const step = playerOnboardingStep(state.phase);
      if (step === null || step <= 1) return state;
      return { ...state, phase: instructionPhase((step - 1) as 1 | 2) };
    }
    case "EXIT": {
      if (!isPlayerOnboardingInstructionPhase(state.phase)) return state;
      const resumeAfterExit = event.reason === "complete"
        ? true
        : state.reducedMotion
          ? false
          : state.resumeAfterExit;
      return {
        ...state,
        phase: "completed",
        source: null,
        resumeAfterExit,
        completionReason: event.reason
      };
    }
    case "REDUCED_MOTION_CHANGED":
      if (state.reducedMotion === event.reducedMotion) return state;
      return {
        ...state,
        reducedMotion: event.reducedMotion,
        phase: event.reducedMotion && state.phase === "demonstrating" ? "paused" : state.phase,
        resumeAfterExit: event.reducedMotion && state.source === "automatic" ? false : state.resumeAfterExit
      };
    default:
      return state;
  }
}
