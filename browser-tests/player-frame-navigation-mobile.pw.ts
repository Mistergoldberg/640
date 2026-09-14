import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const LANDSCAPE_PHOTO = "2002-5d0aaeea05b95f";
const PORTRAIT_PHOTO = "2002-fd741068e43907";

interface TouchPoint {
  x: number;
  y: number;
  id?: number;
}

async function mobileContext(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport, screen: viewport, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data) => {
        (window as Window & { __share?: ShareData }).__share = data;
      }
    });
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Fullscreen unavailable", "NotAllowedError"))
    });
  });
  return context;
}

async function desktopContext(context: BrowserContext) {
  await context.addInitScript(() => {
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Fullscreen unavailable", "NotAllowedError"))
    });
  });
}

function monitorPage(page: Page) {
  const health = { pageErrors: [] as string[], consoleErrors: [] as string[], requestFailures: [] as string[] };
  page.on("pageerror", (error) => health.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") health.consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    const reason = request.failure()?.errorText || "request failed";
    if ((url.includes("insertcatchytitlehere.com") || url.includes("127.0.0.1")) && !reason.includes("ERR_ABORTED")) {
      health.requestFailures.push(`${reason} ${url}`);
    }
  });
  return health;
}

function expectHealthy(health: ReturnType<typeof monitorPage>) {
  expect(health.pageErrors).toEqual([]);
  expect(health.consoleErrors).toEqual([]);
  expect(health.requestFailures).toEqual([]);
}

async function openDirectPhoto(page: Page, photoId: string, orientation: "portrait" | "landscape") {
  await page.goto(`/?year=2002&photo=${photoId}`);
  await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 20_000 });
  const image = page.locator(`.player-image--${orientation}`);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0), { timeout: 20_000 }).toBe(true);
  return image;
}

async function playerIndex(page: Page) {
  const match = (await page.locator(".player-counter").textContent())?.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) throw new Error("Player counter is unavailable");
  return { index: Number(match[1]), total: Number(match[2]) };
}

async function expectPlayerIndex(page: Page, expected: number) {
  await expect.poll(async () => (await playerIndex(page)).index).toBe(expected);
}

async function surfaceBox(page: Page) {
  const box = await page.locator(".player-surface").boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function playPlayer(page: Page) {
  const button = page.locator('[data-player-control="playback"]');
  if (await button.getAttribute("aria-label") === "Play") {
    await button.click();
  }
  await expect(button).toHaveAttribute("aria-label", "Pause");
}

async function pausePlayer(page: Page) {
  const button = page.locator('[data-player-control="playback"]');
  await playPlayer(page);
  await button.click();
  await expect(button).toHaveAttribute("aria-label", "Play");
}

function cdpTouchPoint(point: TouchPoint) {
  return {
    x: Math.round(point.x),
    y: Math.round(point.y),
    id: point.id ?? 1,
    radiusX: 4,
    radiusY: 4,
    force: 1
  };
}

async function touchSequence(
  page: Page,
  start: TouchPoint,
  options: { holdMs?: number; moves?: Array<{ point: TouchPoint; afterMs?: number }> } = {}
) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [cdpTouchPoint(start)],
      modifiers: 0
    });

    for (const move of options.moves || []) {
      if (move.afterMs) await page.waitForTimeout(move.afterMs);
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [cdpTouchPoint({ ...move.point, id: start.id ?? 1 })],
        modifiers: 0
      });
    }

    if (options.holdMs) await page.waitForTimeout(options.holdMs);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], modifiers: 0 });
  } finally {
    await session.detach();
  }
}

async function multiTouch(page: Page, first: TouchPoint, second: TouchPoint, holdMs = 120) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [cdpTouchPoint({ ...first, id: 1 })],
      modifiers: 0
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [cdpTouchPoint({ ...first, id: 1 }), cdpTouchPoint({ ...second, id: 2 })],
      modifiers: 0
    });
    await page.waitForTimeout(holdMs);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], modifiers: 0 });
  } finally {
    await session.detach();
  }
}

