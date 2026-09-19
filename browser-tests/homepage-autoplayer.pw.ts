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

interface DocumentLifecycleProbe {
  documentId: string;
  shellMounts: number;
  mediaAssignments: string[];
}

async function installDocumentLifecycleProbe(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const target = window as typeof window & { __homepageDocumentLifecycleProbe?: DocumentLifecycleProbe };
    const probe: DocumentLifecycleProbe = {
      documentId: crypto.randomUUID(),
      shellMounts: 0,
      mediaAssignments: []
    };
    target.__homepageDocumentLifecycleProbe = probe;
    const mountedShells = new WeakSet<Element>();
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          const shell = node.matches('[aria-label="Photo player"]')
            ? node
            : node.querySelector('[aria-label="Photo player"]');
          if (shell && !mountedShells.has(shell)) {
            mountedShells.add(shell);
            probe.shellMounts += 1;
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });

    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    if (descriptor?.get && descriptor.set) {
      Object.defineProperty(HTMLImageElement.prototype, "src", {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set(value: string) {
          if (String(value).includes("/display/")) probe.mediaAssignments.push(String(value));
          descriptor.set?.call(this, value);
        }
      });
    }
  });
}

async function documentLifecycleProbe(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as typeof window & {
    __homepageDocumentLifecycleProbe?: DocumentLifecycleProbe;
  }).__homepageDocumentLifecycleProbe!);
}

