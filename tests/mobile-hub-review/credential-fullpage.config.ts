import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "credential-fullpage.e2e.ts", workers: 1,
  timeout: 30_000, globalTimeout: 30_000, reporter: "list",
  outputDir: "./evidence/credential-fullpage-results",
  use: { ...devices["iPhone 13"], browserName: "chromium", baseURL: "http://127.0.0.1:4721", serviceWorkers: "block" },
  webServer: { command: "bun -e 'import { startReviewServer } from \"./tests/mobile-hub-review/server.ts\"; await startReviewServer({port:4721})'", cwd: "../..", url: "http://127.0.0.1:4721/review/health", reuseExistingServer: false, timeout: 30_000 },
});
