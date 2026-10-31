import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { currentCatalogueFixture } from "./support/catalogue";

const fixture = currentCatalogueFixture();
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==", "base64");

async function syntheticMedia(page: Page) {
  await page.route("https://media.pixilation.org/**", (route) => route.fulfill({ status: 200, contentType: "image/jpeg", body: JPEG }));
}

async function waitForYear(page: Page, year: string) {
  await expect(page.locator(`.collection-shell[data-active-year="${year}"][data-mounted-years="${year}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".photo-tile").first()).toBeVisible({ timeout: 20_000 });
}

async function openPhoto(page: Page, photoId: string) {
  await page.goto(`/?year=${fixture.newest}&photo=${photoId}`);
  await expect(page.getByLabel("Photo player")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.locator(".player-image").last().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
}

test.beforeEach(async ({ page }) => syntheticMedia(page));

test("served artifact identity matches this source, runtime contract, flags, and catalogue", async ({ request, baseURL }) => {
  const response = await request.get(`${baseURL}/build-identity.json`);
  expect(response.ok()).toBe(true);
  const identity = await response.json();
  expect(identity.schema).toBe("pixilation-build-identity-v1");
  const expectedCommit = process.env.PIXILATION_EXPECTED_BUILD_COMMIT || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  expect(identity.source.commit).toBe(expectedCommit);
  expect(identity.runtime.node).toMatch(/^v24\./);
  expect(identity.runtime.npm).toMatch(/^11\./);
  expect(identity.settings).toEqual({ appBasePath: "/", mediaBaseUrl: "https://media.pixilation.org/", homepageAutoplayer: false, seamlessYearSegments: false });
  expect(identity.catalogue.fileCount).toBeGreaterThan(100);
  expect(identity.catalogue.treeSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(identity.artifacts.fileCount).toBeGreaterThan(100);
  expect(identity.artifacts.treeSha256).toMatch(/^[a-f0-9]{64}$/);
});

test("root derives the newest year and keeps rendering bounded", async ({ page }) => {
  await page.goto("/");
  await waitForYear(page, fixture.newest);
  await expect(page).toHaveURL(new RegExp(`year=${fixture.newest}`));
  await expect(page.getByRole("heading", { name: fixture.newest, exact: true })).toBeVisible();
  expect(await page.locator(".photo-tile").count()).toBeLessThanOrEqual(100);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
  await expect.poll(() => page.locator(".photo-tile").count()).toBeLessThanOrEqual(100);
});

test("catalogue-derived adjacent year navigation preserves Back and Forward history", async ({ page }) => {
  await page.goto("/");
  await waitForYear(page, fixture.newest);
  await page.getByRole("button", { name: `Older photos: ${fixture.adjacent}` }).click();
  await waitForYear(page, fixture.adjacent);
  await expect(page).toHaveURL(new RegExp(`year=${fixture.adjacent}`));
  await page.goBack();
  await waitForYear(page, fixture.newest);
  await page.goForward();
  await waitForYear(page, fixture.adjacent);
});

test("catalogue-derived oldest-year deep link restores a stable anchor after reload", async ({ page }) => {
  await page.goto(`/?year=${fixture.oldest}`);
  await waitForYear(page, fixture.oldest);
  await page.evaluate(() => window.scrollBy(0, 1800));
  await expect.poll(() => page.evaluate(() => history.state?.restoration?.photoId || null)).not.toBeNull();
  const before = await page.evaluate(() => history.state.restoration.photoId);
  await page.reload();
  await waitForYear(page, fixture.oldest);
  await expect.poll(() => page.evaluate(() => history.state?.restoration?.photoId || null)).toBe(before);
});

test("catalogue-derived photo deep link opens, closes, and restores through history", async ({ page }) => {
  await openPhoto(page, fixture.landscape.id);
  await expect(page).toHaveURL(new RegExp(`year=${fixture.newest}.*photo=${fixture.landscape.id}`));
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`year=${fixture.newest}(?!.*photo)`));
  await expect(page.locator(`[data-photo-id="${fixture.landscape.id}"]`)).toBeFocused();
  await page.locator(`[data-photo-id="${fixture.landscape.id}"]`).click();
  await expect(page.getByLabel("Photo player")).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByLabel("Photo player")).toBeVisible();
});

test("representative current portrait and landscape photos decode in the player", async ({ page }) => {
  for (const photo of [fixture.portrait, fixture.landscape]) {
    await openPhoto(page, photo.id);
    await expect(page.locator(`.player-image--${photo.orientation}`).last()).toBeVisible();
  }
});
