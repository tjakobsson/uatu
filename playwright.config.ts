import { defineConfig, devices } from "@playwright/test";

// Per-worker servers are spawned by the `serverPort` fixture in
// `tests/e2e/fixtures.ts`; the global `webServer` config is intentionally
// omitted so each worker can bring up its own server on a distinct port
// + workspace. Tests should import `{ test, expect }` from `./fixtures`
// rather than from `@playwright/test` so the worker-scoped fixture runs.

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  workers: 4,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "on-first-retry",
  },
});
