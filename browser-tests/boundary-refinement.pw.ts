import { expect, test, type Page } from "@playwright/test";

async function waitForYear(page: Page, year: string) {
  await expect(page.locator(`.collection-shell[data-active-year="${year}"][data-mounted-years="${year}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".photo-tile").first()).toBeVisible({ timeout: 20_000 });
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
  await waitForYear(page, year);
}

test("direct 2001 landing leads with its heading and keeps the compact newer control above the content viewport", async ({ page }) => {
  await page.goto("/?year=2001");
  await waitForYear(page, "2001");
  const heading = page.getByRole("heading", { name: "2001", exact: true });
  const boundary = page.getByRole("button", { name: "Newer photos: 2002" });
  await expect(heading).toBeVisible();
  await expect(page.locator(".photo-tile").first()).toBeVisible();
  await expect(boundary).toHaveText(/Newer photos: 2002/);
  await expect(page.locator(".archive-year-boundary small")).toHaveCount(0);
  const [chromeBox, boundaryBox, headingBox] = await Promise.all([
    page.locator(".collection-chrome").boundingBox(),
    boundary.boundingBox(),
    heading.boundingBox()
  ]);
  expect(boundaryBox!.height).toBeGreaterThanOrEqual(44);
  expect(boundaryBox!.height).toBeLessThanOrEqual(48);
  expect(boundaryBox!.width).toBeLessThan(220);
  expect(boundaryBox!.y + boundaryBox!.height).toBeLessThanOrEqual(chromeBox!.y + chromeBox!.height + 2);
  expect(headingBox!.y).toBeGreaterThanOrEqual(chromeBox!.y + chromeBox!.height - 2);
  await expect(page.getByRole("navigation", { name: "Archive years" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Jump to \d{4}/ })).toHaveCount(0);
  await expect(page.locator(".album-context")).toHaveAttribute("aria-hidden", "true");
});

test("bottom boundary is compact, directional, and requires explicit activation", async ({ page }) => {
  await page.goto("/?year=2013");
  await waitForYear(page, "2013");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const boundary = page.getByRole("button", { name: "Older photos: 2002" });
  await expect(boundary).toBeVisible();
  await expect(page).toHaveURL(/year=2013/);
  const box = await boundary.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeLessThanOrEqual(48);
  expect(box!.width).toBeLessThan(220);
  await page.mouse.wheel(0, 1200);
  await expect(page).toHaveURL(/year=2013/);
  await boundary.click();
  await waitForYear(page, "2002");
  await expect(page).toHaveURL(/year=2002/);
});

test("newer boundary restores a saved stable position without exposing restoration copy", async ({ page }) => {
  await page.goto("/?year=2013");
  await waitForYear(page, "2013");
  await page.evaluate(() => window.scrollTo(0, 9000));
  await expect.poll(() => page.evaluate(() => history.state?.restoration?.photoId || null)).not.toBeNull();
  const savedPhoto = await page.evaluate(() => history.state.restoration.photoId as string);
  await jumpArchiveToYear(page, "2002");
  await page.evaluate(() => window.scrollTo(0, 0));
  const newer = page.getByRole("button", { name: "Newer photos: 2013" });
  await expect(newer).toBeVisible();
  await expect(page.getByText(/Restore the last stable position/i)).toHaveCount(0);
  await newer.click();
  await waitForYear(page, "2013");
  await expect(page.locator(`[data-photo-id="${savedPhoto}"]`)).toBeVisible();
});

test("sticky year and album context replace inline headings instead of duplicating them", async ({ page }) => {
  await page.goto("/?year=2001");
  await waitForYear(page, "2001");
  await expect(page.getByRole("navigation", { name: "Archive years" })).toHaveCount(0);
  await page.evaluate(() => window.scrollBy(0, 1600));
  await expect(page.getByRole("navigation", { name: "Archive years" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "2001", exact: true })).not.toBeInViewport();
  await expect(page.locator(".album-context")).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator(".album-context__folder")).toContainText(/^2001-/);
});

test("scrubber year jump uses one unified history action", async ({ page }) => {
  await page.addInitScript(() => {
    const target = window as typeof window & { __pushes: number };
    target.__pushes = 0;
    const push = history.pushState.bind(history);
    history.pushState = (...args) => {
      target.__pushes += 1;
      return push(...args);
    };
  });
  await page.goto("/?year=2013");
  await waitForYear(page, "2013");
  await page.evaluate(() => { (window as typeof window & { __pushes: number }).__pushes = 0; });
  await pressScrubberKey(page, "End");
  await waitForYear(page, "2001");
  expect(await page.evaluate(() => (window as typeof window & { __pushes: number }).__pushes)).toBe(1);
  await page.goBack();
  await waitForYear(page, "2013");
  await page.goForward();
  await waitForYear(page, "2001");
});
