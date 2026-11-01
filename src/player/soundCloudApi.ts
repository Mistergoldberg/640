export const SOUNDCLOUD_WIDGET_API_URL = "https://w.soundcloud.com/player/api.js";
export const SOUNDCLOUD_API_TIMEOUT_MS = 8_000;

export interface SoundCloudWidget {
  bind(eventName: string, listener: () => void): void;
  unbind?(eventName: string, listener?: () => void): void;
  pause(): void;
  play(): void;
}

export interface SoundCloudWidgetFactory {
  (iframe: HTMLIFrameElement): SoundCloudWidget;
  Events: { FINISH: string; PAUSE: string; PLAY: string; READY: string };
}

export interface SoundCloudApiEnvironment {
  document?: Document;
  getWidget?: () => SoundCloudWidgetFactory | undefined;
  timeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  queueMicrotaskFn?: typeof queueMicrotask;
}

type StatefulScript = HTMLScriptElement & { readyState?: string };

export function createSoundCloudApiLoader(environment: SoundCloudApiEnvironment = {}) {
  let pending: Promise<void> | null = null;

  const load = () => {
    if (typeof window === "undefined" && !environment.document) return Promise.resolve();
    const documentTarget = environment.document || document;
    const getWidget = environment.getWidget || (() => window.SC?.Widget);
    const setTimer = environment.setTimeoutFn || setTimeout;
    const clearTimer = environment.clearTimeoutFn || clearTimeout;
    const queueTask = environment.queueMicrotaskFn || queueMicrotask;
    if (getWidget()) return Promise.resolve();
    if (pending) return pending;

    const attempt = new Promise<void>((resolve, reject) => {
      const existing = documentTarget.querySelector<StatefulScript>(`script[src="${SOUNDCLOUD_WIDGET_API_URL}"]`);
      const script = (existing || documentTarget.createElement("script")) as StatefulScript;
      const owned = !existing;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        script.removeEventListener("load", loaded);
        script.removeEventListener("error", failed);
        if (timer !== null) clearTimer(timer);
        timer = null;
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          script.dataset.pixilationSoundcloudState = "error";
          if (owned || script.dataset.pixilationSoundcloudOwned === "1" || script.readyState === "complete" || script.readyState === "loaded") script.remove();
          reject(error);
        } else {
          script.dataset.pixilationSoundcloudState = "loaded";
          resolve();
        }
      };
      const loaded = () => {
        if (getWidget()) finish();
        else finish(new Error("SoundCloud API was unavailable after the script loaded"));
      };
      const failed = () => finish(new Error("SoundCloud API failed to load"));

      script.addEventListener("load", loaded, { once: true });
      script.addEventListener("error", failed, { once: true });
      timer = setTimer(() => finish(new Error("SoundCloud API load timed out")), environment.timeoutMs ?? SOUNDCLOUD_API_TIMEOUT_MS);

      if (existing) {
        const state = script.dataset.pixilationSoundcloudState;
        if (state === "loaded" || script.readyState === "complete" || script.readyState === "loaded") queueTask(loaded);
        else if (state === "error") queueTask(failed);
      } else {
        script.src = SOUNDCLOUD_WIDGET_API_URL;
        script.async = true;
        script.dataset.pixilationSoundcloudOwned = "1";
        script.dataset.pixilationSoundcloudState = "loading";
        documentTarget.head.appendChild(script);
      }
    });

    pending = attempt;
    void attempt.then(
      () => { if (pending === attempt) pending = null; },
      () => { if (pending === attempt) pending = null; }
    );
    return attempt;
  };

  return { load };
}

export const soundCloudApiLoader = createSoundCloudApiLoader();
