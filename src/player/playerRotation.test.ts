import { describe, expect, it } from "vitest";
import { normalizeRotation, playerRotationReducer, rotationForPhoto, type PlayerRotationState } from "./playerRotation";

describe("player rotation", () => {
  it("normalizes quarter turns in both directions", () => {
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
  });

  it("returns to zero after four clockwise activations", () => {
    let state: PlayerRotationState = {};
    for (let turn = 0; turn < 4; turn += 1) {
      state = playerRotationReducer(state, { type: "ROTATE", photoId: "photo-a", direction: 1 });
    }
    expect(rotationForPhoto(state, "photo-a")).toBe(0);
    expect(state).toEqual({});
  });

  it("rotates counterclockwise without affecting another photo", () => {
    const state = playerRotationReducer({}, { type: "ROTATE", photoId: "photo-a", direction: -1 });
    expect(rotationForPhoto(state, "photo-a")).toBe(270);
    expect(rotationForPhoto(state, "photo-b")).toBe(0);
  });

  it("restores a photo's rotation when it is revisited", () => {
    let state: PlayerRotationState = {};
    state = playerRotationReducer(state, { type: "ROTATE", photoId: "photo-a", direction: 1 });
    state = playerRotationReducer(state, { type: "ROTATE", photoId: "photo-b", direction: -1 });
    expect(rotationForPhoto(state, "photo-a")).toBe(90);
    expect(rotationForPhoto(state, "photo-b")).toBe(270);
  });

  it("clears session adjustments on reset", () => {
    const state = playerRotationReducer({ "photo-a": 180 }, { type: "RESET" });
    expect(state).toEqual({});
  });
});
