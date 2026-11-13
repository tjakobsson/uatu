import { relative } from "node:path";
import type { FullConfig, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

// Emit before/after each attempt, not each step. Unlike a finalized blob report,
// stdout can identify unfinished tests when CI kills the job at its time limit.
// Only static test identity and runner timing belong here, never errors, URLs,
// attachments, environment variables, or application/browser console messages.
export default class CIProgressReporter implements Reporter {
  private rootDir = "";

  printsToStdio(): boolean { return true; }

  onBegin(config: FullConfig): void { this.rootDir = config.rootDir; }

  private write(event: "begin" | "end", test: TestCase, result: TestResult): void {
    const project = test.parent.project();
    console.log(`[ci-test] ${JSON.stringify({
      event,
      time: new Date().toISOString(),
      id: test.id,
      project: project?.name,
      // This is the configured engine. Tests that open another engine identify
      // it in their static title; a reporter cannot inspect their contexts.
      configuredBrowser: project?.use.browserName ?? "chromium",
      file: relative(this.rootDir, test.location.file).replaceAll("\\", "/"),
      line: test.location.line,
      title: test.titlePath().slice(2),
      retry: result.retry,
      worker: result.workerIndex,
      parallelIndex: result.parallelIndex,
      ...(event === "end" ? { status: result.status, durationMs: result.duration } : {}),
    })}`);
  }

  onTestBegin(test: TestCase, result: TestResult): void { this.write("begin", test, result); }
  onTestEnd(test: TestCase, result: TestResult): void { this.write("end", test, result); }
}
