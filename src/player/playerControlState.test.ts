import { describe, expect, it } from "vitest";
import {
  createPlayerControlState,
  playerControlReducer,
  screenModeActive,
  speedOption
} from "./playerControlState";

describe("playerControlReducer", () => {
  it("opens grid launches expanded and direct launches in fit mode", () => {
    expect(createPlayerControlState({ openExpanded: true }).imageMode).toBe("expanded");
    expect(createPlayerControlState().imageMode).toBe("fit");
  });

  it("keeps the expanded fallback when native fullscreen never enters", () => {
    const entered = playerControlReducer(createPlayerControlState(), { type: "ENTER_SCREEN_MODE" });

    expect(entered).toEqual({ imageMode: "expanded", speedMenuOpen: false });
    expect(screenModeActive(entered, false)).toBe(true);
  });

  it("returns to fit mode when native fullscreen exits externally", () => {
    const native = playerControlReducer(createPlayerControlState(), { type: "NATIVE_FULLSCREEN_ENTERED" });
    const exited = playerControlReducer(native, { type: "NATIVE_FULLSCREEN_EXITED" });

    expect(exited).toEqual({ imageMode: "fit", speedMenuOpen: false });
    expect(screenModeActive(exited, false)).toBe(false);
  });

  it("closes the speed menu for selection, screen changes, and reset", () => {
    const open = playerControlReducer(createPlayerControlState(), { type: "TOGGLE_SPEED_MENU" });

    expect(playerControlReducer(open, { type: "SELECT_SPEED" }).speedMenuOpen).toBe(false);
    expect(playerControlReducer(open, { type: "ENTER_SCREEN_MODE" }).speedMenuOpen).toBe(false);
    expect(playerControlReducer(open, { type: "RESET", openExpanded: false }).speedMenuOpen).toBe(false);
  });

  it("provides compact and fully spoken labels for every speed", () => {
    expect([100, 250, 500, 1000, 2000].map((delayMs) => speedOption(delayMs).shortLabel)).toEqual([
      "0.1s",
      "0.25s",
      "0.5s",
      "1s",
      "2s"
    ]);
    expect(speedOption(250).accessibleLabel).toBe("0.25 seconds per photo");
  });
});
