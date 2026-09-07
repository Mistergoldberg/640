import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser-tests",
  testMatch: "**/*.pw.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4174",
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure"
  },
  webServer: {
    command: "VITE_APP_BASE_PATH=/ VITE_MEDIA_BASE_URL=https://media.insertcatchytitlehere.com/ npm run build && npm run preview -- --port 4174",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: true,
    timeout: 120_000
  }
});
