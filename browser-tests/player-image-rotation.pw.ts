import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import sharp from "sharp";

const LANDSCAPE_PHOTO = "2002-5d0aaeea05b95f";
const NEXT_LANDSCAPE_PHOTO = "2002-51119fe34ac289";
const PORTRAIT_PHOTO = "2002-fd741068e43907";
const ONBOARDING_KEY = "pixilation-player-onboarding-v1";
const LOCAL_TEST_IMAGE = await sharp({
  create: { width: 640, height: 480, channels: 3, background: "#773344" }
}).jpeg().toBuffer();

async function useLocalPlayerMedia(page: Page) {
  await page.route("https://media.pixilation.org/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/jpeg",
    body: LOCAL_TEST_IMAGE
  }));
}

async function installFullscreenFallback(context: BrowserContext) {
  await context.addInitScript(() => {
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Fullscreen unavailable", "NotAllowedError"))
    });
  });
}

async function openDirectPhoto(page: Page, photoId: string, orientation: "portrait" | "landscape") {
  await page.goto(`/?year=2002&photo=${photoId}`);
  const player = page.getByLabel("Photo player");
  await expect(player).toBeVisible({ timeout: 20_000 });
  const image = page.locator(`.player-image--${orientation}:not(.player-image--incoming)`).first();
  await expect.poll(
    () => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
    { timeout: 20_000 }
  ).toBe(true);
  return image;
}

async function playPlayer(page: Page) {
  const playback = page.locator('[data-player-control="playback"]');
  if (await playback.getAttribute("aria-label") === "Play") await playback.click();
  await expect(playback).toHaveAttribute("aria-label", "Pause");
}

async function pausePlayer(page: Page) {
  await playPlayer(page);
  await page.locator('[data-player-control="playback"]').click();
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Play");
}

async function openRotationMode(page: Page) {
  const toggle = page.locator('[data-player-control="rotation"]');
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Photo rotation controls" })).toBeVisible();
}

async function expectRotation(page: Page, rotation: 0 | 90 | 180 | 270) {
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-current-rotation", String(rotation));
  await expect(page.locator(".player-image:not(.player-image--incoming)").first())
    .toHaveAttribute("data-player-image-rotation", String(rotation));
}

async function playerIndex(page: Page) {
  const match = (await page.locator(".player-counter").textContent())?.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) throw new Error("Player counter is unavailable");
  return Number(match[1]);
}

async function expectFitContainment(page: Page) {
  const [stage, image] = await Promise.all([
    page.locator(".player-media-stage").boundingBox(),
    page.locator(".player-image:not(.player-image--incoming)").first().boundingBox()
  ]);
  expect(stage).not.toBeNull();
  expect(image).not.toBeNull();
  expect(image!.x).toBeGreaterThanOrEqual(stage!.x - 1);
  expect(image!.y).toBeGreaterThanOrEqual(stage!.y - 1);
  expect(image!.x + image!.width).toBeLessThanOrEqual(stage!.x + stage!.width + 1);
  expect(image!.y + image!.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);
}

