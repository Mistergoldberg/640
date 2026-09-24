export const PLAYER_ONBOARDING_STORAGE_KEY = "pixilation-player-onboarding-v1";
export const PLAYER_ONBOARDING_STORAGE_VALUE = "1";
export const PLAYER_ONBOARDING_SEQUENCE_FRAME_MS = 700;
export const PLAYER_ONBOARDING_CONTROL_FRAME_MS = 1_100;

type PlayerOnboardingPhase =
  | "ineligible"
  | "paused"
  | "instruction-1"
  | "instruction-2"
  | "instruction-3"
  | "completed";

export type PlayerOnboardingExitReason = "complete" | "skip" | "escape";

export interface PlayerOnboardingState {
  phase: PlayerOnboardingPhase;
  reducedMotion: boolean;
  resumeAfterExit: boolean;
}

export type PlayerOnboardingEvent =
  | { type: "PLAYER_PAUSED" }
  | { type: "OPEN_HELP"; resumeAfterExit: boolean }
  | { type: "NEXT" }
  | { type: "EXIT"; reason: PlayerOnboardingExitReason }
  | { type: "REDUCED_MOTION_CHANGED"; reducedMotion: boolean };

export function writePlayerOnboardingPreference(storage: Pick<Storage, "setItem"> | null | undefined) {
  if (!storage) return false;
  try {
    storage.setItem(PLAYER_ONBOARDING_STORAGE_KEY, PLAYER_ONBOARDING_STORAGE_VALUE);
    return true;
  } catch {
    return false;
  }
}

export function createPlayerOnboardingState(reducedMotion: boolean): PlayerOnboardingState {
  return {
    phase: "ineligible",
    reducedMotion,
    resumeAfterExit: false
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

function instructionPhase(step: 1 | 2 | 3): PlayerOnboardingPhase {
  return `instruction-${step}` as PlayerOnboardingPhase;
}

export function playerOnboardingReducer(
  state: PlayerOnboardingState,
  event: PlayerOnboardingEvent
): PlayerOnboardingState {
  switch (event.type) {
    case "PLAYER_PAUSED":
      if (state.phase !== "paused") return state;
      return { ...state, phase: "instruction-1" };
    case "OPEN_HELP":
      return {
        ...state,
        phase: "paused",
        resumeAfterExit: event.resumeAfterExit
      };
    case "NEXT": {
      const step = playerOnboardingStep(state.phase);
      if (step === null || step >= 3) return state;
      return { ...state, phase: instructionPhase((step + 1) as 2 | 3) };
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
        resumeAfterExit
      };
    }
    case "REDUCED_MOTION_CHANGED":
      if (state.reducedMotion === event.reducedMotion) return state;
      return {
        ...state,
        reducedMotion: event.reducedMotion
      };
    default:
      return state;
  }
}
