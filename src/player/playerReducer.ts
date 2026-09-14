export type PlaybackStatus =
  | "loading"
  | "initial-delay"
  | "playing"
  | "temporarily-paused"
  | "explicitly-paused"
  | "buffering"
  | "ended";

export const INITIAL_PLAY_DELAY_MS = 3000;
export const MANUAL_RESUME_DELAY_MS = 5000;
export const FRAME_INTERACTION_RESUME_DELAY_MS = 3000;

export interface PlayerScope {
  type: "year";
  year: string;
}

export interface PlayerState {
  currentIndex: number;
  status: PlaybackStatus;
  delayMs: number;
  total: number;
  bufferTargetIndex: number | null;
  resumeToken: number;
  resumeDelayMs: number | null;
  initialDelayToken: number;
  scope: PlayerScope;
}

export type PlayerEvent =
  | { type: "READY" }
  | { type: "INITIAL_DELAY_COMPLETE" }
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "MANUAL_NEXT" }
  | { type: "MANUAL_PREVIOUS" }
  | { type: "FRAME_GESTURE_START" }
  | { type: "FRAME_GESTURE_END" }
  | { type: "FRAME_NEXT" }
  | { type: "FRAME_PREVIOUS" }
  | { type: "TEMPORARY_RESUME" }
  | { type: "BUFFER_EMPTY"; targetIndex: number }
  | { type: "BUFFER_READY" }
  | { type: "ADVANCE" }
  | { type: "REACH_END" }
  | { type: "CHANGE_SPEED"; delayMs: number }
  | { type: "RESET"; initialIndex: number; total: number; scope: PlayerScope; delayMs?: number }
  | { type: "CLOSE" };

export function createPlayerState({
  initialIndex,
  total,
  delayMs = 100,
  scope
}: {
  initialIndex: number;
  total: number;
  delayMs?: number;
  scope: PlayerScope;
}): PlayerState {
  return {
    currentIndex: clampIndex(initialIndex, total),
    status: "loading",
    delayMs,
    total,
    bufferTargetIndex: null,
    resumeToken: 0,
    resumeDelayMs: null,
    initialDelayToken: 0,
    scope
  };
}

function clampIndex(index: number, total: number) {
  if (total <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(index, total - 1));
}

function canAutoResumeAfterManual(status: PlaybackStatus) {
  return status === "initial-delay" || status === "playing" || status === "temporarily-paused" || status === "buffering";
}

function manualStep(state: PlayerState, direction: -1 | 1, resumeDelayMs: number): PlayerState {
  const nextIndex = clampIndex(state.currentIndex + direction, state.total);
  if (nextIndex === state.currentIndex) {
    return state;
  }

  if (!canAutoResumeAfterManual(state.status)) {
    return {
      ...state,
      currentIndex: nextIndex,
      status: "explicitly-paused",
      bufferTargetIndex: null,
      resumeDelayMs: null
    };
  }

  return {
    ...state,
    currentIndex: nextIndex,
    status: "temporarily-paused",
    bufferTargetIndex: null,
    resumeToken: state.resumeToken + 1,
    resumeDelayMs
  };
}

function frameGestureStart(state: PlayerState): PlayerState {
  if (!canAutoResumeAfterManual(state.status)) {
    return state;
  }

  return {
    ...state,
    status: "temporarily-paused",
    bufferTargetIndex: null,
    resumeDelayMs: null
  };
}

function frameGestureEnd(state: PlayerState): PlayerState {
  if (state.status !== "temporarily-paused") {
    return state;
  }

  return {
    ...state,
    bufferTargetIndex: null,
    resumeToken: state.resumeToken + 1,
    resumeDelayMs: FRAME_INTERACTION_RESUME_DELAY_MS
  };
}

