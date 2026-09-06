import { describe, expect, it, vi } from "vitest";
import {
  exitDocumentFullscreen,
  fullscreenSupported,
  requestDocumentFullscreen,
  subscribeToFullscreenChanges
} from "./fullscreen";

function fullscreenFixture(requestResult: "enter" | "reject" | "unsupported" = "enter") {
  const eventTarget = new EventTarget();
  const root = {} as HTMLElement;
  let activeElement: Element | null = null;

  const fullscreenDocument = Object.assign(eventTarget, {
    documentElement: root,
    exitFullscreen: vi.fn(async () => {
      activeElement = null;
    })
  }) as unknown as Document;

  Object.defineProperty(fullscreenDocument, "fullscreenElement", {
    configurable: true,
    get: () => activeElement
  });

  if (requestResult !== "unsupported") {
    root.requestFullscreen = vi.fn(async () => {
      if (requestResult === "reject") {
        throw new Error("denied");
      }
      activeElement = root;
    });
  }

  return {
    fullscreenDocument,
    root,
    dispatchChange: () => eventTarget.dispatchEvent(new Event("fullscreenchange"))
  };
}

describe("fullscreen adapter", () => {
  it("requests the document root once and reports successful entry", async () => {
    const { fullscreenDocument, root } = fullscreenFixture();

    await expect(requestDocumentFullscreen(fullscreenDocument)).resolves.toBe(true);
    expect(root.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(root.requestFullscreen).toHaveBeenCalledWith({ navigationUI: "hide" });
  });

  it("turns rejection and unsupported browsers into a stable fallback result", async () => {
    const rejected = fullscreenFixture("reject");
    const unsupported = fullscreenFixture("unsupported");

    await expect(requestDocumentFullscreen(rejected.fullscreenDocument)).resolves.toBe(false);
    expect(rejected.root.requestFullscreen).toHaveBeenCalledTimes(1);
    await expect(requestDocumentFullscreen(unsupported.fullscreenDocument)).resolves.toBe(false);
    expect(fullscreenSupported(unsupported.fullscreenDocument)).toBe(false);
  });

  it("tracks browser fullscreen changes and can exit cleanly", async () => {
    const { fullscreenDocument, dispatchChange } = fullscreenFixture();
    const listener = vi.fn();
    const unsubscribe = subscribeToFullscreenChanges(listener, fullscreenDocument);

    dispatchChange();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    dispatchChange();
    expect(listener).toHaveBeenCalledTimes(1);

    await requestDocumentFullscreen(fullscreenDocument);
    await expect(exitDocumentFullscreen(fullscreenDocument)).resolves.toBe(true);
    expect(fullscreenDocument.exitFullscreen).toHaveBeenCalledTimes(1);
  });
});
