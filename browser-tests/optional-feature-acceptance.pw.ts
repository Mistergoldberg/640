import { expect, test, type Page } from "@playwright/test";
import { publicFlagEnabled } from "../src/lib/publicFlag";
import { currentCatalogueFixture, installSyntheticMedia } from "./support/catalogue";

const fixture = currentCatalogueFixture();
const homepageAutoplayer = publicFlagEnabled(process.env.VITE_HOMEPAGE_AUTOPLAYER);
const seamlessYearSegments = publicFlagEnabled(process.env.VITE_SEAMLESS_YEAR_SEGMENTS);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pixilation-player-onboarding-v1", "1"));
  await installSyntheticMedia(page);
  await page.route("https://w.soundcloud.com/**", (route) => route.abort("blockedbyclient"));
});

async function waitForActiveYear(page: Page, year: string) {
  await expect(page.locator(`.collection-shell[data-active-year="${year}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`.year-segment[data-segment-year="${year}"] .photo-tile`).first()).toBeVisible({ timeout: 20_000 });
}

async function waitForMountedYear(page: Page, year: string) {
  await expect.poll(async () => ((await page.locator(".collection-shell").getAttribute("data-mounted-years")) || "").split(",")).toContain(year);
}

async function scrollNearActiveBottom(page: Page) {
  await page.evaluate(() => {
    const active = document.querySelector<HTMLElement>(".year-segment--active");
    if (!active) throw new Error("Active year segment missing");
    const rect = active.getBoundingClientRect();
    window.scrollTo(0, rect.top + window.scrollY + rect.height - window.innerHeight / 3);
  });
}

async function scrollNearActiveTop(page: Page) {
  await page.evaluate(() => {
    const active = document.querySelector<HTMLElement>(".year-segment--active");
    if (!active) throw new Error("Active year segment missing");
    const rect = active.getBoundingClientRect();
    window.scrollTo(0, Math.max(0, rect.top + window.scrollY + 120));
  });
}

async function archiveMetrics(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".collection-shell");
    const mountedYears = (shell?.dataset.mountedYears || "").split(",").filter(Boolean);
    const spacerYears = (shell?.dataset.spacerYears || "").split(",").filter(Boolean);
    const images = [...document.querySelectorAll<HTMLImageElement>(".photo-tile img")];
    const diagnostics = (window as typeof window & {
      __PIXILATION_ARCHIVE_DIAGNOSTICS__?: { yearCacheEntries?: number; events?: Array<{ type: string; data?: Record<string, unknown> }> };
    }).__PIXILATION_ARCHIVE_DIAGNOSTICS__;
    return {
      activeYear: shell?.dataset.activeYear || null,
      renderMode: shell?.dataset.renderMode || null,
      mountedYears,
      spacerYears,
      rows: document.querySelectorAll("[data-entry-type='row']").length,
      images: images.length,
      inactiveImages: images.filter((image) => {
        const year = image.closest<HTMLElement>("[data-year]")?.dataset.year;
        return !year || !mountedYears.includes(year);
      }).length,
      spacerImages: document.querySelectorAll(".year-segment-spacer img").length,
      nodes: document.getElementsByTagName("*").length,
      cacheEntries: diagnostics?.yearCacheEntries ?? 0,
      boundWarnings: (diagnostics?.events || []).filter((event) => event.type === "archive-bound-warning").length,
      anchorDrifts: (diagnostics?.events || [])
        .filter((event) => event.type === "visual-anchor-verified")
        .map((event) => Number(event.data?.finalDrift ?? 0)),
      historyLength: history.length
    };
  });
}

function expectArchiveBounds(metrics: Awaited<ReturnType<typeof archiveMetrics>>) {
  expect(metrics.mountedYears.length).toBeLessThanOrEqual(seamlessYearSegments ? 2 : 1);
  expect(metrics.rows).toBeLessThanOrEqual(80);
  expect(metrics.images).toBeLessThanOrEqual(300);
  expect(metrics.inactiveImages).toBe(0);
  expect(metrics.spacerImages).toBe(0);
  expect(metrics.nodes).toBeLessThanOrEqual(900);
  if (metrics.cacheEntries) expect(metrics.cacheEntries).toBeLessThanOrEqual(3);
  expect(metrics.boundWarnings).toBe(0);
  for (const drift of metrics.anchorDrifts) expect(Math.abs(drift)).toBeLessThanOrEqual(1);
}

test("configured features select the intended root entry and archive renderer", async ({ page }) => {
  await page.goto(homepageAutoplayer ? "/" : `/?year=${fixture.newest}`);
  if (homepageAutoplayer) {
    const player = page.getByLabel("Photo player");
    await expect(player).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".player-image").last()).toHaveAttribute("data-player-photo-id", fixture.photos[0].id);
    expect(new URL(page.url()).searchParams.has("photo")).toBe(false);
  } else {
    await expect(page.getByLabel("Photo player")).toHaveCount(0);
  }
  await waitForActiveYear(page, fixture.newest);
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-render-mode", seamlessYearSegments ? "segmented-year-window" : "year-windowed");
  expectArchiveBounds(await archiveMetrics(page));
});

if (homepageAutoplayer) {
  test("homepage warm-up orders frames, excludes a failed frame, and reaches normal playback", async ({ page }) => {
    await page.addInitScript(() => {
      const target = window as typeof window & { __displayAssignments?: string[] };
      target.__displayAssignments = [];
      const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
      if (!descriptor?.get || !descriptor.set) return;
      Object.defineProperty(HTMLImageElement.prototype, "src", {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set(value: string) {
          if (String(value).includes("/display/") && !target.__displayAssignments!.includes(String(value))) {
            target.__displayAssignments!.push(String(value));
          }
          descriptor.set!.call(this, value);
        }
      });
    });
    const failed = fixture.photos[1];
    await installSyntheticMedia(page, [failed.displayKey]);
    await page.goto("/");
    const player = page.getByLabel("Photo player");
    await expect(player).toHaveAttribute("data-player-warmup-phase", "inactive", { timeout: 20_000 });
    const assignments = await page.evaluate(() => (window as typeof window & { __displayAssignments?: string[] }).__displayAssignments || []);
    expect(assignments.length).toBeGreaterThanOrEqual(15);
    expect(assignments.slice(0, 5).map((url) => url.split("https://media.pixilation.org/")[1])).toEqual(
      fixture.photos.slice(0, 5).map((photo) => photo.displayKey)
    );
    expect(assignments.some((url) => url.endsWith(failed.displayKey))).toBe(true);
    await expect(page.locator(".player-image").last()).not.toHaveAttribute("data-player-photo-id", failed.id);
    expect(Number(await player.getAttribute("data-player-cache-entries"))).toBeLessThanOrEqual(51);
  });

  test("explicit pause, manual navigation, close cleanup, and reload follow the document lifecycle", async ({ page }) => {
    const displayRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/display/")) displayRequests.push(request.url());
    });
    await page.goto("/");
    const player = page.getByLabel("Photo player");
    await expect(player).toHaveAttribute("data-player-warmup-phase", /first-five-forward|loading-next-ten|next-ten-forward|steady-forward/, { timeout: 20_000 });
    await page.locator('[data-player-control="playback"]').click();
    await expect(player).toHaveAttribute("data-player-warmup-phase", "paused");
    const pausedPhoto = await page.locator(".player-image").last().getAttribute("data-player-photo-id");
    await page.waitForTimeout(500);
    await expect(page.locator(".player-image").last()).toHaveAttribute("data-player-photo-id", pausedPhoto!);

    await page.getByRole("button", { name: "Next photo" }).click();
    await expect(player).toHaveAttribute("data-player-warmup-phase", "inactive");
    const restoredPhoto = await page.locator(".player-image").last().getAttribute("data-player-photo-id");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(player).toHaveCount(0);
    await expect(page.locator(".player-image")).toHaveCount(0);
    const requestsAtClose = displayRequests.length;
    await page.waitForTimeout(500);
    expect(displayRequests).toHaveLength(requestsAtClose);
    await expect(page.locator(`[data-photo-id="${restoredPhoto}"]`)).toBeFocused();

    await page.reload();
    await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).searchParams.has("photo")).toBe(false);
  });
} else {
  test("feature-off root and reload remain archive-only without extra history", async ({ page }) => {
    await page.goto("/");
    await waitForActiveYear(page, fixture.newest);
    const historyLength = await page.evaluate(() => history.length);
    await expect(page.getByLabel("Photo player")).toHaveCount(0);
    await page.reload();
    await waitForActiveYear(page, fixture.newest);
    await expect(page.getByLabel("Photo player")).toHaveCount(0);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
  });
}

if (seamlessYearSegments) {
  test("adjacent loading passively hands off without adding history and remains bounded", async ({ page }) => {
    await page.goto(`/?year=${fixture.newest}&debug=1`);
    await waitForActiveYear(page, fixture.newest);
    const initial = await archiveMetrics(page);
    await scrollNearActiveBottom(page);
    await waitForMountedYear(page, fixture.adjacent);
    let current = await archiveMetrics(page);
    expect(current.mountedYears).toEqual([fixture.newest, fixture.adjacent]);
    expectArchiveBounds(current);
    await page.mouse.wheel(0, 1400);
    await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", fixture.adjacent, { timeout: 15_000 });
    current = await archiveMetrics(page);
    expect(new URL(page.url()).searchParams.get("year")).toBe(fixture.adjacent);
    expect(current.historyLength).toBe(initial.historyLength);
    expectArchiveBounds(current);
  });

  test("cancelled adjacent loading and a failed index both recover on deliberate navigation", async ({ page }) => {
    let releaseAlbums!: () => void;
    const albumGate = new Promise<void>((resolve) => { releaseAlbums = resolve; });
    let holdAlbums = true;
    await page.route(`**/data/${fixture.adjacent}/albums/**`, async (route) => {
      if (holdAlbums) await albumGate;
      try { await route.continue(); } catch { /* cancellation closes the old request */ }
    });
    await page.goto(`/?year=${fixture.newest}&debug=1`);
    await waitForActiveYear(page, fixture.newest);
    await scrollNearActiveBottom(page);
    await page.waitForTimeout(150);
    await scrollNearActiveTop(page);
    holdAlbums = false;
    releaseAlbums();
    await page.waitForTimeout(300);
    expect((await archiveMetrics(page)).activeYear).toBe(fixture.newest);

    let failed = false;
    await page.route(`**/data/${fixture.adjacent}/index.json`, async (route) => {
      if (!failed) {
        failed = true;
        await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      } else await route.continue();
    });
    await page.reload();
    await waitForActiveYear(page, fixture.newest);
    await scrollNearActiveBottom(page);
    await expect(page.getByRole("alert").filter({ hasText: fixture.adjacent })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Retry year" }).click();
    await waitForMountedYear(page, fixture.adjacent);
    expectArchiveBounds(await archiveMetrics(page));
  });

  test("reclamation, resize, orientation, and reload preserve a stable bounded archive", async ({ page }) => {
    await page.goto(`/?year=${fixture.newest}&debug=1`);
    await waitForActiveYear(page, fixture.newest);
    await scrollNearActiveBottom(page);
    await waitForMountedYear(page, fixture.adjacent);
    await page.mouse.wheel(0, 1400);
    await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", fixture.adjacent, { timeout: 15_000 });
    await scrollNearActiveBottom(page);
    await waitForMountedYear(page, fixture.third);
    await expect.poll(async () => ((await page.locator(".collection-shell").getAttribute("data-spacer-years")) || "")).toContain(fixture.newest);
    let current = await archiveMetrics(page);
    expect(current.spacerYears).toContain(fixture.newest);
    expectArchiveBounds(current);

    for (const viewport of [{ width: 1024, height: 760 }, { width: 844, height: 390 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      current = await archiveMetrics(page);
      expect([fixture.adjacent, fixture.third]).toContain(current.activeYear);
      expectArchiveBounds(current);
    }
    expect(current.anchorDrifts.length).toBeGreaterThan(0);
    await page.waitForTimeout(350);
    await expect.poll(() => page.evaluate(() => history.state?.restoration?.photoId || null)).not.toBeNull();
    const anchor = await page.evaluate(() => history.state.restoration.photoId);
    const yearBeforeReload = current.activeYear!;
    await page.reload();
    await waitForActiveYear(page, yearBeforeReload);
    await expect.poll(() => page.evaluate(() => history.state?.restoration?.photoId || null)).toBe(anchor);
    expectArchiveBounds(await archiveMetrics(page));
  });
} else {
  test("feature-off archive keeps one mounted year through explicit history navigation", async ({ page }) => {
    await page.goto(`/?year=${fixture.newest}&debug=1`);
    await waitForActiveYear(page, fixture.newest);
    await page.getByRole("button", { name: `Older photos: ${fixture.adjacent}` }).click();
    await waitForActiveYear(page, fixture.adjacent);
    let current = await archiveMetrics(page);
    expect(current.mountedYears).toEqual([fixture.adjacent]);
    expectArchiveBounds(current);
    await page.goBack();
    await waitForActiveYear(page, fixture.newest);
    current = await archiveMetrics(page);
    expect(current.mountedYears).toEqual([fixture.newest]);
    expectArchiveBounds(current);
  });
}

if (homepageAutoplayer && seamlessYearSegments) {
  test("combined autoplay close restores the archive before segmented navigation", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 20_000 });
    await waitForActiveYear(page, fixture.newest);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByLabel("Photo player")).toHaveCount(0);
    await expect(page.locator(`[data-photo-id="${fixture.photos[0].id}"]`)).toBeFocused();
    await scrollNearActiveBottom(page);
    await waitForMountedYear(page, fixture.adjacent);
    await page.mouse.wheel(0, 1400);
    await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", fixture.adjacent, { timeout: 15_000 });
    const photo = page.locator(`.year-segment[data-segment-year="${fixture.adjacent}"] .photo-tile`).first();
    const photoId = await photo.getAttribute("data-photo-id");
    await photo.click();
    await expect(page.getByLabel("Photo player")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByLabel("Photo player")).toHaveCount(0);
    await expect(page.locator(`[data-photo-id="${photoId}"]`)).toBeFocused();
    expectArchiveBounds(await archiveMetrics(page));
  });
}
