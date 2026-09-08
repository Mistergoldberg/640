import { expect, test, type Page } from "@playwright/test";

async function waitForArchive(page: Page) {
  await expect(page.getByRole("scrollbar", { name: "Complete archive timeline" })).toBeVisible();
  await expect(page.locator(".photo-tile").first()).toBeVisible();
}

async function scrollUntilYear(page: Page, year: string, direction = 1) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await page.evaluate((delta) => window.scrollBy(0, delta), direction * 5000);
    await page.waitForTimeout(40);
    if (new URL(page.url()).searchParams.get("year") === year) return;
  }
  throw new Error(`Did not reach ${year}`);
}

async function dragArchive(page: Page, fractions: number[]) {
  const rail = page.getByRole("scrollbar", { name: "Complete archive timeline" });
  const box = await rail.boundingBox();
  if (!box) throw new Error("Archive rail is not visible");
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + 8);
  await page.mouse.down();
  for (const fraction of fractions) await page.mouse.move(x, box.y + box.height * fraction);
  await page.mouse.up();
}

test("first visit opens 2013 without fetching other years' album manifests", async ({ page }) => {
  const manifests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/albums/")) manifests.push(request.url());
  });
  await page.goto("/");
  await waitForArchive(page);

  await expect(page).toHaveURL(/year=2013/);
  await expect(page.getByRole("heading", { name: "2013" })).toBeVisible();
  expect(new Set(manifests.filter((url) => url.includes("/data/2013/"))).size).toBe(9);
  expect(manifests.some((url) => url.includes("/data/2002/") || url.includes("/data/2001/"))).toBe(false);
});

test("natural scrolling crosses 2013 to 2002 to 2001 and back with bounded DOM", async ({ page }) => {
  await page.goto("/");
  await waitForArchive(page);
  await scrollUntilYear(page, "2002");
  await expect(page).toHaveURL(/year=2002/);
  await scrollUntilYear(page, "2001");
  await expect(page).toHaveURL(/year=2001/);
  await scrollUntilYear(page, "2013", -1);
  await expect(page).toHaveURL(/year=2013/);
  expect(await page.locator(".photo-row,.photo-mosaic").count()).toBeLessThan(60);
  expect(await page.locator(".photo-tile").count()).toBeLessThan(500);
});

test("fast scrolling keeps a populated, prefetched window on desktop and mobile", async ({ browser }) => {
  for (const contextOptions of [
    { viewport: { width: 1440, height: 900 } },
    { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
  ]) {
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.goto("/");
    await waitForArchive(page);
    await expect.poll(() => page.locator(".photo-tile img").evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0)), { timeout: 20_000 }).toBe(true);

    for (const delta of [1200, 1200, 1200]) {
      const coverage = await page.evaluate(async (amount) => {
        window.scrollBy(0, amount);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const visible = [...document.querySelectorAll<HTMLImageElement>(".photo-tile img")].filter((image) => {
          const rect = image.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < innerHeight;
        });
        return {
          count: visible.length,
          ready: visible.filter((image) => image.complete && image.naturalWidth > 0).length
        };
      }, delta);
      expect(coverage.count).toBeGreaterThan(0);
      expect(coverage.ready).toBe(coverage.count);
    }

    const coverageAfterJump = await page.evaluate(async () => {
      window.scrollBy(0, 5000);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return [...document.querySelectorAll(".photo-tile")].filter((tile) => {
        const rect = tile.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight;
      }).length;
    });
    expect(coverageAfterJump).toBeGreaterThan(0);
    expect(await page.locator(".photo-tile").count()).toBeLessThan(500);
    await context.close();
  }
});

test("iOS Safari and Chrome keep loaded archive rows mounted while WebKit scrolls", async ({ browser }) => {
  const userAgents = [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1"
  ];

  for (const userAgent of userAgents) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      screen: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent
    });
    const page = await context.newPage();
    await page.goto("/");
    await waitForArchive(page);
    await expect(page.locator(".collection-shell")).toHaveAttribute("data-render-mode", "stable");
    await expect(page.locator(".photo-tile")).toHaveCount(4213);
    await expect(page.locator(".photo-tile img").first()).toHaveAttribute("loading", "lazy");

    const coverage = await page.evaluate(() => {
      window.scrollBy(0, 5000);
      return [...document.querySelectorAll(".photo-tile")].filter((tile) => {
        const rect = tile.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight;
      }).length;
    });
    expect(coverage).toBeGreaterThan(0);
    await expect.poll(() => page.locator(".photo-tile img").evaluateAll((images) => images.filter((image) => {
      const rect = image.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight && image.complete && image.naturalWidth > 0;
    }).length), { timeout: 20_000 }).toBeGreaterThan(0);
    await context.close();
  }
});

