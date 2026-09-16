import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildYearSegmentLayout } from "../src/archive/yearSegmentLayout";
import { buildYearCollection, type AlbumLoadResult } from "../src/data/useYearCollection";
import type { AlbumManifest, YearIndex } from "../src/types";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const production2001 = loadProductionYear("2001");

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8")) as T;
}

function loadProductionYear(year: string) {
  const sourceIndex = readJson<YearIndex>(`public/data/${year}/index.json`);
  const albumResults: AlbumLoadResult[] = sourceIndex.albums.map((album) => ({
    status: "ready",
    album,
    manifest: readJson<AlbumManifest>(`public/${album.manifestUrl}`)
  }));
  return buildYearCollection(["2013", "2002", "2001"], sourceIndex, albumResults);
}

function expectedHeight(width: number, viewportHeight: number) {
  const compactViewport = viewportHeight <= 460 && width >= 620;
  const targetRowHeight = compactViewport ? 184 : width < 520 ? 138 : width < 900 ? 146 : 174;
  const gap = width < 520 ? 3 : 4;
  return buildYearSegmentLayout({
    collection: production2001,
    width,
    targetRowHeight,
    gap,
    compactViewport
  }).totalHeight;
}

async function waitForYear(page: Page, year: string) {
  await expect(page.locator(`.collection-shell[data-active-year="${year}"][data-mounted-years="${year}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".photo-tile").first()).toBeVisible({ timeout: 20_000 });
}

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`predicted 2001 segment height matches rendered height at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?year=2001");
    await waitForYear(page, "2001");

    const measured = await page.locator("#photo-grid").evaluate((grid) => {
      const rect = grid.getBoundingClientRect();
      return {
        gridWidth: Math.round(rect.width),
        renderedHeight: rect.height,
        styleHeight: Number.parseFloat(getComputedStyle(grid).height),
        viewportHeight: window.innerHeight,
        imageElements: grid.querySelectorAll("img").length
      };
    });
    const predictedHeight = expectedHeight(measured.gridWidth, measured.viewportHeight);
    const renderedDiff = Math.abs(measured.renderedHeight - predictedHeight);
    const styleDiff = Math.abs(measured.styleHeight - predictedHeight);
    console.log(JSON.stringify({
      viewportWidth: width,
      gridWidth: measured.gridWidth,
      predictedHeight,
      renderedHeight: measured.renderedHeight,
      styleHeight: measured.styleHeight,
      renderedDiff,
      styleDiff,
      mountedImageElements: measured.imageElements
    }));

    expect(renderedDiff).toBeLessThanOrEqual(0.01);
    expect(styleDiff).toBeLessThanOrEqual(0.01);
  });
}
