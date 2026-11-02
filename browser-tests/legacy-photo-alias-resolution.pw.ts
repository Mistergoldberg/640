import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const targetPhotoId = JSON.parse(
  fs.readFileSync(path.join(APP_ROOT, "public/data/2026/index.json"), "utf8")
).sequence[0].id as string;
const digest = "a".repeat(64);

test("an absent optional alias map does not block catalogue bootstrap", async ({ page }) => {
  await page.route("**/data/photo-id-aliases.json", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>SPA fallback</title>" });
  });

  await page.goto("/?year=2026");
  await expect(page.getByRole("heading", { name: "2026" }).first()).toBeVisible();
  await expect(page.getByText("Catalogue data could not be loaded")).toHaveCount(0);
});

test("an approved cross-year alias replaces a legacy public photo URL", async ({ page }) => {
  const oldPhotoId = "2001-00000000000000";
  await page.route("**/data/photo-id-aliases.json", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        status: "approved",
        packageId: digest,
        packageClosedWorldSha256: digest,
        transitionLedgerSha256: digest,
        aliases: [{ oldYear: "2001", oldPhotoId, newYear: "2026", newPhotoId: targetPhotoId }],
        retired: []
      })
    });
  });

  await page.goto(`/?year=2001&photo=${oldPhotoId}`);
  await expect.poll(() => {
    const url = new URL(page.url());
    return { year: url.searchParams.get("year"), photo: url.searchParams.get("photo") };
  }).toEqual({ year: "2026", photo: targetPhotoId });
});
