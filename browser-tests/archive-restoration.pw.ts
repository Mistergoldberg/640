import { expect, test, type Page } from "@playwright/test";

const LEGACY_SCROLL_Y = 165736;
const PHOTO_2001 = "2001-b41561bec02ff5";
const REPORTED_REQUESTED_PHOTO = "2001-8117399092ce75";
const REPORTED_WRONG_PHOTO = "2001-52f7e219f9486a";

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

async function pressScrubberKey(page: Page, key: "Home" | "End" | "PageDown" | "PageUp") {
  const rail = page.getByRole("slider", { name: "Complete archive timeline" });
  await rail.focus();
  await rail.press(key);
}

async function jumpArchiveToYear(page: Page, year: string) {
  const activeYear = await page.locator(".collection-shell").getAttribute("data-active-year");
  if (year === "2013" && activeYear !== "2013") await pressScrubberKey(page, "Home");
  else if (year === "2001" && activeYear !== "2001") await pressScrubberKey(page, "End");
  else if (year === "2002" && activeYear !== "2002") await pressScrubberKey(page, activeYear === "2001" ? "PageUp" : "PageDown");
  await expect(page.locator(`.collection-shell[data-active-year="${year}"][data-mounted-years="${year}"]`)).toBeVisible({ timeout: 20_000 });
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
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", "2013");
  await expect(page).toHaveURL(/year=2013/);
  expect(await page.evaluate(() => scrollY)).toBeLessThanOrEqual(240);
  const photos = await visiblePhotoIds(page);
  expect(photos.length).toBeGreaterThan(0);
  expect(photos.every((id) => id.startsWith("2013-"))).toBe(true);
}

async function scrollWithinYear(page: Page, year: string, amount = 9000) {
  const previousPhotoId = await page.evaluate(() => window.history.state?.restoration?.photoId || null);
  await page.evaluate((delta) => window.scrollBy(0, delta), amount);
  await expect(page).toHaveURL(new RegExp(`year=${year}`));
  await expect.poll(() => page.evaluate((previous) => {
    const current = window.history.state?.restoration?.photoId || null;
    return Boolean(current && current !== previous);
  }, previousPhotoId)).toBe(true);
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
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", "2001");
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

test("reload flushes the live stable anchor before the persistence debounce expires", async ({ page }) => {
  await page.goto("/?year=2001");
  await waitForRestoration(page);
  await page.evaluate(() => window.scrollBy(0, 9000));
  await afterLayoutFrames(page);
  const before = await page.evaluate(() => {
    const nearest = [...document.querySelectorAll<HTMLElement>(".photo-tile")]
      .map((tile) => ({ id: tile.dataset.photoId || "", distance: Math.abs(tile.getBoundingClientRect().top - 112) }))
      .sort((left, right) => left.distance - right.distance)[0];
    return { y: scrollY, photoId: nearest?.id || null };
  });
  expect(before.photoId).not.toBeNull();
  await page.reload();
  await waitForRestoration(page);
  expect(await page.evaluate(() => history.state?.restoration?.photoId)).toBe(before.photoId);
  expect(Math.abs((await page.evaluate(() => scrollY)) - before.y)).toBeLessThan(500);
});

test("the exact reported photo remains authoritative through conflicting state and repeated reloads", async ({ page }) => {
  await page.addInitScript(() => {
    const target = window as typeof window & { __restorationPhotoWrites?: Array<string | null> };
    target.__restorationPhotoWrites = [];
    const replaceState = history.replaceState.bind(history);
    history.replaceState = (state: unknown, unused: string, url?: string | URL | null) => {
      const photoId = (state as { restoration?: { photoId?: string | null } } | null)?.restoration?.photoId ?? null;
      target.__restorationPhotoWrites?.push(photoId);
      replaceState(state, unused, url);
    };
  });
  const url = `/?year=2001&photo=${REPORTED_REQUESTED_PHOTO}`;
  await page.goto(url);
  await expect(page.getByLabel("Photo player")).toBeVisible();
  await expect.poll(() => page.evaluate(() => history.state?.restoration?.photoId)).toBe(REPORTED_REQUESTED_PHOTO);
  await expect(page).toHaveURL(new RegExp(`photo=${REPORTED_REQUESTED_PHOTO}`));
  const historyLength = await page.evaluate(() => history.length);

  await page.evaluate((wrongPhotoId) => {
    const state = history.state;
    history.replaceState({
      ...state,
      photoId: wrongPhotoId,
      restoration: { ...state.restoration, photoId: wrongPhotoId }
    }, "", location.href);
  }, REPORTED_WRONG_PHOTO);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.reload();
    await expect(page.getByLabel("Photo player")).toBeVisible();
    await expect.poll(() => page.evaluate(() => history.state?.restoration?.photoId)).toBe(REPORTED_REQUESTED_PHOTO);
    expect(await page.evaluate((wrongPhotoId) => (
      (window as typeof window & { __restorationPhotoWrites?: Array<string | null> }).__restorationPhotoWrites || []
    ).includes(wrongPhotoId), REPORTED_WRONG_PHOTO)).toBe(false);
    await expect(page).toHaveURL(new RegExp(`photo=${REPORTED_REQUESTED_PHOTO}`));
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
  }
});

