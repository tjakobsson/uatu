import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["preview-examples.e2e.ts", "hub-controls.e2e.ts", "focused-picker.e2e.ts", "folder-picker.e2e.ts"],
  workers: 1, retries: 0, timeout: 30_000, globalTimeout: 240_000,
  reporter: [["list"], ["json", { outputFile: new URL("../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/preview-refinement/browser-results.json", import.meta.url).pathname }]],
  outputDir: "./evidence/preview-refinement-results",
  use: { baseURL: "http://127.0.0.1:4731", serviceWorkers: "block", screenshot: "only-on-failure" },
  projects: ["chromium", "webkit"].map(browserName => ({ name: browserName, use: { ...devices["iPhone 13"], browserName: browserName as "chromium" | "webkit", viewport: { width: 390, height: 844 } } })),
  webServer: { command: 'bun -e \'import {startReviewServer} from "./tests/mobile-hub-review/server.ts"; await startReviewServer({port:4731})\'', cwd: "../..", url: "http://127.0.0.1:4731/review/health", reuseExistingServer: false, timeout: 30_000 },
});
