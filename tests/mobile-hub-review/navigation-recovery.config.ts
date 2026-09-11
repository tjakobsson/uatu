import { defineConfig } from "@playwright/test";
import refinement from "./preview-refinement.config";

export default defineConfig({
  ...refinement,
  testMatch: ["navigation-corrections.e2e.ts", "preview-siblings.e2e.ts", "preview-examples.e2e.ts", "hub-controls.e2e.ts", "focused-picker.e2e.ts", "folder-picker.e2e.ts"],
  outputDir: "./evidence/navigation-recovery-results",
  reporter: [["list"], ["json", { outputFile: new URL("../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/navigation-recovery/browser-results.json", import.meta.url).pathname }]],
  use: { ...refinement.use, baseURL: "http://127.0.0.1:4732" },
  webServer: { command: 'bun -e \'import {startReviewServer} from "./tests/mobile-hub-review/server.ts"; await startReviewServer({port:4732})\'', cwd: "../..", url: "http://127.0.0.1:4732/review/health", reuseExistingServer: false, timeout: 30_000 },
});
