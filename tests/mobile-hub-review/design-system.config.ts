import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "design-system.e2e.ts", workers: 1,
  outputDir: "./evidence/design-system-results", reporter: "list",
  use: { browserName: "chromium", viewport: { width: 390, height: 844 }, serviceWorkers: "block" },
});
