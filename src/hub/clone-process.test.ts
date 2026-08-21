import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildCloneArguments, buildCloneEnvironment, CloneProcessAdapter } from "./clone-process";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("clone invocation policy", () => {
  test("strips ambient agent, askpass, helper, and provider variables while preserving unrelated values", () => {
    const env = buildCloneEnvironment({
      PATH: "/bin",
      SSH_AUTH_SOCK: "/secret/agent.sock",
      SSH_AGENT_PID: "42",
      GIT_ASKPASS: "/secret/git-askpass",
      SSH_ASKPASS: "/secret/ssh-askpass",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "ambient-helper",
      GH_TOKEN: "ambient-provider-token",
      PRIVATE_TOKEN: "not-inspected",
    });

    expect(Object.keys(env).sort()).toEqual([
      "GIT_TERMINAL_PROMPT",
      "PATH",
      "PRIVATE_TOKEN",
      "SSH_ASKPASS_REQUIRE",
    ]);
    expect(env.GIT_TERMINAL_PROMPT).toBe("1");
    expect(env.SSH_ASKPASS_REQUIRE).toBe("never");
    expect("GIT_ASKPASS" in env).toBe(false);
    expect("SSH_ASKPASS" in env).toBe(false);
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
  });

  test("uses per-command empty core askpass and credential helper lists", () => {
    expect(buildCloneArguments("ssh://host/repo.git", "/work/repo")).toEqual([
      "-c", "core.askPass=",
      "-c", "credential.helper=",
      "clone", "--", "ssh://host/repo.git", "/work/repo",
    ]);
  });

  test("scopes an HTTPS helper without putting its token in arguments", () => {
    const args = buildCloneArguments("https://github.com/acme/repo.git", "/work/repo", {
      type: "https",
      host: "github.com",
      credentialId: "token-1",
      stateRoot: "/private/hub state",
      uatuArgv: ["/opt/uatu"],
    });

    expect(args.join(" ")).toContain("credential.https://github.com.helper=");
    expect(args.join(" ")).toContain("UATU_CREDENTIAL_ID='token-1'");
    expect(args.join(" ")).not.toContain("provider-secret");
  });
});

