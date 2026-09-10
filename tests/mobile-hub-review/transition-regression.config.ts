import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "continuity.e2e.ts", workers: 1,
  outputDir: "./evidence/transition-regression-results", reporter: "list",
  use: { ...devices["iPhone 13"], baseURL: "http://127.0.0.1:4706", serviceWorkers: "block" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }, { name: "webkit", use: { browserName: "webkit" } }],
  webServer: { command: "bun server.ts --port 4706", url: "http://127.0.0.1:4706/review/health", reuseExistingServer: false, timeout: 30_000 },
});
