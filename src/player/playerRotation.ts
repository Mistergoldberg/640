import type { Rotation } from "./imageGeometry";

export type RotationDirection = -1 | 1;
export type PlayerRotationState = Readonly<Record<string, Rotation>>;

export type PlayerRotationEvent =
  | { type: "ROTATE"; photoId: string; direction: RotationDirection }
  | { type: "RESET" };

export function normalizeRotation(value: number): Rotation {
  return ((value % 360) + 360) % 360 as Rotation;
}

export function rotationForPhoto(state: PlayerRotationState, photoId: string | null | undefined): Rotation {
  return photoId ? state[photoId] ?? 0 : 0;
}

export function playerRotationReducer(state: PlayerRotationState, event: PlayerRotationEvent): PlayerRotationState {
  switch (event.type) {
    case "ROTATE": {
      const rotation = normalizeRotation(rotationForPhoto(state, event.photoId) + event.direction * 90);
      if (rotation === 0) {
        if (!(event.photoId in state)) return state;
        const next = { ...state };
        delete next[event.photoId];
        return next;
      }
      return { ...state, [event.photoId]: rotation };
    }
    case "RESET":
      return Object.keys(state).length ? {} : state;
    default:
      return state;
  }
}
