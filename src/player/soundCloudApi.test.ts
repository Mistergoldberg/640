import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOUNDCLOUD_WIDGET_API_URL,
  createSoundCloudApiLoader,
  type SoundCloudWidgetFactory
} from "./soundCloudApi";

class FakeScript extends EventTarget {
  src = "";
  async = false;
  dataset: Record<string, string> = {};
  readyState: string | undefined;
  removed = false;
  listenerCount = 0;

  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    this.listenerCount += 1;
    super.addEventListener(...args);
  }

  override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
    this.listenerCount = Math.max(0, this.listenerCount - 1);
    super.removeEventListener(...args);
  }

  remove() { this.removed = true; }
}

class FakeDocument {
  readyState = "complete";
  scripts: FakeScript[] = [];
  head = { appendChild: (script: FakeScript) => { this.scripts.push(script); return script; } };
  querySelector() { return this.scripts.find((script) => !script.removed && script.src === SOUNDCLOUD_WIDGET_API_URL) || null; }
  createElement() { return new FakeScript(); }
}

const widgetFactory = Object.assign(() => ({ bind() {}, unbind() {}, pause() {}, play() {} }), {
  Events: { FINISH: "finish", PAUSE: "pause", PLAY: "play", READY: "ready" }
}) as SoundCloudWidgetFactory;

function fixture(timeoutMs = 100) {
  const document = new FakeDocument();
  let widget: SoundCloudWidgetFactory | undefined;
  const loader = createSoundCloudApiLoader({
    document: document as unknown as Document,
    getWidget: () => widget,
    timeoutMs
  });
  return { document, loader, setWidget: (next: SoundCloudWidgetFactory | undefined) => { widget = next; } };
}

afterEach(() => vi.useRealTimers());

describe("SoundCloud API loader", () => {
  it("deduplicates concurrent callers and cleans listeners after success", async () => {
    const { document, loader, setWidget } = fixture();
    const first = loader.load();
    const second = loader.load();
    expect(first).toBe(second);
    expect(document.scripts).toHaveLength(1);
    setWidget(widgetFactory);
    document.scripts[0].dispatchEvent(new Event("load"));
    await expect(first).resolves.toBeUndefined();
    expect(document.scripts[0].listenerCount).toBe(0);
  });

  it("rejects errors, clears rejected state, and succeeds on a deliberate retry", async () => {
    const { document, loader, setWidget } = fixture();
    const failed = loader.load();
    document.scripts[0].dispatchEvent(new Event("error"));
    await expect(failed).rejects.toThrow("failed to load");
    expect(document.scripts[0].removed).toBe(true);

    const retry = loader.load();
    expect(document.scripts).toHaveLength(2);
    setWidget(widgetFactory);
    document.scripts[1].dispatchEvent(new Event("load"));
    await expect(retry).resolves.toBeUndefined();
  });

  it("bounds loading time, removes owned stale scripts, and ignores late events", async () => {
    vi.useFakeTimers();
    const { document, loader, setWidget } = fixture(50);
    const attempt = loader.load();
    await vi.advanceTimersByTimeAsync(51);
    await expect(attempt).rejects.toThrow("timed out");
    const script = document.scripts[0];
    expect(script.removed).toBe(true);
    expect(script.listenerCount).toBe(0);
    setWidget(widgetFactory);
    script.dispatchEvent(new Event("load"));
    expect(script.dataset.pixilationSoundcloudState).toBe("error");
  });

  it("handles existing scripts whose load or error event already occurred", async () => {
    const loadedFixture = fixture();
    const loaded = new FakeScript();
    loaded.src = SOUNDCLOUD_WIDGET_API_URL;
    loaded.readyState = "complete";
    loadedFixture.document.scripts.push(loaded);
    await expect(loadedFixture.loader.load()).rejects.toThrow("unavailable");
    expect(loaded.removed).toBe(true);

    const errorFixture = fixture();
    const failed = new FakeScript();
    failed.src = SOUNDCLOUD_WIDGET_API_URL;
    failed.dataset.pixilationSoundcloudState = "error";
    errorFixture.document.scripts.push(failed);
    await expect(errorFixture.loader.load()).rejects.toThrow("failed to load");
  });

  it("resolves immediately when an existing API is ready without adding work", async () => {
    const { document, loader, setWidget } = fixture();
    const existing = new FakeScript();
    existing.src = SOUNDCLOUD_WIDGET_API_URL;
    document.scripts.push(existing);
    setWidget(widgetFactory);
    await expect(loader.load()).resolves.toBeUndefined();
    expect(existing.listenerCount).toBe(0);
  });
});
