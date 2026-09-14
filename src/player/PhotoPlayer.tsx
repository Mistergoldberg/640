import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { mediaUrl } from "../lib/assets";
import type { Photo } from "../types";
import { exitDocumentFullscreen, fullscreenElement, requestDocumentFullscreen, subscribeToFullscreenChanges } from "./fullscreen";
import { calculateImageGeometry, playerFitClearance } from "./imageGeometry";
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

function visibleRect(element: Element) {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  return rect;
}

export function PhotoPlayer({ photos, initialIndex, openInFullscreen = false, scope, onClose }: PhotoPlayerProps) {
  const [playerState, dispatch] = useReducer(playerReducer, { initialIndex, total: photos.length, scope }, createPlayerState);
  const [controlState, controlDispatch] = useReducer(playerControlReducer, { openExpanded: openInFullscreen }, createPlayerControlState);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hasMusicLoaded, setHasMusicLoaded] = useState(false);
  const [shouldPlayMusic, setShouldPlayMusic] = useState(false);
  const [isMusicWidgetReady, setIsMusicWidgetReady] = useState(false);
  const [isMusicPlaying, setIsMusicPlaying] = useState(false);
  const [shareStatus, setShareStatus] = useState<ShareStatus>("idle");
  const [nativeFullscreenActive, setNativeFullscreenActive] = useState(() => Boolean(fullscreenElement()));
  const [playerViewport, setPlayerViewport] = useState(() => ({
    width: typeof window === "undefined" ? 640 : window.innerWidth,
    height: typeof window === "undefined" ? 480 : window.innerHeight,
    landscapeRail: false
  }));
  const cacheRef = useRef(new Map<number, CacheEntry>());
  const musicIframeRef = useRef<HTMLIFrameElement | null>(null);
  const soundCloudWidgetRef = useRef<SoundCloudWidget | null>(null);
  const stateRef = useRef<PlayerState>(playerState);
  const currentIndexRef = useRef(playerState.currentIndex);
  const currentImageRef = useRef<HTMLImageElement | null>(null);
  const nativeFullscreenRef = useRef(nativeFullscreenActive);
  const fullscreenRequestTokenRef = useRef(0);
  const controlsTimerRef = useRef<number | null>(null);
  const initialPlayTimerRef = useRef<number | null>(null);
  const resumeTimerRef = useRef<number | null>(null);
  const shareTimerRef = useRef<number | null>(null);
  const ignoreSyntheticClickUntilRef = useRef(0);
  const activeTouchPointersRef = useRef(new Set<number>());
  const touchPointerIdRef = useRef<number | null>(null);
  const framePointerIdRef = useRef<number | null>(null);
  const frameInteractionRef = useRef<PlayerFrameNavigationController | null>(null);
  const touchInteractionRef = useRef<PlayerTouchNavigationController | null>(null);
  const surfaceRef = useRef<HTMLButtonElement | null>(null);
  const mediaStageRef = useRef<HTMLDivElement | null>(null);
  const resetKey = `${scope.type}:${scope.year}:${initialIndex}:${photos.length}`;
  const resetKeyRef = useRef(resetKey);

  const currentIndex = playerState.currentIndex;
  const currentPhoto = photos[currentIndex];
  const atStart = currentIndex <= 0;
  const atEnd = currentIndex >= photos.length - 1;
  const status = playerState.status;
  const isBuffering = status === "buffering";
  const initialPlayPending = status === "loading" || status === "initial-delay";
  const temporaryResumePending = status === "temporarily-paused";
  const imageMode = controlState.imageMode;
  const isScreenModeActive = screenModeActive(controlState, nativeFullscreenActive);

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
    activeTouchPointersRef.current.clear();
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
        markBufferedImageReady(index);
      };

      const markFailed = () => {
        if (cacheRef.current.get(index) !== entry) {
          return;
        }
        entry.failed = true;
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
    if (stateRef.current.status === "loading") {
      return;
    }

    clearInitialDelayTimer();
    clearResumeTimer();
    warmBuffer(currentIndexRef.current);
    dispatch({ type: "PLAY" });
  }, [clearInitialDelayTimer, clearResumeTimer, revealControls, warmBuffer]);

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
    activeTouchPointersRef.current.clear();
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
      overlay?.querySelectorAll<HTMLElement>('.player-controls > [data-player-control="music"], .player-controls > [data-player-control="speed"]') || []
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
      overlay?.querySelectorAll<HTMLElement>(".player-topbar button, .player-controls > [data-player-control], .speed-menu button") || []
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

  const markVisibleImageReady = useCallback(() => {
    const image = currentImageRef.current;
    if (!image || !image.complete || image.naturalWidth === 0) {
      return;
    }
    const source = image.src;
    const markDecoded = () => {
      if (image.isConnected && currentImageRef.current === image && image.src === source) {
        dispatch({ type: "READY" });
      }
    };
    if (typeof image.decode === "function") {
      void image.decode().then(markDecoded, () => {});
    } else {
      markDecoded();
    }
  }, []);

  useEffect(() => {
    const isInitialMount = resetKeyRef.current === resetKey;
    if (!isInitialMount) {
      resetKeyRef.current = resetKey;
      frameInteractionRef.current?.destroy();
      framePointerIdRef.current = null;
      clearInitialDelayTimer();
      clearResumeTimer();
      clearImageCache();
      controlDispatch({ type: "RESET", openExpanded: openInFullscreen });
      dispatch({
        type: "RESET",
        initialIndex,
        total: photos.length,
        scope: { type: scope.type, year: scope.year }
      });
    }

    warmBuffer(initialIndex);
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
    warmBuffer
  ]);

  useEffect(() => {
    warmBuffer(currentIndex);
  }, [currentIndex, warmBuffer]);

  useEffect(() => {
    markVisibleImageReady();
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

    surface.addEventListener("selectstart", preventSurfaceSelection);
    return () => surface.removeEventListener("selectstart", preventSurfaceSelection);
  }, []);

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

      if (event.key === "Escape") {
        event.preventDefault();
        if (nativeFullscreenRef.current) {
          void exitDocumentFullscreen();
          return;
        }
        close();
        return;
      }

      if (event.key === " ") {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(".player-topbar button, .player-controls button:not(.icon-button--primary)")) {
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
  }, [close, navigateManually, pauseExplicitly, playExplicitly, revealControls]);

  useEffect(() => {
    revealControls();
    return () => {
      frameInteractionRef.current?.destroy();
      framePointerIdRef.current = null;
      touchInteractionRef.current?.destroy();
      touchPointerIdRef.current = null;
      activeTouchPointersRef.current.clear();
      clearInitialDelayTimer();
      clearResumeTimer();
      clearImageCache();
      if (controlsTimerRef.current !== null) {
        window.clearTimeout(controlsTimerRef.current);
      }
      if (shareTimerRef.current !== null) {
        window.clearTimeout(shareTimerRef.current);
        shareTimerRef.current = null;
      }
    };
  }, [clearImageCache, clearInitialDelayTimer, clearResumeTimer, revealControls]);

  const imageGeometry = useMemo(() => {
    if (!currentPhoto) {
      return null;
    }

    const clearance = imageMode === "fit" && !playerViewport.landscapeRail
      ? playerFitClearance(playerViewport.width, playerViewport.height)
      : { vertical: 0, horizontal: 0 };
    return calculateImageGeometry({
      sourceWidth: currentPhoto.width,
      sourceHeight: currentPhoto.height,
      viewportWidth: Math.max(1, playerViewport.width - clearance.horizontal),
      viewportHeight: playerViewport.height,
      controlClearance: clearance.vertical,
      mode: imageMode,
      rotation: 0
    });
  }, [currentPhoto, imageMode, playerViewport.height, playerViewport.landscapeRail, playerViewport.width]);

  if (!currentPhoto) {
    return null;
  }

  const playerImageStyle =
    imageMode === "expanded" && imageGeometry
      ? {
          width: `${Math.round(imageGeometry.layoutWidth)}px`,
          height: `${Math.round(imageGeometry.layoutHeight)}px`,
          transform: `translate(-50%, -50%) rotate(${imageGeometry.rotation}deg)`
        }
      : undefined;
  const primaryActionLabel = canPause(status) ? "Pause" : "Play";
  const surfaceActionLabel = temporaryResumePending ? "Play" : primaryActionLabel;
  const musicIsActive = shouldPlayMusic || isMusicPlaying;
  const musicActionLabel = musicIsActive ? "Stop music" : "Play music";
  const shareActionLabel =
    shareStatus === "copied" ? "Link copied" : shareStatus === "failed" ? "Share failed" : "Share player link";

  return (
    <div
      className={`player-overlay ${controlsVisible ? "has-visible-controls" : ""}`}
      data-player-layout={playerViewport.landscapeRail ? "mobile-landscape-rail" : "standard"}
      role="dialog"
      aria-modal="true"
      aria-label="Photo player"
      onMouseMove={revealControls}
      onTouchStart={revealControls}
    >
      <div className="player-media-stage" ref={mediaStageRef}>
        <button
          ref={surfaceRef}
          className={`player-surface player-surface--${imageMode}`}
          type="button"
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
              return;
            }

            if (event.pointerType === "touch") {
              suppressSyntheticClick();
              activeTouchPointersRef.current.add(event.pointerId);

              if (!event.isPrimary || activeTouchPointersRef.current.size > 1) {
                event.preventDefault();
                event.stopPropagation();
                touchInteractionRef.current?.cancel();
                touchPointerIdRef.current = null;
                return;
              }

              event.preventDefault();
              event.stopPropagation();
              closeSpeedMenu();
              revealControls();

              if (pointHitsMobileLandscapeRail(event.clientX)) {
                return;
              }

              touchPointerIdRef.current = event.pointerId;
              event.currentTarget.setPointerCapture(event.pointerId);
              const rect = event.currentTarget.getBoundingClientRect();
              touchInteractionRef.current?.start({
                pointerId: event.pointerId,
                clientX: event.clientX,
                clientY: event.clientY,
                direction: directionFromClientX(event.clientX, rect),
                activeTouchCount: activeTouchPointersRef.current.size,
                isPrimary: event.isPrimary
              });
            }
          }}
          onPointerMove={(event) => {
            if (event.pointerType !== "touch" || touchPointerIdRef.current !== event.pointerId) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();
            touchInteractionRef.current?.move({
              pointerId: event.pointerId,
              clientX: event.clientX,
              clientY: event.clientY
            });

            if (!touchInteractionRef.current?.hasActiveGesture()) {
              touchPointerIdRef.current = null;
              releasePointerCapture(event.currentTarget, event.pointerId);
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
              return;
            }

            if (event.pointerType !== "touch") {
              return;
            }

            activeTouchPointersRef.current.delete(event.pointerId);
            suppressSyntheticClick();

            if (touchPointerIdRef.current !== event.pointerId) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();
            touchPointerIdRef.current = null;
            touchInteractionRef.current?.release({ pointerId: event.pointerId });
            releasePointerCapture(event.currentTarget, event.pointerId);
          }}
          onPointerCancel={(event) => {
            if (event.pointerType === "mouse" && framePointerIdRef.current === event.pointerId) {
              framePointerIdRef.current = null;
              suppressSyntheticClick();
              frameInteractionRef.current?.cancelPointer();
              return;
            }

            if (event.pointerType === "touch") {
              activeTouchPointersRef.current.delete(event.pointerId);
              suppressSyntheticClick();
              if (touchPointerIdRef.current === event.pointerId) {
                touchPointerIdRef.current = null;
                touchInteractionRef.current?.cancel();
                releasePointerCapture(event.currentTarget, event.pointerId);
              }
            }
          }}
          onLostPointerCapture={(event) => {
            if (event.pointerType === "mouse" && framePointerIdRef.current === event.pointerId) {
              framePointerIdRef.current = null;
              suppressSyntheticClick();
              frameInteractionRef.current?.cancelPointer();
            }

            if (event.pointerType === "touch" && touchPointerIdRef.current === event.pointerId) {
              activeTouchPointersRef.current.delete(event.pointerId);
              touchPointerIdRef.current = null;
              suppressSyntheticClick();
              touchInteractionRef.current?.cancel();
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
        >
          <img
            ref={currentImageRef}
            key={currentPhoto.id}
            src={mediaUrl(currentPhoto.displayKey)}
            alt=""
            className={`player-image player-image--${currentPhoto.orientation} player-image--${imageMode}`}
            style={playerImageStyle}
            decoding="async"
            draggable={false}
            onLoad={markVisibleImageReady}
            onError={() => {
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
        <PlayerControls
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
          onPrevious={() => navigateManually(-1)}
          onTogglePlayback={toggleFromPrimaryControl}
          onNext={() => navigateManually(1)}
          onToggleSpeedMenu={toggleSpeedMenu}
          onCloseSpeedMenu={closeSpeedMenu}
          onSelectSpeed={selectSpeed}
          onToggleMusic={toggleMusic}
          onShare={() => void shareCurrentPhoto()}
          onToggleScreenMode={toggleScreenMode}
          onReveal={revealControls}
        />

        <div className="player-topbar">
          <button className="icon-button" type="button" onClick={close} aria-label="Close" title="Close">
            <X size={22} strokeWidth={2.2} />
          </button>
          <div className="player-counter" aria-live="polite">
            {currentIndex + 1} / {photos.length}
            {initialPlayPending ? <span className="player-counter__status">starts</span> : null}
            {!initialPlayPending && temporaryResumePending ? <span className="player-counter__status">resumes</span> : null}
          </div>
          {isBuffering ? <div className="player-buffer">Buffering</div> : null}
        </div>

        <div
          className="player-progress"
          aria-hidden="true"
          style={{ "--player-progress": photos.length <= 1 ? 1 : currentIndex / (photos.length - 1) } as CSSProperties}
        >
          <span />
        </div>
      </div>

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
