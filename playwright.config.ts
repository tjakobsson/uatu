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
  // CI re-runs failed tests up to twice so parallel-worker flakes don't
  // block PRs; real regressions still fail consistently. Locally `retries:
  // 0` keeps tests strict so flakes surface immediately. The `trace:
  // "on-first-retry"` config below captures debug artifacts when a retry
  // happens, so chronic flakes remain investigable. Revisit later as part
  // of a broader e2e-harness pass.
  retries: process.env.CI ? 2 : 0,
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
