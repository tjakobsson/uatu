import { expect, spyOn, test } from "bun:test";
import type { FullConfig, TestCase, TestResult } from "@playwright/test/reporter";
import CIProgressReporter from "./ci-progress-reporter";

test("CI progress emits single-line attempt identity before completion and runner duration after", () => {
  const reporter = new CIProgressReporter();
  reporter.onBegin({ rootDir: "/repo/tests/e2e" } as FullConfig);
  const testcase = {
    id: "stable-id",
    parent: { project: () => ({ name: "e2e", use: { browserName: "chromium" } }) },
    location: { file: "/repo/tests/e2e/example.e2e.ts", line: 7 },
    titlePath: () => ["", "e2e", "example.e2e.ts", "touch (webkit)\n::warning::not a command"],
  } as unknown as TestCase;
  const result = {
    retry: 1, workerIndex: 5, parallelIndex: 2, status: "passed", duration: 1234,
    errors: [{ message: "private error payload" }],
    stdout: ["private application output"],
  } as unknown as TestResult;
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    reporter.onTestBegin(testcase, result);
    expect(output).toHaveBeenCalledTimes(1);
    const beginLine = output.mock.calls[0]![0] as string;
    expect(beginLine.split("\n")).toHaveLength(1);
    const begin = JSON.parse(beginLine.slice("[ci-test] ".length));
    expect(begin).toMatchObject({ event: "begin", id: "stable-id", project: "e2e",
      configuredBrowser: "chromium", file: "example.e2e.ts", line: 7, retry: 1, worker: 5, parallelIndex: 2 });
    expect(begin.title).toEqual(["example.e2e.ts", "touch (webkit)\n::warning::not a command"]);
    expect(Number.isFinite(Date.parse(begin.time))).toBe(true);
    expect(begin.durationMs).toBeUndefined();
    reporter.onTestEnd(testcase, result);
    expect(output).toHaveBeenCalledTimes(2);
    const endLine = output.mock.calls[1]![0] as string;
    expect(JSON.parse(endLine.slice("[ci-test] ".length))).toMatchObject({
      event: "end", id: begin.id, retry: begin.retry, worker: begin.worker, status: "passed", durationMs: 1234,
    });
    expect(endLine).not.toContain("private");
    expect(reporter.printsToStdio()).toBe(true);
  } finally { output.mockRestore(); }
});