async function closePlayerThroughDom(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Close", exact: true }).evaluate((button) => button.click());
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
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

test("loading dismissal stays document-scoped and reload mounts one fresh shell before catalogue resolution", async ({ page }) => {
  let releaseFirstCatalog!: () => void;
  let releaseSecondCatalog!: () => void;
  const firstCatalogGate = new Promise<void>((resolve) => { releaseFirstCatalog = resolve; });
  const secondCatalogGate = new Promise<void>((resolve) => { releaseSecondCatalog = resolve; });
  let catalogRequests = 0;
  await installDocumentLifecycleProbe(page);
  await page.route("**/data/catalog.json", async (route) => {
    catalogRequests += 1;
    if (catalogRequests === 1) await firstCatalogGate;
    if (catalogRequests === 2) await secondCatalogGate;
    await route.continue();
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-shell-state", "loading");
  const originalDocument = await documentLifecycleProbe(page);
  const originalHistoryLength = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);

  releaseFirstCatalog();
  await expect(page.locator(".collection-shell")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");
  expect((await documentLifecycleProbe(page)).documentId).toBe(originalDocument.documentId);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-shell-state", "loading");
  await expect(page.locator('[aria-hidden="true"][inert]')).toHaveCount(1);
  await expect(page.locator(".collection-shell")).toHaveCount(0);
  const reloadedDocument = await documentLifecycleProbe(page);
  expect(reloadedDocument.documentId).not.toBe(originalDocument.documentId);
  expect(reloadedDocument.shellMounts).toBe(1);
  expect(await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.type)).toBe("reload");
  expect(await page.evaluate(() => history.length)).toBe(originalHistoryLength);
  expect(new URL(page.url()).search).toBe("");

  releaseSecondCatalog();
  await expect(page.locator(".player-image")).toBeVisible({ timeout: 30_000 });
  const settledProbe = await documentLifecycleProbe(page);
  expect(settledProbe.shellMounts).toBe(1);
});

test("pre-reload catalogue completion cannot mutate the new player session", async ({ page }) => {
  let releaseStaleCatalog!: () => void;
  const staleCatalogGate = new Promise<void>((resolve) => { releaseStaleCatalog = resolve; });
  let catalogRequests = 0;
  await installDocumentLifecycleProbe(page);
  await page.route("**/data/catalog.json", async (route) => {
    catalogRequests += 1;
    if (catalogRequests === 1) {
      await staleCatalogGate;
      try {
        await route.continue();
      } catch {
        // The old document's request is expected to be cancelled by reload.
      }
      return;
    }
    await route.continue();
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Photo player")).toBeVisible();
  const oldDocumentId = (await documentLifecycleProbe(page)).documentId;
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);

  const reload = page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 30_000 });
  releaseStaleCatalog();
  await reload;
  await expect(page.locator(".player-image")).toBeVisible({ timeout: 30_000 });
  const newDocument = await documentLifecycleProbe(page);
  expect(newDocument.documentId).not.toBe(oldDocumentId);
  expect(newDocument.shellMounts).toBe(1);
  expect(new URL(page.url()).search).toBe("");
});

test("Stage 1 and steady playback dismissals reset only after a full reload", async ({ page }) => {
  await installDocumentLifecycleProbe(page);
  for (const phase of ["first-five-forward", "inactive"]) {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-warmup-phase", phase, { timeout: 30_000 });
    const dismissedDocumentId = (await documentLifecycleProbe(page)).documentId;
    await closePlayerThroughDom(page);
    await page.waitForTimeout(1000);
    await expect(page.getByLabel("Photo player")).toHaveCount(0);
    expect((await documentLifecycleProbe(page)).documentId).toBe(dismissedDocumentId);
    expect(new URL(page.url()).search).toBe("");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-shell-state", "loading");
    const reloadedDocument = await documentLifecycleProbe(page);
    expect(reloadedDocument.documentId).not.toBe(dismissedDocumentId);
    expect(reloadedDocument.shellMounts).toBe(1);
    expect(new URL(page.url()).search).toBe("");
  }
});

test("same-document navigation and Back preserve dismissal", async ({ page }) => {
  await installDocumentLifecycleProbe(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Photo player")).toHaveAttribute(
    "data-player-warmup-phase",
    "first-five-forward",
    { timeout: 30_000 }
  );
  await closePlayerThroughDom(page);
  await expect(page.locator('.collection-shell[data-active-year="2013"]')).toBeVisible({ timeout: 30_000 });
  const dismissedDocumentId = (await documentLifecycleProbe(page)).documentId;

  await page.evaluate(() => {
    history.pushState(history.state, "", "/?year=2002");
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  });
  await expect(page.locator('.collection-shell[data-active-year="2002"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  expect((await documentLifecycleProbe(page)).documentId).toBe(dismissedDocumentId);

  await page.goBack({ waitUntil: "commit" });
  await expect(page.locator('.collection-shell[data-active-year="2013"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  expect((await documentLifecycleProbe(page)).documentId).toBe(dismissedDocumentId);
  expect(new URL(page.url()).search).toBe("");
});

test("excluded entries remain excluded across reload", async ({ page }) => {
  for (const path of ["/?year=2002", "/?debug=1", "/other"]) {
    await page.goto(path);
    await expect(page.locator(".collection-shell")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Photo player")).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".collection-shell")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Photo player")).toHaveCount(0);
  }

  await page.goto("/?year=2013&photo=2013-4651b733c14c76");
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-warmup-phase", "inactive", { timeout: 30_000 });
  await page.reload();
  await expect(page.getByLabel("Photo player")).toHaveAttribute("data-player-warmup-phase", "inactive", { timeout: 30_000 });
});

test("ten close-reload cycles create one bounded player session per document", async ({ page }) => {
  await installDocumentLifecycleProbe(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const historyLength = await page.evaluate(() => history.length);
  const documentIds = new Set<string>();
  const maxima = {
    playerCacheEntries: 0,
    connectedDomImages: 0,
    connectedPlayerImages: 0,
    connectedArchiveImages: 0,
    inactiveArchiveImages: 0,
    spacerArchiveImages: 0,
    otherConnectedImages: 0,
    domNodes: 0,
    heap: 0
  };
  const samples: Array<typeof maxima> = [];

  for (let cycle = 0; cycle < 10; cycle += 1) {
    await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".player-image")).toBeVisible({ timeout: 30_000 });
    const probe = await documentLifecycleProbe(page);
    documentIds.add(probe.documentId);
    expect(probe.shellMounts).toBe(1);
    const sample = await page.evaluate(() => {
      const player = document.querySelector<HTMLElement>('[aria-label="Photo player"]');
      const images = [...document.images];
      const playerImages = images.filter((image) => image.closest('[aria-label="Photo player"]'));
      const archiveImages = images.filter((image) => image.closest(".photo-tile"));
      const activeYear = document.querySelector<HTMLElement>(".collection-shell")?.dataset.activeYear;
      const memory = performance as Performance & { memory?: { usedJSHeapSize: number } };
      return {
        playerCacheEntries: Number(player?.dataset.playerCacheEntries || 0),
        connectedDomImages: document.images.length,
        connectedPlayerImages: playerImages.length,
        connectedArchiveImages: archiveImages.length,
        inactiveArchiveImages: archiveImages.filter((image) => image.closest<HTMLElement>("[data-year]")?.dataset.year !== activeYear).length,
        spacerArchiveImages: archiveImages.filter((image) => image.closest(".year-segment-spacer")).length,
        otherConnectedImages: images.length - playerImages.length - archiveImages.length,
        domNodes: document.getElementsByTagName("*").length,
        heap: memory.memory?.usedJSHeapSize || 0
      };
    });
    expect(sample.connectedPlayerImages).toBe(1);
    expect(sample.inactiveArchiveImages).toBe(0);
    expect(sample.spacerArchiveImages).toBe(0);
    expect(sample.otherConnectedImages).toBe(0);
    samples.push(sample);
    for (const key of Object.keys(maxima) as Array<keyof typeof maxima>) maxima[key] = Math.max(maxima[key], sample[key]);

    await closePlayerThroughDom(page);
    await page.waitForTimeout(750);
    await expect(page.getByLabel("Photo player")).toHaveCount(0);
    await expect(page.locator('[aria-label="Photo player"] img')).toHaveCount(0);
    expect(new URL(page.url()).search).toBe("");
    await page.reload({ waitUntil: "domcontentloaded" });
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
  }

  await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 30_000 });
  documentIds.add((await documentLifecycleProbe(page)).documentId);
  expect(documentIds.size).toBe(11);
  expect(maxima.playerCacheEntries).toBeLessThanOrEqual(15);
  expect(maxima.connectedPlayerImages).toBe(1);
  expect(maxima.connectedArchiveImages).toBeLessThanOrEqual(45);
  expect(maxima.connectedDomImages).toBeLessThanOrEqual(46);
  expect(maxima.inactiveArchiveImages).toBe(0);
  expect(maxima.spacerArchiveImages).toBe(0);
  expect(maxima.otherConnectedImages).toBe(0);
  expect(maxima.domNodes).toBeLessThanOrEqual(220);
  expect(Math.max(...samples.map(({ connectedDomImages }) => connectedDomImages)) - Math.min(...samples.map(({ connectedDomImages }) => connectedDomImages))).toBeLessThanOrEqual(20);
  expect(Math.max(...samples.map(({ domNodes }) => domNodes)) - Math.min(...samples.map(({ domNodes }) => domNodes))).toBeLessThanOrEqual(30);
  console.log(JSON.stringify({ homepageReloadCycles: { cycles: 10, documents: documentIds.size, maxima, samples } }));
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
  const peak = { pending: 0, decoded: 0, cache: 0, connectedDomImages: 0, dom: 0, heap: 0 };
  for (let sample = 0; sample < 50; sample += 1) {
    const current = await page.evaluate(() => {
      const player = document.querySelector<HTMLElement>('[aria-label="Photo player"]');
      const memory = performance as Performance & { memory?: { usedJSHeapSize: number } };
      return {
        pending: Number(player?.dataset.playerPendingImages || 0),
        decoded: Number(player?.dataset.playerDecodedImages || 0),
        cache: Number(player?.dataset.playerCacheEntries || 0),
        connectedDomImages: document.images.length,
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
  expect(peak.connectedDomImages).toBeLessThanOrEqual(80);
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
