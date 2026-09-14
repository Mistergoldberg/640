import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const LANDSCAPE_PHOTO = "2002-5d0aaeea05b95f";
const PORTRAIT_PHOTO = "2002-fd741068e43907";

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

async function pausePlayer(page: Page) {
  const button = page.locator('[data-player-control="playback"]');
  if (await button.getAttribute("aria-label") === "Pause") {
    await button.click();
  }
  await expect(button).toHaveAttribute("aria-label", "Play");
}

async function expectPlayerIndex(page: Page, expected: number) {
  await expect.poll(async () => (await playerIndex(page)).index).toBe(expected);
}

async function surfaceBox(page: Page) {
  const box = await page.locator(".player-surface").boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function clickSurface(page: Page, xRatio: number, yRatio = 0.5) {
  const box = await surfaceBox(page);
  await page.mouse.click(box.x + box.width * xRatio, box.y + box.height * yRatio);
}

async function wheelOnSurface(page: Page, deltaX: number, deltaY: number) {
  const box = await surfaceBox(page);
  await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.5);
  await page.mouse.wheel(deltaX, deltaY);
}

async function desktopContext(context: BrowserContext) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: async (data) => { (window as Window & { __share?: ShareData }).__share = data; } });
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Fullscreen unavailable", "NotAllowedError"))
    });
  });
}

test("desktop frame click zones navigate once, include letterbox, and exclude controls", async ({ context, page }) => {
  await desktopContext(context);
  await openDirectPhoto(page, LANDSCAPE_PHOTO, "landscape");
  await pausePlayer(page);

  const start = await playerIndex(page);
  await clickSurface(page, 0.78);
  await expectPlayerIndex(page, start.index + 1);
  await clickSurface(page, 0.22);
  await expectPlayerIndex(page, start.index);

  await page.locator('[data-player-control="playback"]').click();
  await expectPlayerIndex(page, start.index);
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Play");

  await page.locator('[data-player-control="forward"]').click();
  await expectPlayerIndex(page, start.index + 1);

  const portrait = await openDirectPhoto(page, PORTRAIT_PHOTO, "portrait");
  await pausePlayer(page);
  const portraitStart = await playerIndex(page);
  const [stage, image] = await Promise.all([surfaceBox(page), portrait.boundingBox()]);
  expect(image).not.toBeNull();
  const letterboxX = Math.max(stage.x + 6, (stage.x + image!.x) / 2);
  await page.mouse.click(letterboxX, image!.y + image!.height / 2);
  await expectPlayerIndex(page, portraitStart.index - 1);
});

test("desktop wheel and trackpad gestures navigate without button hold and do not scroll the archive", async ({ context, page }) => {
  await desktopContext(context);
  await openDirectPhoto(page, LANDSCAPE_PHOTO, "landscape");
  await pausePlayer(page);
  await page.evaluate(() => window.scrollTo(0, 320));
  const scrollBefore = await page.evaluate(() => scrollY);
  const start = await playerIndex(page);

  await wheelOnSurface(page, 0, 110);
  await expectPlayerIndex(page, start.index + 1);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(scrollBefore);

  await page.waitForTimeout(140);
  await wheelOnSurface(page, 0, -110);
  await expectPlayerIndex(page, start.index);

  await page.waitForTimeout(140);
  await wheelOnSurface(page, 120, 0);
  await expectPlayerIndex(page, start.index + 1);

  const beforeSmallDeltas = await playerIndex(page);
  await page.waitForTimeout(460);
  await wheelOnSurface(page, 0, 30);
  await page.waitForTimeout(20);
  await expectPlayerIndex(page, beforeSmallDeltas.index);
  await wheelOnSurface(page, 0, 30);
  await page.waitForTimeout(20);
  await expectPlayerIndex(page, beforeSmallDeltas.index);
  await wheelOnSurface(page, 0, 30);
  await expectPlayerIndex(page, beforeSmallDeltas.index + 1);

  await page.waitForTimeout(140);
  const beforeLargeDelta = await playerIndex(page);
  await wheelOnSurface(page, 0, 1200);
  const afterLargeDelta = await playerIndex(page);
  expect(afterLargeDelta.index).toBeLessThanOrEqual(beforeLargeDelta.index + 1);

  await pausePlayer(page);
  const speedBox = await page.locator('[data-player-control="speed"]').boundingBox();
  expect(speedBox).not.toBeNull();
  const beforeControlWheel = await playerIndex(page);
  await page.mouse.move(speedBox!.x + speedBox!.width / 2, speedBox!.y + speedBox!.height / 2);
  await page.mouse.wheel(0, 160);
  await page.waitForTimeout(160);
  expect(await playerIndex(page)).toEqual(beforeControlWheel);
});

test("desktop frame navigation preserves deep-link controls, sharing, fullscreen fallback, and history restoration", async ({ context, page }) => {
  await desktopContext(context);
  await openDirectPhoto(page, PORTRAIT_PHOTO, "portrait");
  await pausePlayer(page);

  await page.locator('[data-player-control="speed"]').click();
  await page.getByRole("radio", { name: "0.5 seconds per photo" }).click();
  await expect(page.locator(".speed-trigger__value")).toHaveText("0.5s");

  await page.locator('[data-player-control="screen-mode"]').click();
  await expect(page.locator(".player-surface")).toHaveClass(/player-surface--expanded/);
  await page.locator('[data-player-control="screen-mode"]').click();
  await expect(page.locator(".player-surface")).toHaveClass(/player-surface--fit/);

  await clickSurface(page, 0.78);
  const currentPhoto = (await page.locator(".player-image").getAttribute("src"))?.split("/").pop()?.replace(/\.jpg$/, "");
  expect(currentPhoto).toBeTruthy();
  await page.locator('[data-player-control="share"]').click();
  const share = await page.evaluate(() => (window as Window & { __share?: ShareData }).__share);
  expect(share?.url).toContain(`year=2002&photo=${currentPhoto}`);

  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  await expect(page.locator(`[data-photo-id="${currentPhoto}"]`)).toBeFocused();

  await page.locator(`[data-photo-id="${currentPhoto}"]`).click();
  await expect(page.getByLabel("Photo player")).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByLabel("Photo player")).toBeVisible();
});
