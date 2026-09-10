import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "credential-ux.e2e.ts", workers: 1,
  outputDir: "./evidence/credential-ux-results", reporter: "list",
  use: { ...devices["iPhone 13"], browserName: "chromium", baseURL: "http://127.0.0.1:4706", serviceWorkers: "block" },
  webServer: { command: "bun -e 'import { startReviewServer } from \"./tests/mobile-hub-review/server.ts\"; await startReviewServer({port:4706})'", cwd: "../..", url: "http://127.0.0.1:4706/review/health", reuseExistingServer: false, timeout: 30_000 },
});
