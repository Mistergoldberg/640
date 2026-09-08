import { expect, test } from "@playwright/test";

test("diagnostics remain absent from normal visits", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Archive diagnostics")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.getAttributeNames().some((name) => name.startsWith("data-debug-")))).toBe(false);
});

test("debug mode exposes local diagnostics, overlays, copy, download, and reset", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?debug=1");
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
  expect(copied.schema).toBe("640x480-ios-qa-v1");
  expect(copied.events.length).toBeGreaterThan(0);
  expect(copied.events.length).toBeLessThanOrEqual(200);
  expect(copied.mountedPhotos).toBeGreaterThan(0);

  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download diagnostics" }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/^640x480-diagnostics-.*\.json$/);

  await panel.getByRole("button", { name: "Reset diagnostics" }).click();
  await expect(panel.getByText(/1\/200 events/)).toBeVisible();
});
