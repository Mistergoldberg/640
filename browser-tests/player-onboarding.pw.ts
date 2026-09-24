import { expect, test, type Browser, type Page } from "@playwright/test";

const enabled = process.env.VITE_HOMEPAGE_AUTOPLAYER === "1";
const STORAGE_KEY = "pixilation-player-onboarding-v1";
const DIRECT_PHOTO = "2002-5d0aaeea05b95f";

test.skip(!enabled, "player onboarding tests require VITE_HOMEPAGE_AUTOPLAYER=1");

async function waitForPaintedPlayer(page: Page) {
  await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".player-image")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.locator(".player-image").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), {
    timeout: 30_000
  }).toBe(true);
}

async function playerIndex(page: Page) {
  const match = (await page.locator(".player-counter").textContent())?.match(/(\d+)\s*\//);
  if (!match) throw new Error("Player counter is unavailable");
  return Number(match[1]);
}

async function expectActionBarInsideViewport(page: Page) {
  expect(await page.locator(".player-onboarding__action-bar").evaluate((bar) => {
    const rect = bar.getBoundingClientRect();
    return rect.top >= 0
      && rect.left >= 0
      && rect.right <= window.innerWidth
      && rect.bottom <= window.innerHeight;
  })).toBe(true);
}

async function expectBrowseTeachingOverImage(page: Page) {
  const prompt = page.locator(".player-onboarding__center-prompt");
  await expect(prompt).toHaveText("Tap to play");
  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
    const image = rect(".player-image");
    const back = rect(".player-onboarding__frame-zone--back .player-onboarding__gesture-cue");
    const prompt = rect(".player-onboarding__center-prompt");
    const forward = rect(".player-onboarding__frame-zone--forward .player-onboarding__gesture-cue");
    const inside = (inner?: DOMRect, outer?: DOMRect) => Boolean(inner && outer
      && inner.left >= outer.left - 1 && inner.right <= outer.right + 1
      && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1);
    const centerY = (box?: DOMRect) => box ? box.top + box.height / 2 : 0;
    return {
      allInsideImage: inside(back, image) && inside(prompt, image) && inside(forward, image),
      ordered: Boolean(back && prompt && forward && back.right <= prompt.left + 1 && prompt.right <= forward.left + 1),
      verticalOffset: Math.max(
        Math.abs(centerY(back) - centerY(prompt)),
        Math.abs(centerY(forward) - centerY(prompt))
      )
    };
  });
  expect(geometry.allInsideImage).toBe(true);
  expect(geometry.ordered).toBe(true);
  expect(geometry.verticalOffset).toBeLessThan(1);
}

async function expectControlsPrompt(page: Page, copy: string, control: "speed" | "music") {
  const prompt = page.locator(".player-onboarding__center-prompt");
  await expect(prompt).toHaveText(copy);
  const geometry = await page.evaluate((control) => {
    const prompt = document.querySelector<HTMLElement>(".player-onboarding__center-prompt")?.getBoundingClientRect();
    const controls = document.querySelector<HTMLElement>(".player-controls")?.getBoundingClientRect();
    const target = document.querySelector<HTMLElement>(`[data-player-control='${control}']`)?.getBoundingClientRect();
    const music = document.querySelector<HTMLElement>("[data-player-control='music']")?.getBoundingClientRect();
    const speed = document.querySelector<HTMLElement>("[data-player-control='speed']")?.getBoundingClientRect();
    const landscapeRail = document.querySelector("[data-player-layout='mobile-landscape-rail']") !== null;
    return {
      landscapeRail,
      standardPlacement: Boolean(prompt && controls
        && Math.abs(prompt.left + prompt.width / 2 - (controls.left + controls.width / 2)) < 1
        && prompt.bottom <= controls.top - 8),
      landscapePlacement: Boolean(prompt && target && music && speed
        && Math.abs(prompt.right - target.right) < 1
        && prompt.bottom <= Math.min(music.top, speed.top) - 8),
      insideViewport: Boolean(prompt && prompt.top >= 0 && prompt.left >= 0
        && prompt.right <= window.innerWidth && prompt.bottom <= window.innerHeight),
      radius: prompt ? getComputedStyle(document.querySelector<HTMLElement>(".player-onboarding__center-prompt")!).borderRadius : ""
    };
  }, control);
  expect(geometry.insideViewport).toBe(true);
  expect(geometry.landscapeRail ? geometry.landscapePlacement : geometry.standardPlacement).toBe(true);
  expect(geometry.radius).toBe("16px");
}

