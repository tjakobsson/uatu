import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
export default defineConfig({
  testDir: ".", testMatch: "contextual-error.e2e.ts", workers: 1,
  outputDir: join(tmpdir(), "opencode", "contextual-error-results"),
  use: { ...devices["iPhone 13"], browserName: "chromium", baseURL: "http://127.0.0.1:4709", serviceWorkers: "block" },
  webServer: { command: "bun -e 'import { startReviewServer } from \"./tests/mobile-hub-review/server.ts\"; await startReviewServer({port:4709})'", cwd: "../..", url: "http://127.0.0.1:4709/review/health", reuseExistingServer: false },
});
