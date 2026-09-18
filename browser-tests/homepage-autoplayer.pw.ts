import { expect, test } from "@playwright/test";

const enabled = process.env.VITE_HOMEPAGE_AUTOPLAYER === "1";
test.skip(!enabled, "homepage autoplay tests require VITE_HOMEPAGE_AUTOPLAYER=1");

async function installAutoplayOrderingProbe(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    type ProbeEvent = { ordinal: number; type: "phase" | "image"; value: string };
    const target = window as typeof window & { __homepageAutoplayProbe?: { events: ProbeEvent[]; seen: string[]; ordinal: number } };
    const probe = { events: [] as ProbeEvent[], seen: [] as string[], assignments: {} as Record<string, number>, ordinal: 0 };
    target.__homepageAutoplayProbe = probe;
    const record = (type: ProbeEvent["type"], value: string) => probe.events.push({ ordinal: ++probe.ordinal, type, value });
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    if (descriptor?.get && descriptor.set) {
      Object.defineProperty(HTMLImageElement.prototype, "src", {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set(value: string) {
          if (value.includes("/display/") && !probe.seen.includes(value)) {
            probe.seen.push(value);
            record("image", value);
          }
          if (value.includes("/display/")) probe.assignments[value] = (probe.assignments[value] || 0) + 1;
          descriptor.set?.call(this, value);
        }
      });
    }
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== "attributes") continue;
        const element = mutation.target as HTMLElement;
        const phase = element.dataset.playerWarmupPhase;
        if (phase) record("phase", phase);
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-player-warmup-phase"] });
  });
}

async function autoplayProbe(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as typeof window & {
    __homepageAutoplayProbe?: { events: Array<{ ordinal: number; type: "phase" | "image"; value: string }>; seen: string[]; assignments: Record<string, number> };
  }).__homepageAutoplayProbe!);
}

async function installShellMountProbe(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const target = window as typeof window & {
      __homepageShellMounts?: number;
      __homepageStartupEvents?: Array<{ ordinal: number; type: string }>;
      __recordHomepageStartupEvent?: (type: string) => void;
    };
    target.__homepageShellMounts = 0;
    target.__homepageStartupEvents = [];
    target.__recordHomepageStartupEvent = (type) => {
      target.__homepageStartupEvents!.push({ ordinal: target.__homepageStartupEvents!.length + 1, type });
    };
    target.__recordHomepageStartupEvent("eligibilityCaptured");
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches('[aria-label="Photo player"]') || node.querySelector('[aria-label="Photo player"]')) {
            target.__homepageShellMounts = (target.__homepageShellMounts || 0) + 1;
            target.__recordHomepageStartupEvent?.("playerShellCommitted");
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

test("eligible homepage commits one inert-backed player shell before catalogue resolution", async ({ page }) => {
  let releaseCatalog!: () => void;
  const catalogueGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  await installShellMountProbe(page);
  await page.route("**/data/catalog.json", async (route) => {
    await catalogueGate;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Photo player")).toBeVisible();
  await expect(page.getByLabel("Loading photographs")).toBeFocused();
  await expect(page.locator('[aria-hidden="true"][inert]')).toHaveCount(1);
  await expect(page.locator(".collection-shell")).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");
  const catalogResponse = page.waitForResponse("**/data/catalog.json");
  releaseCatalog();
  await catalogResponse;
  await page.evaluate(() => (window as typeof window & { __recordHomepageStartupEvent?: (type: string) => void })
    .__recordHomepageStartupEvent?.("catalogueResolved"));
  await expect(page.locator(".player-image")).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as typeof window & { __homepageShellMounts?: number }).__homepageShellMounts)).toBe(1);
  const events = await page.evaluate(() => (window as typeof window & {
    __homepageStartupEvents?: Array<{ ordinal: number; type: string }>;
  }).__homepageStartupEvents || []);
  expect(events.map(({ type }) => type).slice(0, 3)).toEqual([
    "eligibilityCaptured",
    "playerShellCommitted",
    "catalogueResolved",
  ]);
});

