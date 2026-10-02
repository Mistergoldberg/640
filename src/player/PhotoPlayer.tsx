import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import { CircleHelp, X } from "lucide-react";
import { mediaUrl } from "../lib/assets";
import type { Photo } from "../types";
import { exitDocumentFullscreen, fullscreenElement, requestDocumentFullscreen, subscribeToFullscreenChanges } from "./fullscreen";
import { calculateImageGeometry, playerFitClearance, type ImageGeometry, type ImageMode, type Rotation } from "./imageGeometry";
import { PlayerRotationControls } from "./PlayerRotationControls";
import { PlayerControls } from "./PlayerControls";
import { createPlayerControlState, playerControlReducer, screenModeActive } from "./playerControlState";
import { PlayerFrameNavigationController, type FrameNavigationDirection } from "./playerFrameNavigation";
import { INITIAL_PLAY_DELAY_MS, createPlayerState, playerReducer, type PlayerScope, type PlayerState } from "./playerReducer";
import {
  PlayerTouchNavigationController,
  TOUCH_SYNTHETIC_CLICK_SUPPRESSION_MS,
  directionFromClientX,
  isWithinMobileLandscapeRail,
  shouldSuppressSyntheticClick
} from "./playerTouchNavigation";
import { usePlaybackClock } from "./usePlaybackClock";
import { playerRotationReducer, rotationForPhoto, type RotationDirection } from "./playerRotation";
import { settledRange, usableRange } from "./homepageAutoplay";
import { PlayerOnboardingTour } from "./PlayerOnboardingTour";
import {
  createPlayerOnboardingState,
  isPlayerOnboardingInstructionPhase,
  playerOnboardingReducer,
  playerOnboardingStep,
  writePlayerOnboardingPreference,
  type PlayerOnboardingEvent,
  type PlayerOnboardingExitReason,
  type PlayerOnboardingState
} from "./playerOnboarding";

const PRELOAD_AHEAD = 30;
const PRELOAD_BEHIND = 8;
const SOUNDCLOUD_WIDGET_API_URL = "https://w.soundcloud.com/player/api.js";
const SOUNDCLOUD_EMBED_URL =
  "https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Fplaylists%2F2293150329&auto_play=true&hide_related=true&show_comments=false&show_user=false&show_reposts=false&show_teaser=false&visual=false&show_artwork=false";

type ShareStatus = "idle" | "copied" | "failed";

interface SoundCloudWidget {
  bind(eventName: string, listener: () => void): void;
  pause(): void;
  play(): void;
}

interface SoundCloudWidgetFactory {
  (iframe: HTMLIFrameElement): SoundCloudWidget;
  Events: {
    FINISH: string;
    PAUSE: string;
    PLAY: string;
    READY: string;
  };
}

declare global {
  interface Window {
    SC?: {
      Widget: SoundCloudWidgetFactory;
    };
  }
}

interface CacheEntry {
  image: HTMLImageElement;
  ready: boolean;
  failed: boolean;
}

interface PhotoPlayerProps {
  photos: Photo[];
  initialIndex: number;
  openInFullscreen?: boolean;
  scope: PlayerScope;
  onClose: (photoId: string) => void;
  launchMode?: "standard" | "homepage-autoplay";
}

let soundCloudApiPromise: Promise<void> | null = null;

function clampIndex(index: number, total: number) {
  if (total <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(index, total - 1));
}

function canPause(status: PlayerState["status"]) {
  return status === "playing" || status === "buffering" || status === "temporarily-paused";
}

function loadSoundCloudApi() {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  if (window.SC?.Widget) {
    return Promise.resolve();
  }

  if (soundCloudApiPromise) {
    return soundCloudApiPromise;
  }

  soundCloudApiPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${SOUNDCLOUD_WIDGET_API_URL}"]`);
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(new Error("SoundCloud player failed to load")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = SOUNDCLOUD_WIDGET_API_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("SoundCloud player failed to load"));
    document.head.appendChild(script);
  });

  return soundCloudApiPromise;
}

function playerShareUrl(photo: Photo, scope: PlayerScope) {
  const shareUrl = new URL(window.location.href);
  shareUrl.searchParams.set("year", scope.year);
  shareUrl.searchParams.set("photo", photo.id);
  return shareUrl.toString();
}

async function copyShareUrl(url: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }

  const input = document.createElement("input");
  input.value = url;
  input.setAttribute("readonly", "true");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();

  try {
    const didCopy = document.execCommand("copy");
    if (!didCopy) {
      throw new Error("Copy command failed");
    }
  } finally {
    input.remove();
  }
}

function hasFinePointer() {
  return typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;
}

const MOBILE_INSTRUCTION_MAX_WIDTH = 1200;

