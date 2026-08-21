import { describe, expect, test } from "bun:test";

import { passwordFromPipedInput, stopHubRuntime } from "./main";

describe("passwordFromPipedInput", () => {
  test("strips exactly one trailing line terminator", () => {
    expect(passwordFromPipedInput("hunter2\n")).toBe("hunter2");
    expect(passwordFromPipedInput("hunter2\r\n")).toBe("hunter2");
    expect(passwordFromPipedInput("hunter2")).toBe("hunter2");
  });

  test("preserves intentional whitespace — login verification does too", () => {
    expect(passwordFromPipedInput("  padded pw  \n")).toBe("  padded pw  ");
    expect(passwordFromPipedInput(" leading\n")).toBe(" leading");
    // Only the FINAL terminator goes; embedded newlines are part of the password.
    expect(passwordFromPipedInput("multi\nline\n")).toBe("multi\nline");
  });

  test("empty input stays empty (caller rejects it)", () => {
    expect(passwordFromPipedInput("")).toBe("");
    expect(passwordFromPipedInput("\n")).toBe("");
  });
});

describe("Hub runtime shutdown", () => {
  test("stops clone jobs and sessions before agents and isolates cleanup failures", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    await stopHubRuntime({
      cloneJobs: {
        async close() {
          calls.push("clones");
          throw new Error("clone cleanup failed");
        },
      },
      sessions: {
        async stopAll() {
          calls.push("sessions");
          throw new Error("session cleanup failed");
        },
      },
      sshAgent: {
        async shutdown() {
          calls.push("ssh");
          throw new Error("SSH agent cleanup failed");
        },
      },
      openPgp: {
        async shutdown() {
          calls.push("openpgp");
        },
      },
      reportError(message) {
        errors.push(message);
      },
    });

    expect(calls.slice(0, 2)).toEqual(["clones", "sessions"]);
    expect(new Set(calls.slice(2))).toEqual(new Set(["ssh", "openpgp"]));
    expect(errors).toEqual([
      "uatu hub: clone job shutdown failed",
      "uatu hub: workspace session shutdown failed",
      "uatu hub: SSH agent shutdown failed",
    ]);
  });
});
