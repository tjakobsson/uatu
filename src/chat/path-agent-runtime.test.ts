import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChatProvider } from "./provider";
import { PathAgentRuntime, pathAgentMessages, pathAgentRuntime, type PathAgentConfiguration } from "./path-agent-runtime";

// A made-up agent, so nothing here leans on Claude Code's configuration.
const FAKE_AGENT: PathAgentConfiguration = {
  binary: "fake-agent",
  displayName: "Fake Agent",
  probeArgs: ["version", "--plain"],
  parseVersion: stdout => stdout.match(/^fake-agent (\S+)$/m)?.[1] ?? null,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "uatu-path-agent-"));
  temporaryDirectories.push(created);
  return created;
}

// A fake `fake-agent` whose probe appends its arguments to `probes.log` and
// then runs `body`.
async function fakeExecutable(body: string, into?: string): Promise<{ directory: string; executable: string; probes: () => Promise<string[]> }> {
  const home = into ?? await directory();
  const executable = path.join(home, FAKE_AGENT.binary);
  const log = path.join(home, "probes.log");
  await writeFile(executable, `#!/bin/sh\necho "$*" >> '${log}'\n${body}\n`, { mode: 0o755 });
  return {
    directory: home,
    executable,
    probes: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean),
  };
}

function runtime(env: NodeJS.ProcessEnv, options: { probeTimeoutMs?: number; configuration?: PathAgentConfiguration } = {}): PathAgentRuntime {
  return new PathAgentRuntime(options.configuration ?? FAKE_AGENT, { workspacePath: "/workspace", env, probeTimeoutMs: options.probeTimeoutMs });
}

