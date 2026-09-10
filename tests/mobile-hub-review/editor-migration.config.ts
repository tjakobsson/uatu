import { defineConfig, devices } from '@playwright/test';

/** Five current editor cases only. Never reuse the user-owned :4703 instance. */
export default defineConfig({
  testDir: '.',
  testMatch: ['settings-conventions.e2e.ts', 'credential-ux.e2e.ts', 'credential-clone-contract.e2e.ts', 'exceptional.e2e.ts'],
  grep: /Settings keeps grouped|Default Folder has top Back|Unlock and tool Test keep pending|tool Save pending\/failure|default-folder fallback and local\/server/,
  workers: 1, retries: 0, timeout: 30_000, globalTimeout: 180_000,
  expect: { timeout: 5_000 }, reporter: 'list',
  outputDir: './evidence/editor-migration-results',
  use: { ...devices['iPhone 13'], browserName: 'chromium', baseURL: 'http://127.0.0.1:4723', serviceWorkers: 'block', reducedMotion: 'reduce', navigationTimeout: 10_000 },
  webServer: {
    command: `bun -e 'import { startReviewServer } from "./tests/mobile-hub-review/server.ts"; await startReviewServer({port:4723})'`,
    cwd: '../..', url: 'http://127.0.0.1:4723/review/health', reuseExistingServer: false, timeout: 30_000,
  },
});
