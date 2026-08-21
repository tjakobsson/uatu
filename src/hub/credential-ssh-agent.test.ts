import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ManagedSshAgent } from "./credential-ssh-agent";
import { discoverExecutable } from "./credential-tools";

const tempDirectories: string[] = [];
const agents: ManagedSshAgent[] = [];

afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.shutdown().catch(() => undefined)));
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ runtime: string; executable: string }> {
  const root = await mkdtemp("/tmp/uatu-ssh-agent-");
  tempDirectories.push(root);
  const runtime = path.join(root, "credential-runtime");
  await mkdir(runtime, { mode: 0o700 });
  const executable = (await discoverExecutable("ssh-agent")).path;
  if (!executable) throw new Error("OpenSSH ssh-agent is required for this test");
  return { runtime, executable };
}

describe("ManagedSshAgent", () => {
  test("starts lazily at the fixed private socket and shuts down only its recorded child", async () => {
    const { runtime, executable } = await fixture();
    const agent = new ManagedSshAgent({ runtimeDirectory: runtime, sshAgentPath: executable });
    agents.push(agent);

    expect(await Bun.file(agent.socketPath).exists()).toBe(false);
    expect(agent.currentSocket()).toBeUndefined();

    expect(await agent.start()).toBe(path.join(runtime, "ssh-agent.sock"));
    const ownership = JSON.parse(await readFile(path.join(runtime, "ssh-agent.json"), "utf8"));
    expect(ownership.pid).toBeGreaterThan(0);
    expect(ownership.nonce).toBeString();
    expect(agent.currentSocket()).toBe(agent.socketPath);

    await agent.shutdown();
    expect(processExists(ownership.pid)).toBe(false);
    expect(await Bun.file(agent.socketPath).exists()).toBe(false);
    expect(await Bun.file(path.join(runtime, "ssh-agent.json")).exists()).toBe(false);

    await agent.start();
    await agent.shutdown();
    expect(await Bun.file(path.join(runtime, "ssh-agent.json")).exists()).toBe(false);
  });

  test("recovers a record without a socket without signaling its recorded pid", async () => {
    const { runtime, executable } = await fixture();
    const impossiblePid = 2_147_483_647;
    await writeFile(path.join(runtime, "ssh-agent.json"), JSON.stringify({
      version: 1,
      nonce: "stale",
      pid: impossiblePid,
      socketDevice: 1,
      socketInode: 1,
    }), { mode: 0o600 });
    const signals: Array<number | NodeJS.Signals> = [];
    const agent = new ManagedSshAgent({
      runtimeDirectory: runtime,
      sshAgentPath: executable,
      spawn(argv, options) {
        const child = Bun.spawn(argv, options);
        return {
          pid: child.pid,
          exited: child.exited,
          kill(signal) {
            if (signal !== undefined) signals.push(signal);
            child.kill(signal);
          },
        };
      },
    });
    agents.push(agent);

    await agent.start();
    expect(signals).toEqual([]);
    expect(JSON.parse(await readFile(path.join(runtime, "ssh-agent.json"), "utf8")).pid).not.toBe(impossiblePid);
  });

  test("preserves a missing-socket record whose pid is still live", async () => {
    const { runtime, executable } = await fixture();
    const ownershipPath = path.join(runtime, "ssh-agent.json");
    const record = {
      version: 1,
      nonce: "live-owner",
      pid: process.pid,
      socketDevice: 1,
      socketInode: 1,
    };
    await writeFile(ownershipPath, JSON.stringify(record), { mode: 0o600 });
    let spawned = false;
    const agent = new ManagedSshAgent({
      runtimeDirectory: runtime,
      sshAgentPath: executable,
      spawn() {
        spawned = true;
        throw new Error("must not spawn");
      },
    });

    await expect(agent.start()).rejects.toThrow(`names live process ${process.pid}, but its socket is missing`);
    expect(spawned).toBe(false);
    expect(JSON.parse(await readFile(ownershipPath, "utf8"))).toEqual(record);
  });

  test("retires a surviving recorded agent before starting after a Hub restart", async () => {
    const { runtime, executable } = await fixture();
    const socketPath = path.join(runtime, "ssh-agent.sock");
    const ownershipPath = path.join(runtime, "ssh-agent.json");
    const survivor = Bun.spawn([executable, "-D", "-a", socketPath], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C" },
    });
    try {
      let socket;
      for (let attempt = 0; attempt < 250; attempt += 1) {
        socket = await lstat(socketPath).catch(() => undefined);
        if (socket?.isSocket()) break;
        await Bun.sleep(20);
      }
      if (!socket?.isSocket()) throw new Error("fixture SSH agent did not create its socket");
      await writeFile(ownershipPath, JSON.stringify({
        version: 1,
        nonce: "previous-hub",
        pid: survivor.pid,
        socketDevice: Number(socket.dev),
        socketInode: Number(socket.ino),
      }), { mode: 0o600 });

      const replacement = new ManagedSshAgent({ runtimeDirectory: runtime, sshAgentPath: executable });
      agents.push(replacement);
      await replacement.start();

      expect(processExists(survivor.pid)).toBe(false);
      const replacementOwnership = JSON.parse(await readFile(ownershipPath, "utf8"));
      expect(replacementOwnership.pid).not.toBe(survivor.pid);
      expect(replacementOwnership.nonce).not.toBe("previous-hub");
    } finally {
      if (processExists(survivor.pid)) survivor.kill("SIGKILL");
      await survivor.exited;
    }
  });

  test("removes owned artifacts after an unexpected agent exit and restarts", async () => {
    const { runtime, executable } = await fixture();
    const agent = new ManagedSshAgent({ runtimeDirectory: runtime, sshAgentPath: executable });
    agents.push(agent);
    await agent.start();
    const ownership = JSON.parse(await readFile(path.join(runtime, "ssh-agent.json"), "utf8"));

    process.kill(ownership.pid, "SIGKILL");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (agent.currentSocket() === undefined && !await Bun.file(agent.socketPath).exists()) break;
      await Bun.sleep(10);
    }
    expect(agent.currentSocket()).toBeUndefined();
    expect(await Bun.file(agent.socketPath).exists()).toBe(false);
    expect(await Bun.file(path.join(runtime, "ssh-agent.json")).exists()).toBe(false);

    expect(await agent.start()).toBe(agent.socketPath);
  });

  test("refuses an unverified socket without spawning or removing it", async () => {
    const { runtime, executable } = await fixture();
    const socketPath = path.join(runtime, "ssh-agent.sock");
    const listener = Bun.listen({
      unix: socketPath,
      socket: { data() {} },
    });
    let spawned = false;
    const agent = new ManagedSshAgent({
      runtimeDirectory: runtime,
      sshAgentPath: executable,
      spawn() {
        spawned = true;
        throw new Error("must not spawn");
      },
    });
    try {
      await expect(agent.start()).rejects.toThrow("not owned by this Hub process");
      expect(spawned).toBe(false);
      expect((await lstat(socketPath)).isSocket()).toBe(true);
    } finally {
      listener.stop(true);
    }
  });

  test("refuses to signal its child after the ownership record is replaced", async () => {
    const { runtime, executable } = await fixture();
    const agent = new ManagedSshAgent({ runtimeDirectory: runtime, sshAgentPath: executable });
    agents.push(agent);
    await agent.start();
    const original = await readFile(path.join(runtime, "ssh-agent.json"), "utf8");
    await writeFile(path.join(runtime, "ssh-agent.json"), JSON.stringify({
      version: 1,
      nonce: "replacement",
      pid: process.pid,
      socketDevice: 0,
      socketInode: 0,
    }), { mode: 0o600 });

    await expect(agent.shutdown()).rejects.toThrow("ownership cannot be proven");
    expect((await lstat(agent.socketPath)).isSocket()).toBe(true);
    await writeFile(path.join(runtime, "ssh-agent.json"), original, { mode: 0o600 });
    await agent.shutdown();
  });

  test("escalates bounded shutdown to SIGKILL when the owned child ignores SIGTERM", async () => {
    const { runtime, executable } = await fixture();
    const signals: Array<number | NodeJS.Signals | undefined> = [];
    const agent = new ManagedSshAgent({
      runtimeDirectory: runtime,
      sshAgentPath: executable,
      stopTimeoutMs: 5,
      spawn(argv, options) {
        const child = Bun.spawn(argv, options);
        return {
          pid: child.pid,
          exited: child.exited,
          kill(signal) {
            signals.push(signal);
            if (signal !== "SIGTERM") child.kill(signal);
          },
        };
      },
    });
    agents.push(agent);
    await agent.start();

    await agent.shutdown();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
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
