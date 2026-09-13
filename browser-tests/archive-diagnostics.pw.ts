import { expect, test, type Page } from "@playwright/test";

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
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-mounted-years", year);
}

test("diagnostics remain absent from normal visits", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Archive diagnostics")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.getAttributeNames().some((name) => name.startsWith("data-debug-")))).toBe(false);
});

test("debug mode exposes local diagnostics, overlays, copy, download, and reset", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?debug=1");
  await expect(page.locator(".collection-shell")).toHaveAttribute("data-mounted-years", "2013");
  for (const year of ["2001", "2002", "2013"]) {
    await jumpArchiveToYear(page, year);
  }
  const panel = page.getByLabel("Archive diagnostics");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Expand" }).click();
  await expect(panel).toContainText("Build");
  await expect(panel).toContainText("Year states");

  await panel.getByText("Layout overlays").click();
  await panel.getByLabel("Virtual row bounds").check();
  await expect(page.locator("html")).toHaveAttribute("data-debug-rows", "");
  await page.evaluate(() => window.scrollBy(0, 1200));

  await panel.getByRole("button", { name: "Copy diagnostics" }).click();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied.schema).toBe("640x480-year-window-qa-v1");
  expect(copied.events.length).toBeGreaterThan(0);
  expect(copied.events.length).toBeLessThanOrEqual(200);
  expect(copied.mountedPhotos).toBeGreaterThan(0);
  expect(copied.mountedYears).toEqual(["2013"]);
  expect(copied.inactiveImageElements).toBe(0);
  expect(copied.yearCacheEntries).toBe(2);
  expect(copied.retainedYearLayouts).toEqual(["2013"]);
  expect(copied.events.filter((event: { type: string }) => event.type === "archive-bound-warning")).toHaveLength(0);

  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download diagnostics" }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/^640x480-diagnostics-.*\.json$/);

  await panel.getByRole("button", { name: "Reset diagnostics" }).click();
  await expect(panel.getByText(/1\/200 events/)).toBeVisible();
});
