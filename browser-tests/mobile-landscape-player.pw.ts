import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const LANDSCAPE_PHOTO = "2002-5d0aaeea05b95f";
const PORTRAIT_PHOTO = "2002-fd741068e43907";

async function openDirectPhoto(page: Page, photoId: string, orientation: "portrait" | "landscape", debug = false) {
  await page.goto(`/?year=2002&photo=${photoId}${debug ? "&debug=1" : ""}`);
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

async function mobileContext(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport, screen: viewport, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Fullscreen unavailable", "NotAllowedError"))
    });
  });
  return context;
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

async function expectLandscapeContainment(page: Page, viewport: { width: number; height: number }) {
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-layout", "mobile-landscape-rail");
  const stage = page.locator(".player-media-stage");
  const image = page.locator(".player-image");
  const [stageBox, imageBox] = await Promise.all([stage.boundingBox(), image.boundingBox()]);
  expect(stageBox).not.toBeNull();
  expect(imageBox).not.toBeNull();
  expect(stageBox).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  expect(imageBox!.x).toBeGreaterThanOrEqual(stageBox!.x);
  expect(imageBox!.x + imageBox!.width).toBeLessThanOrEqual(stageBox!.x + stageBox!.width + 1);
  expect(imageBox!.y).toBeLessThanOrEqual(1);
  expect(imageBox!.y + imageBox!.height).toBeGreaterThanOrEqual(viewport.height - 1);

  const interactiveBoxes = await page.locator(".player-control-frame > .player-topbar button, .player-controls > [data-player-control]").evaluateAll((buttons) => buttons
    .filter((button) => getComputedStyle(button).display !== "none" && button.getBoundingClientRect().width > 0)
    .map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        name: (button as HTMLElement).dataset.playerControl || button.getAttribute("aria-label") || "",
        width: rect.width,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      };
    }));
  for (const target of interactiveBoxes) {
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(target.left).toBeGreaterThanOrEqual(0);
    expect(target.right).toBeLessThanOrEqual(viewport.width);
    expect(target.top).toBeGreaterThanOrEqual(0);
    expect(target.bottom).toBeLessThanOrEqual(viewport.height);
  }

  const leftRail = interactiveBoxes.filter(({ left }) => left < viewport.width / 2).sort((top, bottom) => top.top - bottom.top);
  const rightRail = interactiveBoxes.filter(({ left }) => left >= viewport.width / 2).sort((top, bottom) => top.top - bottom.top);
  expect(leftRail.map(({ name }) => name)).toEqual(["Close", "back", "forward", "playback", "share"]);
  expect(rightRail.map(({ name }) => name)).toEqual(["music", "speed"]);
  for (const rail of [leftRail, rightRail]) {
    expect(Math.max(...rail.map(({ left }) => left)) - Math.min(...rail.map(({ left }) => left))).toBeLessThan(2);
    for (let index = 1; index < rail.length; index += 1) {
      expect(rail[index].top).toBeGreaterThanOrEqual(rail[index - 1].bottom);
    }
  }

  const speedBox = await page.locator('[data-player-control="speed"]').boundingBox();
  expect(speedBox).not.toBeNull();
  await expect(page.locator(".player-counter")).toBeHidden();
  await expect(page.locator('[data-player-control="screen-mode"]')).toBeHidden();

  return { stageBox: stageBox!, imageBox: imageBox!, speedBox: speedBox! };
}