test("mobile portrait frame taps include letterbox, navigate once, suppress synthetic clicks, and keep explicit pause", async ({ browser }, testInfo) => {
  const context = await mobileContext(browser, { width: 390, height: 844 });
  const page = await context.newPage();
  const health = monitorPage(page);
  const image = await openDirectPhoto(page, PORTRAIT_PHOTO, "portrait");
  await pausePlayer(page);
  const start = await playerIndex(page);
  const [surface, imageBox] = await Promise.all([surfaceBox(page), image.boundingBox()]);
  expect(imageBox).not.toBeNull();

  await page.screenshot({ path: testInfo.outputPath("mobile-portrait-touch-frame.png"), fullPage: false });
  await touchSequence(page, { x: surface.x + 6, y: imageBox!.y + imageBox!.height / 2 });
  await expectPlayerIndex(page, start.index - 1);
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Play");

  await touchSequence(page, { x: surface.x + surface.width - 6, y: imageBox!.y + imageBox!.height / 2 });
  await expectPlayerIndex(page, start.index);
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Play");

  const playbackBox = await page.locator('[data-player-control="playback"]').boundingBox();
  expect(playbackBox).not.toBeNull();
  await page.touchscreen.tap(playbackBox!.x + playbackBox!.width / 2, playbackBox!.y + playbackBox!.height / 2);
  await expectPlayerIndex(page, start.index);
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Pause");

  expectHealthy(health);
  await context.close();
});

test("mobile touch hold repeats, movement cancels before hold, midpoint crossing keeps direction, and multi-touch is ignored", async ({ browser }) => {
  const context = await mobileContext(browser, { width: 390, height: 844 });
  const page = await context.newPage();
  const health = monitorPage(page);
  await openDirectPhoto(page, LANDSCAPE_PHOTO, "landscape");
  await pausePlayer(page);
  const surface = await surfaceBox(page);

  const beforeHold = await playerIndex(page);
  await touchSequence(page, { x: surface.x + surface.width * 0.78, y: surface.y + surface.height * 0.5 }, { holdMs: 525 });
  const afterHold = await playerIndex(page);
  expect(afterHold.index).toBeGreaterThanOrEqual(beforeHold.index + 2);
  await page.waitForTimeout(260);
  expect(await playerIndex(page)).toEqual(afterHold);

  const beforeMoveCancel = await playerIndex(page);
  await touchSequence(page, {
    x: surface.x + surface.width * 0.78,
    y: surface.y + surface.height * 0.5
  }, {
    moves: [{ point: { x: surface.x + surface.width * 0.78, y: surface.y + surface.height * 0.5 + 80 }, afterMs: 60 }],
    holdMs: 330
  });
  expect(await playerIndex(page)).toEqual(beforeMoveCancel);

  const beforeCross = await playerIndex(page);
  await touchSequence(page, {
    x: surface.x + surface.width * 0.78,
    y: surface.y + surface.height * 0.5
  }, {
    moves: [{ point: { x: surface.x + surface.width * 0.18, y: surface.y + surface.height * 0.5 }, afterMs: 320 }],
    holdMs: 140
  });
  expect((await playerIndex(page)).index).toBeGreaterThan(beforeCross.index);

  const beforeMulti = await playerIndex(page);
  await multiTouch(
    page,
    { x: surface.x + surface.width * 0.78, y: surface.y + surface.height * 0.5 },
    { x: surface.x + surface.width * 0.22, y: surface.y + surface.height * 0.5 },
    360
  );
  expect(await playerIndex(page)).toEqual(beforeMulti);

  expectHealthy(health);
  await context.close();
});

