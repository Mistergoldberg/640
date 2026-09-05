export type PlaybackStatus =
  | "loading"
  | "initial-delay"
  | "playing"
  | "temporarily-paused"
  | "explicitly-paused"
  | "buffering"
  | "ended";

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

function manualStep(state: PlayerState, direction: -1 | 1): PlayerState {
  const nextIndex = clampIndex(state.currentIndex + direction, state.total);
  if (nextIndex === state.currentIndex) {
    return state;
  }

  if (!canAutoResumeAfterManual(state.status)) {
    return {
      ...state,
      currentIndex: nextIndex,
      status: "explicitly-paused",
      bufferTargetIndex: null
    };
  }

  return {
    ...state,
    currentIndex: nextIndex,
    status: "temporarily-paused",
    bufferTargetIndex: null,
    resumeToken: state.resumeToken + 1
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
          bufferTargetIndex: null
        };
      }

      return {
        ...state,
        status: "initial-delay",
        initialDelayToken: state.initialDelayToken + 1,
        bufferTargetIndex: null
      };

    case "INITIAL_DELAY_COMPLETE":
      if (state.status !== "initial-delay") {
        return state;
      }

      if (state.currentIndex >= state.total - 1) {
        return {
          ...state,
          status: "ended",
          bufferTargetIndex: null
        };
      }

      return {
        ...state,
        status: "playing",
        bufferTargetIndex: null
      };

    case "PLAY":
      if (state.currentIndex >= state.total - 1) {
        return {
          ...state,
          status: "ended",
          bufferTargetIndex: null
        };
      }

      return {
        ...state,
        status: "playing",
        bufferTargetIndex: null
      };

    case "PAUSE":
      return {
        ...state,
        status: "explicitly-paused",
        bufferTargetIndex: null
      };

    case "MANUAL_NEXT":
      return manualStep(state, 1);

    case "MANUAL_PREVIOUS":
      return manualStep(state, -1);

    case "TEMPORARY_RESUME":
      if (state.status !== "temporarily-paused") {
        return state;
      }

      if (state.currentIndex >= state.total - 1) {
        return {
          ...state,
          status: "ended",
          bufferTargetIndex: null
        };
      }

      return {
        ...state,
        status: "playing",
        bufferTargetIndex: null
      };

    case "BUFFER_EMPTY":
      if (state.status !== "playing") {
        return state;
      }

      return {
        ...state,
        status: "buffering",
        bufferTargetIndex: clampIndex(event.targetIndex, state.total)
      };

    case "BUFFER_READY":
      if (state.status !== "buffering" || state.bufferTargetIndex === null) {
        return state;
      }

      return {
        ...state,
        currentIndex: state.bufferTargetIndex,
        status: state.bufferTargetIndex >= state.total - 1 ? "ended" : "playing",
        bufferTargetIndex: null
      };

    case "ADVANCE": {
      const nextIndex = state.currentIndex + 1;
      if (nextIndex >= state.total) {
        return {
          ...state,
          status: "ended",
          bufferTargetIndex: null
        };
      }

      return {
        ...state,
        currentIndex: nextIndex,
        status: nextIndex >= state.total - 1 ? "ended" : state.status,
        bufferTargetIndex: null
      };
    }

    case "REACH_END":
      return {
        ...state,
        currentIndex: Math.max(0, state.total - 1),
        status: "ended",
        bufferTargetIndex: null
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
        bufferTargetIndex: null
      };

    default:
      return state;
  }
}
