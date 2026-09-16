import { expect, test, type Page } from "@playwright/test";

const enabled = process.env.VITE_SEAMLESS_YEAR_SEGMENTS === "1";

test.skip(!enabled, "seamless year segment handoff tests require VITE_SEAMLESS_YEAR_SEGMENTS=1");

interface SegmentMetrics {
  activeYear: string | undefined;
  mountedYears: string[];
  urlYear: string | null;
  rows: number;
  images: number;
  inactiveImages: number;
  nodes: number;
  scrollY: number;
  visibleHeading: string | null;
  historyCalls: Array<{ kind: "push" | "replace"; year: string | null }>;
  scrollToCalls: Array<{ top: number | null }>;
}

async function installInstrumentation(page: Page) {
  await page.addInitScript(() => {
    const target = window as typeof window & {
      __segmentHistoryCalls?: Array<{ kind: "push" | "replace"; year: string | null }>;
      __segmentScrollToCalls?: Array<{ top: number | null }>;
    };
    target.__segmentHistoryCalls = [];
    target.__segmentScrollToCalls = [];
    const pushState = history.pushState.bind(history);
    const replaceState = history.replaceState.bind(history);
    const scrollTo = window.scrollTo.bind(window);
    history.pushState = (state: unknown, unused: string, url?: string | URL | null) => {
      target.__segmentHistoryCalls?.push({ kind: "push", year: new URL(String(url || location.href), location.href).searchParams.get("year") });
      pushState(state, unused, url);
    };
    history.replaceState = (state: unknown, unused: string, url?: string | URL | null) => {
      target.__segmentHistoryCalls?.push({ kind: "replace", year: new URL(String(url || location.href), location.href).searchParams.get("year") });
      replaceState(state, unused, url);
    };
    window.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
      const top = typeof options === "number" ? y ?? null : options?.top ?? null;
      target.__segmentScrollToCalls?.push({ top });
      scrollTo(options as ScrollToOptions & number, y as number);
    };
  });
}

async function resetInstrumentation(page: Page) {
  await page.evaluate(() => {
    const target = window as typeof window & {
      __segmentHistoryCalls?: unknown[];
      __segmentScrollToCalls?: unknown[];
    };
    target.__segmentHistoryCalls = [];
    target.__segmentScrollToCalls = [];
  });
}