test("exact photo URLs survive delayed metadata and representative reloads", async ({ page }) => {
  await page.route("**/data/2001/albums/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 125));
    await route.continue();
  });
  for (const [year, photoId] of [
    ["2001", REPORTED_REQUESTED_PHOTO],
    ["2002", "2002-50386e89706e2e"],
    ["2013", "2013-4651b733c14c76"]
  ]) {
    await page.goto(`/?year=${year}&photo=${photoId}`);
    await expect(page.getByLabel("Photo player")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Photo player")).toBeVisible();
    expect(await page.evaluate(() => history.state?.restoration?.photoId)).toBe(photoId);
    await expect(page).toHaveURL(new RegExp(`year=${year}.*photo=${photoId}`));
  }
});

test("the exact reported photo survives mobile viewports and repeated orientation changes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?year=2001&photo=${REPORTED_REQUESTED_PHOTO}`);
  await expect(page.getByLabel("Photo player")).toBeVisible();
  for (let turn = 0; turn < 30; turn += 1) {
    await page.setViewportSize(turn % 2 ? { width: 844, height: 390 } : { width: 390, height: 844 });
    expect(await page.evaluate(() => history.state?.restoration?.photoId)).toBe(REPORTED_REQUESTED_PHOTO);
  }
  expect(await page.locator(".collection-shell").getAttribute("data-active-year")).toBe("2001");
  expect(await page.locator("[data-year]:not([data-year='2001']) img").count()).toBe(0);
});

test("Back and Forward restore the stable anchor for each history entry", async ({ page }) => {
  await page.goto("/");
  await expectRootAt2013(page);
  await jumpArchiveToYear(page, "2001");
  await expect(page).toHaveURL(/year=2001/);
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", "2001");
  const entry2001 = await page.evaluate(() => history.state.entryId);
  await page.goBack();
  await expect(page).toHaveURL(/year=2013/);
  await waitForRestoration(page);
  await expect(page.getByRole("heading", { name: "2013", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/year=2001/);
  await waitForRestoration(page);
  expect(await page.evaluate(() => history.state.entryId)).toBe(entry2001);
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", "2001");
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
  await pressScrubberKey(page, "End");
  await expect.poll(() => requested).toBe(3);
  await pressScrubberKey(page, "Home");
  release();
  await expect(page).toHaveURL(/year=2013/);
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", "2013");
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
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", "2001");
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-mounted-years", "2001");
  expect(await page.evaluate(() => scrollY)).toBeLessThan(5000);
});
