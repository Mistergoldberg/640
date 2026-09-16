import { expect, test, type Page } from "@playwright/test";

const enabled = process.env.VITE_SEAMLESS_YEAR_SEGMENTS === "1";

test.skip(!enabled, "seamless year segment reclamation tests require VITE_SEAMLESS_YEAR_SEGMENTS=1");

interface ReclamationMetrics {
  activeYear: string | undefined;
  mountedYears: string[];
  spacerYears: string[];
  urlYear: string | null;
  rows: number;
  images: number;
  inactiveImages: number;
  spacerImages: number;
  nodes: number;
  scrollY: number;
  observerCount: number;
  retainedCollections: number;
  anchorEvents: Array<{ type: string; data?: Record<string, unknown> }>;
  historyLength: number;
}

async function installInstrumentation(page: Page) {
  await page.addInitScript(() => {
    const target = window as typeof window & {
      __segmentHistoryCalls?: Array<{ kind: "push" | "replace"; year: string | null }>;
    };
    target.__segmentHistoryCalls = [];
    const pushState = history.pushState.bind(history);
    const replaceState = history.replaceState.bind(history);
    history.pushState = (state: unknown, unused: string, url?: string | URL | null) => {
      target.__segmentHistoryCalls?.push({ kind: "push", year: new URL(String(url || location.href), location.href).searchParams.get("year") });
      pushState(state, unused, url);
    };
    history.replaceState = (state: unknown, unused: string, url?: string | URL | null) => {
      target.__segmentHistoryCalls?.push({ kind: "replace", year: new URL(String(url || location.href), location.href).searchParams.get("year") });
      replaceState(state, unused, url);
    };
  });
}