async function expectGestureCuesClearOfActionBar(page: Page) {
  await expect(page.locator(".player-onboarding__frame-zone--back .player-onboarding__gesture-cue")).toBeVisible();
  await expect(page.locator(".player-onboarding__frame-zone--forward .player-onboarding__gesture-cue")).toBeVisible();
  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
    const actionBar = rect(".player-onboarding__action-bar");
    const back = rect(".player-onboarding__frame-zone--back .player-onboarding__gesture-cue");
    const forward = rect(".player-onboarding__frame-zone--forward .player-onboarding__gesture-cue");
    const overlaps = (first?: DOMRect, second?: DOMRect) => Boolean(first && second
      && first.right > second.left
      && first.left < second.right
      && first.bottom > second.top
      && first.top < second.bottom);
    return {
      actionBarBottom: actionBar?.bottom ?? 0,
      actionBarHeight: actionBar?.height ?? 0,
      backTop: back?.top ?? 0,
      backWidth: back?.width ?? 0,
      forwardTop: forward?.top ?? 0,
      forwardWidth: forward?.width ?? 0,
      backOverlap: overlaps(actionBar, back),
      forwardOverlap: overlaps(actionBar, forward),
      viewportHeight: window.innerHeight
    };
  });
  expect(geometry.backWidth).toBeGreaterThan(120);
  expect(geometry.forwardWidth).toBeGreaterThan(120);
  expect(geometry.actionBarHeight).toBeLessThan(60);
  expect(geometry.backTop).toBeGreaterThan(geometry.actionBarBottom + 12);
  expect(geometry.forwardTop).toBeGreaterThan(geometry.actionBarBottom + 12);
  expect(geometry.backOverlap).toBe(false);
  expect(geometry.forwardOverlap).toBe(false);
}

test("homepage autoplay never opens instructions without a Help request", async ({ page }) => {
  const soundCloudRequests: string[] = [];
  page.on("request", (request) => {
    if (/soundcloud/i.test(request.url())) soundCloudRequests.push(request.url());
  });
  await page.goto("/");
  await waitForPaintedPlayer(page);
  await expect(page.locator(".player-onboarding__action-bar")).toHaveCount(0);
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-onboarding-phase", "ineligible");
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
  const first = await playerIndex(page);
  await expect.poll(() => playerIndex(page), { timeout: 3_500 }).toBeGreaterThan(first);
  await page.waitForTimeout(2_600);
  await expect(page.locator(".player-onboarding__action-bar")).toHaveCount(0);
  await expect(page.locator("[data-player-control='playback']")).toHaveAttribute("aria-label", "Pause");
  expect(soundCloudRequests).toEqual([]);
});

