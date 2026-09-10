import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/mobile-hub-review", testMatch: "**/*.e2e.ts", workers: 1,
  outputDir: "./tests/mobile-hub-review/results", reporter: "list",
  use: { ...devices["iPhone 13"], baseURL: "http://127.0.0.1:4703", serviceWorkers: "block" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }, { name: "webkit", use: { browserName: "webkit" } }],
  webServer: { command: "bun tests/mobile-hub-review/server.ts", url: "http://127.0.0.1:4703/review/health", reuseExistingServer: false, timeout: 30_000 },
});
