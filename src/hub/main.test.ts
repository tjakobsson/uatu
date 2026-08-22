import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyCredentialRuntimeAtomically,
  createHubSignalShutdown,
  createCredentialRuntimeGate,
  passwordFromPipedInput,
  reconcileManagedSshAgent,
  recoverPersistedSshGuardian,
  shutdownHub,
  stopHubRuntime,
} from "./main";
import { acquireHubStateLease, ensureStateDir } from "./state-dir";

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

describe("applyCredentialRuntimeAtomically", () => {
  test("restores bookkeeping and every manager after a partial replacement", async () => {
    let activePaths = "old";
    let sshAgent = "old";
    let sshManager = "old";
    let openPgpManager = "old";
    const calls: string[] = [];
    let failOpenPgp = true;
    const apply = async (paths: string, force: boolean) => {
      calls.push(`${paths}:${force}`);
      if (force || paths !== activePaths) {
        sshAgent = paths;
        sshManager = paths;
      }
      if (paths === "new" && failOpenPgp) {
        failOpenPgp = false;
        throw new Error("OpenPGP replacement failed");
      }
      if (force || paths !== activePaths) openPgpManager = paths;
      activePaths = paths;
    };

    await expect(applyCredentialRuntimeAtomically("old", "new", apply)).rejects.toThrow("OpenPGP replacement failed");
    expect(calls).toEqual(["new:false", "old:true"]);
    expect({ activePaths, sshAgent, sshManager, openPgpManager }).toEqual({
      activePaths: "old",
      sshAgent: "old",
      sshManager: "old",
      openPgpManager: "old",
    });
  });

  test("aggregates application and forced restoration failures without clearing bookkeeping", async () => {
    let activePaths = "old";
    let manager = "old";
    const apply = async (paths: string, force: boolean) => {
      manager = paths;
      if (force) throw new Error("restoration failed");
      throw new Error("application failed");
    };

    let failure: unknown;
    try {
      await applyCredentialRuntimeAtomically(activePaths, "new", apply);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(error => (error as Error).message)).toEqual([
      "application failed",
      "restoration failed",
    ]);
    expect(activePaths).toBe("old");
    expect(manager).toBe("old");
  });

  test("forced restoration does not restart SSH for unrelated or key-tool failures when the agent path is unchanged", async () => {
    for (const changedTool of ["gpg", "git", "ssh-keygen", "ssh-add"]) {
      let shutdowns = 0;
      const agent = { async shutdown() { shutdowns += 1; } };
      let currentAgent: typeof agent | null = agent;
      let currentAgentPath: string | null = "/usr/bin/ssh-agent";
      const oldPaths: Record<string, string> = { agent: "/usr/bin/ssh-agent", [changedTool]: "old" };
      const newPaths: Record<string, string> = { agent: "/usr/bin/ssh-agent", [changedTool]: "new" };
      const apply = async (paths: Record<string, string>, force: boolean) => {
        const reconciled = await reconcileManagedSshAgent({
          agent: currentAgent,
          agentPath: currentAgentPath,
          nextAgentPath: paths.agent!,
          create: () => agent,
        });
        currentAgent = reconciled.agent;
        currentAgentPath = reconciled.agentPath;
        if (!force) throw new Error(`${changedTool} runtime application failed`);
      };

      await expect(applyCredentialRuntimeAtomically(oldPaths, newPaths, apply))
        .rejects.toThrow(`${changedTool} runtime application failed`);
      expect(shutdowns).toBe(0);
      expect(currentAgent).toBe(agent);
    }
  });
});

describe("SSH guardian runtime initialization", () => {
  test("proactively recovers persisted guardian state without requiring an ssh-agent executable", async () => {
    const calls: string[] = [];
    await recoverPersistedSshGuardian(
      { runtimeDirectory: "/private/runtime", uatuArgv: ["uatu"] },
      options => {
        expect(options).toEqual({ runtimeDirectory: "/private/runtime", uatuArgv: ["uatu"] });
        return { async recover() { calls.push("recover"); } };
      },
    );
    expect(calls).toEqual(["recover"]);
  });
});

