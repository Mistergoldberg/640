import { expect, test, type Browser, type Page } from "@playwright/test";

async function waitForYear(page: Page, year: string) {
  await expect(page.locator(`.collection-shell[data-active-year="${year}"][data-mounted-years="${year}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".photo-tile").first()).toBeVisible({ timeout: 20_000 });
}

async function installHistoryCounters(page: Page) {
  await page.addInitScript(() => {
    const state = window as typeof window & { __historyWrites: { push: number; replace: number } };
    state.__historyWrites = { push: 0, replace: 0 };
    const push = history.pushState.bind(history);
    const replace = history.replaceState.bind(history);
    history.pushState = (...args) => {
      state.__historyWrites.push += 1;
      return push(...args);
    };
    history.replaceState = (...args) => {
      state.__historyWrites.replace += 1;
      return replace(...args);
    };
  });
}

async function resetHistoryCounters(page: Page) {
  await page.evaluate(() => {
    (window as typeof window & { __historyWrites: { push: number; replace: number } }).__historyWrites = { push: 0, replace: 0 };
  });
}

async function dragTo(page: Page, ratio: number, hold = false) {
  const rail = page.getByRole("slider", { name: "Complete archive timeline" });
  const box = await rail.boundingBox();
  if (!box) throw new Error("Archive rail is not visible");
  const x = box.x + box.width - 10;
  await page.mouse.move(x, box.y + 14);
  await page.mouse.down();
  await page.mouse.move(x, box.y + box.height * ratio);
  if (!hold) await page.mouse.up();
}

async function assertScrubberGeometry(page: Page) {
  const rail = page.getByRole("slider", { name: "Complete archive timeline" });
  const thumb = page.locator(".archive-timeline__thumb");
  const content = page.locator("#photo-grid");
  const [railBox, thumbBox, contentBox] = await Promise.all([rail.boundingBox(), thumb.boundingBox(), content.boundingBox()]);
  expect(railBox).not.toBeNull();
  expect(thumbBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(railBox!.width).toBeGreaterThanOrEqual(44);
  expect(railBox!.height).toBeGreaterThanOrEqual(44);
  expect(thumbBox!.width).toBeGreaterThanOrEqual(16);
  expect(thumbBox!.width).toBeLessThanOrEqual(20);
  expect(thumbBox!.x).toBeGreaterThanOrEqual(0);
  expect(thumbBox!.x + thumbBox!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  expect(thumbBox!.y).toBeGreaterThanOrEqual(0);
  expect(thumbBox!.y + thumbBox!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
  expect(thumbBox!.x).toBeGreaterThanOrEqual(contentBox!.x + contentBox!.width);
  expect(await rail.evaluate((element) => getComputedStyle(element).touchAction)).toBe("none");
  expect(await content.evaluate((element) => getComputedStyle(element).touchAction)).not.toBe("none");
}

async function contextPage(browser: Browser, viewport: { width: number; height: number }, mobile = false) {
  const context = await browser.newContext({ viewport, screen: viewport, isMobile: mobile, hasTouch: mobile });
  return { context, page: await context.newPage() };
}

test("scrubber rail, touch target, thumb, and hover label stay bounded", async ({ browser }) => {
  for (const [viewport, mobile] of [
    [{ width: 1440, height: 900 }, false],
    [{ width: 390, height: 844 }, true],
    [{ width: 844, height: 390 }, true],
    [{ width: 320, height: 568 }, true]
  ] as const) {
    const { context, page } = await contextPage(browser, viewport, mobile);
    await page.goto("/");
    await waitForYear(page, "2013");
    await assertScrubberGeometry(page);
    const rail = page.getByRole("slider", { name: "Complete archive timeline" });
    const box = await rail.boundingBox();
    await page.mouse.move(box!.x + box!.width - 10, box!.y + box!.height * 0.96);
    const label = page.locator(".archive-timeline__label");
    if (!mobile) await expect(label).toBeVisible();
    if (!mobile) {
      const labelBox = await label.boundingBox();
      expect(labelBox!.x).toBeGreaterThanOrEqual(0);
      expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(viewport.width);
      expect(labelBox!.y).toBeGreaterThanOrEqual(0);
      expect(labelBox!.y + labelBox!.height).toBeLessThanOrEqual(viewport.height);
      await expect(label).toContainText(/2001-/);
    }
    await context.close();
  }
});

test("drag preview is local and release creates one navigation entry", async ({ page }) => {
  await installHistoryCounters(page);
  const albumRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/albums/")) albumRequests.push(request.url());
  });
  await page.goto("/");
  await waitForYear(page, "2013");
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-restoration-phase", "settled");
  await expect.poll(() => page.evaluate(() => history.state?.restoration?.photoId || null)).not.toBeNull();
  await resetHistoryCounters(page);
  albumRequests.length = 0;
  await dragTo(page, 0.96, true);
  await expect(page.locator(".archive-timeline")).toHaveClass(/is-dragging/);
  await expect(page.locator(".archive-timeline__label")).toContainText(/2001-/);
  await expect(page).toHaveURL(/year=2013/);
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-mounted-years", "2013");
  expect(albumRequests.some((url) => url.includes("/data/2001/"))).toBe(false);
  expect(await page.evaluate(() => (window as typeof window & { __historyWrites: { push: number; replace: number } }).__historyWrites)).toEqual({ push: 0, replace: 0 });
  await page.mouse.up();
  await waitForYear(page, "2001");
  expect(await page.evaluate(() => (window as typeof window & { __historyWrites: { push: number } }).__historyWrites.push)).toBe(1);
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-mounted-years", "2001");
  expect(await page.locator("[data-year='2013'] .photo-tile").count()).toBe(0);
});

test("pointer cancellation ends the preview without navigation", async ({ page }) => {
  await installHistoryCounters(page);
  await page.goto("/");
  await waitForYear(page, "2013");
  await resetHistoryCounters(page);
  await dragTo(page, 0.96, true);
  await page.getByRole("slider", { name: "Complete archive timeline" }).dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse", isPrimary: true });
  await page.mouse.up();
  await expect(page.locator(".archive-timeline")).not.toHaveClass(/is-dragging/);
  await expect(page.locator(".archive-timeline__label")).toHaveCount(0);
  await expect(page).toHaveURL(/year=2013/);
  expect(await page.evaluate(() => (window as typeof window & { __historyWrites: { push: number } }).__historyWrites.push)).toBe(0);
});

test("passive scrolling moves the thumb without history and page scrolling works outside the rail", async ({ page }) => {
  await installHistoryCounters(page);
  await page.goto("/");
  await waitForYear(page, "2013");
  await resetHistoryCounters(page);
  const thumb = page.locator(".archive-timeline__thumb");
  const before = await thumb.boundingBox();
  await page.mouse.move(100, 400);
  await page.mouse.wheel(0, 30_000);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(10_000);
  await expect.poll(async () => (await thumb.boundingBox())?.y || 0).toBeGreaterThan(before!.y + 2);
  expect(await page.evaluate(() => (window as typeof window & { __historyWrites: { push: number } }).__historyWrites.push)).toBe(0);
  await expect(page).toHaveURL(/year=2013/);
});

test("keyboard reaches the small middle year and both archive endpoints", async ({ page }) => {
  await page.goto("/");
  await waitForYear(page, "2013");
  const rail = page.getByRole("slider", { name: "Complete archive timeline" });
  await rail.focus();
  await rail.press("PageDown");
  await waitForYear(page, "2002");
  await rail.press("End");
  await waitForYear(page, "2001");
  await rail.press("Home");
  await waitForYear(page, "2013");
});

test("portrait and landscape drag labels remain inside the viewport", async ({ browser }) => {
  const { context, page } = await contextPage(browser, { width: 390, height: 844 }, true);
  await page.goto("/");
  await waitForYear(page, "2013");
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await dragTo(page, 0.96, true);
    const labelBox = await page.locator(".archive-timeline__label").boundingBox();
    expect(labelBox).not.toBeNull();
    expect(labelBox!.x).toBeGreaterThanOrEqual(0);
    expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(viewport.width);
    expect(labelBox!.y).toBeGreaterThanOrEqual(0);
    expect(labelBox!.y + labelBox!.height).toBeLessThanOrEqual(viewport.height);
    await page.getByRole("slider", { name: "Complete archive timeline" }).dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse", isPrimary: true });
    await page.mouse.up();
    await expect(page).toHaveURL(/year=2013/);
  }
  await context.close();
});

test("orientation change cancels an active drag without changing the year or anchor", async ({ browser }) => {
  const { context, page } = await contextPage(browser, { width: 390, height: 844 }, true);
  await page.goto("/?year=2013");
  await waitForYear(page, "2013");
  await expect.poll(() => page.evaluate(() => history.state?.restoration?.photoId || null)).not.toBeNull();
  const anchor = await page.evaluate(() => history.state.restoration.photoId as string);
  await dragTo(page, 0.96, true);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator(".archive-timeline")).not.toHaveClass(/is-dragging/);
  await page.mouse.up();
  await expect(page).toHaveURL(/year=2013/);
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-mounted-years", "2013");
  expect(await page.evaluate(() => history.state.restoration.photoId)).toBe(anchor);
  await context.close();
});
