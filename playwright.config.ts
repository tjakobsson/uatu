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
  // 0` keeps tests strict so flakes surface immediately. The trace is
  // recorded on every attempt and kept only when it fails: a flake that
  // passes on retry fails first, and "on-first-retry" left exactly that
  // first failure without evidence. Tests that launch their own browser
  // (the WebKit viewport and frame-budget suites) are outside this context
  // and record only the API calls.
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
    trace: "retain-on-failure",
  },
});
