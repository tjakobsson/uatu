import { defineConfig, devices } from "@playwright/test";

import { E2E_PORT } from "./src/e2e";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: "bun run src/e2e-server.ts",
    url: `http://127.0.0.1:${E2E_PORT}`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
