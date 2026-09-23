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

async function expectTourCardInsideViewport(page: Page) {
  expect(await page.locator(".player-onboarding__card").evaluate((card) => {
    const rect = card.getBoundingClientRect();
    return rect.top >= 0
      && rect.left >= 0
      && rect.right <= window.innerWidth
      && rect.bottom <= window.innerHeight;
  })).toBe(true);
}

test("first visit demonstrates presented frames, teaches real controls, and persists only on exit", async ({ page }) => {
  const soundCloudRequests: string[] = [];
  page.on("request", (request) => {
    if (/soundcloud/i.test(request.url())) soundCloudRequests.push(request.url());
  });
  await page.goto("/");
  await waitForPaintedPlayer(page);
  await expect(page.getByRole("heading", { name: "Play the pictures" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-onboarding-phase", "instruction-1");
  await expect(page.locator(".player-onboarding__instruction")).toHaveCount(4);
  await expect(page.locator(".player-onboarding__progress [aria-current='step']")).toHaveText("1");
  await expectTourCardInsideViewport(page);
  await expect(page.locator("[data-player-control='playback']")).toHaveAttribute("aria-label", "Play");
  await expect(page.locator(".player-surface")).toBeFocused();
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
  expect(soundCloudRequests).toEqual([]);

  const pausedIndex = await playerIndex(page);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => playerIndex(page)).toBe(pausedIndex + 1);
  await page.waitForTimeout(400);
  expect(await playerIndex(page)).toBe(pausedIndex + 1);

  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Set the speed" })).toBeVisible();
  await expect(page.locator(".player-onboarding__progress [aria-current='step']")).toHaveText("2");
  await expect(page.locator("[data-player-control='speed']")).toBeFocused();
  await expect(page.locator("[data-player-control='playback']")).toBeDisabled();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("radiogroup", { name: "Playback speed" })).toBeVisible();
  await page.getByRole("radio", { name: "0.5 seconds per photo" }).click();
  await expect(page.locator(".speed-trigger__value")).toHaveText("0.5s");
  await page.locator("[data-player-control='speed']").click();
  await expect(page.getByRole("radiogroup", { name: "Playback speed" })).toBeVisible();

  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add music" })).toBeVisible();
  await expect(page.locator(".player-onboarding__progress [aria-current='step']")).toHaveText("3");
  await expect(page.getByRole("radiogroup", { name: "Playback speed" })).toHaveCount(0);
  await expect(page.locator("[data-player-control='music']")).toBeFocused();
  expect(soundCloudRequests).toEqual([]);

  await page.getByRole("button", { name: "Play the pictures" }).click();
  await expect(page.getByRole("heading", { name: "Add music" })).toHaveCount(0);
  await expect(page.locator("[data-player-control='playback']")).toHaveAttribute("aria-label", "Pause");
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe("1");
  expect(soundCloudRequests).toEqual([]);
});

test("trusted interaction during the demonstration completes onboarding without interrupting the visitor", async ({ page }) => {
  await page.goto("/");
  await waitForPaintedPlayer(page);
  await expect.poll(async () => page.getByLabel("Photo player").getAttribute("data-player-onboarding-phase"), { timeout: 20_000 })
    .toMatch(/waiting-for-player|demonstrating/);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-onboarding-phase", "completed");
  await expect(page.locator(".player-onboarding__card")).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe("1");
});

test("returning and direct-photo visitors use permanent Help without automatic interruption", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "1"), STORAGE_KEY);
  await page.goto("/");
  await waitForPaintedPlayer(page);
  await page.waitForTimeout(3_000);
  await expect(page.locator(".player-onboarding__card")).toHaveCount(0);
  await page.getByRole("button", { name: "Player help" }).click();
  await expect(page.getByRole("heading", { name: "Play the pictures" })).toBeVisible();
  await page.getByRole("button", { name: "Close tutorial" }).click();
  await expect(page.locator(".player-onboarding__card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Player help" })).toBeFocused();

  await page.goto(`/?year=2002&photo=${DIRECT_PHOTO}`);
  await waitForPaintedPlayer(page);
  await page.waitForTimeout(500);
  await expect(page.locator(".player-onboarding__card")).toHaveCount(0);
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
  await expect(page.getByRole("heading", { name: "Play the pictures" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".player-onboarding__frame-zone--back .player-onboarding__gesture-cue")).toHaveCSS("animation-name", "none");
  const first = await playerIndex(page);
  await page.waitForTimeout(1_000);
  expect(await playerIndex(page)).toBe(first);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.locator("[data-player-control='playback']")).toHaveAttribute("aria-label", "Play");
  await page.waitForTimeout(500);
  expect(await playerIndex(page)).toBe(first);

  await page.getByRole("button", { name: "Player help" }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Play the pictures" }).click();
  await expect(page.locator("[data-player-control='playback']")).toHaveAttribute("aria-label", "Pause");
  await expect.poll(() => playerIndex(page), { timeout: 2_000 }).toBeGreaterThan(first);
  await context.close();
});

test("reference-style instruction card stays contained in mobile landscape", async ({ browser }) => {
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
  await expect(page.locator(".player-onboarding__instruction")).toHaveCount(3);
  await expect(page.locator(".player-onboarding__gesture-copy")).toHaveCount(2);
  await expect(page.locator(".player-onboarding__frame-zone--back .player-onboarding__gesture-cue")).not.toHaveCSS("animation-name", "none");
  await expectTourCardInsideViewport(page);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Tap to choose speed", { exact: true })).toBeVisible();
  await expectTourCardInsideViewport(page);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Tap to add music", { exact: true })).toBeVisible();
  await expectTourCardInsideViewport(page);
  await context.close();
});

test("portrait chrome and playback controls recover after Help closes across rotation", async ({ browser }) => {
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
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-orientation", "landscape");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-orientation", "portrait");
  await page.getByRole("button", { name: "Close tutorial" }).click();

  await expect(page.locator(".player-onboarding__card")).toHaveCount(0);
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