test("Help opens the tutorial and teaches the real controls", async ({ page }) => {
  const soundCloudRequests: string[] = [];
  page.on("request", (request) => {
    if (/soundcloud/i.test(request.url())) soundCloudRequests.push(request.url());
  });
  await page.goto("/");
  await waitForPaintedPlayer(page);
  await expect(page.locator(".player-onboarding__action-bar")).toHaveCount(0);
  const playback = page.locator("[data-player-control='playback']");
  await expect(playback).toHaveAttribute("aria-label", "Pause", { timeout: 5_000 });
  await playback.click();
  await expect(playback).toHaveAttribute("aria-label", "Play");
  const initialIndex = await playerIndex(page);
  await page.getByRole("button", { name: "Player help" }).click();
  await expect(page.locator(".player-onboarding__action-bar")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-onboarding-phase", "instruction-1");
  await expect(page.locator(".player-onboarding")).toHaveAttribute("data-onboarding-frame", "next-1");
  await expect(page.locator(".player-onboarding__card")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Step 1 of 6, Next, Tap to play");
  await expectBrowseTeachingOverImage(page);
  await expect(page.getByRole("button", { name: "Close tutorial" })).toHaveCount(0);
  await expect(page.getByText("Quick tour", { exact: true })).toHaveCount(0);
  await expect(page.locator(".player-onboarding__progress")).toHaveCount(0);
  await expectActionBarInsideViewport(page);
  await expect(playback).toBeDisabled();
  await expect(page.locator(".player-surface")).toBeFocused();
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
  expect(soundCloudRequests).toEqual([]);

  await expect.poll(() => playerIndex(page)).toBe(initialIndex + 1);
  await expect(page.locator(".player-onboarding")).toHaveAttribute("data-onboarding-frame", "previous-1", { timeout: 1_200 });
  await expect.poll(() => playerIndex(page)).toBe(initialIndex);
  await expect(page.locator(".player-onboarding")).toHaveAttribute("data-onboarding-frame", "next-2", { timeout: 1_200 });
  await expect.poll(() => playerIndex(page)).toBe(initialIndex + 1);
  await expect(page.locator(".player-onboarding")).toHaveAttribute("data-onboarding-frame", "previous-2", { timeout: 1_200 });
  await expect.poll(() => playerIndex(page)).toBe(initialIndex);

  await expect(page.locator(".player-onboarding")).toHaveAttribute("data-onboarding-frame", "speed", { timeout: 1_200 });
  await expect(page.locator("[data-player-control='speed']")).toBeFocused();
  await expectControlsPrompt(page, "Adjust Speed", "speed");
  await expect(page.getByRole("status")).toHaveText("Step 5 of 6, Adjust Speed");

  await expect(page.locator(".player-onboarding")).toHaveAttribute("data-onboarding-frame", "music", { timeout: 1_200 });
  await expect(page.locator("[data-player-control='music']")).toBeFocused();
  await expectControlsPrompt(page, "Add Music", "music");
  await expect(page.getByRole("status")).toHaveText("Step 6 of 6, Add Music");
  expect(soundCloudRequests).toEqual([]);

  await expect(page.locator(".player-onboarding__action-bar")).toHaveCount(0, { timeout: 1_200 });
  await expect(playback).toHaveAttribute("aria-label", "Pause");
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe("1");
  expect(soundCloudRequests).toEqual([]);
});

test("returning and direct-photo visitors use permanent Help without automatic interruption", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "1"), STORAGE_KEY);
  await page.goto("/");
  await waitForPaintedPlayer(page);
  await page.waitForTimeout(3_000);
  await expect(page.locator(".player-onboarding__action-bar")).toHaveCount(0);
  await page.getByRole("button", { name: "Player help" }).click();
  await expect(page.locator(".player-onboarding__action-bar")).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.locator(".player-onboarding__action-bar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Player help" })).toBeFocused();

  await page.goto(`/?year=2002&photo=${DIRECT_PHOTO}`);
  await waitForPaintedPlayer(page);
  await page.waitForTimeout(500);
  await expect(page.locator(".player-onboarding__action-bar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Player help" })).toBeVisible();
});

test("reduced motion uses a static first frame and only explicit Play starts motion", async ({ browser }) => {
  const context = await (browser as Browser).newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce"
  });
  const page = await context.newPage();
  await page.goto("/");
  await waitForPaintedPlayer(page);
  await expect(page.locator(".player-onboarding__action-bar")).toHaveCount(0);
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-onboarding-phase", "ineligible");
  const first = await playerIndex(page);
  await page.waitForTimeout(1_000);
  expect(await playerIndex(page)).toBe(first);
  await expect(page.locator("[data-player-control='playback']")).toHaveAttribute("aria-label", "Play");

  await page.getByRole("button", { name: "Player help" }).click();
  await expect(page.locator(".player-onboarding__action-bar")).toBeVisible();
  await expect(page.locator(".player-onboarding")).toHaveAttribute("data-onboarding-frame", "browse");
  await expectBrowseTeachingOverImage(page);
  await expect(page.locator(".player-onboarding__frame-zone--back .player-onboarding__gesture-cue")).toHaveCSS("animation-name", "none");
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.locator("[data-player-control='playback']")).toHaveAttribute("aria-label", "Play");
  await page.waitForTimeout(500);
  expect(await playerIndex(page)).toBe(first);

  await page.getByRole("button", { name: "Player help" }).click();
  await page.getByRole("button", { name: "Speed", exact: true }).click();
  await expectControlsPrompt(page, "Adjust Speed", "speed");
  await page.waitForTimeout(800);
  await expect(page.locator(".player-onboarding")).toHaveAttribute("data-onboarding-frame", "speed");
  await page.getByRole("button", { name: "Music", exact: true }).click();
  await expectControlsPrompt(page, "Add Music", "music");
  await page.waitForTimeout(800);
  await expect(page.locator(".player-onboarding")).toHaveAttribute("data-onboarding-frame", "music");
  await page.getByRole("button", { name: "Play slideshow", exact: true }).click();
  await expect(page.locator("[data-player-control='playback']")).toHaveAttribute("aria-label", "Pause");
  await expect.poll(() => playerIndex(page), { timeout: 2_000 }).toBeGreaterThan(first);
  await context.close();
});

