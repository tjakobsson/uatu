import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

function config(ci: boolean) {
  const env = { ...process.env };
  delete env.CI;
  delete env.UATU_E2E_LEG;
  delete env.JEST_WORKER_ID;
  if (ci) env.CI = "true";
  const result = Bun.spawnSync([
    process.execPath, "--eval",
    'import config from "./playwright.config.ts"; console.log(JSON.stringify(config));',
  ], { cwd: fileURLToPath(new URL("..", import.meta.url)), env });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

test("CI traces the first retry without recording every passing first attempt", () => {
  const ci = config(true);
  const functional = ci.projects.find((project: { name: string }) => project.name === "e2e");
  expect(functional.use.trace).toBe("on-first-retry");
  expect(functional.use.screenshot).toBe("only-on-failure");
  // Runtime savings come from recording policy, not weaker execution budgets.
  expect(ci.workers).toBe(4);
  expect(ci.retries).toBe(2);
  expect(ci.timeout).toBe(30_000);
  expect(ci.expect.timeout).toBe(10_000);
  const perf = ci.projects.find((project: { name: string }) => project.name === "perf");
  expect(perf.workers).toBe(2);
  expect(perf.use).toBeUndefined();
  expect(ci.use.trace).toBe("on-first-retry");
});

test("local runs remain strict and do not trace passing first attempts", () => {
  const local = config(false);
  expect(local.retries).toBe(0);
  expect(local.projects.find((project: { name: string }) => project.name === "e2e").use)
    .toEqual({ trace: "on-first-retry", screenshot: "off" });
});
