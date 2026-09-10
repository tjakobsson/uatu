import { defineConfig, devices } from '@playwright/test';

// Isolated verification listener. Never reuse the user's live review on 4703.
export default defineConfig({
  testDir: '.', testMatch: '*.e2e.ts', workers: 1,
  globalTimeout: 1_200_000,
  outputDir: process.env.IOS_UX_OUTPUT ?? './evidence/ios-ux-after',
  reporter: 'list',
  use: { ...devices['iPhone 13'], baseURL: 'http://127.0.0.1:4704', serviceWorkers: 'block' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
  webServer: { command: 'bun -e \'import { startReviewServer } from "./tests/mobile-hub-review/server.ts"; await startReviewServer({port:4704})\'', cwd: '../..', url: 'http://127.0.0.1:4704/review/health', reuseExistingServer: false, timeout: 30_000 },
});
