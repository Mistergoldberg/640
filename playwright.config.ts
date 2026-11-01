import { defineConfig } from "@playwright/test";
import path from "node:path";

const externalBaseURL = process.env.PIXILATION_PLAYWRIGHT_BASE_URL?.trim();
const matrix = process.env.PIXILATION_BROWSER_MATRIX === "1";
const profile = process.env.PIXILATION_ACCEPTANCE_PROFILE || "default-off-off";
if (externalBaseURL && !process.env.PIXILATION_EXPECTED_BUILD_COMMIT?.trim()) {
  throw new Error("PIXILATION_EXPECTED_BUILD_COMMIT is required with PIXILATION_PLAYWRIGHT_BASE_URL");
}

export default defineConfig({
  testDir: "./browser-tests",
  testMatch: matrix
    ? ["**/current-catalogue-acceptance.pw.ts", "**/optional-feature-acceptance.pw.ts"]
    : "**/current-catalogue-acceptance.pw.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [
    ["line"],
    [path.resolve("scripts/playwright-acceptance-reporter.mjs"), { profile }]
  ],
  use: {
    baseURL: externalBaseURL || "http://127.0.0.1:4174",
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure"
  },
  webServer: externalBaseURL ? undefined : {
    command: "VITE_APP_BASE_PATH=/ VITE_MEDIA_BASE_URL=https://media.pixilation.org/ npm run build && npm run preview -- --port 4174 --strictPort",
    url: "http://127.0.0.1:4174/build-identity.json",
    reuseExistingServer: false,
    timeout: 120_000
  }
});
