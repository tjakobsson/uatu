import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

// Pins Claude Code's configuration of the runtime byte for byte: the
// messages, the diagnostics shape, the version parser and the default probe
// (`claude --version` found on PATH).
describe("ClaudeRuntime messages and diagnostics", () => {
  const temporaryDirectories: string[] = [];
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  function clocked(options: Parameters<typeof runtime>[0] & { elapsed?: number } = {}): ClaudeRuntime {
    let calls = 0;
    return new ClaudeRuntime({
      workspacePath: "/workspace",
      discoverCandidates: async () => options.candidates ?? ["/usr/local/bin/claude"],
      probe: options.probe ?? (async () => ({ exitCode: 0, stdout: "2.1.236 (Claude Code)\n", stderr: "", timedOut: false })),
      probeTimeoutMs: options.probeTimeoutMs,
      // Start, then end: the diagnostics' elapsed time is their difference.
      now: () => (calls++ === 0 ? 1_000 : 1_000 + (options.elapsed ?? 0)),
    });
  }

  test("not installed", async () => {
    expect(await clocked({ candidates: [], elapsed: 7 }).ensure()).toEqual({
      state: "unavailable",
      reason: "not-installed",
      message: "Claude Code is not installed or is not available on PATH.",
      diagnostics: {
        executable: null,
        shadowedExecutables: [],
        version: null,
        endpoint: null,
        elapsedMs: 7,
        probes: 0,
        lastProbe: { kind: "none" },
        stdout: "",
        stderr: "",
      },
    });
  });

  test("a probe abandoned on the bound names the bound in seconds", async () => {
    const subject = clocked({
      candidates: ["/first/claude", "/second/claude"],
      probeTimeoutMs: 10_000,
      elapsed: 10_002,
      probe: async () => ({ exitCode: null, stdout: "partial", stderr: "slow", timedOut: true }),
    });
    expect(await subject.ensure()).toEqual({
      state: "unavailable",
      reason: "startup-failed",
      message: "Claude Code did not answer a version probe within 10s.",
      diagnostics: {
        executable: "/first/claude",
        shadowedExecutables: ["/second/claude"],
        version: null,
        endpoint: null,
        elapsedMs: 10_002,
        probes: 1,
        lastProbe: { kind: "abandoned" },
        stdout: "partial",
        stderr: "slow",
      },
    });
    expect(subject.executablePath()).toBeNull();
  });

  test("failed, unrecognizable and throwing probes", async () => {
    const exited = await clocked({ probe: async () => ({ exitCode: 3, stdout: "", stderr: "boom", timedOut: false }) }).ensure();
    expect(exited).toEqual({
      state: "unavailable",
      reason: "startup-failed",
      message: "Claude Code could not be started: version probe exited with 3.",
      diagnostics: expect.objectContaining({ lastProbe: { kind: "unknown", error: "version probe exited with 3" }, version: null, stderr: "boom" }),
    });
    const garbled = await clocked({ probe: async () => ({ exitCode: 0, stdout: "Claude Code\n", stderr: "", timedOut: false }) }).ensure();
    expect(garbled).toEqual(expect.objectContaining({
      reason: "startup-failed",
      message: "Claude Code could not be started: version probe produced no recognizable version.",
    }));
    const thrown = await clocked({ probe: async () => { throw new Error("EACCES"); } }).ensure();
    expect(thrown).toEqual(expect.objectContaining({
      reason: "startup-failed",
      message: "Claude Code could not be started: EACCES.",
      diagnostics: expect.objectContaining({ lastProbe: { kind: "unknown", error: "EACCES" }, stdout: "", stderr: "" }),
    }));
    // A recognizable version on a failed exit is still reported.
    const versioned = await clocked({ probe: async () => ({ exitCode: 1, stdout: "2.1.236 (Claude Code)", stderr: "", timedOut: false }) }).ensure();
    if (versioned.state !== "unavailable") throw new Error("expected unavailable");
    expect(versioned.diagnostics?.version).toBe("2.1.236");
  });

  test("probe output is capped at 16 KiB in diagnostics", async () => {
    const long = "y".repeat(20 * 1024);
    const availability = await clocked({ probe: async () => ({ exitCode: 1, stdout: long, stderr: long, timedOut: false }) }).ensure();
    if (availability.state !== "unavailable") throw new Error("expected unavailable");
    expect(availability.diagnostics?.stdout).toHaveLength(16 * 1024);
    expect(availability.diagnostics?.stderr).toHaveLength(16 * 1024);
  });

  test("the version is the leading semver token, prerelease included", async () => {
    for (const [stdout, version] of [["  2.1.236-beta.1 (Claude Code)\n", "2.1.236-beta.1"], ["2.0.0\n", "2.0.0"]] as const) {
      expect(await clocked({ probe: async () => ({ exitCode: 0, stdout, stderr: "", timedOut: false }) }).ensure()).toEqual({ state: "ready", version });
    }
  });

  test("reports starting while the probe runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let probing!: () => void;
    const started = new Promise<void>(resolve => { probing = resolve; });
    const subject = clocked({ probe: async () => { probing(); await gate; return { exitCode: 0, stdout: "2.1.236", stderr: "", timedOut: false }; } });
    const ensuring = subject.ensure();
    await started;
    expect(subject.peekStatus()).toEqual({ state: "starting" });
    release();
    expect(await ensuring).toEqual({ state: "ready", version: "2.1.236" });
  });

  test("after dispose, ensure and restart probe nothing and report the last state", async () => {
    let probes = 0;
    const subject = clocked({ probe: async () => { probes += 1; return { exitCode: 0, stdout: "2.1.236", stderr: "", timedOut: false }; } });
    subject.dispose();
    expect(await subject.ensure()).toEqual({ state: "idle" });
    expect(await subject.restart()).toEqual({ state: "idle" });
    expect(probes).toBe(0);
  });

  // A shell-script fixture: POSIX only.
  test.skipIf(process.platform === "win32")("the default probe runs `claude --version` from the first `claude` on PATH", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-claude-runtime-"));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "claude");
    await writeFile(executable, [
      "#!/bin/sh",
      "if [ \"$#\" = 1 ] && [ \"$1\" = --version ]; then echo '2.1.236 (Claude Code)'; exit 0; fi",
      "echo \"unexpected arguments: $*\" >&2",
      "exit 2",
      "",
    ].join("\n"), { mode: 0o755 });
    const subject = new ClaudeRuntime({ workspacePath: directory, env: { PATH: directory } });
    expect(await subject.ensure()).toEqual({ state: "ready", version: "2.1.236" });
    expect(subject.executablePath()).toBe(executable);
  });
});
