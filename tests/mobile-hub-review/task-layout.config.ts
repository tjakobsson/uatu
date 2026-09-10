import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: ["task-layout.e2e.ts", "domain-ios.e2e.ts"], workers: 1,
  outputDir: "./evidence/task-layout-results", reporter: "list",
  use: { ...devices["iPhone 13"], browserName: "chromium", baseURL: "http://127.0.0.1:4705", serviceWorkers: "block" },
  webServer: { command: "bun -e 'import { startReviewServer } from \"./tests/mobile-hub-review/server.ts\"; await startReviewServer({port:4705})'", cwd: "../..", url: "http://127.0.0.1:4705/review/health", reuseExistingServer: false, timeout: 30_000 },
});
