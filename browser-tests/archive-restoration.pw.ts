import { expect, test, type Page } from "@playwright/test";

const LEGACY_SCROLL_Y = 165736;
const PHOTO_2001 = "2001-b41561bec02ff5";

async function afterLayoutFrames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function monitorScrollPosition(page: Page) {
  await page.addInitScript(() => {
    const target = window as typeof window & { __archiveMaxScrollY?: number };
    target.__archiveMaxScrollY = scrollY;
    addEventListener("scroll", () => {
      target.__archiveMaxScrollY = Math.max(target.__archiveMaxScrollY || 0, scrollY);
    }, { passive: true });
  });
}

async function expectNoLargeJump(page: Page) {
  expect(await page.evaluate(() => (window as typeof window & { __archiveMaxScrollY?: number }).__archiveMaxScrollY || 0)).toBeLessThanOrEqual(240);
}

async function waitForRestoration(page: Page, phase: "settled" | "cancelled" = "settled") {
  await expect(page.locator(`.collection-shell[data-restoration-phase="${phase}"]`)).toBeVisible({ timeout: 20_000 });
  await afterLayoutFrames(page);
}

async function visiblePhotoIds(page: Page) {
  return page.locator(".photo-tile").evaluateAll((tiles) => tiles
    .filter((tile) => {
      const rect = tile.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight;
    })
    .map((tile) => (tile as HTMLElement).dataset.photoId || ""));
}

async function expectRootAt2013(page: Page) {
  await waitForRestoration(page);
  await expect(page.getByRole("heading", { name: "2013", exact: true })).toBeVisible();
  await expect(page.locator(".app-bar__year")).toHaveText("2013");
  await expect(page).toHaveURL(/year=2013/);
  expect(await page.evaluate(() => scrollY)).toBeLessThanOrEqual(240);
  const photos = await visiblePhotoIds(page);
  expect(photos.length).toBeGreaterThan(0);
  expect(photos.every((id) => id.startsWith("2013-"))).toBe(true);
}

async function scrollWithinYear(page: Page, year: string, amount = 9000) {
  await page.evaluate((delta) => window.scrollBy(0, delta), amount);
  await expect(page).toHaveURL(new RegExp(`year=${year}`));
  await expect.poll(() => page.evaluate(() => window.history.state?.restoration?.photoId || null)).not.toBeNull();
  await afterLayoutFrames(page);
}

test("empty-state first visit to root stays at the newest inline heading", async ({ page }) => {
  await monitorScrollPosition(page);
  await page.goto("/");
  expect(await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.type)).toBe("navigate");
  expect(await page.evaluate(() => history.scrollRestoration)).toBe("manual");
  await expectRootAt2013(page);
  await expectNoLargeJump(page);
});

test("legacy storage with a 165736 pixel offset is rejected", async ({ context, page }) => {
  await monitorScrollPosition(page);
  await context.addInitScript((legacyY) => {
    if (location.hostname !== "127.0.0.1") return;
    sessionStorage.setItem("640x480-scroll:2013", String(legacyY));
    sessionStorage.setItem("640x480-anchor:2013", JSON.stringify({ year: "2013", scrollY: legacyY }));
  }, LEGACY_SCROLL_Y);
  await page.goto("/");
  await expectRootAt2013(page);
  await expectNoLargeJump(page);
  expect(await page.evaluate(() => sessionStorage.getItem("640x480-scroll:2013"))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("640x480-anchor:2013"))).toBeNull();
});

test("legacy selected-year state cannot override a new root navigation", async ({ context, page }) => {
  await monitorScrollPosition(page);
  await context.addInitScript(() => {
    if (location.hostname !== "127.0.0.1") return;
    localStorage.setItem("640x480-selected-year", "2001");
  });
  await page.goto("/");
  await expectRootAt2013(page);
  await expectNoLargeJump(page);
  expect(await page.evaluate(() => localStorage.getItem("640x480-selected-year"))).toBeNull();
});

test("explicit 2013 URL wins over unrelated current-schema history", async ({ page }) => {
  await page.goto("/?year=2001");
  await waitForRestoration(page);
  await page.evaluate(() => history.replaceState(history.state, "", "/?year=2013"));
  await page.reload();
  await expectRootAt2013(page);
  expect(await page.evaluate(() => history.state.restoration.schema)).toBe("year-window-archive-v1");
});

test("explicit 2001 URL loads and positions its year heading", async ({ page }) => {
  await page.goto("/?year=2001");
  await waitForRestoration(page);
  await expect(page.getByRole("heading", { name: "2001", exact: true })).toBeVisible();
  await expect(page.locator(".app-bar__year")).toHaveText("2001");
  expect((await visiblePhotoIds(page)).every((id) => id.startsWith("2001-"))).toBe(true);
});

