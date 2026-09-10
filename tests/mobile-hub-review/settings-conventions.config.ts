import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: ["settings-conventions.e2e.ts", "folder-picker.e2e.ts"], workers: 1,
  timeout: 30_000, outputDir: "./evidence/settings-conventions-results", reporter: "list",
  use: { ...devices["iPhone 13"], browserName: "chromium", baseURL: "http://127.0.0.1:4713", serviceWorkers: "block" },
  webServer: { command: "bun -e 'import { startReviewServer } from \"./tests/mobile-hub-review/server.ts\"; await startReviewServer({port:4713})'", cwd: "../..", url: "http://127.0.0.1:4713/review/health", reuseExistingServer: false, timeout: 30_000 },
});
