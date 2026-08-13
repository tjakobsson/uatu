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
  test("disables askpass and credential helpers while preserving unrelated values and SSH_AUTH_SOCK", () => {
    const env = buildCloneEnvironment({
      PATH: "/bin",
      SSH_AUTH_SOCK: "/secret/agent.sock",
      GIT_ASKPASS: "/secret/git-askpass",
      SSH_ASKPASS: "/secret/ssh-askpass",
      PRIVATE_TOKEN: "not-inspected",
    });

    expect(Object.keys(env).sort()).toEqual([
      "GIT_TERMINAL_PROMPT",
      "PATH",
      "PRIVATE_TOKEN",
      "SSH_ASKPASS_REQUIRE",
      "SSH_AUTH_SOCK",
    ]);
    expect(env.GIT_TERMINAL_PROMPT).toBe("1");
    expect(env.SSH_ASKPASS_REQUIRE).toBe("never");
    expect("GIT_ASKPASS" in env).toBe(false);
    expect("SSH_ASKPASS" in env).toBe(false);
    expect(env.SSH_AUTH_SOCK).toBeDefined();
  });

  test("uses per-command empty core askpass and credential helper lists", () => {
    expect(buildCloneArguments("ssh://host/repo.git", "/work/repo")).toEqual([
      "-c", "core.askPass=",
      "-c", "credential.helper=",
      "clone", "--", "ssh://host/repo.git", "/work/repo",
    ]);
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
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