test("mobile landscape uses a full-height image and vertical control rail for both image orientations", async ({ browser }) => {
  for (const sample of [
    { viewport: { width: 844, height: 390 }, photo: LANDSCAPE_PHOTO, orientation: "landscape" as const },
    { viewport: { width: 667, height: 320 }, photo: PORTRAIT_PHOTO, orientation: "portrait" as const }
  ]) {
    const context = await mobileContext(browser, sample.viewport);
    const page = await context.newPage();
    const health = monitorPage(page);
    await openDirectPhoto(page, sample.photo, sample.orientation);
    const { speedBox } = await expectLandscapeContainment(page, sample.viewport);

    const playbackBox = await page.locator('[data-player-control="playback"]').boundingBox();
    const previousBox = await page.locator('[data-player-control="back"]').boundingBox();
    const playbackBackground = await page.locator('[data-player-control="playback"]').evaluate((element) => getComputedStyle(element).backgroundColor);
    const previousBackground = await page.locator('[data-player-control="back"]').evaluate((element) => getComputedStyle(element).backgroundColor);
    const speedBackground = await page.locator('[data-player-control="speed"]').evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(playbackBox!.width).toBe(previousBox!.width);
    expect(playbackBackground).not.toBe(previousBackground);
    expect(speedBackground).toBe(playbackBackground);
    await expect(page.locator('[data-player-control="more"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Share player link" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Play music" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Full screen" })).toBeHidden();
    await expect(page.locator(".speed-trigger__value")).toHaveText("0.1s");

    const beforeMenuStage = await page.locator(".player-media-stage").boundingBox();
    const beforeSpeedIndex = await playerIndex(page);
    await page.locator('[data-player-control="speed"]').click();
    await expect(page.getByRole("radiogroup", { name: "Playback speed" })).toBeVisible();
    const menuBox = await page.locator(".speed-menu").boundingBox();
    expect(menuBox!.x).toBeGreaterThanOrEqual(0);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(speedBox.x - 2);
    expect(menuBox!.y).toBeGreaterThanOrEqual(0);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(sample.viewport.height);
    await expect(page.getByRole("radio", { name: "0.1 seconds per photo" })).toHaveAttribute("aria-checked", "true");
    for (const button of await page.locator(".speed-menu button:visible").all()) {
      const box = await button.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(speedBox.x - 2);
      expect(box!.y + box!.height).toBeLessThanOrEqual(sample.viewport.height);
    }
    const speedOptions = await page.locator(".speed-menu button:visible").evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left };
    }));
    expect(Math.max(...speedOptions.map(({ left }) => left)) - Math.min(...speedOptions.map(({ left }) => left))).toBeLessThan(2);
    for (let index = 1; index < speedOptions.length; index += 1) {
      expect(speedOptions[index].top).toBeGreaterThanOrEqual(speedOptions[index - 1].bottom);
    }
    await page.getByRole("radio", { name: "0.5 seconds per photo" }).click();
    await expect(page.getByRole("radiogroup", { name: "Playback speed" })).toHaveCount(0);
    await expect(page.locator(".speed-trigger__value")).toHaveText("0.5s");
    expect(await playerIndex(page)).toEqual(beforeSpeedIndex);
    expect(await page.locator(".player-media-stage").boundingBox()).toEqual(beforeMenuStage);

    await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
    await expectLandscapeContainment(page, sample.viewport);
    expectHealthy(health);
    await context.close();
  }
});

test("speed selection preserves opening, resume, and explicit-pause semantics", async ({ browser }) => {
  const context = await mobileContext(browser, { width: 844, height: 390 });
  const page = await context.newPage();
  const health = monitorPage(page);
  await openDirectPhoto(page, LANDSCAPE_PHOTO, "landscape");
  await expect.poll(() => page.locator(".player-counter").textContent()).toContain("starts");
  const opening = await playerIndex(page);
  const openingStarted = Date.now();
  await page.waitForTimeout(700);
  await page.locator('[data-player-control="speed"]').click();
  await page.getByRole("radio", { name: "0.25 seconds per photo" }).click();
  expect(await playerIndex(page)).toEqual(opening);
  await page.waitForTimeout(1_700);
  expect(await playerIndex(page)).toEqual(opening);
  await expect.poll(async () => (await playerIndex(page)).index, { timeout: 2_000 }).toBeGreaterThan(opening.index);
  const openingDelay = Date.now() - openingStarted;
  expect(openingDelay).toBeGreaterThanOrEqual(2_700);
  expect(openingDelay).toBeLessThan(4_500);

  await page.locator('[data-player-control="speed"]').click();
  await page.getByRole("radio", { name: "2 seconds per photo" }).click();
  const beforeManual = await playerIndex(page);
  await page.locator('[data-player-control="forward"]').click();
  const manual = await playerIndex(page);
  expect(manual.index).toBe(beforeManual.index + 1);
  await expect.poll(() => page.locator(".player-counter").textContent()).toContain("resumes");
  const resumeStarted = Date.now();
  await page.waitForTimeout(4_400);
  expect((await playerIndex(page)).index).toBe(manual.index);
  await expect.poll(() => page.locator(".player-counter").textContent(), { timeout: 2_000 }).not.toContain("resumes");
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Pause");
  const resumeDelay = Date.now() - resumeStarted;
  expect(resumeDelay).toBeGreaterThanOrEqual(4_850);
  expect(resumeDelay).toBeLessThan(6_500);

  await page.locator('[data-player-control="playback"]').click();
  const paused = await playerIndex(page);
  await page.locator('[data-player-control="speed"]').click();
  await page.getByRole("radio", { name: "0.5 seconds per photo" }).click();
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Play");
  await page.waitForTimeout(2_300);
  expect(await playerIndex(page)).toEqual(paused);
  expectHealthy(health);
  await context.close();
});