test("rotation mode pauses, rotates once per keyboard activation, and respects menus, Help, and Escape", async ({ context, page }) => {
  await installFullscreenFallback(context);
  await useLocalPlayerMedia(page);
  const image = await openDirectPhoto(page, LANDSCAPE_PHOTO, "landscape");
  await playPlayer(page);
  const startIndex = await playerIndex(page);

  await openRotationMode(page);
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Play");
  const counterclockwise = page.getByRole("button", { name: "Rotate photo counterclockwise 90 degrees" });
  const clockwise = page.getByRole("button", { name: "Rotate photo clockwise 90 degrees" });
  await expect(counterclockwise).toBeFocused();
  await expect(page.getByText("Rotate photo", { exact: true })).toBeVisible();

  for (const rotation of [90, 180, 270, 0] as const) {
    await clockwise.click();
    await expectRotation(page, rotation);
  }

  await counterclockwise.focus();
  await page.keyboard.press("Space");
  await expectRotation(page, 270);
  expect(await playerIndex(page)).toBe(startIndex);
  await expect(image).toHaveCSS("transform", /matrix/);
  expect(await page.evaluate((key) => localStorage.getItem(key), ONBOARDING_KEY)).toBeNull();

  await page.locator('[data-player-control="speed"]').click();
  await expect(page.getByRole("group", { name: "Photo rotation controls" })).toHaveCount(0);
  await expect(page.getByRole("radiogroup", { name: "Playback speed" })).toBeVisible();
  await openRotationMode(page);
  await expect(page.getByRole("radiogroup", { name: "Playback speed" })).toHaveCount(0);

  await page.keyboard.press("Escape");
  const rotationToggle = page.locator('[data-player-control="rotation"]');
  await expect(page.getByRole("group", { name: "Photo rotation controls" })).toHaveCount(0);
  await expect(rotationToggle).toBeFocused();
  await expect(page.getByLabel("Photo player")).toBeVisible();
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Play");

  await openRotationMode(page);
  await page.locator('[data-player-control="playback"]').click();
  await expect(page.getByRole("group", { name: "Photo rotation controls" })).toHaveCount(0);
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Pause");
  await page.locator('[data-player-control="playback"]').click();
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Play");

  await openRotationMode(page);
  await page.getByRole("button", { name: "Player help" }).click();
  await expect(page.getByRole("group", { name: "Photo rotation controls" })).toHaveCount(0);
  await expect(page.locator(".player-onboarding")).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), ONBOARDING_KEY)).toBeNull();
});

test("rotations remain photo-specific through a decode-safe swap and reset when the player closes", async ({ context, page }) => {
  await installFullscreenFallback(context);
  await useLocalPlayerMedia(page);
  let releaseSlowImage: () => void = () => {};
  const slowImage = new Promise<void>((resolve) => { releaseSlowImage = resolve; });
  await page.route(`**/2002/display/${NEXT_LANDSCAPE_PHOTO}.jpg`, async (route) => {
    await slowImage;
    await route.fallback();
  });

  try {
    await openDirectPhoto(page, LANDSCAPE_PHOTO, "landscape");
    await pausePlayer(page);
    await openRotationMode(page);
    await page.getByRole("button", { name: "Rotate photo clockwise 90 degrees" }).click();
    await expectRotation(page, 90);

    await page.locator('[data-player-control="forward"]').click();
    await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-current-rotation", "0");
    const outgoing = page.locator(`.player-image[data-player-photo-id="${LANDSCAPE_PHOTO}"]:not(.player-image--incoming)`);
    const incoming = page.locator(`.player-image--incoming[data-player-photo-id="${NEXT_LANDSCAPE_PHOTO}"]`);
    await expect(outgoing).toHaveAttribute("data-player-image-rotation", "90");
    await expect(outgoing).toHaveCSS("transform", /matrix/);
    await expect(incoming).toHaveAttribute("data-player-image-rotation", "0");
    await expect(page.getByRole("button", { name: "Rotate photo clockwise 90 degrees" })).toBeDisabled();

    releaseSlowImage();
    await expect(incoming).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator(".player-image:not(.player-image--incoming)").first())
      .toHaveAttribute("data-player-photo-id", NEXT_LANDSCAPE_PHOTO);
    await page.getByRole("button", { name: "Rotate photo counterclockwise 90 degrees" }).click();
    await expectRotation(page, 270);

    await page.locator('[data-player-control="back"]').click();
    await expect(page.locator(".player-image:not(.player-image--incoming)").first())
      .toHaveAttribute("data-player-photo-id", LANDSCAPE_PHOTO);
    await expectRotation(page, 90);

    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByLabel("Photo player")).toHaveCount(0);
    await openDirectPhoto(page, LANDSCAPE_PHOTO, "landscape");
    await expectRotation(page, 0);
  } finally {
    releaseSlowImage();
  }
});