test("iOS stable rendering remains usable after every archive year is loaded", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1"
  });
  const page = await context.newPage();
  await page.goto("/");
  await waitForArchive(page);
  await page.getByRole("button", { name: "Jump to 2001" }).click();
  await expect(page).toHaveURL(/year=2001/);
  await expect(page.locator(".photo-tile")).toHaveCount(4213 + 6669, { timeout: 20_000 });
  await page.getByRole("button", { name: "Jump to 2002" }).click();
  await expect(page).toHaveURL(/year=2002/);
  await expect(page.locator(".photo-tile")).toHaveCount(4213 + 479 + 6669, { timeout: 20_000 });
  await expect(page.locator(".photo-tile:visible").first()).toBeVisible();
  await page.getByRole("button", { name: "Jump to 2013" }).click();
  await expect(page).toHaveURL(/year=2013/);
  await expect(page.getByRole("heading", { name: "2013", exact: true })).toBeVisible();
  await context.close();
});

test("one gesture reaches an unloaded year, reverse scrub returns, and rapid movement prioritizes the final year", async ({ page }) => {
  const manifests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/albums/")) manifests.push(request.url());
  });
  await page.goto("/");
  await waitForArchive(page);
  await dragArchive(page, [0.18, 0.44, 0.7, 0.94]);
  await expect(page).toHaveURL(/year=2001/);
  await expect(page.locator(".photo-tile").first()).toBeVisible();
  expect(new Set(manifests.filter((url) => url.includes("/data/2001/"))).size).toBe(3);
  expect(manifests.some((url) => url.includes("/data/2002/"))).toBe(false);

  const rail = page.getByRole("scrollbar", { name: "Complete archive timeline" });
  const box = await rail.boundingBox();
  if (!box) throw new Error("Archive rail is not visible");
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height * 0.94);
  await page.mouse.down();
  for (const fraction of [0.72, 0.45, 0.2, 0.01]) await page.mouse.move(x, box.y + box.height * fraction);
  await page.mouse.up();
  await expect(page).toHaveURL(/year=2013/);
});

test("a failed album stays isolated and retries in place", async ({ page }) => {
  let shouldFail = true;
  await page.route("**/data/2002/albums/2002-thialand-0a8e8616.json", async (route) => {
    if (shouldFail) {
      shouldFail = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    } else {
      await route.continue();
    }
  });
  await page.goto("/?year=2002");
  await expect(page.locator(".album-error:not(.album-error--loading)")).toBeVisible();
  expect(await page.locator(".photo-tile").count()).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".album-error")).toHaveCount(0);
  expect(await page.locator(".photo-tile").count()).toBeGreaterThan(0);
});

test("direct year and photo URLs, Back/Forward, and player return preserve stable locations", async ({ page }) => {
  await page.goto("/?year=2001");
  await waitForArchive(page);
  await expect(page).toHaveURL(/year=2001/);
  await expect(page.getByRole("heading", { name: "2001" })).toBeVisible();

  await page.goto("/?year=2013");
  await waitForArchive(page);
  await page.getByRole("button", { name: "Jump to 2001" }).click();
  await expect(page).toHaveURL(/year=2001/);
  await page.goBack();
  await expect(page).toHaveURL(/year=2013/);
  await page.goForward();
  await expect(page).toHaveURL(/year=2001/);

  const photoId = "2001-b41561bec02ff5";
  await page.goto(`/?year=2001&photo=${photoId}`);
  await expect(page.getByLabel("Photo player")).toBeVisible();
  await expect(page.locator(".player-counter")).toContainText("/ 6669");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  await expect(page).toHaveURL(/year=2001/);
  await expect(page.locator(`[data-photo-id="${photoId}"]`)).toBeFocused();
});

test("keyboard anchors cover albums and archive endpoints", async ({ page }) => {
  await page.goto("/");
  await waitForArchive(page);
  const rail = page.getByRole("scrollbar", { name: "Complete archive timeline" });
  await rail.focus();
  await rail.press("ArrowDown");
  await expect(rail).toHaveAttribute("aria-valuetext", /2013/);
  await rail.press("PageDown");
  await expect(page).toHaveURL(/year=2002/);
  await rail.press("End");
  await expect(page).toHaveURL(/year=2001/);
  await rail.press("Home");
  await expect(page).toHaveURL(/year=2013/);
});

test("mobile portrait and landscape keep a bounded label, wide hitbox, and clean pointer cancellation", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto("/");
  await waitForArchive(page);
  const rail = page.getByRole("scrollbar", { name: "Complete archive timeline" });
  expect((await rail.boundingBox())?.width).toBeGreaterThanOrEqual(60);
  const box = await rail.boundingBox();
  if (!box) throw new Error("Archive rail is not visible");
  await page.mouse.move(box.x + box.width - 6, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 6, box.y + box.height * 0.72);
  await expect(page.locator(".archive-timeline")).toHaveClass(/is-dragging/);
  const label = await page.locator(".archive-timeline__label").boundingBox();
  expect(label?.x).toBeGreaterThanOrEqual(0);
  expect((label?.x || 0) + (label?.width || 0)).toBeLessThanOrEqual(390);
  await rail.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse", clientX: box.x, clientY: box.y });
  await expect(page.locator(".archive-timeline")).not.toHaveClass(/is-dragging/);
  await page.mouse.up();

  await page.setViewportSize({ width: 844, height: 390 });
  expect((await rail.boundingBox())?.width).toBeGreaterThanOrEqual(60);
  await context.close();
});