async function waitForActiveYear(page: Page, year: string) {
  await expect(page.locator(`.collection-shell[data-active-year="${year}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".photo-tile").first()).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function waitForMountedYear(page: Page, year: string) {
  await expect.poll(async () => (await page.locator(".collection-shell").getAttribute("data-mounted-years")) || "", { timeout: 15_000 }).toContain(year);
}

async function waitForSpacerYear(page: Page, year: string) {
  await expect.poll(async () => (await page.locator(".collection-shell").getAttribute("data-spacer-years")) || "", { timeout: 15_000 }).toContain(year);
}

async function waitForNoSpacerYear(page: Page, year: string) {
  await expect.poll(async () => (await page.locator(".collection-shell").getAttribute("data-spacer-years")) || "", { timeout: 15_000 }).not.toContain(year);
}

async function metrics(page: Page): Promise<ReclamationMetrics> {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".collection-shell");
    const mountedYears = (shell?.dataset.mountedYears || "").split(",").filter(Boolean);
    const spacerYears = (shell?.dataset.spacerYears || "").split(",").filter(Boolean);
    const images = [...document.querySelectorAll<HTMLImageElement>(".photo-tile img")];
    let nodes = 0;
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
    while (walker.nextNode()) nodes += 1;
    const diagnostics = (window as typeof window & {
      __PIXILATION_ARCHIVE_DIAGNOSTICS__?: {
        observerCount?: number;
        yearCacheEntries?: number;
        events?: Array<{ type: string; data?: Record<string, unknown> }>;
      };
    }).__PIXILATION_ARCHIVE_DIAGNOSTICS__;
    return {
      activeYear: shell?.dataset.activeYear,
      mountedYears,
      spacerYears,
      urlYear: new URL(location.href).searchParams.get("year"),
      rows: document.querySelectorAll("[data-entry-type='row']").length,
      images: images.length,
      inactiveImages: images.filter((image) => {
        const year = image.closest<HTMLElement>("[data-year]")?.dataset.year;
        return !year || !mountedYears.includes(year);
      }).length,
      spacerImages: [...document.querySelectorAll<HTMLElement>(".year-segment-spacer")].reduce((sum, spacer) => sum + spacer.querySelectorAll("img").length, 0),
      nodes,
      scrollY: Math.round(scrollY),
      observerCount: diagnostics?.observerCount || 0,
      retainedCollections: diagnostics?.yearCacheEntries || 0,
      anchorEvents: (diagnostics?.events || []).filter((event) => event.type === "visual-anchor-verified"),
      historyLength: history.length
    };
  });
}

async function scrollNearActiveBottom(page: Page) {
  await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>("#photo-grid");
    if (!grid) throw new Error("Active grid missing");
    const rect = grid.getBoundingClientRect();
    window.scrollTo(0, rect.top + scrollY + rect.height - innerHeight / 2);
  });
}

async function scrollNearActiveTop(page: Page) {
  await page.evaluate(() => {
    const segment = document.querySelector<HTMLElement>(".year-segment--active");
    if (!segment) throw new Error("Active segment missing");
    const rect = segment.getBoundingClientRect();
    window.scrollTo(0, Math.max(0, rect.top + scrollY + 160));
  });
}

function expectBounded(current: ReclamationMetrics) {
  expect(current.mountedYears.length).toBeLessThanOrEqual(2);
  expect(current.retainedCollections).toBeLessThanOrEqual(3);
  expect(current.rows).toBeLessThanOrEqual(80);
  expect(current.images).toBeLessThanOrEqual(300);
  expect(current.inactiveImages).toBe(0);
  expect(current.spacerImages).toBe(0);
}

function expectAnchorDriftWithinBudget(current: ReclamationMetrics) {
  for (const event of current.anchorEvents) {
    const drift = Number(event.data?.finalDrift ?? 0);
    expect(Math.abs(drift)).toBeLessThanOrEqual(1);
  }
}

async function moveOlder(page: Page, targetYear: string) {
  await scrollNearActiveBottom(page);
  await waitForMountedYear(page, targetYear);
  await page.evaluate(() => window.scrollBy(0, 1400));
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", targetYear, { timeout: 15_000 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function moveNewer(page: Page, targetYear: string) {
  await scrollNearActiveTop(page);
  await waitForMountedYear(page, targetYear);
  await page.evaluate(() => window.scrollBy(0, -1400));
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", targetYear, { timeout: 15_000 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("real-data traversal reclaims and restores spacers without resource growth or history mutation", async ({ page }) => {
  await installInstrumentation(page);
  await page.goto("/?debug=1");
  await waitForActiveYear(page, "2013");
  const initial = await metrics(page);

  await moveOlder(page, "2002");
  await scrollNearActiveBottom(page);
  await waitForSpacerYear(page, "2013");
  await waitForMountedYear(page, "2001");
  let current = await metrics(page);
  expect(current.activeYear).toBe("2002");
  expect(current.spacerYears).toContain("2013");
  expectBounded(current);

  await page.evaluate(() => window.scrollBy(0, 1400));
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", "2001", { timeout: 15_000 });
  current = await metrics(page);
  expect(current.urlYear).toBe("2001");
  expectBounded(current);

  await moveNewer(page, "2002");
  await scrollNearActiveTop(page);
  await waitForSpacerYear(page, "2001");
  await waitForMountedYear(page, "2013");
  await waitForNoSpacerYear(page, "2013");
  current = await metrics(page);
  expect(current.activeYear).toBe("2002");
  expect(current.spacerYears).toContain("2001");
  expectBounded(current);

  await page.evaluate(() => window.scrollBy(0, -1400));
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", "2013", { timeout: 15_000 });
  current = await metrics(page);
  expect(current.urlYear).toBe("2013");
  expect(current.historyLength).toBe(initial.historyLength);
  expectBounded(current);
  expectAnchorDriftWithinBudget(current);
});

test("thirty real-data traversal cycles stay bounded after spacers have been exercised", async ({ page }) => {
  await installInstrumentation(page);
  await page.goto("/?year=2002&debug=1");
  await waitForActiveYear(page, "2002");

  const maxima = {
    mounted: 0,
    rows: 0,
    images: 0,
    nodes: 0,
    retainedCollections: 0,
    observers: 0,
    spacerImages: 0
  };

  for (let index = 0; index < 30; index += 1) {
    await moveOlder(page, "2001");
    await moveNewer(page, "2002");
    const current = await metrics(page);
    maxima.mounted = Math.max(maxima.mounted, current.mountedYears.length);
    maxima.rows = Math.max(maxima.rows, current.rows);
    maxima.images = Math.max(maxima.images, current.images);
    maxima.nodes = Math.max(maxima.nodes, current.nodes);
    maxima.retainedCollections = Math.max(maxima.retainedCollections, current.retainedCollections);
    maxima.observers = Math.max(maxima.observers, current.observerCount);
    maxima.spacerImages = Math.max(maxima.spacerImages, current.spacerImages);
    expectBounded(current);
  }

  console.log(JSON.stringify({ type: "segment-reclamation-maxima", ...maxima }));
  expect(maxima.mounted).toBeLessThanOrEqual(2);
  expect(maxima.retainedCollections).toBeLessThanOrEqual(3);
  expect(maxima.rows).toBeLessThanOrEqual(80);
  expect(maxima.images).toBeLessThanOrEqual(300);
  expect(maxima.spacerImages).toBe(0);
});

test("width and height changes preserve spacer geometry and the active anchor", async ({ page }) => {
  await installInstrumentation(page);
  await page.goto("/?debug=1");
  await waitForActiveYear(page, "2013");
  await moveOlder(page, "2002");
  await scrollNearActiveBottom(page);
  await waitForSpacerYear(page, "2013");
  await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>("#photo-grid");
    if (!grid) throw new Error("Active grid missing");
    const gridTop = grid.getBoundingClientRect().top + scrollY;
    window.scrollTo(0, gridTop + 1200);
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  const before = await page.locator(".year-segment-spacer[data-year='2013']").evaluate((spacer) => {
    const tile = [...document.querySelectorAll<HTMLElement>(".year-segment--active .photo-tile")]
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight;
      });
    if (!tile) throw new Error("Visible active photo missing");
    return {
      width: window.innerWidth,
      height: spacer.getBoundingClientRect().height,
      photoId: tile?.dataset.photoId || "",
      top: tile?.getBoundingClientRect().top ?? 0
    };
  });

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const afterWidth = await page.locator(".year-segment-spacer[data-year='2013']").evaluate((spacer, photoId) => {
    const tile = document.querySelector<HTMLElement>(`.year-segment--active [data-photo-id="${CSS.escape(photoId)}"]`);
    if (!tile) throw new Error("Resized anchor photo missing");
    return {
      width: window.innerWidth,
      height: spacer.getBoundingClientRect().height,
      top: tile?.getBoundingClientRect().top ?? 0
    };
  }, before.photoId);
  expect(afterWidth.width).toBe(1024);
  expect(afterWidth.height).not.toBe(before.height);
  let current = await metrics(page);
  expectAnchorDriftWithinBudget(current);

  await page.setViewportSize({ width: 1024, height: 760 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const afterHeightOnly = await page.locator(".year-segment-spacer[data-year='2013']").evaluate((spacer) => ({
    width: window.innerWidth,
    height: spacer.getBoundingClientRect().height
  }));
  expect(afterHeightOnly.width).toBe(1024);
  expect(afterHeightOnly.height).toBe(afterWidth.height);

  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  current = await metrics(page);
  expect(current.spacerYears).toContain("2013");
  expectBounded(current);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  current = await metrics(page);
  expect(current.spacerYears).toContain("2013");
  expectBounded(current);
  expectAnchorDriftWithinBudget(current);
});