describe.skipIf(process.platform === "win32")("PathAgentRuntime", () => {
  test("probes the first executable on PATH with the configured arguments and parses its version", async () => {
    const fake = await fakeExecutable("echo 'fake-agent 0.4.2-rc.1'");
    const subject = runtime({ PATH: fake.directory });
    expect(subject.peekStatus()).toEqual({ state: "idle" });
    expect(await fake.probes()).toEqual([]);
    expect(await subject.ensure()).toEqual({ state: "ready", version: "0.4.2-rc.1" });
    expect(await subject.ensure()).toEqual({ state: "ready", version: "0.4.2-rc.1" });
    expect(await fake.probes()).toEqual(["version --plain"]);
    expect(subject.executablePath()).toBe(fake.executable);
  });

  test("probes with --version when no arguments are configured", async () => {
    const fake = await fakeExecutable("echo 'fake-agent 1.0.0'");
    const subject = runtime({ PATH: fake.directory }, { configuration: { ...FAKE_AGENT, probeArgs: undefined } });
    expect(await subject.ensure()).toEqual({ state: "ready", version: "1.0.0" });
    expect(await fake.probes()).toEqual(["--version"]);
  });

  test("an agent missing from PATH is not installed", async () => {
    const empty = await directory();
    const availability = await runtime({ PATH: empty }).ensure();
    expect(availability).toEqual(expect.objectContaining({
      state: "unavailable",
      reason: "not-installed",
      message: "Fake Agent is not installed or is not available on PATH.",
    }));
  });

  test("a probe that never answers is killed on the bound and attributed", async () => {
    // The bound may fire before the shell has run at all, so nothing here
    // depends on what the fixture printed.
    const fake = await fakeExecutable("exec sleep 30");
    const availability = await runtime({ PATH: fake.directory }, { probeTimeoutMs: 500 }).ensure();
    expect(availability).toEqual({
      state: "unavailable",
      reason: "startup-failed",
      message: "Fake Agent did not answer a version probe within 1s.",
      diagnostics: expect.objectContaining({
        executable: fake.executable,
        lastProbe: { kind: "abandoned" },
        probes: 1,
      }),
    });
  }, 10_000);

  test("the bound is the answer's deadline even while a descendant holds the probe's output open", async () => {
    // The child is killed on the bound, but a background descendant keeps
    // its pipes for 3 s more; the answer must not wait for it.
    const fake = await fakeExecutable("(sleep 3) &\nexec sleep 3");
    const started = Date.now();
    const availability = await runtime({ PATH: fake.directory }, { probeTimeoutMs: 300 }).ensure();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(availability).toEqual(expect.objectContaining({ state: "unavailable", reason: "startup-failed", diagnostics: expect.objectContaining({ lastProbe: { kind: "abandoned" } }) }));
  }, 10_000);

  test("a probe that exited answers with its version at the bound when a descendant keeps its output open", async () => {
    const fake = await fakeExecutable("echo 'fake-agent 2.0.0'\n(sleep 3) &\nexit 0");
    const started = Date.now();
    const availability = await runtime({ PATH: fake.directory }, { probeTimeoutMs: 300 }).ensure();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(availability).toEqual({ state: "ready", version: "2.0.0" });
  }, 10_000);

  test("what a timed-out probe printed before the bound is kept as evidence", async () => {
    // Through the probe seam: a real child cannot be made to print before a
    // deadline that starts at its spawn.
    const subject = new PathAgentRuntime(FAKE_AGENT, {
      workspacePath: "/workspace",
      discoverCandidates: async () => ["/opt/fake-agent"],
      probe: async () => ({ exitCode: null, stdout: "fake-agent 1.0.0\n", stderr: "warming up", timedOut: true }),
    });
    expect(await subject.ensure()).toEqual({
      state: "unavailable",
      reason: "startup-failed",
      message: "Fake Agent did not answer a version probe within 10s.",
      diagnostics: expect.objectContaining({
        executable: "/opt/fake-agent",
        version: "1.0.0",
        lastProbe: { kind: "abandoned" },
        stdout: "fake-agent 1.0.0\n",
        stderr: "warming up",
      }),
    });
    expect(subject.executablePath()).toBeNull();
  });

  test("the first candidate is probed and the rest are reported as shadowed", async () => {
    const first = await fakeExecutable("echo 'first broke' >&2; exit 4");
    const second = await fakeExecutable("echo 'fake-agent 9.9.9'");
    const availability = await runtime({ PATH: [first.directory, second.directory].join(path.delimiter) }).ensure();
    expect(availability).toEqual({
      state: "unavailable",
      reason: "startup-failed",
      message: "Fake Agent could not be started: version probe exited with 4.",
      diagnostics: expect.objectContaining({
        executable: first.executable,
        shadowedExecutables: [second.executable],
        lastProbe: { kind: "unknown", error: "version probe exited with 4" },
        stderr: "first broke\n",
      }),
    });
    expect(await first.probes()).toHaveLength(1);
    expect(await second.probes()).toEqual([]);
  });

  test("restart forgets a cached failure and probes the executable again", async () => {
    const home = await directory();
    const state = path.join(home, "installed");
    await writeFile(state, "broken");
    const fake = await fakeExecutable(`if [ "$(cat '${state}')" = fixed ]; then echo 'fake-agent 2.0.0'; else exit 1; fi`, home);
    const subject = runtime({ PATH: fake.directory });
    expect((await subject.ensure()).state).toBe("unavailable");
    await writeFile(state, "fixed");
    // Cached until the user asks again.
    expect((await subject.ensure()).state).toBe("unavailable");
    expect(await subject.restart()).toEqual({ state: "ready", version: "2.0.0" });
    expect(await fake.probes()).toHaveLength(2);
  });

  test("concurrent ensures and a restart during the probe join one probe each", async () => {
    const fake = await fakeExecutable("echo 'fake-agent 3.1.4'");
    const subject = runtime({ PATH: fake.directory });
    const ensures = [subject.ensure(), subject.ensure(), subject.ensure()];
    expect(subject.peekStatus()).toEqual({ state: "starting" });
    // A restart waits for the probe in flight, then probes once more.
    const restarted = subject.restart();
    for (const ensured of ensures) expect(await ensured).toEqual({ state: "ready", version: "3.1.4" });
    expect(await restarted).toEqual({ state: "ready", version: "3.1.4" });
    expect(await fake.probes()).toHaveLength(2);
  });

  test("messages derive from the display name, and a configuration may override any", () => {
    const messages = pathAgentMessages("Fake Agent");
    expect(messages.notInstalled).toBe("Fake Agent is not installed or is not available on PATH.");
    expect(messages.timedOut(10)).toBe("Fake Agent did not answer a version probe within 10s.");
    expect(messages.startFailed("version probe exited with 1")).toBe("Fake Agent could not be started: version probe exited with 1.");
  });

  test("an override written as undefined keeps the default", async () => {
    const configuration: PathAgentConfiguration = { ...FAKE_AGENT, messages: { notInstalled: undefined, timedOut: undefined, startFailed: undefined } };
    const missing = new PathAgentRuntime(configuration, { workspacePath: "/workspace", discoverCandidates: async () => [] });
    expect(await missing.ensure()).toEqual(expect.objectContaining({ message: "Fake Agent is not installed or is not available on PATH." }));
    const slow = new PathAgentRuntime(configuration, {
      workspacePath: "/workspace",
      discoverCandidates: async () => ["/opt/fake-agent"],
      probe: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }),
    });
    expect(await slow.ensure()).toEqual(expect.objectContaining({ message: "Fake Agent did not answer a version probe within 10s." }));
    const broken = new PathAgentRuntime(configuration, {
      workspacePath: "/workspace",
      discoverCandidates: async () => ["/opt/fake-agent"],
      probe: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }),
    });
    expect(await broken.ensure()).toEqual(expect.objectContaining({ message: "Fake Agent could not be started: version probe exited with 1." }));
  });

  test("a parser that throws has found no version, and a timeout still reports the timeout", async () => {
    const configuration: PathAgentConfiguration = { ...FAKE_AGENT, parseVersion: stdout => JSON.parse(stdout).version };
    const banner = new PathAgentRuntime(configuration, {
      workspacePath: "/workspace",
      discoverCandidates: async () => ["/opt/fake-agent"],
      probe: async () => ({ exitCode: 0, stdout: "Welcome to Fake Agent\n", stderr: "", timedOut: false }),
    });
    expect(await banner.ensure()).toEqual(expect.objectContaining({
      state: "unavailable",
      reason: "startup-failed",
      message: "Fake Agent could not be started: version probe produced no recognizable version.",
      diagnostics: expect.objectContaining({ version: null, lastProbe: { kind: "unknown", error: "version probe produced no recognizable version" } }),
    }));
    expect(banner.peekStatus().state).toBe("unavailable");

    const truncated = new PathAgentRuntime(configuration, {
      workspacePath: "/workspace",
      discoverCandidates: async () => ["/opt/fake-agent"],
      probe: async () => ({ exitCode: null, stdout: "{\"version\": \"1.", stderr: "", timedOut: true }),
    });
    expect(await truncated.ensure()).toEqual(expect.objectContaining({
      state: "unavailable",
      reason: "startup-failed",
      message: "Fake Agent did not answer a version probe within 10s.",
      diagnostics: expect.objectContaining({ version: null, lastProbe: { kind: "abandoned" } }),
    }));
    expect(truncated.peekStatus().state).toBe("unavailable");
  });

  test("only a non-empty string is a version, and a timeout still reports the timeout", async () => {
    for (const answer of [undefined, "", 42, { version: "1.0.0" }]) {
      const configuration: PathAgentConfiguration = { ...FAKE_AGENT, parseVersion: () => answer as string | null };
      const answered = new PathAgentRuntime(configuration, {
        workspacePath: "/workspace",
        discoverCandidates: async () => ["/opt/fake-agent"],
        probe: async () => ({ exitCode: 0, stdout: "{}\n", stderr: "", timedOut: false }),
      });
      expect(await answered.ensure()).toEqual(expect.objectContaining({
        state: "unavailable",
        reason: "startup-failed",
        message: "Fake Agent could not be started: version probe produced no recognizable version.",
        diagnostics: expect.objectContaining({ version: null }),
      }));
      expect(answered.executablePath()).toBeNull();
      const timedOut = new PathAgentRuntime(configuration, {
        workspacePath: "/workspace",
        discoverCandidates: async () => ["/opt/fake-agent"],
        probe: async () => ({ exitCode: null, stdout: "{}", stderr: "", timedOut: true }),
      });
      expect(await timedOut.ensure()).toEqual(expect.objectContaining({
        message: "Fake Agent did not answer a version probe within 10s.",
        diagnostics: expect.objectContaining({ version: null, lastProbe: { kind: "abandoned" } }),
      }));
    }
  });

  test("an overridden message replaces only itself", async () => {
    const empty = await directory();
    const subject = runtime({ PATH: empty }, { configuration: { ...FAKE_AGENT, messages: { notInstalled: "Install Fake Agent first." } } });
    expect(await subject.ensure()).toEqual(expect.objectContaining({ message: "Install Fake Agent first." }));
  });
});

describe.skipIf(process.platform === "win32")("pathAgentRuntime", () => {
  test("status never probes, and the provider is built from the executable the probe found", async () => {
    const fake = await fakeExecutable("echo 'fake-agent 1.2.3'");
    const subject = runtime({ PATH: fake.directory });
    const built: string[] = [];
    const agent = pathAgentRuntime(subject, executable => {
      built.push(executable);
      return {} as ChatProvider;
    });
    expect(await agent.status()).toEqual({ state: "idle" });
    expect(await fake.probes()).toEqual([]);
    expect(agent.createProvider()).toBeNull();
    expect(await agent.ensure()).toEqual({ state: "ready", version: "1.2.3" });
    expect(await agent.status()).toEqual({ state: "ready", version: "1.2.3" });
    expect(agent.createProvider()).not.toBeNull();
    expect(built).toEqual([fake.executable]);
    expect(await agent.restart()).toEqual({ state: "ready", version: "1.2.3" });
    expect(await fake.probes()).toHaveLength(2);

    await agent.dispose();
    // Disposed: nothing probes again.
    expect(await agent.restart()).toEqual({ state: "ready", version: "1.2.3" });
    expect(await fake.probes()).toHaveLength(2);
  });
});