test("portrait and landscape rotation preserve player state and history", async ({ browser }) => {
  const context = await mobileContext(browser, { width: 390, height: 844 });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: async (data) => { (window as Window & { __share?: ShareData }).__share = data; } });
    const widget = (() => ({ bind: (event: string, listener: () => void) => { if (event === "READY") queueMicrotask(listener); }, play: () => {}, pause: () => {} })) as unknown as Window["SC"]["Widget"];
    widget.Events = { READY: "READY", PLAY: "PLAY", PAUSE: "PAUSE", FINISH: "FINISH" };
    window.SC = { Widget: widget };
  });
  await context.route("https://w.soundcloud.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>SoundCloud</title>" }));
  const page = await context.newPage();
  const health = monitorPage(page);
  await openDirectPhoto(page, PORTRAIT_PHOTO, "portrait");
  const openingStarted = Date.now();
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-layout", "standard");
  await expect.poll(() => page.locator(".player-counter").textContent()).toContain("starts");
  const openingPhoto = await playerIndex(page);
  const historyLength = await page.evaluate(() => history.length);
  await expect.poll(() => page.evaluate(() => history.state?.restoration?.photoId || null)).toBe(PORTRAIT_PHOTO);
  const restorationState = await page.evaluate(() => history.state?.restoration || null);
  await page.waitForTimeout(700);
  await page.setViewportSize({ width: 844, height: 390 });
  await expectLandscapeContainment(page, { width: 844, height: 390 });
  await page.waitForTimeout(1_700);
  expect(await playerIndex(page)).toEqual(openingPhoto);
  await expect.poll(async () => (await playerIndex(page)).index, { timeout: 2_000 }).toBeGreaterThan(openingPhoto.index);
  expect(Date.now() - openingStarted).toBeGreaterThanOrEqual(2_850);

  await page.locator('[data-player-control="speed"]').click();
  await page.getByRole("radio", { name: "1 second per photo" }).click();
  const beforeManual = await playerIndex(page);
  await page.locator('[data-player-control="forward"]').click();
  const manual = await playerIndex(page);
  expect(manual.index).toBe(beforeManual.index + 1);
  await page.waitForTimeout(1_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-layout", "standard");
  await page.waitForTimeout(3_300);
  expect((await playerIndex(page)).index).toBe(manual.index);
  await expect.poll(async () => (await playerIndex(page)).index, { timeout: 2_000 }).toBeGreaterThan(manual.index);

  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Pause");
  await page.locator('[data-player-control="playback"]').click();
  await page.locator('[data-player-control="speed"]').click();
  await page.getByRole("radio", { name: "1 second per photo" }).click();
  await page.locator('[data-player-control="screen-mode"]').click();
  await expect(page.locator(".player-surface")).toHaveClass(/player-surface--expanded/);
  await page.locator('[data-player-control="music"]').click();
  await expect(page.locator('iframe[title="640 SoundCloud playlist"]')).toBeAttached();
  await expect(page.locator('[data-player-control="music"]')).toHaveAttribute("aria-pressed", "true");
  const preserved = await playerIndex(page);

  await page.locator('[data-player-control="speed"]').click();
  await expect(page.getByRole("radiogroup", { name: "Playback speed" })).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await expectLandscapeContainment(page, { width: 844, height: 390 });
  await expect(page.getByRole("radiogroup", { name: "Playback speed" })).toHaveCount(0);
  expect(await playerIndex(page)).toEqual(preserved);
  await expect(page.locator(".speed-trigger__value")).toHaveText("1s");
  await expect(page.locator(".player-surface")).toHaveClass(/player-surface--expanded/);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(await page.evaluate(() => history.state?.restoration || null)).toEqual(restorationState);
  await page.waitForTimeout(1_200);
  expect(await playerIndex(page)).toEqual(preserved);

  await expect(page.locator('[data-player-control="music"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-player-control="share"]').click();
  const share = await page.evaluate(() => (window as Window & { __share?: ShareData }).__share);
  const currentPhoto = (await page.locator(".player-image").getAttribute("src"))?.split("/").pop()?.replace(/\.jpg$/, "");
  expect(currentPhoto).toBeTruthy();
  expect(share?.url).toContain(`year=2002&photo=${currentPhoto}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-layout", "standard");
  expect(await playerIndex(page)).toEqual(preserved);
  await expect(page.locator(".speed-trigger__value")).toHaveText("1s");
  await expect(page.locator(".player-surface")).toHaveClass(/player-surface--expanded/);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(await page.evaluate(() => history.state?.restoration || null)).toEqual(restorationState);

  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  await expect(page.locator(`[data-photo-id="${currentPhoto}"]`)).toBeFocused();
  await page.locator(`[data-photo-id="${currentPhoto}"]`).click();
  await expect(page.getByLabel("Photo player")).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByLabel("Photo player")).toBeVisible();
  await expect(page.locator(".player-counter")).toContainText("/ 479");
  expectHealthy(health);
  await context.close();
});

async function listenerCount(page: Page) {
  const session = await page.context().newCDPSession(page);
  const response = await session.send("Runtime.evaluate", {
    expression: `(() => {
      const count = (target) => target ? Object.values(getEventListeners(target)).reduce((sum, listeners) => sum + listeners.length, 0) : 0;
      return count(window) + count(document) + count(document.documentElement) + count(window.visualViewport);
    })()`,
    includeCommandLineAPI: true,
    returnByValue: true
  });
  await session.detach();
  if (response.exceptionDetails || typeof response.result.value !== "number") throw new Error("Could not inspect listener count");
  return response.result.value as number;
}

test("thirty player rotations retain one instance without listeners or observers accumulating", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await mobileContext(browser, { width: 390, height: 844 });
  const page = await context.newPage();
  const health = monitorPage(page);
  await openDirectPhoto(page, LANDSCAPE_PHOTO, "landscape", true);
  await page.locator(".player-surface").click();
  await page.locator('[data-player-control="playback"]').click();
  const preserved = await playerIndex(page);
  const historyLength = await page.evaluate(() => history.length);
  const listenersBefore = await listenerCount(page);
  await page.locator('[data-player-control="speed"]').click();

  for (let index = 0; index < 30; index += 1) {
    const viewport = index % 2 ? { width: 390, height: 844 } : { width: 844, height: 390 };
    await page.setViewportSize(viewport);
    await expect(page.getByLabel("Photo player")).toHaveAttribute(
      "data-player-layout",
      viewport.width > viewport.height ? "mobile-landscape-rail" : "standard"
    );
    expect(await playerIndex(page)).toEqual(preserved);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
  }

  await expect(page.getByRole("radiogroup", { name: "Playback speed" })).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(await listenerCount(page)).toBe(listenersBefore);
  const boundedDom = await page.locator("*").count();
  expect(boundedDom).toBeLessThan(500);
  await page.getByRole("button", { name: "Archive QA" }).click();
  const observerRow = page.locator(".archive-diagnostics dl > div").filter({ has: page.locator("dt", { hasText: "Archive observers" }) });
  await expect(observerRow.locator("dd")).toHaveText("2");
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-mounted-years", "2002");
  expect(await page.locator("[data-year='2013'] .photo-tile,[data-year='2001'] .photo-tile").count()).toBe(0);
  expectHealthy(health);
  await context.close();
});

test("desktop and mobile portrait retain their horizontal control layout", async ({ browser }) => {
  for (const sample of [
    { viewport: { width: 1440, height: 900 }, mobile: false },
    { viewport: { width: 390, height: 844 }, mobile: true }
  ]) {
    const context: BrowserContext = sample.mobile
      ? await mobileContext(browser, sample.viewport)
      : await browser.newContext({ viewport: sample.viewport });
    const page = await context.newPage();
    const health = monitorPage(page);
    await openDirectPhoto(page, LANDSCAPE_PHOTO, "landscape");
    await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-layout", "standard");
    const stageBox = await page.locator(".player-media-stage").boundingBox();
    expect(stageBox).toEqual({ x: 0, y: 0, width: sample.viewport.width, height: sample.viewport.height });
    const order = await page.locator(".player-controls > [data-player-control]").evaluateAll((controls) => controls
      .filter((control) => getComputedStyle(control).display !== "none")
      .map((control) => ({ name: (control as HTMLElement).dataset.playerControl, left: control.getBoundingClientRect().left, top: control.getBoundingClientRect().top }))
      .sort((left, right) => left.left - right.left));
    expect(order.map(({ name }) => name)).toEqual(["back", "playback", "forward", "speed", "music", "share", "screen-mode"]);
    expect(Math.max(...order.map(({ top }) => top)) - Math.min(...order.map(({ top }) => top))).toBeLessThan(2);
    expectHealthy(health);
    await context.close();
  }
});
