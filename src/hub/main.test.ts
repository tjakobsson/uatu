import { describe, expect, test } from "bun:test";

import { createCredentialRuntimeGate, passwordFromPipedInput, stopHubRuntime } from "./main";

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

describe("createCredentialRuntimeGate", () => {
  test("replacement drains in-flight operations and holds new ones until the swap lands", async () => {
    let service = "old-service";
    const gate = createCredentialRuntimeGate(() => service);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = gate.run(async captured => {
      await firstGate;
      order.push(`first:${captured}`);
      return captured;
    });
    // The unlock-vs-override race: replacement must not swap while `first`
    // still holds the old service, and `second` must not capture a service
    // mid-swap.
    const replacement = gate.replace(async () => {
      order.push("swap");
      service = "new-service";
    });
    const second = gate.run(async captured => {
      order.push(`second:${captured}`);
      return captured;
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    releaseFirst();
    expect(await first).toBe("old-service");
    await replacement;
    expect(await second).toBe("new-service");
    expect(order).toEqual(["first:old-service", "swap", "second:new-service"]);
  });

  test("overlapping replacements queue instead of overwriting the active barrier", async () => {
    let service = "first";
    const gate = createCredentialRuntimeGate(() => service);
    const order: string[] = [];
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });

    // The SIGTERM-during-tool-refresh race: the shutdown replacement must
    // wait for the refresh replacement, or a drained operation would be
    // released against the service the shutdown is about to retire.
    const refresh = gate.replace(async () => {
      await refreshGate;
      service = "second";
      order.push("refresh");
    });
    const shutdown = gate.replace(async () => {
      service = "none";
      order.push("shutdown");
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const late = gate.run(async captured => {
      order.push(`late:${captured}`);
      return captured;
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    releaseRefresh();
    await Promise.all([refresh, shutdown]);
    expect(await late).toBe("none");
    expect(order).toEqual(["refresh", "shutdown", "late:none"]);
  });

  test("a nested run inside a gate section piggybacks instead of deadlocking on a pending replacement", async () => {
    let service = "old";
    const gate = createCredentialRuntimeGate(() => service);
    const outer = gate.run(async () => {
      // Pending replacement drains this very section; a nested gated call
      // (a usability check inside a workspace start) must piggyback on it.
      const replacement = gate.replace(async () => { service = "new"; });
      const nested = await gate.run(async captured => captured);
      return { nested, replacement };
    });
    const { nested, replacement } = await outer;
    await replacement;
    expect(nested).toBe("old");
    expect(await gate.run(async captured => captured)).toBe("new");
  });

  test("a rejected operation neither wedges the gate nor blocks replacement", async () => {
    let service = "one";
    const gate = createCredentialRuntimeGate(() => service);
    await expect(gate.run(async () => { throw new Error("operation failed"); })).rejects.toThrow("operation failed");
    await gate.replace(async () => { service = "two"; });
    expect(await gate.run(async captured => captured)).toBe("two");
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
