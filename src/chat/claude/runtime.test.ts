import { describe, expect, test } from "bun:test";

import { ClaudeRuntime, type ClaudeProbeResult } from "./runtime";

function runtime(options: {
  candidates?: string[];
  probe?: (executable: string, timeoutMs: number) => Promise<ClaudeProbeResult>;
  probeTimeoutMs?: number;
} = {}): ClaudeRuntime {
  return new ClaudeRuntime({
    workspacePath: "/workspace",
    discoverCandidates: async () => options.candidates ?? ["/usr/local/bin/claude"],
    probe: options.probe ?? (async () => ({ exitCode: 0, stdout: "2.1.236 (Claude Code)\n", stderr: "", timedOut: false })),
    probeTimeoutMs: options.probeTimeoutMs,
  });
}

describe("ClaudeRuntime", () => {
  test("peeking never probes; ensuring does, once, and caches ready", async () => {
    let probes = 0;
    const subject = runtime({ probe: async () => { probes += 1; return { exitCode: 0, stdout: "2.1.236 (Claude Code)", stderr: "", timedOut: false }; } });
    expect(subject.peekStatus()).toEqual({ state: "idle" });
    expect(probes).toBe(0);
    expect(await subject.ensure()).toEqual({ state: "ready", version: "2.1.236" });
    expect(await subject.ensure()).toEqual({ state: "ready", version: "2.1.236" });
    expect(probes).toBe(1);
    expect(subject.executablePath()).toBe("/usr/local/bin/claude");
  });

  test("no executable reports not-installed with empty-probe diagnostics", async () => {
    const subject = runtime({ candidates: [] });
    const availability = await subject.ensure();
    expect(availability).toEqual(expect.objectContaining({
      state: "unavailable",
      reason: "not-installed",
    }));
    if (availability.state !== "unavailable") throw new Error("expected unavailable");
    expect(availability.diagnostics).toEqual(expect.objectContaining({
      executable: null,
      endpoint: null,
      probes: 0,
      lastProbe: { kind: "none" },
    }));
    expect(subject.executablePath()).toBeNull();
  });

  test("a probe that never answers is abandoned on the bound and attributed", async () => {
    const subject = runtime({
      probeTimeoutMs: 20,
      // Models the real probe contract: the runner resolves with timedOut
      // when the child had to be killed on the bound.
      probe: (_executable, timeoutMs) => new Promise(resolve => {
        setTimeout(() => resolve({ exitCode: null, stdout: "", stderr: "", timedOut: true }), timeoutMs);
      }),
    });
    const availability = await subject.ensure();
    expect(availability).toEqual(expect.objectContaining({ state: "unavailable", reason: "startup-failed" }));
    if (availability.state !== "unavailable") throw new Error("expected unavailable");
    expect(availability.message).toContain("did not answer");
    expect(availability.diagnostics?.lastProbe).toEqual({ kind: "abandoned" });
  });

  test("a failing or unrecognizable probe reports startup-failed with evidence", async () => {
    const subject = runtime({ probe: async () => ({ exitCode: 1, stdout: "", stderr: "segfault", timedOut: false }) });
    const availability = await subject.ensure();
    if (availability.state !== "unavailable") throw new Error("expected unavailable");
    expect(availability.reason).toBe("startup-failed");
    expect(availability.diagnostics?.stderr).toBe("segfault");
    expect(availability.diagnostics?.lastProbe).toEqual({ kind: "unknown", error: "version probe exited with 1" });
  });

  test("shadowed executables are reported, first candidate probed", async () => {
    const probed: string[] = [];
    const subject = runtime({
      candidates: ["/first/claude", "/second/claude"],
      probe: async executable => { probed.push(executable); return { exitCode: 1, stdout: "", stderr: "", timedOut: false }; },
    });
    const availability = await subject.ensure();
    expect(probed).toEqual(["/first/claude"]);
    if (availability.state !== "unavailable") throw new Error("expected unavailable");
    expect(availability.diagnostics?.shadowedExecutables).toEqual(["/second/claude"]);
  });

  test("restart forgets a cached failure and probes again", async () => {
    let attempts = 0;
    const subject = runtime({
      probe: async () => {
        attempts += 1;
        return attempts === 1
          ? { exitCode: 1, stdout: "", stderr: "broken install", timedOut: false }
          : { exitCode: 0, stdout: "2.1.240 (Claude Code)", stderr: "", timedOut: false };
      },
    });
    expect((await subject.ensure()).state).toBe("unavailable");
    // Cached: another ensure does not re-probe.
    expect((await subject.ensure()).state).toBe("unavailable");
    expect(attempts).toBe(1);
    expect(await subject.restart()).toEqual({ state: "ready", version: "2.1.240" });
    expect(attempts).toBe(2);
  });

  test("concurrent ensures join one probe", async () => {
    let probes = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const subject = runtime({
      probe: async () => {
        probes += 1;
        await gate;
        return { exitCode: 0, stdout: "2.1.236 (Claude Code)", stderr: "", timedOut: false };
      },
    });
    const [first, second] = [subject.ensure(), subject.ensure()];
    release();
    expect(await first).toEqual({ state: "ready", version: "2.1.236" });
    expect(await second).toEqual({ state: "ready", version: "2.1.236" });
    expect(probes).toBe(1);
  });
});
