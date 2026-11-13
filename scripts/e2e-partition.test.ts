import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

type ListedSuite = {
  specs?: { id: string; tests: { projectName: string }[] }[];
  suites?: ListedSuite[];
};

function list(project?: string, leg?: string): Map<string, string[]> {
  const env = { ...process.env, CI: "true" };
  delete env.UATU_E2E_LEG;
  // Bun's parallel test workers set this compatibility marker. The child is
  // Playwright's own CLI, not a Jest worker importing Playwright test files.
  delete env.JEST_WORKER_ID;
  if (leg) env.UATU_E2E_LEG = leg;
  const result = Bun.spawnSync([
    process.execPath, "run", "test:e2e", "--list", "--reporter=json",
    ...(project ? [`--project=${project}`] : []),
  ], { cwd: fileURLToPath(new URL("..", import.meta.url)), env });
  const report = JSON.parse(result.stdout.toString()) as { suites: ListedSuite[]; errors: { message: string }[] };
  if (result.exitCode !== 0) {
    throw new Error([result.stderr.toString(), ...report.errors.slice(0, 3).map(error => error.message)].join("\n"));
  }
  expect(report.errors).toEqual([]);
  const projects = new Map<string, string[]>();
  function visit(suite: ListedSuite) {
    for (const spec of suite.specs ?? []) for (const entry of spec.tests) {
      const ids = projects.get(entry.projectName) ?? [];
      ids.push(spec.id);
      projects.set(entry.projectName, ids);
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites) visit(suite);
  return projects;
}

test("CI legs preserve every functional test once and stay balanced; perf stays separate", () => {
  const full = list();
  expect([...full.keys()].sort()).toEqual(["e2e", "perf"]);
  const first = list("e2e", "1").get("e2e")!;
  const second = list("e2e", "2").get("e2e")!;
  const functional = [...first, ...second];
  expect(new Set(functional).size).toBe(functional.length);
  expect(functional.sort()).toEqual(full.get("e2e")!.sort());
  expect(list("perf", "1").get("perf")!.sort()).toEqual(full.get("perf")!.sort());
  expect(first.length).toBeGreaterThan(0);
  expect(second.length).toBeGreaterThan(0);
  // Counts are a drift guard, not a substitute for CI's measured worker time.
  // In run 39258146264, 408 versus 873 let the larger leg hit its 25m limit.
  expect(Math.max(first.length, second.length) / Math.min(first.length, second.length)).toBeLessThanOrEqual(1.25);
}, 30_000);