async function waitForActiveYear(page: Page, year: string) {
  await expect(page.locator(`.collection-shell[data-active-year="${year}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".photo-tile").first()).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function waitForMountedYear(page: Page, year: string) {
  await expect.poll(async () => (await page.locator(".collection-shell").getAttribute("data-mounted-years")) || "", { timeout: 10_000 }).toContain(year);
}

async function segmentMetrics(page: Page): Promise<SegmentMetrics> {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".collection-shell");
    const mountedYears = (shell?.dataset.mountedYears || "").split(",").filter(Boolean);
    const images = [...document.querySelectorAll<HTMLImageElement>(".photo-tile img")];
    let nodes = 0;
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
    while (walker.nextNode()) nodes += 1;
    const visibleHeading = [...document.querySelectorAll<HTMLElement>(".archive-year-heading")]
      .find((heading) => {
        const rect = heading.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight;
      })?.textContent?.trim() || null;
    const target = window as typeof window & {
      __segmentHistoryCalls?: Array<{ kind: "push" | "replace"; year: string | null }>;
      __segmentScrollToCalls?: Array<{ top: number | null }>;
    };
    return {
      activeYear: shell?.dataset.activeYear,
      mountedYears,
      urlYear: new URL(location.href).searchParams.get("year"),
      rows: document.querySelectorAll("[data-entry-type='row']").length,
      images: images.length,
      inactiveImages: images.filter((image) => {
        const year = image.closest<HTMLElement>("[data-year]")?.dataset.year;
        return !year || !mountedYears.includes(year);
      }).length,
      nodes,
      scrollY: Math.round(scrollY),
      visibleHeading,
      historyCalls: target.__segmentHistoryCalls || [],
      scrollToCalls: target.__segmentScrollToCalls || []
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

function expectBounded(metrics: SegmentMetrics) {
  expect(metrics.mountedYears.length).toBeLessThanOrEqual(2);
  expect(metrics.rows).toBeLessThanOrEqual(80);
  expect(metrics.images).toBeLessThanOrEqual(300);
  expect(metrics.inactiveImages).toBe(0);
}

test("bottom sentinel prefetches 2002 and passive handoff replaces history", async ({ page }) => {
  await installInstrumentation(page);
  const manifests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/data/") && request.url().includes("/albums/")) manifests.push(request.url());
  });

  await page.goto("/?debug=1");
  await waitForActiveYear(page, "2013");
  manifests.length = 0;
  await resetInstrumentation(page);

  await scrollNearActiveBottom(page);
  await waitForMountedYear(page, "2002");
  let metrics = await segmentMetrics(page);
  expect(metrics.activeYear).toBe("2013");
  expect(metrics.mountedYears).toEqual(["2013", "2002"]);
  expect(manifests.length).toBeGreaterThan(0);
  expect(manifests.every((url) => url.includes("/data/2002/"))).toBe(true);
  expectBounded(metrics);

  await resetInstrumentation(page);
  const beforeScroll = metrics.scrollY;
  await page.evaluate(() => window.scrollBy(0, 1400));
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", "2002", { timeout: 10_000 });
  metrics = await segmentMetrics(page);
  expect(metrics.urlYear).toBe("2002");
  expect(metrics.historyCalls.filter((call) => call.kind === "replace" && call.year === "2002")).toHaveLength(1);
  expect(metrics.historyCalls.some((call) => call.kind === "push")).toBe(false);
  expect(metrics.scrollToCalls.some((call) => call.top === 0)).toBe(false);
  expect(metrics.scrollY - beforeScroll).toBeGreaterThan(1000);
  expect(metrics.scrollY - beforeScroll).toBeLessThan(1800);
  expectBounded(metrics);
});

test("top sentinel prepends 2013 without visual jump and hands off upward", async ({ page }) => {
  await installInstrumentation(page);
  await page.goto("/?year=2002&debug=1");
  await waitForActiveYear(page, "2002");
  await page.evaluate(() => window.scrollTo(0, 320));
  await page.waitForTimeout(100);
  await page.evaluate(() => window.scrollTo(0, 0));
  await resetInstrumentation(page);

  await waitForMountedYear(page, "2013");
  let metrics = await segmentMetrics(page);
  expect(metrics.activeYear).toBe("2002");
  expect(metrics.mountedYears).toEqual(["2002", "2013"]);
  expect(metrics.visibleHeading).toBe("2002");
  expect(metrics.scrollY).toBeGreaterThan(100_000);
  expectBounded(metrics);

  await resetInstrumentation(page);
  await page.evaluate(() => window.scrollBy(0, -1400));
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", "2013", { timeout: 10_000 });
  metrics = await segmentMetrics(page);
  expect(metrics.urlYear).toBe("2013");
  expect(metrics.historyCalls.filter((call) => call.kind === "replace" && call.year === "2013")).toHaveLength(1);
  expect(metrics.historyCalls.some((call) => call.kind === "push")).toBe(false);
  expect(metrics.scrollToCalls.some((call) => call.top === 0)).toBe(false);
  expectBounded(metrics);
});

test("slow adjacent load stays quiet without premature image elements", async ({ page }) => {
  await installInstrumentation(page);
  let releaseAlbums: (() => void) | null = null;
  const blocked = new Promise<void>((resolve) => {
    releaseAlbums = resolve;
  });
  await page.route("**/data/2002/albums/**", async (route) => {
    await blocked;
    await route.continue();
  });

  await page.goto("/?debug=1");
  await waitForActiveYear(page, "2013");
  await scrollNearActiveBottom(page);
  await expect(page.getByText("Preparing adjacent year")).toHaveCount(0);
  let metrics = await segmentMetrics(page);
  expect(metrics.mountedYears).toEqual(["2013"]);
  expect(metrics.images).toBeLessThan(120);
  expect(metrics.inactiveImages).toBe(0);

  releaseAlbums?.();
  await waitForMountedYear(page, "2002");
  metrics = await segmentMetrics(page);
  expect(metrics.mountedYears).toEqual(["2013", "2002"]);
  expectBounded(metrics);
});

test("partial adjacent year renders a bounded photo lead-in instead of loading copy", async ({ page }) => {
  await installInstrumentation(page);
  let releaseSecondAlbum: (() => void) | null = null;
  const blocked = new Promise<void>((resolve) => {
    releaseSecondAlbum = resolve;
  });
  await page.route("**/data/2002/albums/2002-when-canada-0fed0859.json", async (route) => {
    await blocked;
    await route.continue();
  });

  await page.goto("/?debug=1");
  await waitForActiveYear(page, "2013");
  await scrollNearActiveBottom(page);
  const leadIn = page.locator(".year-segment-leadin[data-year='2002']");
  await expect(leadIn).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Preparing adjacent year")).toHaveCount(0);
  await expect(leadIn.locator(".photo-tile")).not.toHaveCount(0);
  await expect(leadIn.locator(".photo-tile[aria-disabled='true']").first()).toBeVisible();
  let metrics = await segmentMetrics(page);
  expect(metrics.mountedYears).toEqual(["2013", "2002"]);
  expect(metrics.images).toBeLessThan(120);
  expect(metrics.inactiveImages).toBe(0);

  releaseSecondAlbum?.();
  await waitForMountedYear(page, "2002");
  metrics = await segmentMetrics(page);
  expect(metrics.mountedYears).toEqual(["2013", "2002"]);
  expectBounded(metrics);
});

test("failed adjacent index preserves current feed and retry can mount the segment", async ({ page }) => {
  await installInstrumentation(page);
  let failedIndex = false;
  await page.route("**/data/2002/index.json", async (route) => {
    if (!failedIndex) {
      failedIndex = true;
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return;
    }
    await route.continue();
  });

  await page.goto("/?debug=1");
  await waitForActiveYear(page, "2013");
  await scrollNearActiveBottom(page);
  await expect(page.getByRole("alert").filter({ hasText: "2002" })).toBeVisible({ timeout: 10_000 });
  let metrics = await segmentMetrics(page);
  expect(metrics.activeYear).toBe("2013");
  expect(metrics.urlYear).toBe("2013");
  expect(metrics.mountedYears).toEqual(["2013"]);
  expectBounded(metrics);

  await page.getByRole("button", { name: "Retry year" }).click();
  await waitForMountedYear(page, "2002");
  metrics = await segmentMetrics(page);
  expect(metrics.mountedYears).toEqual(["2013", "2002"]);
  expect(metrics.activeYear).toBe("2013");
  expectBounded(metrics);
});

test("manual fallback remains explicit push navigation while the flag is enabled", async ({ page }) => {
  await installInstrumentation(page);
  await page.goto("/?debug=1");
  await waitForActiveYear(page, "2013");
  await resetInstrumentation(page);

  await page.getByRole("button", { name: /Older photos: 2002/ }).click();
  await waitForActiveYear(page, "2002");
  const metrics = await segmentMetrics(page);
  expect(metrics.activeYear).toBe("2002");
  expect(metrics.urlYear).toBe("2002");
  expect(metrics.mountedYears).toEqual(["2002"]);
  expect(metrics.historyCalls.some((call) => call.kind === "push" && call.year === "2002")).toBe(true);
  expectBounded(metrics);
});

test("middle and oldest years hand off across the 2002 and 2001 boundary", async ({ page }) => {
  await installInstrumentation(page);
  await page.goto("/?year=2002&debug=1");
  await waitForActiveYear(page, "2002");
  await resetInstrumentation(page);

  await scrollNearActiveBottom(page);
  await waitForMountedYear(page, "2001");
  await resetInstrumentation(page);
  await page.evaluate(() => window.scrollBy(0, 1400));
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", "2001", { timeout: 10_000 });
  let metrics = await segmentMetrics(page);
  expect(metrics.mountedYears).toEqual(["2002", "2001"]);
  expect(metrics.urlYear).toBe("2001");
  expect(metrics.historyCalls.filter((call) => call.kind === "replace" && call.year === "2001")).toHaveLength(1);
  expect(metrics.historyCalls.some((call) => call.kind === "push")).toBe(false);
  expectBounded(metrics);

  await resetInstrumentation(page);
  await page.evaluate(() => window.scrollBy(0, -1400));
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", "2002", { timeout: 10_000 });
  metrics = await segmentMetrics(page);
  expect(metrics.mountedYears).toEqual(["2002", "2001"]);
  expect(metrics.urlYear).toBe("2002");
  expect(metrics.historyCalls.filter((call) => call.kind === "replace" && call.year === "2002")).toHaveLength(1);
  expect(metrics.historyCalls.some((call) => call.kind === "push")).toBe(false);
  expectBounded(metrics);
});