test("compact action bar and enlarged callouts stay clear in mobile landscape", async ({ browser }) => {
  const context = await (browser as Browser).newContext({
    viewport: { width: 844, height: 390 },
    screen: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true
  });
  await context.addInitScript((key) => localStorage.setItem(key, "1"), STORAGE_KEY);
  const page = await context.newPage();
  await page.goto("/");
  await waitForPaintedPlayer(page);
  await page.getByRole("button", { name: "Player help" }).click();
  await expect(page.locator(".player-onboarding")).toHaveAttribute("data-onboarding-frame", "next-1");
  await expect(page.getByRole("status")).toHaveText("Step 1 of 6, Next, Tap to play");
  await expect(page.locator(".player-onboarding__gesture-copy")).toHaveCount(2);
  await expect(page.locator(".player-onboarding__frame-zone--forward .player-onboarding__gesture-cue")).toHaveCSS("animation-name", "onboarding-demo-cue");
  await expect(page.locator(".player-onboarding__gesture-copy strong").first()).toHaveCSS("font-size", "14.4px");
  await expectActionBarInsideViewport(page);
  await expectGestureCuesClearOfActionBar(page);
  await expectBrowseTeachingOverImage(page);
  await page.addStyleTag({ content: ".player-onboarding__action-bar { top: 59px !important; }" });
  await expectGestureCuesClearOfActionBar(page);
  await expect(page.locator(".player-onboarding")).toHaveAttribute("data-onboarding-frame", "previous-1", { timeout: 1_200 });
  await expect(page.locator(".player-onboarding__frame-zone--back .player-onboarding__gesture-cue")).toHaveCSS("animation-name", "onboarding-demo-cue");
  await expect(page.locator(".player-onboarding")).toHaveAttribute("data-onboarding-frame", "speed", { timeout: 3_000 });
  await expectControlsPrompt(page, "Adjust Speed", "speed");
  await expectActionBarInsideViewport(page);
  await expect(page.locator(".player-onboarding")).toHaveAttribute("data-onboarding-frame", "music", { timeout: 1_200 });
  await expectControlsPrompt(page, "Add Music", "music");
  await expectActionBarInsideViewport(page);
  await context.close();
});

test("portrait chrome and playback controls recover after Help exits across rotation", async ({ browser }) => {
  const context = await (browser as Browser).newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  await context.addInitScript((key) => localStorage.setItem(key, "1"), STORAGE_KEY);
  const page = await context.newPage();
  await page.goto("/");
  await waitForPaintedPlayer(page);

  const playback = page.locator("[data-player-control='playback']");
  await page.getByRole("button", { name: "Player help" }).click();
  await expectGestureCuesClearOfActionBar(page);
  await expectBrowseTeachingOverImage(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-orientation", "landscape");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-orientation", "portrait");
  await expect(page.locator(".player-onboarding__action-bar")).toHaveCount(0, { timeout: 6_000 });
  await expect(page.locator(".player-counter")).toBeHidden();
  await expect(page.getByRole("button", { name: "Player help" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeEnabled();
  const positions = await page.evaluate(() => {
    const help = document.querySelector<HTMLElement>(".player-help")?.getBoundingClientRect();
    const close = document.querySelector<HTMLElement>(".player-topbar button")?.getBoundingClientRect();
    return { helpLeft: help?.left, closeRight: close?.right };
  });
  expect(positions.helpLeft).toBeLessThan(70);
  expect(positions.closeRight).toBeGreaterThan(320);

  await expect(playback).toHaveAttribute("aria-label", "Pause");
  await playback.click();
  await expect(playback).toHaveAttribute("aria-label", "Play");

  const initial = await playerIndex(page);
  await page.locator("[data-player-control='forward']").click();
  await expect.poll(() => playerIndex(page)).toBe(initial + 1);
  await page.locator("[data-player-control='back']").click();
  await expect.poll(() => playerIndex(page)).toBe(initial);
  await expect(playback).toHaveAttribute("aria-label", "Play");
  await playback.click();
  await expect(playback).toHaveAttribute("aria-label", "Pause");
  await expect.poll(() => playerIndex(page), { timeout: 2_000 }).toBeGreaterThan(initial);
  await context.close();
});
