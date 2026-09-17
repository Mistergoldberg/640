import { expect, test } from "@playwright/test";

const enabled = process.env.VITE_HOMEPAGE_AUTOPLAYER === "1";
test.skip(!enabled, "homepage autoplay tests require VITE_HOMEPAGE_AUTOPLAYER=1");

test("clean homepage and cache-busting entry autoplay without pushing history", async ({ page }) => {
  for (const path of ["/", "/?v=autoplay-test"]) {
    await page.goto(path);
    const historyLength = await page.evaluate(() => history.length);
    await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".player-image")).toHaveAttribute("src", /2013-/);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    expect(new URL(page.url()).searchParams.has("photo")).toBe(false);
  }
});

test("explicit archive, direct-photo, and debug entries do not autoplay", async ({ page }) => {
  await page.goto("/?year=2002");
  await expect(page.locator('.collection-shell[data-active-year="2002"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Photo player")).toHaveCount(0);

  await page.goto("/?debug=1");
  await expect(page.locator(".collection-shell")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Photo player")).toHaveCount(0);

  await page.goto("/?year=2013&photo=2013-4651b733c14c76");
  await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-warmup-phase", "inactive");
});

test("closing suppresses reopen for the document and reload restores eligibility", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("photo")).toBe(false);

  await page.reload();
  await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 30_000 });
});

test("the homepage player keeps mobile portrait and landscape layouts", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-layout", "standard", { timeout: 30_000 });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-layout", "mobile-landscape-rail");
  await context.close();
});

test("startup and steady playback remain resource bounded", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 30_000 });
  const peak = { pending: 0, decoded: 0, cache: 0, images: 0, dom: 0, heap: 0 };
  for (let sample = 0; sample < 50; sample += 1) {
    const current = await page.evaluate(() => {
      const player = document.querySelector<HTMLElement>('[aria-label="Photo player"]');
      const memory = performance as Performance & { memory?: { usedJSHeapSize: number } };
      return {
        pending: Number(player?.dataset.playerPendingImages || 0),
        decoded: Number(player?.dataset.playerDecodedImages || 0),
        cache: Number(player?.dataset.playerCacheEntries || 0),
        images: document.images.length,
        dom: document.getElementsByTagName("*").length,
        heap: memory.memory?.usedJSHeapSize || 0
      };
    });
    for (const key of Object.keys(peak) as Array<keyof typeof peak>) peak[key] = Math.max(peak[key], current[key]);
    await page.waitForTimeout(100);
  }
  console.log(JSON.stringify({ homepageAutoplayerPeak: peak }));
  expect(peak.pending).toBeLessThanOrEqual(45);
  expect(peak.cache).toBeLessThanOrEqual(51);
  expect(peak.images).toBeLessThanOrEqual(80);
});
