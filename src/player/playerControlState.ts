import type { ImageMode } from "./imageGeometry";

export const PLAYER_SPEED_OPTIONS = [
  { shortLabel: "0.1s", accessibleLabel: "0.1 seconds per photo", value: 100 },
  { shortLabel: "0.25s", accessibleLabel: "0.25 seconds per photo", value: 250 },
  { shortLabel: "0.5s", accessibleLabel: "0.5 seconds per photo", value: 500 },
  { shortLabel: "1s", accessibleLabel: "1 second per photo", value: 1000 },
  { shortLabel: "2s", accessibleLabel: "2 seconds per photo", value: 2000 }
] as const;

export interface PlayerControlState {
  imageMode: ImageMode;
  speedMenuOpen: boolean;
}

export type PlayerControlEvent =
  | { type: "TOGGLE_SPEED_MENU" }
  | { type: "CLOSE_SPEED_MENU" }
  | { type: "SELECT_SPEED" }
  | { type: "ENTER_SCREEN_MODE" }
  | { type: "EXIT_SCREEN_MODE" }
  | { type: "NATIVE_FULLSCREEN_ENTERED" }
  | { type: "NATIVE_FULLSCREEN_EXITED" }
  | { type: "RESET"; openExpanded: boolean };

export function createPlayerControlState({ openExpanded = false }: { openExpanded?: boolean } = {}): PlayerControlState {
  return {
    imageMode: openExpanded ? "expanded" : "fit",
    speedMenuOpen: false
  };
}

export function playerControlReducer(state: PlayerControlState, event: PlayerControlEvent): PlayerControlState {
  switch (event.type) {
    case "TOGGLE_SPEED_MENU":
      return { ...state, speedMenuOpen: !state.speedMenuOpen };
    case "CLOSE_SPEED_MENU":
    case "SELECT_SPEED":
      return state.speedMenuOpen ? { ...state, speedMenuOpen: false } : state;
    case "ENTER_SCREEN_MODE":
    case "NATIVE_FULLSCREEN_ENTERED":
      return { imageMode: "expanded", speedMenuOpen: false };
    case "EXIT_SCREEN_MODE":
    case "NATIVE_FULLSCREEN_EXITED":
      return { imageMode: "fit", speedMenuOpen: false };
    case "RESET":
      return createPlayerControlState({ openExpanded: event.openExpanded });
    default:
      return state;
  }
}

export function screenModeActive(state: PlayerControlState, nativeFullscreenActive: boolean) {
  // The screen control owns one presentation relationship: native browser
  // fullscreen when available, with expanded image geometry as its fallback.
  // Browser state itself is updated only from fullscreen-change events.
  return nativeFullscreenActive || state.imageMode === "expanded";
}

export function speedOption(delayMs: number) {
  return PLAYER_SPEED_OPTIONS.find((option) => option.value === delayMs) ?? PLAYER_SPEED_OPTIONS[0];
}