test("player shell remains mounted while the year collection is unresolved", async ({ page }) => {
  let releaseAlbums!: () => void;
  const albumGate = new Promise<void>((resolve) => { releaseAlbums = resolve; });
  await installShellMountProbe(page);
  await page.route("**/data/2013/albums/*.json", async (route) => {
    await albumGate;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Photo player")).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-shell-state", "loading");
  await expect(page.locator('[aria-hidden="true"][inert]')).toHaveCount(1);
  releaseAlbums();
  await expect(page.locator(".player-image")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => (window as typeof window & { __recordHomepageStartupEvent?: (type: string) => void })
    .__recordHomepageStartupEvent?.("yearCollectionResolved"));
  expect(await page.evaluate(() => (window as typeof window & { __homepageShellMounts?: number }).__homepageShellMounts)).toBe(1);
  const events = await page.evaluate(() => (window as typeof window & {
    __homepageStartupEvents?: Array<{ ordinal: number; type: string }>;
  }).__homepageStartupEvents || []);
  expect(events.find(({ type }) => type === "playerShellCommitted")!.ordinal)
    .toBeLessThan(events.find(({ type }) => type === "yearCollectionResolved")!.ordinal);
});

test("closing before catalogue completion prevents a late autoplay session", async ({ page }) => {
  let releaseCatalog!: () => void;
  const catalogueGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  await page.route("**/data/catalog.json", async (route) => {
    await catalogueGate;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Photo player")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  releaseCatalog();
  await expect(page.locator(".collection-shell")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
});

test("a failed catalogue leaves the loading shell closable without reopening", async ({ page }) => {
  await page.route("**/data/catalog.json", (route) => route.fulfill({ status: 503, body: "catalogue unavailable" }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Photo player")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");
});

test("a failed year collection leaves the loading shell closable without reopening", async ({ page }) => {
  await page.route("**/data/2013/albums/*.json", (route) => route.fulfill({ status: 503, body: "album unavailable" }));
  const failedAlbum = page.waitForResponse((response) => response.url().includes("/data/2013/albums/") && response.status() === 503);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Photo player")).toBeVisible();
  await failedAlbum;
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");
});

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

test("committed Stage 2 precedes rolling lookahead by deterministic event ordinal", async ({ page }) => {
  const networkRequests = new Map<string, number>();
  page.on("request", (request) => {
    if (!request.url().includes("/display/")) return;
    networkRequests.set(request.url(), (networkRequests.get(request.url()) || 0) + 1);
  });
  await installAutoplayOrderingProbe(page);
  await page.goto("/");
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-warmup-phase", "next-ten-forward", { timeout: 30_000 });
  await expect.poll(async () => (await autoplayProbe(page)).seen.length).toBeGreaterThanOrEqual(45);
  const probe = await autoplayProbe(page);
  const stage2 = probe.events.find((event) => event.type === "phase" && event.value === "next-ten-forward");
  const firstRollingUrl = probe.seen[15];
  const firstRolling = probe.events.find((event) => event.type === "image" && event.value === firstRollingUrl);
  expect(stage2).toBeTruthy();
  expect(firstRolling).toBeTruthy();
  expect(stage2!.ordinal).toBeLessThan(firstRolling!.ordinal);
  expect(probe.seen.slice(0, 15)).toHaveLength(15);
  expect(new Set(probe.seen).size).toBe(probe.seen.length);
  expect(Math.max(...networkRequests.values())).toBe(1);
});

test("manual navigation before Stage 2 cannot commit a stale Stage 2 transition", async ({ page }) => {
  await installAutoplayOrderingProbe(page);
  await page.route("**/2013/display/*.jpg", async (route) => {
    const probe = await autoplayProbe(page);
    const knownIndex = probe.seen.indexOf(route.request().url());
    if (knownIndex >= 5 && knownIndex < 15) await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await autoplayProbe(page)).seen.length).toBeGreaterThanOrEqual(5);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-warmup-phase", "inactive");
  await page.waitForTimeout(1200);
  const probe = await autoplayProbe(page);
  expect(probe.events.some((event) => event.type === "phase" && event.value === "next-ten-forward")).toBe(false);
});

test("closing before Stage 2 prevents a stale rolling preload", async ({ page }) => {
  await installAutoplayOrderingProbe(page);
  await page.route("**/2013/display/*.jpg", async (route) => {
    const probe = await autoplayProbe(page);
    const knownIndex = probe.seen.indexOf(route.request().url());
    if (knownIndex >= 5 && knownIndex < 15) await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await autoplayProbe(page)).seen.length).toBeGreaterThanOrEqual(5);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  await page.waitForTimeout(1200);
  expect((await autoplayProbe(page)).seen.length).toBeLessThanOrEqual(15);
});