function usesDesktopInstructions() {
  if (typeof window === "undefined") return false;
  const viewportWidth = window.visualViewport?.width || window.innerWidth;
  return viewportWidth > MOBILE_INSTRUCTION_MAX_WIDTH
    && navigator.maxTouchPoints === 0
    && !window.matchMedia("(pointer: coarse)").matches
    && !window.matchMedia("(any-pointer: coarse)").matches;
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function playerOnboardingStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function shouldResumeAfterHelp(status: PlayerState["status"]) {
  return status === "loading"
    || status === "initial-delay"
    || status === "playing"
    || status === "buffering"
    || status === "temporarily-paused";
}

function visibleRect(element: Element) {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  return rect;
}

function photoImageGeometry(
  photo: Photo,
  mode: ImageMode,
  viewport: { width: number; height: number; landscapeRail: boolean },
  rotation: Rotation
) {
  const clearance = mode === "fit" && !viewport.landscapeRail
    ? playerFitClearance(viewport.width, viewport.height)
    : { vertical: 0, horizontal: 0 };
  return calculateImageGeometry({
    sourceWidth: photo.width,
    sourceHeight: photo.height,
    viewportWidth: Math.max(1, viewport.width - clearance.horizontal),
    viewportHeight: viewport.height,
    controlClearance: clearance.vertical,
    mode,
    rotation
  });
}

function imageGeometryStyle(mode: ImageMode, geometry: ImageGeometry | null) {
  if (!geometry || (mode === "fit" && geometry.rotation === 0)) return undefined;
  return {
    width: `${Math.round(geometry.layoutWidth)}px`,
    height: `${Math.round(geometry.layoutHeight)}px`,
    maxWidth: "none",
    maxHeight: "none",
    transform: mode === "expanded"
      ? `translate(-50%, -50%) rotate(${geometry.rotation}deg)`
      : `rotate(${geometry.rotation}deg)`
  };
}

export function PhotoPlayer({ photos, initialIndex, openInFullscreen = false, scope, onClose, launchMode = "standard" }: PhotoPlayerProps) {
  const resetKey = `${scope.type}:${scope.year}:${initialIndex}:${photos.length}`;
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const [desktopInstructions, setDesktopInstructions] = useState(usesDesktopInstructions);
  const [playerState, dispatch] = useReducer(
    playerReducer,
    { initialIndex, total: photos.length, scope, launchMode, reducedMotion },
    createPlayerState
  );
  const [paintedFrame, setPaintedFrame] = useState(() => ({
    resetKey,
    photo: photos[clampIndex(initialIndex, photos.length)] ?? null
  }));
  const [controlState, controlDispatch] = useReducer(playerControlReducer, { openExpanded: openInFullscreen }, createPlayerControlState);
  const [photoRotations, rotationDispatch] = useReducer(playerRotationReducer, {});
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hasMusicLoaded, setHasMusicLoaded] = useState(false);
  const [shouldPlayMusic, setShouldPlayMusic] = useState(false);
  const [isMusicWidgetReady, setIsMusicWidgetReady] = useState(false);
  const [isMusicPlaying, setIsMusicPlaying] = useState(false);
  const [shareStatus, setShareStatus] = useState<ShareStatus>("idle");
  const [nativeFullscreenActive, setNativeFullscreenActive] = useState(() => Boolean(fullscreenElement()));
  const onboardingDescriptionId = useId();
  const rotationControlsId = useId();
  const initialOnboardingStateRef = useRef<PlayerOnboardingState | null>(null);
  if (!initialOnboardingStateRef.current) {
    initialOnboardingStateRef.current = createPlayerOnboardingState(reducedMotion);
  }
  const [onboardingState, setOnboardingState] = useState(initialOnboardingStateRef.current);
  const onboardingStateRef = useRef(onboardingState);
  const [playerViewport, setPlayerViewport] = useState(() => ({
    width: typeof window === "undefined" ? 640 : window.innerWidth,
    height: typeof window === "undefined" ? 480 : window.innerHeight,
    landscapeRail: false
  }));
  const cacheRef = useRef(new Map<number, CacheEntry>());
  const rollingWarmupLaunchKeyRef = useRef<string | null>(null);
  const rollingWarmupFrameRef = useRef<number | null>(null);
  const [cacheRevision, setCacheRevision] = useState(0);
  const musicIframeRef = useRef<HTMLIFrameElement | null>(null);
  const soundCloudWidgetRef = useRef<SoundCloudWidget | null>(null);
  const stateRef = useRef<PlayerState>(playerState);
  const currentIndexRef = useRef(playerState.currentIndex);
  const currentImageRef = useRef<HTMLImageElement | null>(null);
  const paintedImageRef = useRef<HTMLImageElement | null>(null);
  const desiredPhotoIdRef = useRef<string | null>(null);
  const nativeFullscreenRef = useRef(nativeFullscreenActive);
  const fullscreenRequestTokenRef = useRef(0);
  const controlsTimerRef = useRef<number | null>(null);
  const initialPlayTimerRef = useRef<number | null>(null);
  const resumeTimerRef = useRef<number | null>(null);
  const shareTimerRef = useRef<number | null>(null);
  const ignoreSyntheticClickUntilRef = useRef(0);
  const touchPointerIdRef = useRef<number | null>(null);
  const framePointerIdRef = useRef<number | null>(null);
  const frameInteractionRef = useRef<PlayerFrameNavigationController | null>(null);
  const touchInteractionRef = useRef<PlayerTouchNavigationController | null>(null);
  const surfaceRef = useRef<HTMLButtonElement | null>(null);
  const speedControlRef = useRef<HTMLButtonElement | null>(null);
  const musicControlRef = useRef<HTMLButtonElement | null>(null);
  const rotationControlRef = useRef<HTMLButtonElement | null>(null);
  const helpControlRef = useRef<HTMLButtonElement | null>(null);
  const focusRestoreFrameRef = useRef<number | null>(null);
  const rotationFocusFrameRef = useRef<number | null>(null);
  const mediaStageRef = useRef<HTMLDivElement | null>(null);
  const resetKeyRef = useRef(resetKey);

  const currentIndex = playerState.currentIndex;
  const currentPhoto = photos[currentIndex];
  const paintedPhoto = paintedFrame.resetKey === resetKey
    ? paintedFrame.photo
    : photos[clampIndex(initialIndex, photos.length)] ?? null;
  const isImagePending = Boolean(paintedPhoto && currentPhoto && paintedPhoto.id !== currentPhoto.id);
  desiredPhotoIdRef.current = currentPhoto?.id ?? null;
  const atStart = currentIndex <= 0;
  const atEnd = currentIndex >= photos.length - 1;
  const status = playerState.status;
  const isBuffering = status === "buffering";
  const initialPlayPending = status === "loading" || status === "initial-delay";
  const temporaryResumePending = status === "temporarily-paused";
  const imageMode = controlState.imageMode;
  const rotationModeOpen = controlState.rotationModeOpen;
  const rotationModeOpenRef = useRef(rotationModeOpen);
  rotationModeOpenRef.current = rotationModeOpen;
  const currentRotation = rotationForPhoto(photoRotations, currentPhoto?.id);
  const paintedRotation = rotationForPhoto(photoRotations, paintedPhoto?.id);
  const isScreenModeActive = screenModeActive(controlState, nativeFullscreenActive);
  const onboardingStep = playerOnboardingStep(onboardingState.phase);
  const onboardingActive = onboardingStep !== null;
  const desktopOnboardingActive = desktopInstructions && onboardingActive;

  const sendOnboarding = useCallback((event: PlayerOnboardingEvent) => {
    const next = playerOnboardingReducer(onboardingStateRef.current, event);
    onboardingStateRef.current = next;
    setOnboardingState(next);
    return next;
  }, []);
  const advanceOnboarding = useCallback(() => sendOnboarding({ type: "NEXT" }), [sendOnboarding]);

  useEffect(() => {
    stateRef.current = playerState;
    currentIndexRef.current = playerState.currentIndex;
  }, [playerState]);

  const clearInitialDelayTimer = useCallback(() => {
    if (initialPlayTimerRef.current !== null) {
      window.clearTimeout(initialPlayTimerRef.current);
      initialPlayTimerRef.current = null;
    }
  }, []);

  const clearResumeTimer = useCallback(() => {
    if (resumeTimerRef.current !== null) {
      window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
  }, []);

  const clearImageCache = useCallback(() => {
    for (const entry of cacheRef.current.values()) {
      entry.image.onload = null;
      entry.image.onerror = null;
    }
    cacheRef.current.clear();
  }, []);

  const suppressSyntheticClick = useCallback(() => {
    ignoreSyntheticClickUntilRef.current = Date.now() + TOUCH_SYNTHETIC_CLICK_SUPPRESSION_MS;
  }, []);

  const close = useCallback(() => {
    frameInteractionRef.current?.destroy();
    framePointerIdRef.current = null;
    touchInteractionRef.current?.destroy();
    touchPointerIdRef.current = null;
    clearInitialDelayTimer();
    clearResumeTimer();
    fullscreenRequestTokenRef.current += 1;
    if (nativeFullscreenRef.current || fullscreenElement()) {
      void exitDocumentFullscreen();
    }
    dispatch({ type: "CLOSE" });
    onClose(photos[currentIndexRef.current]?.id || photos[initialIndex]?.id || "");
  }, [clearInitialDelayTimer, clearResumeTimer, initialIndex, onClose, photos]);

  const markBufferedImageReady = useCallback((index: number) => {
    const state = stateRef.current;
    if (state.status === "buffering" && state.bufferTargetIndex === index) {
      dispatch({ type: "BUFFER_READY" });
    }
  }, []);

  const preloadPhoto = useCallback(
    (index: number) => {
      if (index < 0 || index >= photos.length) {
        return null;
      }

      const existing = cacheRef.current.get(index);
      if (existing) {
        return existing;
      }

      const image = new Image();
      const entry: CacheEntry = {
        image,
        ready: false,
        failed: false
      };

      const markReady = () => {
        if (cacheRef.current.get(index) !== entry) {
          return;
        }
        entry.ready = true;
        entry.failed = false;
        entry.image.onload = null;
        entry.image.onerror = null;
        setCacheRevision((revision) => revision + 1);
        markBufferedImageReady(index);
      };

      const markFailed = () => {
        if (cacheRef.current.get(index) !== entry) {
          return;
        }
        entry.failed = true;
        entry.image.onload = null;
        entry.image.onerror = null;
        setCacheRevision((revision) => revision + 1);
        markBufferedImageReady(index);
      };

      cacheRef.current.set(index, entry);
      image.decoding = "async";
      image.onload = () => {
        if (typeof image.decode === "function") {
          void image.decode().then(markReady, markFailed);
        } else {
          markReady();
        }
      };
      image.onerror = markFailed;
      image.src = mediaUrl(photos[index].displayKey);
      return entry;
    },
    [markBufferedImageReady, photos]
  );

  const warmBuffer = useCallback(
    (index: number) => {
      for (let offset = 0; offset <= PRELOAD_AHEAD; offset += 1) {
        preloadPhoto(index + offset);
      }

      for (const cachedIndex of Array.from(cacheRef.current.keys())) {
        if (cachedIndex < index - PRELOAD_BEHIND || cachedIndex > index + PRELOAD_AHEAD + 12) {
          const entry = cacheRef.current.get(cachedIndex);
          if (entry) {
            entry.image.onload = null;
            entry.image.onerror = null;
          }
          cacheRef.current.delete(cachedIndex);
        }
      }
    },
    [preloadPhoto]
  );

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimerRef.current !== null) {
      window.clearTimeout(controlsTimerRef.current);
    }

    if (isPlayerOnboardingInstructionPhase(onboardingStateRef.current.phase) || rotationModeOpenRef.current) {
      controlsTimerRef.current = null;
      return;
    }

    controlsTimerRef.current = window.setTimeout(() => setControlsVisible(false), 1800);
  }, []);

  const pauseExplicitly = useCallback(() => {
    revealControls();
    clearInitialDelayTimer();
    clearResumeTimer();
    dispatch({ type: "PAUSE" });
  }, [clearInitialDelayTimer, clearResumeTimer, revealControls]);

  const playExplicitly = useCallback(() => {
    revealControls();
    controlDispatch({ type: "CLOSE_ROTATION_MODE" });
    if (stateRef.current.status === "loading") {
      return;
    }

    clearInitialDelayTimer();
    clearResumeTimer();
    warmBuffer(currentIndexRef.current);
    dispatch({ type: "WARMUP_EXIT" });
    dispatch({ type: "PLAY" });
  }, [clearInitialDelayTimer, clearResumeTimer, revealControls, warmBuffer]);

  const openOnboardingHelp = useCallback(() => {
    controlDispatch({ type: "CLOSE_ROTATION_MODE" });
    const resumeAfterExit = shouldResumeAfterHelp(stateRef.current.status);
    sendOnboarding({ type: "OPEN_HELP", resumeAfterExit });
    pauseExplicitly();
  }, [pauseExplicitly, sendOnboarding]);

  const exitOnboarding = useCallback((reason: PlayerOnboardingExitReason) => {
    const previous = onboardingStateRef.current;
    writePlayerOnboardingPreference(playerOnboardingStorage());
    const next = sendOnboarding({ type: "EXIT", reason });
    if (next === previous || next.phase !== "completed") return;
    if (next.resumeAfterExit) playExplicitly();
    else pauseExplicitly();
    if (focusRestoreFrameRef.current !== null) window.cancelAnimationFrame(focusRestoreFrameRef.current);
    focusRestoreFrameRef.current = window.requestAnimationFrame(() => {
      focusRestoreFrameRef.current = null;
      helpControlRef.current?.focus({ preventScroll: true });
    });
  }, [pauseExplicitly, playExplicitly, sendOnboarding]);

  useEffect(() => {
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const pointerQuery = window.matchMedia("(pointer: fine)");
    const coarsePointerQuery = window.matchMedia("(pointer: coarse)");
    const anyCoarsePointerQuery = window.matchMedia("(any-pointer: coarse)");
    const updateMotion = () => {
      setReducedMotion(motionQuery.matches);
      sendOnboarding({ type: "REDUCED_MOTION_CHANGED", reducedMotion: motionQuery.matches });
      if (motionQuery.matches && launchMode === "homepage-autoplay") {
        clearInitialDelayTimer();
        clearResumeTimer();
        dispatch({ type: "PAUSE" });
      }
    };
    const updatePointer = () => setDesktopInstructions(usesDesktopInstructions());
    motionQuery.addEventListener("change", updateMotion);
    pointerQuery.addEventListener("change", updatePointer);
    coarsePointerQuery.addEventListener("change", updatePointer);
    anyCoarsePointerQuery.addEventListener("change", updatePointer);
    window.addEventListener("resize", updatePointer);
    window.addEventListener("orientationchange", updatePointer);
    window.visualViewport?.addEventListener("resize", updatePointer);
    updatePointer();
    return () => {
      motionQuery.removeEventListener("change", updateMotion);
      pointerQuery.removeEventListener("change", updatePointer);
      coarsePointerQuery.removeEventListener("change", updatePointer);
      anyCoarsePointerQuery.removeEventListener("change", updatePointer);
      window.removeEventListener("resize", updatePointer);
      window.removeEventListener("orientationchange", updatePointer);
      window.visualViewport?.removeEventListener("resize", updatePointer);
    };
  }, [clearInitialDelayTimer, clearResumeTimer, launchMode, sendOnboarding]);

  useEffect(() => {
    if (onboardingState.phase !== "paused") return;
    pauseExplicitly();
    controlDispatch({ type: "CLOSE_SPEED_MENU" });
    setControlsVisible(true);
    const frame = window.requestAnimationFrame(() => sendOnboarding({ type: "PLAYER_PAUSED" }));
    return () => window.cancelAnimationFrame(frame);
  }, [onboardingState.phase, pauseExplicitly, sendOnboarding]);

  useEffect(() => {
    if (!onboardingActive) return;
    setControlsVisible(true);
    if (controlsTimerRef.current !== null) {
      window.clearTimeout(controlsTimerRef.current);
      controlsTimerRef.current = null;
    }
  }, [onboardingActive, onboardingStep]);

  useEffect(() => {
    if (rotationModeOpen) {
      setControlsVisible(true);
      if (controlsTimerRef.current !== null) {
        window.clearTimeout(controlsTimerRef.current);
        controlsTimerRef.current = null;
      }
      return;
    }
    revealControls();
  }, [revealControls, rotationModeOpen]);

  const navigateManually = useCallback(
    (direction: -1 | 1) => {
      revealControls();

      const fromIndex = currentIndexRef.current;
      const nextIndex = clampIndex(fromIndex + direction, photos.length);
      if (nextIndex === fromIndex) {
        return;
      }

      clearInitialDelayTimer();
      clearResumeTimer();
      dispatch({ type: direction > 0 ? "MANUAL_NEXT" : "MANUAL_PREVIOUS" });
      warmBuffer(nextIndex);
    },
    [clearInitialDelayTimer, clearResumeTimer, photos.length, revealControls, warmBuffer]
  );

  const pauseForFrameInteraction = useCallback(() => {
    revealControls();
    clearInitialDelayTimer();
    clearResumeTimer();
    dispatch({ type: "FRAME_GESTURE_START" });
  }, [clearInitialDelayTimer, clearResumeTimer, revealControls]);

  const finishFrameInteraction = useCallback(() => {
    clearResumeTimer();
    dispatch({ type: "FRAME_GESTURE_END" });
  }, [clearResumeTimer]);

  const navigateByFrameInteraction = useCallback(
    (direction: FrameNavigationDirection) => {
      revealControls();

      const fromIndex = currentIndexRef.current;
      const nextIndex = clampIndex(fromIndex + direction, photos.length);
      if (nextIndex === fromIndex) {
        return;
      }

      clearInitialDelayTimer();
      clearResumeTimer();
      dispatch({ type: direction > 0 ? "FRAME_NEXT" : "FRAME_PREVIOUS" });
      warmBuffer(nextIndex);
    },
    [clearInitialDelayTimer, clearResumeTimer, photos.length, revealControls, warmBuffer]
  );

  useEffect(() => {
    if (!frameInteractionRef.current) {
      frameInteractionRef.current = new PlayerFrameNavigationController({
        pause: pauseForFrameInteraction,
        navigate: navigateByFrameInteraction,
        finish: finishFrameInteraction
      });
    } else {
      frameInteractionRef.current.setActions({
        pause: pauseForFrameInteraction,
        navigate: navigateByFrameInteraction,
        finish: finishFrameInteraction
      });
    }

    if (!touchInteractionRef.current) {
      touchInteractionRef.current = new PlayerTouchNavigationController({
        pause: pauseForFrameInteraction,
        navigate: navigateByFrameInteraction,
        finish: finishFrameInteraction
      });
    } else {
      touchInteractionRef.current.setActions({
        pause: pauseForFrameInteraction,
        navigate: navigateByFrameInteraction,
        finish: finishFrameInteraction
      });
    }
  }, [finishFrameInteraction, navigateByFrameInteraction, pauseForFrameInteraction]);

  const cancelFramePointerInteraction = useCallback(() => {
    if (frameInteractionRef.current?.cancelPointer()) {
      framePointerIdRef.current = null;
    }
  }, []);

  const cancelTouchFrameInteraction = useCallback((finishGesture = true) => {
    if (touchInteractionRef.current?.cancel(finishGesture)) {
      touchPointerIdRef.current = null;
    }
  }, []);

  const cancelActiveFrameInteractions = useCallback(() => {
    cancelFramePointerInteraction();
    cancelTouchFrameInteraction();
  }, [cancelFramePointerInteraction, cancelTouchFrameInteraction]);

  const releasePointerCapture = useCallback((target: Element, pointerId: number) => {
    if (target instanceof HTMLElement && target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  }, []);

  const mobileLandscapeRailLeft = useCallback(() => {
    if (!playerViewport.landscapeRail) {
      return null;
    }

    const overlay = surfaceRef.current?.closest(".player-overlay");
    const controls = Array.from(
      overlay?.querySelectorAll<HTMLElement>('.player-controls > [data-player-control="music"], .player-controls > [data-player-control="speed"], .player-controls > [data-player-control="rotation"]') || []
    )
      .map(visibleRect)
      .filter((rect): rect is DOMRect => Boolean(rect));

    if (controls.length === 0) {
      return null;
    }

    return Math.min(...controls.map((rect) => rect.left));
  }, [playerViewport.landscapeRail]);

  const pointHitsMobileLandscapeRail = useCallback(
    (clientX: number) => isWithinMobileLandscapeRail(clientX, mobileLandscapeRailLeft()),
    [mobileLandscapeRailLeft]
  );

  const pointHitsPlayerControl = useCallback((clientX: number, clientY: number) => {
    const overlay = surfaceRef.current?.closest(".player-overlay");
    const controls = Array.from(
      overlay?.querySelectorAll<HTMLElement>(".player-topbar button, .player-help, .player-controls > [data-player-control], .speed-menu button, .player-rotation-controls button") || []
    )
      .map(visibleRect)
      .filter((rect): rect is DOMRect => Boolean(rect));

    return controls.some((rect) => clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom);
  }, []);

  const closeSpeedMenu = useCallback(() => {
    controlDispatch({ type: "CLOSE_SPEED_MENU" });
  }, []);

  const toggleSpeedMenu = useCallback(() => {
    controlDispatch({ type: "TOGGLE_SPEED_MENU" });
  }, []);

  const closeRotationMode = useCallback((restoreFocus = false) => {
    controlDispatch({ type: "CLOSE_ROTATION_MODE" });
    if (!restoreFocus) return;
    if (rotationFocusFrameRef.current !== null) window.cancelAnimationFrame(rotationFocusFrameRef.current);
    rotationFocusFrameRef.current = window.requestAnimationFrame(() => {
      rotationFocusFrameRef.current = null;
      rotationControlRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const toggleRotationMode = useCallback(() => {
    revealControls();
    if (rotationModeOpenRef.current) {
      closeRotationMode();
      return;
    }

    pauseExplicitly();
    controlDispatch({ type: "TOGGLE_ROTATION_MODE" });
  }, [closeRotationMode, pauseExplicitly, revealControls]);

  const rotateCurrentPhoto = useCallback((direction: RotationDirection) => {
    const photo = photos[currentIndexRef.current];
    if (!photo) return;
    revealControls();
    rotationDispatch({ type: "ROTATE", photoId: photo.id, direction });
  }, [photos, revealControls]);

  const selectSpeed = useCallback(
    (delayMs: number) => {
      dispatch({ type: "CHANGE_SPEED", delayMs });
      controlDispatch({ type: "SELECT_SPEED" });
      revealControls();
    },
    [revealControls]
  );

  const toggleScreenMode = useCallback(() => {
    revealControls();
    closeSpeedMenu();

    if (screenModeActive(controlState, nativeFullscreenRef.current)) {
      fullscreenRequestTokenRef.current += 1;
      controlDispatch({ type: "EXIT_SCREEN_MODE" });
      if (nativeFullscreenRef.current) {
        void exitDocumentFullscreen();
      }
      return;
    }

    // Keep expanded mode as the deterministic fallback. This request is also
    // called directly by the screen control's click handler, preserving its
    // user activation when native fullscreen is available.
    controlDispatch({ type: "ENTER_SCREEN_MODE" });
    const requestToken = fullscreenRequestTokenRef.current + 1;
    fullscreenRequestTokenRef.current = requestToken;
    void requestDocumentFullscreen().then((entered) => {
      if (entered && fullscreenRequestTokenRef.current !== requestToken) {
        void exitDocumentFullscreen();
      }
    });
  }, [closeSpeedMenu, controlState, revealControls]);

  const toggleFromPrimaryControl = useCallback(() => {
    if (canPause(stateRef.current.status)) {
      pauseExplicitly();
    } else {
      playExplicitly();
    }
  }, [pauseExplicitly, playExplicitly]);

  const toggleFromPhotoSurface = useCallback(() => {
    revealControls();
    if (stateRef.current.status === "loading") {
      return;
    }

    if (stateRef.current.status === "temporarily-paused") {
      playExplicitly();
      return;
    }

    if (canPause(stateRef.current.status)) {
      pauseExplicitly();
      return;
    }

    playExplicitly();
  }, [pauseExplicitly, playExplicitly, revealControls]);

  const toggleMusic = useCallback(() => {
    revealControls();
    const nextValue = !shouldPlayMusic;
    if (nextValue) {
      setHasMusicLoaded(true);
    }

    setShouldPlayMusic(nextValue);
    if (nextValue) {
      soundCloudWidgetRef.current?.play();
    } else {
      soundCloudWidgetRef.current?.pause();
    }
  }, [revealControls, shouldPlayMusic]);

  const showShareStatus = useCallback((nextStatus: ShareStatus) => {
    setShareStatus(nextStatus);
    if (shareTimerRef.current !== null) {
      window.clearTimeout(shareTimerRef.current);
      shareTimerRef.current = null;
    }

    if (nextStatus !== "idle") {
      shareTimerRef.current = window.setTimeout(() => {
        shareTimerRef.current = null;
        setShareStatus("idle");
      }, 1800);
    }
  }, []);

  const shareCurrentPhoto = useCallback(async () => {
    revealControls();

    const photo = photos[currentIndexRef.current];
    if (!photo) {
      showShareStatus("failed");
      return;
    }

    const shareUrl = playerShareUrl(photo, scope);
    try {
      if (navigator.share) {
        await navigator.share({
          title: "640×480",
          url: shareUrl
        });
        showShareStatus("copied");
        return;
      }

      await copyShareUrl(shareUrl);
      showShareStatus("copied");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        showShareStatus("idle");
        return;
      }

      try {
        await copyShareUrl(shareUrl);
        showShareStatus("copied");
      } catch {
        showShareStatus("failed");
      }
    }
  }, [photos, revealControls, scope, showShareStatus]);

  const attemptAdvance = useCallback(() => {
    const state = stateRef.current;
    if (state.status !== "playing") {
      return false;
    }

    if (state.launchMode === "homepage-autoplay" && state.warmupPhase !== "inactive" && state.warmupPhase !== "steady-forward") {
      const statuses = new Map<number, "ready" | "failed">();
      for (const [index, entry] of cacheRef.current) {
        if (entry.ready) statuses.set(index, "ready");
        else if (entry.failed) statuses.set(index, "failed");
      }
      const first = usableRange(statuses, 0, Math.min(5, photos.length));
      const second = usableRange(statuses, 5, Math.min(15, photos.length));
      const phase = state.warmupPhase;
      const moveWithin = (indices: number[], forward: boolean, forwardPhase: PlayerState["warmupPhase"], backwardPhase: PlayerState["warmupPhase"]) => {
        const position = indices.indexOf(state.currentIndex);
        if (forward && position >= 0 && position < indices.length - 1) {
          dispatch({ type: "WARMUP_FRAME", index: indices[position + 1], phase: forwardPhase });
          return true;
        }
        if (forward && indices.length > 1) {
          dispatch({ type: "WARMUP_FRAME", index: indices[indices.length - 2], phase: backwardPhase });
          return true;
        }
        if (!forward && position > 0) {
          dispatch({ type: "WARMUP_FRAME", index: indices[position - 1], phase: backwardPhase });
          return true;
        }
        return false;
      };

      if (phase === "first-five-forward" && moveWithin(first, true, "first-five-forward", "first-five-backward")) return true;
      if (phase === "first-five-backward" && moveWithin(first, false, "first-five-forward", "first-five-backward")) return true;
      if (phase === "first-five-forward" || phase === "first-five-backward") {
        if (settledRange(statuses, 5, Math.min(15, photos.length))) {
          if (second.length) {
            dispatch({ type: "WARMUP_FRAME", index: second[0], phase: second.length > 1 ? "next-ten-forward" : "next-ten-backward" });
          } else {
            dispatch({ type: "WARMUP_EXIT" });
          }
          return true;
        }
        if (first.length > 1) {
          dispatch({ type: "WARMUP_FRAME", index: first[1], phase: "first-five-forward" });
          return true;
        }
        return false;
      }

      if (phase === "next-ten-forward" && moveWithin(second, true, "next-ten-forward", "next-ten-backward")) return true;
      if (phase === "next-ten-backward" && moveWithin(second, false, "next-ten-forward", "next-ten-backward")) return true;
      if (phase === "next-ten-forward" || phase === "next-ten-backward") {
        const steadyReady = photos.length <= 15 || Boolean(cacheRef.current.get(15)?.ready || cacheRef.current.get(15)?.failed);
        if (steadyReady) {
          dispatch({ type: "WARMUP_EXIT" });
          dispatch({ type: "ADVANCE" });
          return true;
        }
        if (second.length > 1) {
          dispatch({ type: "WARMUP_FRAME", index: second[1], phase: "next-ten-forward" });
          return true;
        }
        return false;
      }
    }

    const nextIndex = state.currentIndex + 1;
    if (nextIndex >= photos.length) {
      dispatch({ type: "REACH_END" });
      return false;
    }

    const nextEntry = preloadPhoto(nextIndex);
    if (nextEntry && !nextEntry.ready && !nextEntry.failed) {
      dispatch({ type: "BUFFER_EMPTY", targetIndex: nextIndex });
      return false;
    }

    dispatch({ type: "ADVANCE" });
    return true;
  }, [photos.length, preloadPhoto]);

  const markVisibleImageReady = useCallback((image: HTMLImageElement, photo: Photo) => {
    if (!image || !image.complete || image.naturalWidth === 0) {
      return;
    }
    const source = image.src;
    const markDecoded = () => {
      window.requestAnimationFrame(() => {
        if (!image.isConnected || currentImageRef.current !== image || image.src !== source || desiredPhotoIdRef.current !== photo.id) return;
        setPaintedFrame((previous) => previous.resetKey === resetKey && previous.photo?.id === photo.id
          ? previous
          : { resetKey, photo });
        dispatch({ type: "READY" });
      });
    };
    if (typeof image.decode === "function") {
      void image.decode().then(markDecoded, markDecoded);
    } else {
      markDecoded();
    }
  }, [resetKey]);

  useEffect(() => {
    const isInitialMount = resetKeyRef.current === resetKey;
    if (!isInitialMount) {
      resetKeyRef.current = resetKey;
      setPaintedFrame({ resetKey, photo: photos[clampIndex(initialIndex, photos.length)] ?? null });
      rollingWarmupLaunchKeyRef.current = null;
      if (rollingWarmupFrameRef.current !== null) {
        window.cancelAnimationFrame(rollingWarmupFrameRef.current);
        rollingWarmupFrameRef.current = null;
      }
      frameInteractionRef.current?.destroy();
      framePointerIdRef.current = null;
      clearInitialDelayTimer();
      clearResumeTimer();
      clearImageCache();
      if (focusRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(focusRestoreFrameRef.current);
        focusRestoreFrameRef.current = null;
      }
      controlDispatch({ type: "RESET", openExpanded: openInFullscreen });
      rotationDispatch({ type: "RESET" });
      dispatch({
        type: "RESET",
        initialIndex,
        total: photos.length,
        scope: { type: scope.type, year: scope.year },
        reducedMotion
      });
    }

    if (launchMode === "homepage-autoplay") {
      for (let index = 0; index < Math.min(5, photos.length); index += 1) preloadPhoto(index);
    } else {
      warmBuffer(initialIndex);
    }
    revealControls();
    const frame = window.requestAnimationFrame(() => {
      surfaceRef.current?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    clearImageCache,
    clearInitialDelayTimer,
    clearResumeTimer,
    initialIndex,
    openInFullscreen,
    photos.length,
    resetKey,
    revealControls,
    scope.type,
    scope.year,
    warmBuffer,
    launchMode,
    preloadPhoto,
    reducedMotion
  ]);

  useEffect(() => {
    if (playerState.warmupPhase === "inactive") warmBuffer(currentIndex);
  }, [currentIndex, playerState.warmupPhase, warmBuffer]);

  useEffect(() => {
    if (launchMode !== "homepage-autoplay" || playerState.warmupPhase !== "next-ten-forward") return;
    if (rollingWarmupLaunchKeyRef.current === resetKey) return;
    rollingWarmupLaunchKeyRef.current = resetKey;
    rollingWarmupFrameRef.current = window.requestAnimationFrame(() => {
      rollingWarmupFrameRef.current = null;
      if (resetKeyRef.current !== resetKey || stateRef.current.warmupPhase !== "next-ten-forward") return;
      for (let index = 15; index < Math.min(photos.length, 45); index += 1) preloadPhoto(index);
    });
    return () => {
      if (rollingWarmupFrameRef.current !== null) {
        window.cancelAnimationFrame(rollingWarmupFrameRef.current);
        rollingWarmupFrameRef.current = null;
      }
    };
  }, [launchMode, photos.length, playerState.warmupPhase, preloadPhoto, resetKey]);

  useEffect(() => {
    if (launchMode !== "homepage-autoplay" || stateRef.current.warmupPhase !== "loading-first-five") return;
    const statuses = new Map<number, "ready" | "failed">();
    for (const [index, entry] of cacheRef.current) {
      if (entry.ready) statuses.set(index, "ready");
      else if (entry.failed) statuses.set(index, "failed");
    }
    const firstEnd = Math.min(5, photos.length);
    const usable = usableRange(statuses, 0, firstEnd);
    if (usable.length && stateRef.current.currentIndex !== usable[0]) {
      dispatch({ type: "WARMUP_FRAME", index: usable[0], phase: "loading-first-five" });
    }
    if (!settledRange(statuses, 0, firstEnd)) return;
    if (!usable.length) return;
    for (let index = 5; index < Math.min(15, photos.length); index += 1) preloadPhoto(index);
    if (usable.length === 1 && photos.length <= 5) {
      dispatch({ type: "WARMUP_FRAME", index: usable[0], phase: "steady-forward" });
      return;
    }
    dispatch({ type: "WARMUP_FRAME", index: usable[0], phase: "first-five-forward" });
  }, [cacheRevision, launchMode, photos.length, preloadPhoto]);

  useEffect(() => {
    if (currentPhoto && currentImageRef.current) markVisibleImageReady(currentImageRef.current, currentPhoto);
  }, [currentPhoto?.id, markVisibleImageReady]);

  useEffect(() => {
    clearInitialDelayTimer();
    if (status !== "initial-delay") {
      return;
    }

    initialPlayTimerRef.current = window.setTimeout(() => {
      initialPlayTimerRef.current = null;
      dispatch({ type: "INITIAL_DELAY_COMPLETE" });
    }, INITIAL_PLAY_DELAY_MS);

    return clearInitialDelayTimer;
  }, [clearInitialDelayTimer, playerState.initialDelayToken, status]);

  useEffect(() => {
    clearResumeTimer();
    if (status !== "temporarily-paused") {
      return;
    }

    if (playerState.resumeDelayMs === null) {
      return;
    }

    resumeTimerRef.current = window.setTimeout(() => {
      resumeTimerRef.current = null;
      dispatch({ type: "TEMPORARY_RESUME" });
    }, playerState.resumeDelayMs);

    return clearResumeTimer;
  }, [clearResumeTimer, playerState.resumeDelayMs, playerState.resumeToken, status]);

  useEffect(() => {
    if (status !== "buffering" || playerState.bufferTargetIndex === null) {
      return;
    }

    const target = preloadPhoto(playerState.bufferTargetIndex);
    if (!target || target.ready || target.failed) {
      dispatch({ type: "BUFFER_READY" });
    }
  }, [playerState.bufferTargetIndex, preloadPhoto, status]);

  usePlaybackClock({
    isRunning: status === "playing",
    delayMs: playerState.delayMs,
    onTick: attemptAdvance
  });

  useEffect(() => {
    if (!hasMusicLoaded) {
      return;
    }

    let isMounted = true;
    setIsMusicWidgetReady(false);

    loadSoundCloudApi()
      .then(() => {
        if (!isMounted || !window.SC?.Widget || !musicIframeRef.current) {
          return;
        }

        const widget = window.SC.Widget(musicIframeRef.current);
        const events = window.SC.Widget.Events;
        soundCloudWidgetRef.current = widget;

        widget.bind(events.READY, () => {
          if (isMounted) {
            setIsMusicWidgetReady(true);
          }
        });
        widget.bind(events.PLAY, () => {
          if (isMounted) {
            setIsMusicPlaying(true);
          }
        });
        widget.bind(events.PAUSE, () => {
          if (isMounted) {
            setIsMusicPlaying(false);
          }
        });
        widget.bind(events.FINISH, () => {
          if (isMounted) {
            setShouldPlayMusic(false);
            setIsMusicPlaying(false);
          }
        });
      })
      .catch(() => {
        if (isMounted) {
          setShouldPlayMusic(false);
          setIsMusicPlaying(false);
        }
      });

    return () => {
      isMounted = false;
      // Removing the iframe stops playback; its window is already gone during cleanup.
      soundCloudWidgetRef.current = null;
    };
  }, [hasMusicLoaded]);

  useEffect(() => {
    if (!isMusicWidgetReady) {
      return;
    }

    if (shouldPlayMusic) {
      soundCloudWidgetRef.current?.play();
    } else {
      soundCloudWidgetRef.current?.pause();
    }
  }, [isMusicWidgetReady, shouldPlayMusic]);

  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) {
      return;
    }

    const preventSurfaceSelection = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const preventNativeTouch = (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    };

    const touchByIdentifier = (touches: TouchList, identifier: number) => {
      for (let index = 0; index < touches.length; index += 1) {
        const touch = touches.item(index);
        if (touch?.identifier === identifier) return touch;
      }
      return null;
    };

    const handleTouchStart = (event: TouchEvent) => {
      preventNativeTouch(event);
      suppressSyntheticClick();
      revealControls();
      closeSpeedMenu();

      if (event.touches.length !== 1) {
        cancelTouchFrameInteraction();
        return;
      }

      const touch = event.touches.item(0);
      if (!touch || pointHitsMobileLandscapeRail(touch.clientX)) {
        cancelTouchFrameInteraction();
        return;
      }

      touchPointerIdRef.current = touch.identifier;
      const rect = surface.getBoundingClientRect();
      touchInteractionRef.current?.start({
        pointerId: touch.identifier,
        clientX: touch.clientX,
        clientY: touch.clientY,
        direction: directionFromClientX(touch.clientX, rect),
        activeTouchCount: event.touches.length,
        isPrimary: true
      });
    };

    const handleTouchMove = (event: TouchEvent) => {
      preventNativeTouch(event);
      const identifier = touchPointerIdRef.current;
      if (identifier === null) return;
      const touch = touchByIdentifier(event.touches, identifier);
      if (!touch) {
        cancelTouchFrameInteraction();
        return;
      }

      touchInteractionRef.current?.move({
        pointerId: identifier,
        clientX: touch.clientX,
        clientY: touch.clientY
      });
      if (!touchInteractionRef.current?.hasActiveGesture()) {
        touchPointerIdRef.current = null;
      }
    };

    const handleTouchEnd = (event: TouchEvent) => {
      preventNativeTouch(event);
      const identifier = touchPointerIdRef.current;
      if (identifier === null) return;
      suppressSyntheticClick();
      touchPointerIdRef.current = null;
      touchInteractionRef.current?.release({ pointerId: identifier });
    };

    const handleTouchCancel = (event: TouchEvent) => {
      preventNativeTouch(event);
      suppressSyntheticClick();
      cancelTouchFrameInteraction();
    };

    surface.addEventListener("selectstart", preventSurfaceSelection);
    surface.addEventListener("touchstart", handleTouchStart, { passive: false });
    surface.addEventListener("touchmove", handleTouchMove, { passive: false });
    surface.addEventListener("touchend", handleTouchEnd, { passive: false });
    surface.addEventListener("touchcancel", handleTouchCancel, { passive: false });
    return () => {
      surface.removeEventListener("selectstart", preventSurfaceSelection);
      surface.removeEventListener("touchstart", handleTouchStart);
      surface.removeEventListener("touchmove", handleTouchMove);
      surface.removeEventListener("touchend", handleTouchEnd);
      surface.removeEventListener("touchcancel", handleTouchCancel);
    };
  }, [cancelTouchFrameInteraction, closeSpeedMenu, pointHitsMobileLandscapeRail, revealControls, suppressSyntheticClick]);

  useEffect(() => {
    const syncFullscreenState = () => {
      const nextActive = Boolean(fullscreenElement());
      const wasActive = nativeFullscreenRef.current;
      nativeFullscreenRef.current = nextActive;
      setNativeFullscreenActive(nextActive);

      if (nextActive !== wasActive) {
        cancelActiveFrameInteractions();
      }

      if (nextActive) {
        controlDispatch({ type: "NATIVE_FULLSCREEN_ENTERED" });
      } else if (wasActive) {
        controlDispatch({ type: "NATIVE_FULLSCREEN_EXITED" });
      }
    };

    const unsubscribe = subscribeToFullscreenChanges(syncFullscreenState);
    syncFullscreenState();

    return () => {
      fullscreenRequestTokenRef.current += 1;
      unsubscribe();
      if (fullscreenElement()) {
        void exitDocumentFullscreen();
      }
    };
  }, [cancelActiveFrameInteractions]);

  useEffect(() => {
    window.addEventListener("blur", cancelActiveFrameInteractions);
    return () => window.removeEventListener("blur", cancelActiveFrameInteractions);
  }, [cancelActiveFrameInteractions]);

  useEffect(() => {
    let frame = 0;
    const updateViewport = () => {
      frame = 0;
      const mediaStage = mediaStageRef.current?.getBoundingClientRect();
      setPlayerViewport({
        width: Math.max(1, mediaStage?.width || window.innerWidth),
        height: Math.max(1, mediaStage?.height || window.innerHeight),
        landscapeRail: window.matchMedia("(pointer: coarse) and (orientation: landscape) and (max-height: 460px)").matches
      });
    };
    const scheduleViewportUpdate = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(updateViewport);
      }
    };

    window.addEventListener("resize", scheduleViewportUpdate);
    window.addEventListener("orientationchange", scheduleViewportUpdate);
    window.visualViewport?.addEventListener("resize", scheduleViewportUpdate);
    scheduleViewportUpdate();
    return () => {
      window.removeEventListener("resize", scheduleViewportUpdate);
      window.removeEventListener("orientationchange", scheduleViewportUpdate);
      window.visualViewport?.removeEventListener("resize", scheduleViewportUpdate);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      revealControls();

      const activeOnboardingStep = playerOnboardingStep(onboardingStateRef.current.phase);
      if (activeOnboardingStep !== null) {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(".player-onboarding__center-prompt--interactive")) return;
        if (activeOnboardingStep === 1 && event.key === "ArrowLeft") {
          event.preventDefault();
          navigateManually(-1);
        } else if (activeOnboardingStep === 1 && event.key === "ArrowRight") {
          event.preventDefault();
          navigateManually(1);
        } else if (event.key === " ") {
          event.preventDefault();
        }
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        if (rotationModeOpenRef.current) {
          closeRotationMode(true);
          return;
        }
        if (nativeFullscreenRef.current) {
          void exitDocumentFullscreen();
          return;
        }
        close();
        return;
      }

      if (event.key === " ") {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(".player-topbar button, .player-controls button:not(.icon-button--primary), .player-rotation-controls button")) {
          return;
        }

        event.preventDefault();
        if (canPause(stateRef.current.status)) {
          pauseExplicitly();
        } else {
          playExplicitly();
        }
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigateManually(-1);
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        navigateManually(1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close, closeRotationMode, navigateManually, pauseExplicitly, playExplicitly, revealControls]);

  useEffect(() => {
    revealControls();
    return () => {
      frameInteractionRef.current?.destroy();
      framePointerIdRef.current = null;
      touchInteractionRef.current?.destroy();
      touchPointerIdRef.current = null;
      clearInitialDelayTimer();
      clearResumeTimer();
      clearImageCache();
      if (focusRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(focusRestoreFrameRef.current);
        focusRestoreFrameRef.current = null;
      }
      if (rotationFocusFrameRef.current !== null) {
        window.cancelAnimationFrame(rotationFocusFrameRef.current);
        rotationFocusFrameRef.current = null;
      }
      if (rollingWarmupFrameRef.current !== null) {
        window.cancelAnimationFrame(rollingWarmupFrameRef.current);
        rollingWarmupFrameRef.current = null;
      }
      if (controlsTimerRef.current !== null) {
        window.clearTimeout(controlsTimerRef.current);
      }
      if (shareTimerRef.current !== null) {
        window.clearTimeout(shareTimerRef.current);
        shareTimerRef.current = null;
      }
    };
  }, [clearImageCache, clearInitialDelayTimer, clearResumeTimer, revealControls]);

  const imageGeometry = useMemo(() => currentPhoto ? photoImageGeometry(currentPhoto, imageMode, playerViewport, currentRotation) : null,
    [currentPhoto, currentRotation, imageMode, playerViewport]);
  const paintedImageGeometry = useMemo(() => paintedPhoto && paintedPhoto.id !== currentPhoto?.id
    ? photoImageGeometry(paintedPhoto, imageMode, playerViewport, paintedRotation)
    : imageGeometry, [currentPhoto?.id, imageGeometry, imageMode, paintedPhoto, paintedRotation, playerViewport]);

  if (!currentPhoto) {
    if (launchMode !== "homepage-autoplay") return null;
    return (
      <div
        className="player-overlay has-visible-controls"
        data-player-layout={playerViewport.landscapeRail ? "mobile-landscape-rail" : "standard"}
        data-player-warmup-phase="loading-first-five"
        data-player-shell-state="loading"
        role="dialog"
        aria-modal="true"
        aria-label="Photo player"
      >
        <div className="player-media-stage" ref={mediaStageRef}>
          <button
            ref={surfaceRef}
            className="player-surface player-surface--fit"
            type="button"
            aria-label="Loading photographs"
            onClick={revealControls}
          >
            <span className="player-buffer" role="status">Loading photographs</span>
          </button>
        </div>
        <div className="player-control-frame">
          <div className="player-topbar">
            <button className="icon-button" type="button" onClick={close} aria-label="Close" title="Close">
              <X size={22} strokeWidth={2.2} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  const playerImageStyle = imageGeometryStyle(imageMode, imageGeometry);
  const paintedImageStyle = imageGeometryStyle(imageMode, paintedImageGeometry);
  const primaryActionLabel = canPause(status) ? "Pause" : "Play";
  const surfaceActionLabel = temporaryResumePending ? "Play" : primaryActionLabel;
  const musicIsActive = shouldPlayMusic || isMusicPlaying;
  const musicActionLabel = musicIsActive ? "Stop music" : "Play music";
  const shareActionLabel =
    shareStatus === "copied" ? "Link copied" : shareStatus === "failed" ? "Share failed" : "Share player link";
  const onboardingTargetRef = onboardingStep === 2
    ? speedControlRef
    : onboardingStep === 3
      ? musicControlRef
      : surfaceRef;
  const visibleImageRef = isImagePending ? paintedImageRef : currentImageRef;

  return (
    <div
      className={`player-overlay ${controlsVisible ? "has-visible-controls" : ""}`}
      data-player-layout={playerViewport.landscapeRail ? "mobile-landscape-rail" : "standard"}
      data-player-orientation={playerViewport.height > playerViewport.width ? "portrait" : "landscape"}
      role="dialog"
      aria-modal="true"
      aria-label="Photo player"
      data-player-warmup-phase={playerState.warmupPhase}
      data-player-cache-entries={cacheRef.current.size}
      data-player-pending-images={[...cacheRef.current.values()].filter((entry) => !entry.ready && !entry.failed).length}
      data-player-decoded-images={[...cacheRef.current.values()].filter((entry) => entry.ready).length}
      data-player-onboarding-phase={onboardingState.phase}
      data-player-rotation-mode={rotationModeOpen ? "active" : "inactive"}
      data-player-current-rotation={currentRotation}
      onMouseMove={revealControls}
      onTouchStart={revealControls}
    >
      <div className="player-media-stage" ref={mediaStageRef}>
        <button
          ref={surfaceRef}
          className={`player-surface player-surface--${imageMode}`}
          type="button"
          disabled={desktopOnboardingActive || (onboardingStep !== null && onboardingStep !== 1)}
          aria-hidden={desktopOnboardingActive ? true : undefined}
          onPointerDown={(event) => {
            if (event.pointerType === "mouse" && hasFinePointer()) {
              if (event.button !== 0 || !event.isPrimary) {
                return;
              }

              event.preventDefault();
              event.stopPropagation();
              closeSpeedMenu();
              revealControls();
              framePointerIdRef.current = event.pointerId;
              event.currentTarget.setPointerCapture(event.pointerId);
              const rect = event.currentTarget.getBoundingClientRect();
              const direction = directionFromClientX(event.clientX, rect);
              frameInteractionRef.current?.startPointer(direction);
            }
          }}
          onPointerUp={(event) => {
            if (event.pointerType === "mouse" && framePointerIdRef.current === event.pointerId) {
              event.preventDefault();
              event.stopPropagation();
              suppressSyntheticClick();
              framePointerIdRef.current = null;
              frameInteractionRef.current?.releasePointer();
              releasePointerCapture(event.currentTarget, event.pointerId);
            }
          }}
          onPointerCancel={(event) => {
            if (event.pointerType === "mouse" && framePointerIdRef.current === event.pointerId) {
              framePointerIdRef.current = null;
              suppressSyntheticClick();
              frameInteractionRef.current?.cancelPointer();
            }
          }}
          onLostPointerCapture={(event) => {
            if (event.pointerType === "mouse" && framePointerIdRef.current === event.pointerId) {
              framePointerIdRef.current = null;
              suppressSyntheticClick();
              frameInteractionRef.current?.cancelPointer();
            }
          }}
          onWheel={(event) => {
            if (!hasFinePointer()) {
              return;
            }

            if (pointHitsPlayerControl(event.clientX, event.clientY)) {
              return;
            }

            const handled = frameInteractionRef.current?.handleWheel({
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              deltaMode: event.deltaMode,
              ctrlKey: event.ctrlKey,
              viewportHeight: playerViewport.height
            });
            if (handled) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onClick={(event) => {
            if (shouldSuppressSyntheticClick(ignoreSyntheticClickUntilRef.current)) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }

            toggleFromPhotoSurface();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onDragStart={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onSelect={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          aria-label={surfaceActionLabel}
          aria-describedby={onboardingStep === 1 ? onboardingDescriptionId : undefined}
        >
          {isImagePending && paintedPhoto ? (
            <img
              ref={paintedImageRef}
              key={paintedPhoto.id}
              src={mediaUrl(paintedPhoto.displayKey)}
              data-player-photo-id={paintedPhoto.id}
              data-player-image-rotation={paintedRotation}
              alt=""
              className={`player-image player-image--${paintedPhoto.orientation} player-image--${imageMode}`}
              style={paintedImageStyle}
              draggable={false}
            />
          ) : null}
          <img
            ref={currentImageRef}
            key={currentPhoto.id}
            src={mediaUrl(currentPhoto.displayKey)}
            data-player-photo-id={currentPhoto.id}
            data-player-image-rotation={currentRotation}
            alt=""
            className={`player-image player-image--${currentPhoto.orientation} player-image--${imageMode}${isImagePending ? " player-image--incoming" : ""}`}
            style={playerImageStyle}
            decoding="async"
            draggable={false}
            onLoad={(event) => markVisibleImageReady(event.currentTarget, currentPhoto)}
            onError={() => {
              if (stateRef.current.launchMode === "homepage-autoplay" && stateRef.current.warmupPhase !== "inactive") {
                return;
              }
              if (!atEnd) {
                dispatch({ type: "ADVANCE" });
              } else {
                dispatch({ type: "REACH_END" });
              }
            }}
          />
        </button>
      </div>

      <div className={`player-control-frame ${controlState.speedMenuOpen ? "is-speed-menu-open" : ""}`}>
        {!desktopOnboardingActive ? <PlayerControls
          atStart={atStart}
          atEnd={atEnd}
          primaryActionLabel={primaryActionLabel}
          delayMs={playerState.delayMs}
          speedMenuOpen={controlState.speedMenuOpen}
          musicActionLabel={musicActionLabel}
          musicIsActive={musicIsActive}
          shareActionLabel={shareActionLabel}
          shareIsActive={shareStatus === "copied"}
          screenModeActive={isScreenModeActive}
          rotationModeOpen={rotationModeOpen}
          rotationControlsId={rotationControlsId}
          tutorialStep={onboardingStep}
          speedControlRef={speedControlRef}
          musicControlRef={musicControlRef}
          rotationControlRef={rotationControlRef}
          speedDescriptionId={onboardingStep === 2 ? onboardingDescriptionId : undefined}
          musicDescriptionId={onboardingStep === 3 ? onboardingDescriptionId : undefined}
          onPrevious={() => navigateManually(-1)}
          onFrameNavigationStart={(direction) => frameInteractionRef.current?.startPointer(direction)}
          onFrameNavigationEnd={(direction) => {
            if (frameInteractionRef.current?.isPointerHolding()) {
              frameInteractionRef.current.releasePointer();
              return;
            }
            if (frameInteractionRef.current?.cancelPointer(false)) navigateManually(direction);
          }}
          onFrameNavigationCancel={() => frameInteractionRef.current?.cancelPointer()}
          onTogglePlayback={toggleFromPrimaryControl}
          onNext={() => navigateManually(1)}
          onToggleSpeedMenu={toggleSpeedMenu}
          onCloseSpeedMenu={closeSpeedMenu}
          onSelectSpeed={selectSpeed}
          onToggleMusic={toggleMusic}
          onShare={() => void shareCurrentPhoto()}
          onToggleRotationMode={toggleRotationMode}
          onToggleScreenMode={toggleScreenMode}
          onReveal={revealControls}
        /> : null}

        <div className="player-topbar">
          <div className="player-topbar__actions">
            <button className="icon-button" type="button" onClick={close} disabled={onboardingActive} aria-label="Close" title="Close">
              <X aria-hidden="true" size={22} strokeWidth={2.2} />
            </button>
          </div>
          <div className="player-counter sr-only" aria-live="polite">
            {currentIndex + 1} / {photos.length}
            {initialPlayPending ? <span className="player-counter__status">starts</span> : null}
            {!initialPlayPending && temporaryResumePending ? <span className="player-counter__status">resumes</span> : null}
          </div>
          {isBuffering ? <div className="player-buffer">Buffering</div> : null}
        </div>

        <button
          ref={helpControlRef}
          className="icon-button player-help"
          type="button"
          onClick={openOnboardingHelp}
          disabled={onboardingActive}
          aria-label="Player help"
          title="Player help"
        >
          <CircleHelp aria-hidden="true" size={20} strokeWidth={2.2} />
        </button>

        <div
          className="player-progress"
          aria-hidden="true"
          style={{ "--player-progress": photos.length <= 1 ? 1 : currentIndex / (photos.length - 1) } as CSSProperties}
        >
          <span />
        </div>
      </div>

      {rotationModeOpen && !onboardingActive ? (
        <PlayerRotationControls
          id={rotationControlsId}
          imageRef={visibleImageRef}
          photoId={currentPhoto.id}
          rotation={currentRotation}
          disabled={isImagePending}
          onRotate={rotateCurrentPhoto}
          onReveal={revealControls}
        />
      ) : null}

      {onboardingStep !== null ? (
        <PlayerOnboardingTour
          step={onboardingStep}
          desktopInstructions={desktopInstructions}
          reducedMotion={reducedMotion}
          imageRef={currentImageRef}
          targetRef={onboardingTargetRef}
          descriptionId={onboardingDescriptionId}
          onDemonstrate={navigateManually}
          onNext={advanceOnboarding}
          onExit={exitOnboarding}
        />
      ) : null}

      <span className="sr-only" aria-live="polite">
        {shareStatus === "copied" ? "Share link copied" : shareStatus === "failed" ? "Share link failed" : ""}
      </span>

      {hasMusicLoaded ? (
        <iframe
          ref={musicIframeRef}
          className="player-music-frame"
          src={SOUNDCLOUD_EMBED_URL}
          title="640 SoundCloud playlist"
          allow="autoplay; encrypted-media"
          aria-hidden="true"
          tabIndex={-1}
        />
      ) : null}
    </div>
  );
}
