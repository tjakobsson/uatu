import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "ios-ux.e2e.ts", workers: 1,
  outputDir: process.env.IOS_UX_OUTPUT ?? "./evidence/ios-ux-results", reporter: "list",
  use: { ...devices["iPhone 13"], browserName: "chromium", baseURL: "http://127.0.0.1:4704", serviceWorkers: "block" },
  webServer: { command: "bun -e 'import { startReviewServer } from \"./tests/mobile-hub-review/server.ts\"; await startReviewServer({port:4704})'", cwd: "../..", url: "http://127.0.0.1:4704/review/health", reuseExistingServer: false, timeout: 30_000 },
});
