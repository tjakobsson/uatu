import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json";
import { checkPortLayout } from "../tests/e2e/ports";
import { unitTestCommand } from "./test-ci";
import { availableCores, MAX_WORKERS, testWorkers } from "./test-workers";

function config(ci: boolean, workers?: string, ports?: { base: string; hub: string }) {
  const env = { ...process.env };
  delete env.CI;
  delete env.UATU_E2E_LEG;
  delete env.JEST_WORKER_ID;
  delete env.UATU_TEST_WORKERS;
  if (ci) env.CI = "true";
  if (workers !== undefined) env.UATU_TEST_WORKERS = workers;
  if (ports) {
    env.UATU_E2E_BASE_PORT = ports.base;
    env.UATU_E2E_HUB_BASE_PORT = ports.hub;
  }
  // --no-env-file: a local .env must not put back what this deleted.
  const result = Bun.spawnSync([
    process.execPath, "--no-env-file", "--eval",
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
  expect(ci.workers).toBe(testWorkers({}, availableCores()));
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

test("both runners take one worker per available core, from one floor to one ceiling", () => {
  // CI's runners have four cores, so CI keeps its four workers.
  expect(testWorkers({}, 4)).toBe(4);
  expect(testWorkers({}, 2)).toBe(2);
  expect(testWorkers({}, 1)).toBe(1);
  expect(testWorkers({}, 0)).toBe(1);
  expect(testWorkers({}, MAX_WORKERS)).toBe(MAX_WORKERS);
  expect(testWorkers({}, 64)).toBe(MAX_WORKERS);
  expect(MAX_WORKERS).toBe(8);
});

test("UATU_TEST_WORKERS sets the count exactly, past the ceiling too, and rejects anything else", () => {
  expect(testWorkers({ UATU_TEST_WORKERS: "2" }, 16)).toBe(2);
  expect(testWorkers({ UATU_TEST_WORKERS: "12" }, 4)).toBe(12);
  expect(testWorkers({ UATU_TEST_WORKERS: "" }, 4)).toBe(4);
  for (const bad of ["0", "-1", "2.5", "four", " 4"]) {
    expect(() => testWorkers({ UATU_TEST_WORKERS: bad }, 4)).toThrow("UATU_TEST_WORKERS");
  }
});

test("Playwright and test:ci both take their worker count from the shared helper", () => {
  const overridden = config(true, "3");
  expect(overridden.workers).toBe(3);
  // The perf project keeps its own cap: it protects frame and interaction budgets.
  expect(overridden.projects.find((project: { name: string }) => project.name === "perf").workers).toBe(2);

  expect(packageJson.scripts["test:ci"]).toBe("bun run scripts/test-ci.ts");
  expect(unitTestCommand(["--update-timings"], { UATU_TEST_WORKERS: "6" }, 4).slice(1)).toEqual([
    "test", "--parallel=6", "--timings=tests/unit-timings.json", "--update-timings",
  ]);
  expect(unitTestCommand([], {}, 4)).toContain("--parallel=4");
});

test("e2e port ranges must stay disjoint and below the ephemeral range for the worker count", () => {
  // Each slot (parallelIndex, 0..workers-1) takes one harness port and a hub
  // block of 10; Linux hands out ephemeral ports from 32768.
  expect(() => checkPortLayout(MAX_WORKERS, 20000, 21000)).not.toThrow();
  expect(() => checkPortLayout(4, 20000, 20004)).not.toThrow();
  expect(() => checkPortLayout(5, 20000, 20004)).toThrow("overlap");
  expect(() => checkPortLayout(5, 20005, 20000)).toThrow("overlap");
  expect(() => checkPortLayout(1000, 20000, 21000)).not.toThrow();
  expect(() => checkPortLayout(1001, 20000, 21000)).toThrow("overlap");
  expect(() => checkPortLayout(176, 30000, 31000)).not.toThrow();
  expect(() => checkPortLayout(177, 30000, 31000)).toThrow("ephemeral");
  expect(() => checkPortLayout(999_999_999, 20000, 21000)).toThrow("UATU_TEST_WORKERS");
});

test("Playwright refuses a worker count whose port ranges would collide", () => {
  expect(config(false, "4", { base: "20000", hub: "20004" }).workers).toBe(4);
  expect(() => config(false, "5", { base: "20000", hub: "20004" })).toThrow("overlap");
});
