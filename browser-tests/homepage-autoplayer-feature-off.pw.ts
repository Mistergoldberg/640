import { expect, test } from "@playwright/test";

const enabled = process.env.VITE_HOMEPAGE_AUTOPLAYER === "1";
test.skip(enabled, "feature-off coverage requires VITE_HOMEPAGE_AUTOPLAYER to be disabled");

test("feature-off reload remains archive mode without adding history", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const historyLength = await page.evaluate(() => history.length);
  await expect(page.locator(".collection-shell")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Photo player")).toHaveCount(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".collection-shell")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Photo player")).toHaveCount(0);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
});