test("touch, reduced motion, expanded mode, and orientation changes preserve intentional rotation state", async ({ browser }) => {
  const viewport = { width: 390, height: 844 };
  const context = await browser.newContext({ viewport, screen: viewport, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  await installFullscreenFallback(context);
  const page = await context.newPage();
  await useLocalPlayerMedia(page);
  await openDirectPhoto(page, PORTRAIT_PHOTO, "portrait");
  await pausePlayer(page);
  const startIndex = await playerIndex(page);
  await openRotationMode(page);

  const clockwise = page.getByRole("button", { name: "Rotate photo clockwise 90 degrees" });
  const buttonBox = await clockwise.boundingBox();
  expect(buttonBox).not.toBeNull();
  await page.touchscreen.tap(buttonBox!.x + buttonBox!.width / 2, buttonBox!.y + buttonBox!.height / 2);
  await expectRotation(page, 90);
  expect(await playerIndex(page)).toBe(startIndex);
  await page.waitForTimeout(2_000);
  await expect(page.getByLabel("Photo player")).toHaveClass(/has-visible-controls/);

  await page.locator('[data-player-control="screen-mode"]').click();
  await expect(page.locator(".player-surface")).toHaveClass(/player-surface--expanded/);
  await expect(page.getByRole("group", { name: "Photo rotation controls" })).toBeVisible();
  await expectRotation(page, 90);

  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-layout", "mobile-landscape-rail");
  await expect(page.getByRole("group", { name: "Photo rotation controls" })).toBeVisible();
  await expectRotation(page, 90);

  await page.locator('[data-player-control="rotation"]').click();
  await expect(page.getByRole("group", { name: "Photo rotation controls" })).toHaveCount(0);
  await expect(page.locator('[data-player-control="playback"]')).toHaveAttribute("aria-label", "Play");
  await page.locator(".player-surface").click({ position: { x: 420, y: 190 } });
  await page.waitForTimeout(2_000);
  await expect(page.getByLabel("Photo player")).not.toHaveClass(/has-visible-controls/);
  await context.close();
});

test("rotation controls integrate at all target layouts with fit and expanded screenshots", async ({ browser }, testInfo) => {
  const samples = [
    { name: "desktop-landscape-fit", viewport: { width: 1440, height: 900 }, photo: LANDSCAPE_PHOTO, orientation: "landscape" as const, mobile: false, expanded: false },
    { name: "desktop-portrait-expanded", viewport: { width: 1440, height: 900 }, photo: PORTRAIT_PHOTO, orientation: "portrait" as const, mobile: false, expanded: true },
    { name: "mobile-portrait-fit", viewport: { width: 390, height: 844 }, photo: PORTRAIT_PHOTO, orientation: "portrait" as const, mobile: true, expanded: false },
    { name: "mobile-landscape-fit", viewport: { width: 844, height: 390 }, photo: LANDSCAPE_PHOTO, orientation: "landscape" as const, mobile: true, expanded: false },
    { name: "compact-landscape-fit", viewport: { width: 667, height: 320 }, photo: PORTRAIT_PHOTO, orientation: "portrait" as const, mobile: true, expanded: false }
  ];

  for (const sample of samples) {
    const context = await browser.newContext({
      viewport: sample.viewport,
      screen: sample.viewport,
      isMobile: sample.mobile,
      hasTouch: sample.mobile
    });
    await installFullscreenFallback(context);
    const page = await context.newPage();
    await openDirectPhoto(page, sample.photo, sample.orientation);
    await pausePlayer(page);
    await openRotationMode(page);
    await page.getByRole("button", { name: "Rotate photo clockwise 90 degrees" }).click();
    if (sample.expanded) {
      await page.locator('[data-player-control="screen-mode"]').click();
      await expect(page.locator(".player-surface")).toHaveClass(/player-surface--expanded/);
    } else {
      await expectFitContainment(page);
    }

    const toolbarButtons = page.locator('.player-controls > [data-player-control]:visible');
    const boxes = await toolbarButtons.evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
    expect(boxes).toHaveLength(sample.viewport.height < sample.viewport.width && sample.mobile ? 7 : 8);
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(sample.viewport.width);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(sample.viewport.height);
    }

    const rotationButtons = page.locator(".player-rotation-controls button");
    await expect(rotationButtons).toHaveCount(2);
    for (const button of await rotationButtons.all()) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(sample.viewport.width);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(sample.viewport.height);
    }

    await page.screenshot({ path: testInfo.outputPath(`${sample.name}.png`), fullPage: false });
    await context.close();
  }
});
