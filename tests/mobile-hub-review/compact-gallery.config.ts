import { defineConfig, devices } from "@playwright/test";
import { galleryEngines, galleryViewport } from "./compact-gallery";

export default defineConfig({
  testDir: ".", testMatch: ["compact-gallery.e2e.ts", "compact-publisher.e2e.ts"], workers: 1, retries: 0,
  timeout: 30_000, globalTimeout: 180_000,
  outputDir: "./results/artifacts/compact-gallery/playwright",
  reporter: [["list"], ["json", { outputFile: new URL("./results/artifacts/compact-gallery/results.json", import.meta.url).pathname }]],
  use: { baseURL: "http://127.0.0.1:4732", serviceWorkers: "block", reducedMotion: "reduce", colorScheme: "light" },
  projects: galleryEngines.map(browserName => ({ name: browserName, use: { ...devices["iPhone 13"], browserName, viewport: { width: galleryViewport.width, height: galleryViewport.height }, deviceScaleFactor: galleryViewport.deviceScaleFactor } })),
  webServer: { command: 'bun -e \'import {startReviewServer} from "./tests/mobile-hub-review/server.ts"; import {buildEvidenceAssets} from "./tests/mobile-hub-review/hosting-evidence.ts"; await startReviewServer({port:4732,evidenceAssets:await buildEvidenceAssets()})\'', cwd: "../..", url: "http://127.0.0.1:4732/review/health", reuseExistingServer: false, timeout: 30_000 },
});
