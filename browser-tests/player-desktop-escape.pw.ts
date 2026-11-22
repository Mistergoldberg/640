import { expect, test, type Page } from "@playwright/test";
import { currentCatalogueFixture, installSyntheticMedia } from "./support/catalogue";

const fixture = currentCatalogueFixture();
const photoId = fixture.photos[0].id;

async function openPlayer(page: Page) {
  await page.goto(`/?year=${fixture.newest}&photo=${photoId}`);
  await expect(page.getByRole("dialog", { name: "Photo player" })).toBeVisible();
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-player-control="playback"]');
    if (button?.getAttribute("aria-label") === "Pause") button.click();
  });
}

async function expectAlbum(page: Page) {
  await expect(page.getByRole("dialog", { name: "Photo player" })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("photo")).toBeNull();
  await expect(page.locator(`[data-photo-id="${photoId}"]`)).toBeFocused();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
}

test.beforeEach(async ({ page }) => {
  await installSyntheticMedia(page);
  await page.addInitScript(() => localStorage.setItem("pixilation-player-onboarding-v1", "1"));
});

for (const mode of ["fit", "narrow desktop", "expanded fallback", "speed menu", "Help", "rotation"] as const) {
  test(`desktop Escape closes ${mode} player and restores the album`, async ({ page }) => {
    if (mode === "expanded fallback") await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: () => Promise.reject(new Error("Unavailable")) });
    });
    if (mode === "narrow desktop") await page.setViewportSize({ width: 1024, height: 768 });
    await openPlayer(page);
    if (mode === "expanded fallback") {
      await page.locator('[data-player-control="screen-mode"]').click();
      await expect(page.locator(".player-surface")).toHaveClass(/expanded/);
    }
    if (mode === "speed menu") await page.locator('[data-player-control="speed"]').click();
    if (mode === "Help") await page.getByRole("button", { name: "Player help", exact: true }).click();
    if (mode === "rotation") await page.locator('[data-player-control="rotation"]').click();
    await page.keyboard.press("Escape");
    await expectAlbum(page);
  });
}

test("browser-owned desktop fullscreen exit returns to the album without a page keydown", async ({ page }) => {
  await page.goto(`/?year=${fixture.newest}`);
  await page.locator(`[data-photo-id="${photoId}"]`).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  // Browsers can reserve Escape and deliver only fullscreenchange to the page.
  await page.evaluate(() => document.exitFullscreen());
  await expectAlbum(page);
  await expect.poll(() => new URL(page.url()).searchParams.get("year")).toBe(fixture.newest);
});

test("fullscreen button still resizes without closing; the next Escape closes once", async ({ page }) => {
  await openPlayer(page);
  await page.locator('[data-player-control="screen-mode"]').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.locator('[data-player-control="screen-mode"]').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await expect(page.getByRole("dialog", { name: "Photo player" })).toBeVisible();
  await expect(page.locator(".player-surface")).toHaveClass(/fit/);
  await page.keyboard.press("Escape");
  await expectAlbum(page);
});

test("Escape from native fullscreen closes the player and keeps the album history entry", async ({ page }) => {
  await page.goto(`/?year=${fixture.newest}`);
  await page.locator(`[data-photo-id="${photoId}"]`).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expectAlbum(page);
  await expect.poll(() => new URL(page.url()).searchParams.get("year")).toBe(fixture.newest);
});

test.describe("touch player", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("external fullscreen exit preserves the existing touch player behavior", async ({ page }) => {
    await openPlayer(page);
    await page.locator('[data-player-control="screen-mode"]').click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    await expect(page.getByRole("dialog", { name: "Photo player" })).toBeVisible();
  });
});
