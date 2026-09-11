import { expect, test, type Page } from "@playwright/test";

async function waitForYear(page: Page, year: string) {
  await expect(page.locator(`.collection-shell[data-active-year="${year}"][data-mounted-years="${year}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".photo-tile").first()).toBeVisible({ timeout: 20_000 });
}

async function dragArchive(page: Page, fractions: number[], hold = false) {
  const rail = page.getByRole("slider", { name: "Complete archive timeline" });
  const box = await rail.boundingBox();
  if (!box) throw new Error("Archive rail is not visible");
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + 8);
  await page.mouse.down();
  for (const fraction of fractions) await page.mouse.move(x, box.y + box.height * fraction);
  if (!hold) await page.mouse.up();
}

async function mountedMetrics(page: Page) {
  return page.evaluate(() => {
    const entries = [...document.querySelectorAll<HTMLElement>(".photo-row")];
    const years = [...new Set(entries.map((entry) => entry.dataset.year).filter(Boolean))];
    const images = [...document.querySelectorAll<HTMLImageElement>(".photo-tile img")];
    let nodes = 0;
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
    while (walker.nextNode()) nodes += 1;
    return {
      activeYear: document.querySelector<HTMLElement>(".collection-shell")?.dataset.activeYear,
      years,
      rows: entries.length,
      photos: document.querySelectorAll(".photo-tile").length,
      images: images.length,
      inactiveImages: images.filter((image) => image.closest<HTMLElement>("[data-year]")?.dataset.year !== document.querySelector<HTMLElement>(".collection-shell")?.dataset.activeYear).length,
      elements: document.querySelectorAll("*").length,
      nodes
    };
  });
}

async function visibleTileGeometry(page: Page) {
  return page.locator(".photo-tile").evaluateAll((tiles) => tiles
    .filter((tile) => {
      const rect = tile.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight;
    })
    .map((tile) => {
      const rect = tile.getBoundingClientRect();
      const image = tile.querySelector("img");
      const sourceWidth = Number(image?.getAttribute("width") || 0);
      const sourceHeight = Number(image?.getAttribute("height") || 0);
      return {
        id: (tile as HTMLElement).dataset.photoId || "",
        rowTone: tile.closest<HTMLElement>(".photo-row")?.dataset.rowTone || "",
        objectFit: image ? getComputedStyle(image).objectFit : "",
        tileRatio: rect.width / rect.height,
        sourceRatio: sourceWidth / sourceHeight
      };
    }));
}

test("clean root visit mounts only 2013 and fetches no inactive album manifests", async ({ page }) => {
  const manifests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/albums/")) manifests.push(request.url());
  });
  await page.goto("/");
  await waitForYear(page, "2013");
  await expect(page).toHaveURL(/year=2013/);
  await expect(page.getByRole("heading", { name: "2013", exact: true })).toBeVisible();
  expect(new Set(manifests.filter((url) => url.includes("/data/2013/"))).size).toBe(9);
  expect(manifests.some((url) => url.includes("/data/2002/") || url.includes("/data/2001/"))).toBe(false);
  expect((await mountedMetrics(page)).years).toEqual(["2013"]);
});

test("scrubber movement is preview-only and commits 2013 to 2001 once on release", async ({ page }) => {
  const manifests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/albums/")) manifests.push(request.url());
  });
  await page.goto("/");
  await waitForYear(page, "2013");
  manifests.length = 0;
  await dragArchive(page, [0.2, 0.48, 0.72, 0.96], true);
  await expect(page.locator(".archive-timeline")).toHaveClass(/is-dragging/);
  await expect(page.locator(".archive-timeline__label")).toContainText("2001");
  await expect(page).toHaveURL(/year=2013/);
  expect(manifests.some((url) => url.includes("/data/2001/"))).toBe(false);
  await page.mouse.up();
  await expect(page).toHaveURL(/year=2001/);
  await waitForYear(page, "2001");
  expect((await mountedMetrics(page)).years).toEqual(["2001"]);
  expect(new Set(manifests.filter((url) => url.includes("/data/2001/"))).size).toBe(3);
});

test("reverse scrub returns from 2001 to 2013 with one mounted year", async ({ page }) => {
  await page.goto("/?year=2001");
  await waitForYear(page, "2001");
  await dragArchive(page, [0.7, 0.42, 0.18, 0.01]);
  await expect(page).toHaveURL(/year=2013/);
  await waitForYear(page, "2013");
  expect((await mountedMetrics(page)).years).toEqual(["2013"]);
});

test("rapid committed targets abort obsolete work and mount only the final year", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requested2001 = 0;
  await page.route("**/data/2001/albums/**", async (route) => {
    requested2001 += 1;
    await gate;
    await route.continue().catch(() => undefined);
  });
  await page.goto("/");
  await waitForYear(page, "2013");
  await page.getByRole("button", { name: "Jump to 2001" }).click();
  await expect.poll(() => requested2001).toBe(3);
  await page.getByRole("button", { name: "Jump to 2002" }).click();
  release();
  await expect(page).toHaveURL(/year=2002/);
  await waitForYear(page, "2002");
  const metrics = await mountedMetrics(page);
  expect(metrics.years).toEqual(["2002"]);
  expect(metrics.inactiveImages).toBe(0);
});

test("small 2002 range remains directly reachable", async ({ page }) => {
  await page.goto("/");
  await waitForYear(page, "2013");
  await page.getByRole("button", { name: "Jump to 2002" }).click();
  await expect(page).toHaveURL(/year=2002/);
  await waitForYear(page, "2002");
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-active-year", "2002");
  expect((await mountedMetrics(page)).years).toEqual(["2002"]);
});

test("integrated end boundary moves 2013 to 2002", async ({ page }) => {
  await page.goto("/");
  await waitForYear(page, "2013");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const boundary = page.getByRole("button", { name: /Older photos: 2002/ });
  await expect(boundary).toBeVisible();
  await boundary.click();
  await expect(page).toHaveURL(/year=2002/);
  await waitForYear(page, "2002");
  expect(await page.evaluate(() => scrollY)).toBeLessThan(500);
});

test("integrated beginning boundary restores the newer year's saved local anchor", async ({ page }) => {
  await page.goto("/");
  await waitForYear(page, "2013");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => history.state?.restoration?.photoId || null)).not.toBeNull();
  const savedPhoto = await page.evaluate(() => history.state.restoration.photoId as string);
  await page.getByRole("button", { name: /Older photos: 2002/ }).click();
  await waitForYear(page, "2002");
  await page.getByRole("button", { name: /Newer photos: 2013/ }).click();
  await waitForYear(page, "2013");
  await expect(page.locator(`[data-photo-id="${savedPhoto}"]`)).toBeVisible();
});

test("ordinary fast scrolling keeps visible image coverage on desktop and mobile", async ({ browser }) => {
  for (const contextOptions of [
    { viewport: { width: 1440, height: 900 } },
    { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
  ]) {
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.goto("/");
    await waitForYear(page, "2013");
    for (const delta of [900, 900, 900, 1200]) {
      await page.evaluate((amount) => window.scrollBy(0, amount), delta);
      await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>(".photo-tile img")].filter((image) => {
        const rect = image.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight && image.complete && image.naturalWidth > 0;
      }).length), { timeout: 10_000 }).toBeGreaterThan(0);
    }
    const metrics = await mountedMetrics(page);
    expect(metrics.rows).toBeLessThan(40);
    expect(metrics.photos).toBeLessThan(150);
    await context.close();
  }
});

test("archive contact sheet preserves image aspect ratios across representative viewports", async ({ browser }) => {
  for (const contextOptions of [
    { viewport: { width: 1440, height: 900 }, expectedVisible: 12, expectsFeatureRows: true },
    { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true, expectedVisible: 10, expectsFeatureRows: true },
    { viewport: { width: 844, height: 390 }, screen: { width: 844, height: 390 }, isMobile: true, hasTouch: true, expectedVisible: 6, expectsFeatureRows: false }
  ]) {
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.goto("/");
    await waitForYear(page, "2013");
    const samples = await visibleTileGeometry(page);
    expect(samples.length).toBeGreaterThanOrEqual(contextOptions.expectedVisible);
    expect(samples.every((sample) => sample.objectFit === "contain")).toBe(true);
    for (const sample of samples) {
      expect(Math.abs(sample.tileRatio - sample.sourceRatio)).toBeLessThan(0.04);
    }
    const tones = new Set(samples.map((sample) => sample.rowTone));
    if (contextOptions.expectsFeatureRows) expect(tones.has("feature")).toBe(true);
    expect(tones.has("compact") || tones.has("standard")).toBe(true);
    await context.close();
  }
});

test("Safari and Chrome iOS user agents share the bounded year-window architecture", async ({ browser }) => {
  const userAgents = [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1"
  ];
  for (const userAgent of userAgents) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent });
    const page = await context.newPage();
    await page.goto("/");
    await waitForYear(page, "2013");
    await expect(page.locator(".collection-shell")).toHaveAttribute("data-render-mode", "year-windowed");
    let metrics = await mountedMetrics(page);
    expect(metrics.rows).toBeLessThan(40);
    expect(metrics.photos).toBeLessThan(150);
    await page.getByRole("button", { name: "Jump to 2001" }).click();
    await waitForYear(page, "2001");
    metrics = await mountedMetrics(page);
    expect(metrics.years).toEqual(["2001"]);
    expect(metrics.inactiveImages).toBe(0);
    expect(metrics.photos).toBeLessThan(150);
    await context.close();
  }
});

test("thirty portrait and landscape changes preserve a stable photo without accumulating DOM", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:4174" });
  const page = await context.newPage();
  await page.goto("/?year=2001&debug=1");
  await waitForYear(page, "2001");
  await page.evaluate(() => window.scrollTo(0, 9000));
  await expect.poll(() => page.evaluate(() => history.state?.restoration?.photoId || null)).not.toBeNull();
  const samples: Awaited<ReturnType<typeof mountedMetrics>>[] = [];
  for (let cycle = 0; cycle < 30; cycle += 1) {
    const anchorPhoto = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".photo-tile")]
      .map((tile) => ({ id: tile.dataset.photoId || "", top: tile.getBoundingClientRect().top }))
      .sort((left, right) => Math.abs(left.top - 112) - Math.abs(right.top - 112))[0]?.id || "");
    expect(anchorPhoto).not.toBe("");
    await page.setViewportSize(cycle % 2 ? { width: 390, height: 844 } : { width: 844, height: 390 });
    await expect.poll(() => page.locator(`[data-photo-id="${anchorPhoto}"]`).evaluateAll((tiles) => tiles.some((tile) => {
      const rect = tile.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight;
    }))).toBe(true);
    const metrics = await mountedMetrics(page);
    samples.push(metrics);
    expect(metrics.years).toEqual(["2001"]);
    expect(metrics.inactiveImages).toBe(0);
    expect(metrics.rows).toBeLessThan(40);
    expect(metrics.photos).toBeLessThan(150);
  }
  expect(Math.max(...samples.map((sample) => sample.elements))).toBeLessThan(500);
  expect(Math.max(...samples.map((sample) => sample.nodes))).toBeLessThan(650);
  await page.getByRole("button", { name: "Archive QA" }).click();
  await page.getByRole("button", { name: "Copy diagnostics" }).click();
  const diagnostics = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(diagnostics.observerCount).toBe(2);
  expect(diagnostics.events.filter((event: { type: string }) => event.type === "archive-bound-warning")).toHaveLength(0);
  await context.close();
});

test("repeated traversal keeps inactive years empty and total DOM bounded", async ({ page }) => {
  await page.goto("/");
  await waitForYear(page, "2013");
  const samples: Awaited<ReturnType<typeof mountedMetrics>>[] = [];
  for (const year of ["2001", "2002", "2013", "2002", "2001", "2013"]) {
    await page.getByRole("button", { name: `Jump to ${year}` }).click();
    await waitForYear(page, year);
    const metrics = await mountedMetrics(page);
    samples.push(metrics);
    expect(metrics.years).toEqual([year]);
    expect(metrics.inactiveImages).toBe(0);
    expect(metrics.rows).toBeLessThan(40);
    expect(metrics.photos).toBeLessThan(150);
  }
  expect(Math.max(...samples.map((sample) => sample.elements))).toBeLessThan(500);
  expect(Math.max(...samples.map((sample) => sample.nodes))).toBeLessThan(650);
});

test("failed album remains isolated and retries in the active year", async ({ page }) => {
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
  expect((await mountedMetrics(page)).years).toEqual(["2002"]);
});

test("player remains scoped to each active year's exact photo total", async ({ page }) => {
  await page.goto("/");
  await waitForYear(page, "2013");
  for (const [year, total] of [["2013", 4213], ["2002", 479], ["2001", 6669]] as const) {
    if (year !== "2013") {
      await page.getByRole("button", { name: `Jump to ${year}` }).click();
      await waitForYear(page, year);
    }
    await page.locator(".photo-tile").first().click();
    await expect(page.getByLabel("Photo player")).toBeVisible();
    await expect(page.locator(".player-counter")).toContainText(`/ ${total}`);
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByLabel("Photo player")).toHaveCount(0);
    await waitForYear(page, year);
    expect((await mountedMetrics(page)).years).toEqual([year]);
  }
});

test("keyboard scrubber commits archive and year boundary targets", async ({ page }) => {
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