describe("CloneProcessAdapter", () => {
  test("spawns a detached PTY, incrementally normalizes output, writes one line, and closes", async () => {
    let spawnArgv: string[] = [];
    let spawnOptions: Record<string, unknown> = {};
    let terminalData!: (terminal: unknown, bytes: Uint8Array) => void;
    const writes: string[] = [];
    let closed = false;
    const terminal = {
      localFlags: 0xff,
      write: (value: string) => writes.push(value),
      close: () => {
        closed = true;
      },
    };
    const output: string[] = [];
    const adapter = new CloneProcessAdapter({
      spawn(argv, options) {
        spawnArgv = argv;
        spawnOptions = options as Record<string, unknown>;
        terminalData = (options as { terminal: { data: typeof terminalData } }).terminal.data;
        return { pid: 42, exited: Promise.resolve(0), terminal };
      },
    });

    const proc = adapter.start({ url: "remote", target: "/tmp/repo", onOutput: value => output.push(value) });
    terminalData(terminal, new TextEncoder().encode("\u001b[31mclon"));
    terminalData(terminal, new TextEncoder().encode("ing\u001b[0m\r\nnext\u0007"));
    proc.writeLine("response");
    expect(await proc.exited).toBe(0);

    expect(spawnArgv).toEqual(["git", ...buildCloneArguments("remote", "/tmp/repo")]);
    expect(spawnOptions.detached).toBe(true);
    expect(spawnOptions.cwd).toBe("/tmp");
    expect(output.join("")).toBe("cloning\nnext");
    expect(writes).toEqual(["response\n"]);
    expect(terminal.localFlags & 0x08).toBe(0);
    expect(closed).toBe(true);
  });

  test("selects only the managed SSH identity and socket", async () => {
    let spawnOptions: Record<string, unknown> = {};
    const terminal = { localFlags: 0xff, write() {}, close() {} };
    const adapter = new CloneProcessAdapter({
      env: { PATH: "/bin", SSH_AUTH_SOCK: "/ambient.sock", GIT_SSH_COMMAND: "ambient ssh" },
      spawn(_argv, options) {
        spawnOptions = options as Record<string, unknown>;
        return { pid: 42, exited: Promise.resolve(0), terminal };
      },
    });

    const proc = adapter.start({
      url: "git@example.com:acme/repo.git",
      target: "/tmp/repo",
      credential: {
        type: "ssh",
        host: "example.com",
        agentSocket: "/managed/agent.sock",
        publicKeyPath: "/managed/key.pub",
      },
      onOutput() {},
    });
    await proc.exited;

    const env = spawnOptions.env as Record<string, string>;
    expect(env.SSH_AUTH_SOCK).toBe("/managed/agent.sock");
    expect(env.GIT_SSH_COMMAND).toContain("IdentityFile='/managed/key.pub'");
    expect(env.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
    expect(env.GIT_SSH_COMMAND).not.toContain("ambient");
  });

  test("does not echo a submitted response through a real PTY", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-clone-secret-"));
    tempDirectories.push(dir);
    const fakeGit = path.join(dir, "git-shaped.sh");
    await writeFile(fakeGit, [
      "#!/bin/sh",
      "printf 'Unrecognized response: '",
      "IFS= read -r answer",
      "printf '\\nreceived %s bytes\\n' \"${#answer}\"",
    ].join("\n"), { mode: 0o755 });

    let output = "";
    let sawPrompt!: () => void;
    const prompted = new Promise<void>(resolve => {
      sawPrompt = resolve;
    });
    const adapter = new CloneProcessAdapter({ gitCommand: fakeGit });
    const proc = adapter.start({
      url: "ignored",
      target: path.join(dir, "target"),
      onOutput(value) {
        output += value;
        if (output.includes("Unrecognized response:")) sawPrompt();
      },
    });
    await prompted;
    proc.writeLine("private-response");

    expect(await proc.exited).toBe(0);
    expect(output).toContain("received 16 bytes");
    expect(output).not.toContain("private-response");
  });

  test("terminates the detached process group, including a blocking descendant", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(path.join(os.tmpdir(), "uatu-clone-process-"));
    tempDirectories.push(dir);
    const fakeGit = path.join(dir, "git-shaped.sh");
    const childPidFile = path.join(dir, "child.pid");
    await writeFile(fakeGit, [
      "#!/bin/sh",
      "sleep 300 &",
      `printf '%s' \"$!\" > '${childPidFile}'`,
      "trap 'exit 0' TERM",
      "wait",
    ].join("\n"), { mode: 0o755 });

    const adapter = new CloneProcessAdapter({ gitCommand: fakeGit, termGraceMs: 100 });
    const proc = adapter.start({ url: "ignored", target: path.join(dir, "target"), onOutput: () => undefined });
    for (let attempt = 0; attempt < 100 && !(await Bun.file(childPidFile).exists()); attempt += 1) {
      await Bun.sleep(10);
    }
    const childPid = Number.parseInt(await Bun.file(childPidFile).text(), 10);

    await proc.terminate();
    expect(processExists(proc.pid)).toBe(false);
    expect(processExists(childPid)).toBe(false);
  });

  test("rejects termination when descendants remain after SIGKILL", async () => {
    const signals: Array<NodeJS.Signals | 0> = [];
    const terminal = { localFlags: 0xff, write() {}, close() {} };
    const adapter = new CloneProcessAdapter({
      spawn: () => ({ pid: 42, exited: Promise.resolve(143), terminal }),
      killGroup(_pid, signal) {
        signals.push(signal);
      },
      sleep: async () => Bun.sleep(1),
      termGraceMs: 1,
    });
    const proc = adapter.start({ url: "remote", target: "/tmp/repo", onOutput: () => undefined });

    await expect(proc.terminate()).rejects.toThrow("did not exit after SIGKILL");
    expect(signals).toContain("SIGKILL");
  });

  test("retries process-group termination after verification failure", async () => {
    let attempt = 0;
    const terminal = { localFlags: 0xff, write() {}, close() {} };
    const adapter = new CloneProcessAdapter({
      spawn: () => ({ pid: 42, exited: Promise.resolve(143), terminal }),
      killGroup(_pid, signal) {
        if (signal === "SIGTERM") attempt += 1;
        if (signal === 0 && attempt > 1) throw new Error("gone");
      },
      sleep: async () => Bun.sleep(1),
      termGraceMs: 1,
    });
    const proc = adapter.start({ url: "remote", target: "/tmp/repo", onOutput: () => undefined });

    await expect(proc.terminate()).rejects.toThrow("did not exit after SIGKILL");
    await expect(proc.terminate()).resolves.toBeUndefined();
    expect(attempt).toBe(2);
  });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