describe("Hub runtime shutdown", () => {
  test("stops clone jobs and sessions before agents and isolates cleanup failures", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const result = await stopHubRuntime({
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
    expect(result).toEqual({ ok: false, stateLeaseSafeToRelease: false });
  });

  test("signal shutdown exits nonzero and retains the lease when clones or sessions remain unreaped", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const result = await shutdownHub({
      stopServer() { calls.push("server"); },
      stateLease: {
        async release() { calls.push("lease"); },
      },
      cloneJobs: {
        async close() {
          calls.push("clones");
          throw new Error("clone process survived");
        },
      },
      credentialTools: {
        async shutdown() { calls.push("tools"); },
      },
      sessions: {
        async stopAll() {
          calls.push("sessions");
          throw new Error("session process survived");
        },
      },
      sshAgent: {
        async shutdown() { calls.push("ssh"); },
      },
      openPgp: {
        async shutdown() { calls.push("openpgp"); },
      },
      reportError(message) { errors.push(message); },
    });

    expect(result).toEqual({ exitCode: 1, stateLeaseHeld: true });
    expect(calls).toContain("tools");
    expect(calls).toContain("ssh");
    expect(calls).toContain("openpgp");
    expect(calls).not.toContain("lease");
    expect(errors).toContain("uatu hub: retaining state-root lease after incomplete shutdown");
  });

  test("clean signal shutdown releases the lease and exits zero", async () => {
    let releases = 0;
    const result = await shutdownHub({
      stopServer() {},
      stateLease: { async release() { releases += 1; } },
      cloneJobs: { async close() {} },
      sessions: { async stopAll() {} },
    });

    expect(result).toEqual({ exitCode: 0, stateLeaseHeld: false });
    expect(releases).toBe(1);
  });

  test("a non-runtime failure exits nonzero after safely releasing the lease", async () => {
    let releases = 0;
    const result = await shutdownHub({
      stopServer() {},
      stateLease: { async release() { releases += 1; } },
      cloneJobs: { async close() {} },
      sessions: { async stopAll() {} },
      sshAgent: { async shutdown() { throw new Error("agent stop failed"); } },
      reportError() {},
    });

    expect(result).toEqual({ exitCode: 1, stateLeaseHeld: false });
    expect(releases).toBe(1);
  });

  test("lease release failure reports that the process must retain the lease", async () => {
    const errors: string[] = [];
    const result = await shutdownHub({
      stopServer() {},
      stateLease: { async release() { throw new Error("rollback failed"); } },
      cloneJobs: { async close() {} },
      sessions: { async stopAll() {} },
      reportError: message => { errors.push(message); },
    });

    expect(result).toEqual({ exitCode: 1, stateLeaseHeld: true });
    expect(errors).toContain("uatu hub: state-root lease release failed: rollback failed");
  });

  test("signal shutdown waits after retaining the lease and force-exits on the next signal", async () => {
    let finishShutdown!: (result: { exitCode: number; stateLeaseHeld: boolean }) => void;
    const shutdownResult = new Promise<{ exitCode: number; stateLeaseHeld: boolean }>(resolve => {
      finishShutdown = resolve;
    });
    const exits: number[] = [];
    let retained = 0;
    const signal = createHubSignalShutdown({
      shutdown: () => shutdownResult,
      forceExit: code => { exits.push(code); },
      reportRetained: () => { retained += 1; },
    });

    signal();
    finishShutdown({ exitCode: 1, stateLeaseHeld: true });
    await Bun.sleep(0);
    expect(exits).toEqual([]);
    expect(retained).toBe(1);
    signal();
    expect(exits).toEqual([1]);
  });

  test("a contender stays blocked after failed shutdown until forced owner exit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-hub-failed-shutdown-"));
    const stateRoot = path.join(directory, "state");
    await mkdir(stateRoot, { mode: 0o700 });
    const fixture = path.resolve(import.meta.dir, "../../tests/fixtures/hub-failed-shutdown-helper.ts");
    const child = spawn(process.execPath, [fixture, stateRoot], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    const waitForOutput = async (text: string) => {
      const deadline = Date.now() + 5_000;
      while (!output.includes(text) && Date.now() < deadline) await Bun.sleep(10);
      if (!output.includes(text)) throw new Error(`fixture did not print ${text}: ${output}`);
    };
    const waitForExit = () => new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));

    try {
      await waitForOutput("locked\n");
      child.kill("SIGTERM");
      await waitForOutput("retained\n");
      await expect(acquireHubStateLease(stateRoot)).rejects.toThrow(/already in use/);

      child.kill("SIGTERM");
      expect(await waitForExit()).toBe(1);
      const successor = await acquireHubStateLease(stateRoot);
      await successor.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise(resolve => child.once("exit", resolve));
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