test("touch frame navigation resumes autoplay after three seconds unless explicitly paused", async ({ browser }) => {
  const context = await mobileContext(browser, { width: 390, height: 844 });
  const page = await context.newPage();
  const health = monitorPage(page);
  await openDirectPhoto(page, LANDSCAPE_PHOTO, "landscape");
  await playPlayer(page);
  const surface = await surfaceBox(page);

  await touchSequence(page, { x: surface.x + surface.width * 0.78, y: surface.y + surface.height * 0.5 });
  const navigated = await playerIndex(page);
  await expect(page.locator(".player-counter")).toContainText("resumes");
  await page.waitForTimeout(2_650);
  expect(await playerIndex(page)).toEqual(navigated);
  await expect.poll(async () => (await playerIndex(page)).index, { timeout: 1_600 }).toBeGreaterThan(navigated.index);

  await pausePlayer(page);
  const explicitlyPaused = await playerIndex(page);
  await touchSequence(page, { x: surface.x + surface.width * 0.78, y: surface.y + surface.height * 0.5 });
  expect((await playerIndex(page)).index).toBe(explicitlyPaused.index + 1);
  await page.waitForTimeout(3_300);
  expect((await playerIndex(page)).index).toBe(explicitlyPaused.index + 1);
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Play");

  expectHealthy(health);
  await context.close();
});

test("mobile landscape keeps compact controls and excludes the right rail from frame navigation", async ({ browser }, testInfo) => {
  const context = await mobileContext(browser, { width: 844, height: 390 });
  const page = await context.newPage();
  const health = monitorPage(page);
  await openDirectPhoto(page, LANDSCAPE_PHOTO, "landscape");
  await pausePlayer(page);
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-layout", "mobile-landscape-rail");
  const surface = await surfaceBox(page);
  const speedBox = await page.locator('[data-player-control="speed"]').boundingBox();
  expect(speedBox).not.toBeNull();

  await page.screenshot({ path: testInfo.outputPath("mobile-landscape-touch-frame.png"), fullPage: false });
  const start = await playerIndex(page);
  await touchSequence(page, { x: surface.x + surface.width * 0.68, y: surface.y + surface.height * 0.5 });
  await expectPlayerIndex(page, start.index + 1);
  await touchSequence(page, { x: surface.x + surface.width * 0.18, y: surface.y + surface.height * 0.5 });
  await expectPlayerIndex(page, start.index);

  await touchSequence(page, { x: speedBox!.x + speedBox!.width / 2, y: surface.y + surface.height * 0.5 });
  await expectPlayerIndex(page, start.index);
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Play");

  expectHealthy(health);
  await context.close();
});

test("photo-surface copy deterrence is scoped and desktop frame navigation still works", async ({ context, page }) => {
  await desktopContext(context);
  const health = monitorPage(page);
  await openDirectPhoto(page, LANDSCAPE_PHOTO, "landscape");
  await pausePlayer(page);
  const start = await playerIndex(page);
  const surface = await surfaceBox(page);

  await page.mouse.click(surface.x + surface.width * 0.78, surface.y + surface.height * 0.5);
  await expectPlayerIndex(page, start.index + 1);

  const protections = await page.locator(".player-surface").evaluate((element) => {
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    const selectStart = new Event("selectstart", { bubbles: true, cancelable: true });
    element.dispatchEvent(contextMenu);
    element.dispatchEvent(dragStart);
    element.dispatchEvent(selectStart);
    const image = element.querySelector(".player-image") as HTMLImageElement | null;
    const styles = image ? getComputedStyle(image) : null;
    return {
      contextMenuPrevented: contextMenu.defaultPrevented,
      dragStartPrevented: dragStart.defaultPrevented,
      selectStartPrevented: selectStart.defaultPrevented,
      imageDraggable: image?.getAttribute("draggable"),
      imageUserSelect: styles?.userSelect,
      imageTouchCallout: styles?.getPropertyValue("-webkit-touch-callout"),
      imageUserDrag: styles?.getPropertyValue("-webkit-user-drag")
    };
  });
  expect(protections).toMatchObject({
    contextMenuPrevented: true,
    dragStartPrevented: true,
    selectStartPrevented: true,
    imageDraggable: "false",
    imageUserSelect: "none",
    imageUserDrag: "none"
  });
  expect(["", "none"]).toContain(protections.imageTouchCallout);

  const controlContextMenuPrevented = await page.locator('[data-player-control="playback"]').evaluate((element) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(controlContextMenuPrevented).toBe(false);

  expectHealthy(health);
});
