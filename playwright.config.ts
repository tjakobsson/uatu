import { defineConfig, devices } from "@playwright/test";

// Per-worker servers are spawned by the `serverPort` fixture in
// `tests/e2e/fixtures.ts`; the global `webServer` config is intentionally
// omitted so each worker can bring up its own server on a distinct port
// + workspace. Tests should import `{ test, expect }` from `./fixtures`
// rather than from `@playwright/test` so the worker-scoped fixture runs.

// Tests tagged `@perf` hold a frame, interaction, or load budget that
// neighbouring workers can eat into. They form their own project with a
// lower worker limit; every other test is in `e2e`. The two patterns are
// exact complements, so each test belongs to exactly one project and
// `playwright test` still runs the whole suite.
const PERF = /@perf\b/;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  workers: 4,
  // CI re-runs failed tests up to twice so parallel-worker flakes don't
  // block PRs; real regressions still fail consistently. Locally `retries:
  // 0` keeps tests strict so flakes surface immediately. The per-project
  // `trace` settings below keep debug artifacts for failures and retries,
  // so chronic flakes remain investigable.
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  // CI runs the suite in parallel jobs (shards of `e2e`, plus `perf`); each
  // writes a blob report that the workflow merges into one HTML report.
  reporter: process.env.CI
    ? [["github"], ["blob"]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "e2e",
      grepInvert: PERF,
      use: {
        // On CI, keep the trace of a test's first failing attempt; retries
        // run untraced, so the attempt most likely to pass does not pay
        // for tracing again. Locally (no retries) nothing is traced.
        trace: process.env.CI ? "retain-on-first-failure" : "on-first-retry",
      },
    },
    {
      name: "perf",
      grep: PERF,
      // Tracing slows exactly what these tests measure, so they keep
      // `on-first-retry`, and run at most two at a time.
      workers: 2,
    },
  ],
});