export function playerReducer(state: PlayerState, event: PlayerEvent): PlayerState {
  switch (event.type) {
    case "READY":
      if (state.status !== "loading") {
        return state;
      }

      if (state.currentIndex >= state.total - 1) {
        return {
          ...state,
          status: "ended",
          bufferTargetIndex: null,
          resumeDelayMs: null
        };
      }

      return {
        ...state,
        status: "initial-delay",
        initialDelayToken: state.initialDelayToken + 1,
        bufferTargetIndex: null,
        resumeDelayMs: null
      };

    case "INITIAL_DELAY_COMPLETE":
      if (state.status !== "initial-delay") {
        return state;
      }

      if (state.currentIndex >= state.total - 1) {
        return {
          ...state,
          status: "ended",
          bufferTargetIndex: null,
          resumeDelayMs: null
        };
      }

      return {
        ...state,
        status: "playing",
        bufferTargetIndex: null,
        resumeDelayMs: null
      };

    case "PLAY":
      if (state.currentIndex >= state.total - 1) {
        return {
          ...state,
          status: "ended",
          bufferTargetIndex: null,
          resumeDelayMs: null
        };
      }

      return {
        ...state,
        status: "playing",
        bufferTargetIndex: null,
        resumeDelayMs: null
      };

    case "PAUSE":
      return {
        ...state,
        status: "explicitly-paused",
        bufferTargetIndex: null,
        resumeDelayMs: null
      };

    case "MANUAL_NEXT":
      return manualStep(state, 1, MANUAL_RESUME_DELAY_MS);

    case "MANUAL_PREVIOUS":
      return manualStep(state, -1, MANUAL_RESUME_DELAY_MS);

    case "FRAME_GESTURE_START":
      return frameGestureStart(state);

    case "FRAME_GESTURE_END":
      return frameGestureEnd(state);

    case "FRAME_NEXT":
      return manualStep(state, 1, FRAME_INTERACTION_RESUME_DELAY_MS);

    case "FRAME_PREVIOUS":
      return manualStep(state, -1, FRAME_INTERACTION_RESUME_DELAY_MS);

    case "TEMPORARY_RESUME":
      if (state.status !== "temporarily-paused") {
        return state;
      }

      if (state.currentIndex >= state.total - 1) {
        return {
          ...state,
          status: "ended",
          bufferTargetIndex: null,
          resumeDelayMs: null
        };
      }

      return {
        ...state,
        status: "playing",
        bufferTargetIndex: null,
        resumeDelayMs: null
      };

    case "BUFFER_EMPTY":
      if (state.status !== "playing") {
        return state;
      }

      return {
        ...state,
        status: "buffering",
        bufferTargetIndex: clampIndex(event.targetIndex, state.total),
        resumeDelayMs: null
      };

    case "BUFFER_READY":
      if (state.status !== "buffering" || state.bufferTargetIndex === null) {
        return state;
      }

      return {
        ...state,
        currentIndex: state.bufferTargetIndex,
        status: state.bufferTargetIndex >= state.total - 1 ? "ended" : "playing",
        bufferTargetIndex: null,
        resumeDelayMs: null
      };

    case "ADVANCE": {
      const nextIndex = state.currentIndex + 1;
      if (nextIndex >= state.total) {
        return {
          ...state,
          status: "ended",
          bufferTargetIndex: null,
          resumeDelayMs: null
        };
      }

      return {
        ...state,
        currentIndex: nextIndex,
        status: nextIndex >= state.total - 1 ? "ended" : state.status,
        bufferTargetIndex: null,
        resumeDelayMs: nextIndex >= state.total - 1 ? null : state.resumeDelayMs
      };
    }

    case "REACH_END":
      return {
        ...state,
        currentIndex: Math.max(0, state.total - 1),
        status: "ended",
        bufferTargetIndex: null,
        resumeDelayMs: null
      };

    case "CHANGE_SPEED":
      return {
        ...state,
        delayMs: event.delayMs
      };

    case "RESET":
      return createPlayerState({
        initialIndex: event.initialIndex,
        total: event.total,
        delayMs: event.delayMs ?? state.delayMs,
        scope: event.scope
      });

    case "CLOSE":
      return {
        ...state,
        status: "explicitly-paused",
        bufferTargetIndex: null,
        resumeDelayMs: null
      };

    default:
      return state;
  }
}
