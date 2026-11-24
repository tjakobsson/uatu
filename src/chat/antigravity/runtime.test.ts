import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { VersionProbeResult } from "../path-agent-runtime";
import { ANTIGRAVITY_AGENT } from "./descriptor";
import { AntigravityRuntime, parseAntigravityVersion } from "./runtime";

function runtime(options: { candidates?: string[]; probe?: (executable: string, timeoutMs: number) => Promise<VersionProbeResult>; probeTimeoutMs?: number } = {}): AntigravityRuntime {
  return new AntigravityRuntime({
    workspacePath: "/workspace",
    discoverCandidates: async () => options.candidates ?? ["/usr/local/bin/agy"],
    probe: options.probe ?? (async () => ({ exitCode: 0, stdout: "1.5.13\n", stderr: "", timedOut: false })),
    probeTimeoutMs: options.probeTimeoutMs,
  });
}

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("AntigravityRuntime", () => {
  test("the descriptor declares agy's own login, not a Hub-managed one", () => {
    expect(ANTIGRAVITY_AGENT).toEqual({ id: "antigravity", name: "Antigravity", login: { command: "agy", hubManaged: false } });
  });

  test("a ready probe reports agy's version and the executable it found", async () => {
    const subject = runtime();
    expect(await subject.ensure()).toEqual({ state: "ready", version: "1.5.13" });
    expect(subject.executablePath()).toBe("/usr/local/bin/agy");
  });

  test("the version parser takes the leading semantic version of the first line", () => {
    expect(parseAntigravityVersion("1.5.13\n")).toBe("1.5.13");
    expect(parseAntigravityVersion("agy version 1.6.0-beta.2 (linux/amd64)\nbuilt somewhere")).toBe("1.6.0-beta.2");
    expect(parseAntigravityVersion("Antigravity CLI\n1.5.13")).toBeNull();
    expect(parseAntigravityVersion("")).toBeNull();
  });

  test("no agy on PATH is not installed, named Antigravity", async () => {
    const availability = await runtime({ candidates: [] }).ensure();
    expect(availability).toEqual(expect.objectContaining({ state: "unavailable", reason: "not-installed", message: "Antigravity is not installed or is not available on PATH." }));
  });

  test("a probe that does not answer in time names Antigravity and is abandoned", async () => {
    const availability = await runtime({
      probeTimeoutMs: 20,
      probe: (_executable, timeoutMs) => new Promise(resolve => setTimeout(() => resolve({ exitCode: null, stdout: "", stderr: "", timedOut: true }), timeoutMs)),
    }).ensure();
    if (availability.state !== "unavailable") throw new Error("expected unavailable");
    expect(availability.message).toBe("Antigravity did not answer a version probe within 0s.");
    expect(availability.diagnostics).toEqual(expect.objectContaining({ executable: "/usr/local/bin/agy", lastProbe: { kind: "abandoned" }, probes: 1 }));
  });

  test("an unrecognized version is a startup failure with bounded output", async () => {
    const availability = await runtime({ probe: async () => ({ exitCode: 0, stdout: "Antigravity CLI (no version)", stderr: "warn", timedOut: false }) }).ensure();
    if (availability.state !== "unavailable") throw new Error("expected unavailable");
    expect(availability.reason).toBe("startup-failed");
    expect(availability.message).toBe("Antigravity could not be started: version probe produced no recognizable version.");
    expect(availability.diagnostics).toEqual(expect.objectContaining({ stdout: "Antigravity CLI (no version)", stderr: "warn" }));
  });

  test("shadowed agy executables are reported and only the first is probed", async () => {
    const probed: string[] = [];
    const subject = runtime({ candidates: ["/first/agy", "/second/agy"], probe: async executable => { probed.push(executable); return { exitCode: 0, stdout: "1.5.13", stderr: "", timedOut: false }; } });
    expect(await subject.ensure()).toEqual({ state: "ready", version: "1.5.13" });
    expect(probed).toEqual(["/first/agy"]);
    const failing = runtime({ candidates: ["/first/agy", "/second/agy"], probe: async () => ({ exitCode: 2, stdout: "", stderr: "", timedOut: false }) });
    const availability = await failing.ensure();
    if (availability.state !== "unavailable") throw new Error("expected unavailable");
    expect(availability.diagnostics?.shadowedExecutables).toEqual(["/second/agy"]);
  });

  test.skipIf(process.platform === "win32")("a real probe runs `agy --version` from PATH and leaves nothing running", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-agy-runtime-"));
    temporary.push(directory);
    await writeFile(path.join(directory, "agy"), "#!/bin/sh\n[ \"$1\" = --version ] && echo 1.5.13\n", { mode: 0o755 });
    const subject = new AntigravityRuntime({ workspacePath: directory, env: { PATH: directory } });
    expect(await subject.ensure()).toEqual({ state: "ready", version: "1.5.13" });
    expect(subject.executablePath()).toBe(path.join(directory, "agy"));
  });
});
