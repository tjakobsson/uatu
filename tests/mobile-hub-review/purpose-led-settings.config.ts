import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "purpose-led-settings.e2e.ts", workers: 1, retries: 0,
  timeout: 30_000, outputDir: "./evidence/purpose-led-settings-results", reporter: "list",
  use: { ...devices["iPhone 13"], browserName: "chromium", baseURL: "http://127.0.0.1:4714", serviceWorkers: "block" },
  webServer: { command: "bun -e 'import { startReviewServer } from \"./tests/mobile-hub-review/server.ts\"; await startReviewServer({port:4714})'", cwd: "../..", url: "http://127.0.0.1:4714/review/health", reuseExistingServer: false, timeout: 30_000 },
});
