import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
export default defineConfig({
  testDir: ".", testMatch: "domain-ios.e2e.ts", workers: 1,
  outputDir: process.env.DOMAIN_IOS_OUTPUT ?? join(tmpdir(), "opencode", "domain-ios-results"),
  use: { ...devices["iPhone 13"], browserName: "chromium", baseURL: "http://127.0.0.1:4704", serviceWorkers: "block" },
  webServer: { command: "bun -e 'import { startReviewServer } from \"./tests/mobile-hub-review/server.ts\"; await startReviewServer({port:4704})'", cwd: "../..", url: "http://127.0.0.1:4704/review/health", reuseExistingServer: false },
});