test("reload deep inside 2001 restores the current-schema stable anchor", async ({ page }) => {
  await page.goto("/?year=2001");
  await waitForRestoration(page);
  await scrollWithinYear(page, "2001");
  const before = await page.evaluate(() => ({ y: scrollY, anchor: history.state.restoration }));
  expect(before.anchor.schema).toBe("year-window-archive-v1");
  expect(Math.abs(before.anchor.adjustmentPx)).toBeLessThanOrEqual(160);
  await page.reload();
  await waitForRestoration(page);
  const after = await page.evaluate(() => ({ y: scrollY, anchor: history.state.restoration }));
  expect(after.anchor.entryId).toBe(before.anchor.entryId);
  expect(after.anchor.photoId).toBe(before.anchor.photoId);
  expect(Math.abs(after.y - before.y)).toBeLessThan(500);
  expect((await visiblePhotoIds(page)).every((id) => id.startsWith("2001-"))).toBe(true);
});

test("Back and Forward restore the stable anchor for each history entry", async ({ page }) => {
  await page.goto("/");
  await expectRootAt2013(page);
  await page.getByRole("button", { name: "Jump to 2001" }).click();
  await expect(page).toHaveURL(/year=2001/);
  await expect(page.locator(".app-bar__year")).toHaveText("2001");
  const entry2001 = await page.evaluate(() => history.state.entryId);
  await page.goBack();
  await expect(page).toHaveURL(/year=2013/);
  await waitForRestoration(page);
  await expect(page.getByRole("heading", { name: "2013", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/year=2001/);
  await waitForRestoration(page);
  expect(await page.evaluate(() => history.state.entryId)).toBe(entry2001);
  await expect(page.locator(".app-bar__year")).toHaveText("2001");
  await page.goto("/?year=2013");
  await waitForRestoration(page);
  await page.goBack();
  await expect(page).toHaveURL(/year=2001/);
  await waitForRestoration(page);
  expect(await page.evaluate(() => history.state.entryId)).toBe(entry2001);
});

test("direct photo URL owns the underlying archive position", async ({ page }) => {
  await page.goto(`/?year=2001&photo=${PHOTO_2001}`);
  await expect(page.getByLabel("Photo player")).toBeVisible();
  await expect(page.locator(".player-counter")).toContainText("/ 6669");
  await expect.poll(() => page.evaluate(() => history.state.restoration.photoId)).toBe(PHOTO_2001);
  expect(await page.evaluate(() => history.state.restoration.year)).toBe("2001");
});

test("player close restores and focuses the exact photograph", async ({ page }) => {
  await page.goto(`/?year=2001&photo=${PHOTO_2001}`);
  await expect(page.getByLabel("Photo player")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  await waitForRestoration(page);
  await expect(page).toHaveURL(/year=2001(?!.*photo)/);
  await expect(page.locator(`[data-photo-id="${PHOTO_2001}"]`)).toBeFocused();
});

test("delayed 2013 layout cannot reproduce the production scroll jump", async ({ page }) => {
  await monitorScrollPosition(page);
  await page.route("**/data/2013/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 125));
    await route.continue();
  });
  await page.goto("/");
  await expectRootAt2013(page);
  await expectNoLargeJump(page);
});

test("a delayed non-current year cannot apply an obsolete target", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requested = 0;
  await page.route("**/data/2001/albums/**", async (route) => {
    requested += 1;
    await gate;
    await route.continue().catch(() => undefined);
  });
  await page.goto("/");
  await expectRootAt2013(page);
  await page.getByRole("button", { name: "Jump to 2001" }).click();
  await expect.poll(() => requested).toBe(3);
  await page.getByRole("button", { name: "Jump to 2013" }).click();
  release();
  await expect(page).toHaveURL(/year=2013/);
  await expect(page.locator(".app-bar__year")).toHaveText("2013");
  await afterLayoutFrames(page);
  expect(await page.evaluate(() => scrollY)).toBeLessThanOrEqual(240);
});

test("user scrolling cancels positioning while the selected year remains authoritative", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requested = 0;
  let completed = 0;
  page.on("response", (response) => {
    if (response.url().includes("/data/2001/albums/")) completed += 1;
  });
  await page.route("**/data/2001/albums/**", async (route) => {
    requested += 1;
    await gate;
    await route.continue();
  });
  await page.goto("/?year=2001");
  await expect.poll(() => requested).toBe(3);
  await page.mouse.move(50, 350);
  await page.mouse.wheel(0, 700);
  await waitForRestoration(page, "cancelled");
  release();
  await expect.poll(() => completed).toBe(3);
  await afterLayoutFrames(page);
  await expect(page).toHaveURL(/year=2001/);
  await expect(page.locator(".app-bar__year")).toHaveText("2001");
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-mounted-years", "2001");
  expect(await page.evaluate(() => scrollY)).toBeLessThan(5000);
});
