import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ManagedSshAgent } from "./credential-ssh-agent";
import { parseOwnership, socketIdentity, type SshAgentOwnership } from "./credential-ssh-supervisor";
import { discoverExecutable } from "./credential-tools";

const tempDirectories: string[] = [];
const agents: ManagedSshAgent[] = [];
const guardianPids = new Set<number>();
const CLI_ARGV = [process.execPath, path.resolve(import.meta.dir, "../cli.ts")];

async function pathExists(filePath: string): Promise<boolean> {
  try { await lstat(filePath); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.shutdown().catch(() => undefined)));
  const pids = [...guardianPids];
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* Already gone. */ }
  }
  guardianPids.clear();
  const deadline = Date.now() + 5_000;
  let remaining = pids.filter(processExists);
  while (remaining.length > 0 && Date.now() < deadline) {
    await Bun.sleep(20);
    remaining = remaining.filter(processExists);
  }
  if (remaining.length > 0) {
    throw new Error(`guardian test cleanup could not reap PID(s): ${remaining.join(", ")}`);
  }
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

function manager(runtime: string, executable: string, options: { stopTimeoutMs?: number; bootId?: string | null } = {}): ManagedSshAgent {
  const agent = new ManagedSshAgent({ runtimeDirectory: runtime, sshAgentPath: executable, uatuArgv: CLI_ARGV, ...options });
  agents.push(agent);
  return agent;
}

async function ownership(runtime: string): Promise<SshAgentOwnership> {
  const record = JSON.parse(await readFile(path.join(runtime, "ssh-agent.json"), "utf8")) as SshAgentOwnership;
  guardianPids.add(record.supervisorPid);
  return record;
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let buffered = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) throw new Error("stream closed before a line was available");
      buffered += new TextDecoder().decode(next.value);
      const newline = buffered.indexOf("\n");
      if (newline >= 0) return buffered.slice(0, newline);
    }
  } finally {
    reader.releaseLock();
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function killManaged(record: SshAgentOwnership): Promise<void> {
  for (const pid of [record.supervisorPid, record.agentPid]) {
    try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
  guardianPids.delete(record.supervisorPid);
  const deadline = Date.now() + 2_000;
  while ((processExists(record.supervisorPid) || processExists(record.agentPid)) && Date.now() < deadline) {
    await Bun.sleep(20);
  }
  if (processExists(record.supervisorPid) || processExists(record.agentPid)) {
    throw new Error("managed processes did not exit after simulated WSL shutdown");
  }
}

describe("ManagedSshAgent", () => {
  test("starts through the source CLI and shuts down through its authenticated guardian", async () => {
    const { runtime, executable } = await fixture();
    const agent = manager(runtime, executable);

    expect(await agent.start()).toBe(path.join(runtime, "ssh-agent.sock"));
    const record = await ownership(runtime);
    expect([2, 3]).toContain(record.version);
    if (record.version === 3) expect(record.bootId).toMatch(/^[a-f0-9-]{36}$/);
    expect(record.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(record.agentPid).toBeGreaterThan(0);
    expect(record.supervisorPid).toBeGreaterThan(0);
    expect((await lstat(agent.socketPath)).mode & 0o077).toBe(0);
    expect((await lstat(agent.controlSocketPath)).mode & 0o077).toBe(0);

    await agent.shutdown();
    guardianPids.delete(record.supervisorPid);
    expect(await pathExists(agent.socketPath)).toBe(false);
    expect(await pathExists(agent.controlSocketPath)).toBe(false);
    expect(await Bun.file(path.join(runtime, "ssh-agent.json")).exists()).toBe(false);
  });

  test("writes version 3 ownership with a boot ID and falls back to version 2 without a valid one", async () => {
    const { runtime, executable } = await fixture();
    const bootId = "11111111-1111-4111-8111-111111111111";
    const versioned = manager(runtime, executable, { bootId });
    await versioned.start();
    const versionedRecord = await ownership(runtime);
    expect(versionedRecord).toMatchObject({ version: 3, bootId });
    await versioned.shutdown();
    guardianPids.delete(versionedRecord.supervisorPid);

    const fallback = manager(runtime, executable, { bootId: "not-a-boot-id" });
    await fallback.start();
    const fallbackRecord = await ownership(runtime);
    expect(fallbackRecord.version).toBe(2);
    expect(fallbackRecord).not.toHaveProperty("bootId");
  });

  test("recovers a real surviving guardian before starting fresh without numeric process.kill", async () => {
    const { runtime, executable } = await fixture();
    const first = manager(runtime, executable);
    await first.start();
    const previous = await ownership(runtime);
    const kill = spyOn(process, "kill");

    const replacement = manager(runtime, executable);
    await replacement.start();
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();

    const current = await ownership(runtime);
    guardianPids.delete(previous.supervisorPid);
    expect(current.nonce).not.toBe(previous.nonce);
    expect(current.supervisorPid).not.toBe(previous.supervisorPid);
    expect(current.agentPid).not.toBe(previous.agentPid);
  });

  test("public recover retires persisted guardian state without starting a fresh agent", async () => {
    const { runtime, executable } = await fixture();
    const first = manager(runtime, executable);
    await first.start();
    const previous = await ownership(runtime);
    const recovery = new ManagedSshAgent({ runtimeDirectory: runtime, uatuArgv: CLI_ARGV });
    agents.push(recovery);

    await recovery.recover();
    guardianPids.delete(previous.supervisorPid);
    expect(recovery.currentSocket()).toBeUndefined();
    expect(await pathExists(first.socketPath)).toBe(false);
    expect(await pathExists(first.controlSocketPath)).toBe(false);
    expect(await pathExists(path.join(runtime, "ssh-agent.json"))).toBe(false);
    await expect(recovery.start()).rejects.toThrow("ssh-agent is unavailable");
  });

  test("fails closed on an old ownership record without spawning or removing it", async () => {
    const { runtime, executable } = await fixture();
    const record = { version: 1, nonce: "old", pid: process.pid, socketDevice: 1, socketInode: 1 };
    const ownershipPath = path.join(runtime, "ssh-agent.json");
    await writeFile(ownershipPath, JSON.stringify(record), { mode: 0o600 });
    let spawned = false;
    const agent = new ManagedSshAgent({
      runtimeDirectory: runtime,
      sshAgentPath: executable,
      uatuArgv: CLI_ARGV,
      spawnSupervisor() { spawned = true; throw new Error("must not spawn"); },
    });

    await expect(agent.start()).rejects.toThrow("unsupported version");
    expect(spawned).toBe(false);
    expect(JSON.parse(await readFile(ownershipPath, "utf8"))).toEqual(record);
  });

  test("wrong nonce fails closed and preserves both sockets and the record", async () => {
    const { runtime, executable } = await fixture();
    const first = manager(runtime, executable);
    await first.start();
    const original = await ownership(runtime);
    const ownershipPath = path.join(runtime, "ssh-agent.json");
    const replaced = { ...original, nonce: "0".repeat(64) };
    await writeFile(ownershipPath, `${JSON.stringify(replaced)}\n`, { mode: 0o600 });

    const recovery = manager(runtime, executable, { stopTimeoutMs: 200 });
    await expect(recovery.start()).rejects.toThrow("SSH guardian request failed");
    expect(JSON.parse(await readFile(ownershipPath, "utf8"))).toEqual(replaced);
    expect((await lstat(first.socketPath)).isSocket()).toBe(true);
    expect((await lstat(first.controlSocketPath)).isSocket()).toBe(true);

    await writeFile(ownershipPath, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  });

  test("a replaced control socket fails closed without touching the agent socket", async () => {
    const { runtime, executable } = await fixture();
    const first = manager(runtime, executable);
    await first.start();
    const record = await ownership(runtime);
    await rm(first.controlSocketPath);
    const replacement = Bun.listen({ unix: first.controlSocketPath, socket: { data() {} } });
    await chmod(first.controlSocketPath, 0o600);
    try {
      const recovery = manager(runtime, executable);
      await expect(recovery.start()).rejects.toThrow("does not match its ownership record");
      expect((await lstat(first.socketPath)).isSocket()).toBe(true);
      expect(JSON.parse(await readFile(path.join(runtime, "ssh-agent.json"), "utf8"))).toEqual(record);
    } finally {
      replacement.stop(true);
      await rm(first.controlSocketPath, { force: true });
    }
  });

  test("a missing guardian fails closed and preserves the ownership record", async () => {
    const { runtime, executable } = await fixture();
    const first = manager(runtime, executable);
    await first.start();
    const record = await ownership(runtime);
    await rm(first.controlSocketPath);

    const recovery = manager(runtime, executable);
    await expect(recovery.start()).rejects.toThrow("ENOENT");
    expect((await lstat(first.socketPath)).isSocket()).toBe(true);
    expect(JSON.parse(await readFile(path.join(runtime, "ssh-agent.json"), "utf8"))).toEqual(record);
  });

  test("removes exact previous-boot artifacts after an interrupted WSL shutdown", async () => {
    const { runtime, executable } = await fixture();
    const oldBootId = "11111111-1111-4111-8111-111111111111";
    const newBootId = "22222222-2222-4222-8222-222222222222";
    const first = manager(runtime, executable, { bootId: oldBootId });
    await first.start();
    const record = await ownership(runtime);
    await killManaged(record);

    // WSL teardown may interrupt guardian cleanup after removing only one path.
    await rm(first.controlSocketPath, { force: true });
    expect(await pathExists(first.socketPath)).toBe(true);
    expect(await pathExists(path.join(runtime, "ssh-agent.json"))).toBe(true);

    const recovery = manager(runtime, executable, { bootId: newBootId });
    await recovery.recover();

    expect(await pathExists(first.socketPath)).toBe(false);
    expect(await pathExists(first.controlSocketPath)).toBe(false);
    expect(await pathExists(path.join(runtime, "ssh-agent.json"))).toBe(false);
  });

  test("preserves a replaced previous-boot socket", async () => {
    const { runtime, executable } = await fixture();
    const first = manager(runtime, executable, { bootId: "11111111-1111-4111-8111-111111111111" });
    await first.start();
    const record = await ownership(runtime);
    await killManaged(record);
    await rm(first.controlSocketPath);
    const replacement = Bun.listen({ unix: first.controlSocketPath, socket: { data() {} } });
    await chmod(first.controlSocketPath, 0o600);
    try {
      const recovery = manager(runtime, executable, { bootId: "22222222-2222-4222-8222-222222222222" });
      await expect(recovery.recover()).rejects.toThrow("does not match its ownership record");
      expect(await pathExists(first.socketPath)).toBe(true);
      expect(await pathExists(first.controlSocketPath)).toBe(true);
      expect(JSON.parse(await readFile(path.join(runtime, "ssh-agent.json"), "utf8"))).toEqual(record);
    } finally {
      replacement.stop(true);
      await rm(first.controlSocketPath, { force: true });
    }
  });

  test("an unresponsive identity-matched control socket times out and is preserved", async () => {
    const { runtime, executable } = await fixture();
    const first = manager(runtime, executable);
    await first.start();
    const original = await ownership(runtime);
    const ownershipPath = path.join(runtime, "ssh-agent.json");
    await rm(first.controlSocketPath);
    const unresponsive = Bun.listen({ unix: first.controlSocketPath, socket: { data() {} } });
    await chmod(first.controlSocketPath, 0o600);
    const record = { ...original, controlSocket: await socketIdentity(first.controlSocketPath) };
    await writeFile(ownershipPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try {
      const recovery = manager(runtime, executable, { stopTimeoutMs: 100 });
      await expect(recovery.start()).rejects.toThrow("SSH guardian request failed");
      expect(await pathExists(first.socketPath)).toBe(true);
      expect(await pathExists(first.controlSocketPath)).toBe(true);
      expect(JSON.parse(await readFile(ownershipPath, "utf8"))).toEqual(record);
    } finally {
      unresponsive.stop(true);
      await rm(first.controlSocketPath, { force: true });
    }
  });

  test("an unrecorded socket is preserved and blocks startup", async () => {
    const { runtime, executable } = await fixture();
    const socketPath = path.join(runtime, "ssh-agent.sock");
    const listener = Bun.listen({ unix: socketPath, socket: { data() {} } });
    try {
      await expect(manager(runtime, executable).start()).rejects.toThrow("unowned SSH guardian artifact");
      expect((await lstat(socketPath)).isSocket()).toBe(true);
    } finally {
      listener.stop(true);
    }
  });

  test("cached start detects an unexpected agent exit, waits for guardian cleanup, and starts fresh", async () => {
    const { runtime, executable } = await fixture();
    const agent = manager(runtime, executable);
    await agent.start();
    const previous = await ownership(runtime);

    process.kill(previous.agentPid, "SIGKILL");
    for (let attempt = 0; attempt < 100 && await pathExists(agent.controlSocketPath); attempt += 1) await Bun.sleep(20);
    await agent.start();

    const current = await ownership(runtime);
    guardianPids.delete(previous.supervisorPid);
    expect(current.nonce).not.toBe(previous.nonce);
    expect(current.agentPid).not.toBe(previous.agentPid);
    expect(current.supervisorPid).not.toBe(previous.supervisorPid);
  });

  test("clean unexpected agent exit removes its missing socket and restarts fresh", async () => {
    const { runtime, executable } = await fixture();
    const agent = manager(runtime, executable);
    await agent.start();
    const previous = await ownership(runtime);

    process.kill(previous.agentPid, "SIGTERM");
    for (let attempt = 0; attempt < 100 && await pathExists(agent.controlSocketPath); attempt += 1) await Bun.sleep(20);
    await agent.start();

    const current = await ownership(runtime);
    guardianPids.delete(previous.supervisorPid);
    expect(current.nonce).not.toBe(previous.nonce);
    expect(current.agentPid).not.toBe(previous.agentPid);
  });

  test("refuses interrupted nonce quarantine artifacts when the public record is absent", async () => {
    const { runtime, executable } = await fixture();
    const first = manager(runtime, executable);
    await first.start();
    const record = await ownership(runtime);
    const publicPaths = [first.socketPath, first.controlSocketPath, path.join(runtime, "ssh-agent.json")];
    const quarantines = publicPaths.map(filePath => `${filePath}.${record.nonce}.quarantine`);
    for (let index = 0; index < publicPaths.length; index += 1) {
      await rename(publicPaths[index]!, quarantines[index]!);
    }
    try {
      const recovery = new ManagedSshAgent({ runtimeDirectory: runtime, uatuArgv: CLI_ARGV });
      await expect(recovery.recover()).rejects.toThrow("quarantine artifacts require manual recovery");
      for (const quarantine of quarantines) expect(await pathExists(quarantine)).toBe(true);
    } finally {
      for (let index = 0; index < publicPaths.length; index += 1) {
        await rename(quarantines[index]!, publicPaths[index]!);
      }
    }
  });

  test("serializes shutdown during startup and startup during shutdown", async () => {
    const { runtime, executable } = await fixture();
    const agent = manager(runtime, executable);
    const starting = agent.start();
    const stopping = agent.shutdown();
    await starting;
    await stopping;
    expect(await pathExists(agent.socketPath)).toBe(false);

    await agent.start();
    const previous = await ownership(runtime);
    const stopAgain = agent.shutdown();
    const restart = agent.start();
    await stopAgain;
    await restart;
    const current = await ownership(runtime);
    guardianPids.delete(previous.supervisorPid);
    expect(current.nonce).not.toBe(previous.nonce);
  });

  test("rejects a forged challenge response and preserves all artifacts", async () => {
    const { runtime, executable } = await fixture();
    const first = manager(runtime, executable);
    await first.start();
    const original = await ownership(runtime);
    const ownershipPath = path.join(runtime, "ssh-agent.json");
    await rm(first.controlSocketPath);
    const forged = Bun.listen<{ input: string }>({
      unix: first.controlSocketPath,
      data: { input: "" },
      socket: {
        data(socket, data) {
          socket.data.input += data.toString("utf8");
          const newline = socket.data.input.indexOf("\n");
          if (newline < 0) return;
          const request = JSON.parse(socket.data.input.slice(0, newline)) as { version: number; command: string; challenge: string };
          expect(request).not.toHaveProperty("nonce");
          socket.write(`${JSON.stringify({ ...request, mac: "0".repeat(64) })}\n`);
          socket.end();
        },
      },
    });
    await chmod(first.controlSocketPath, 0o600);
    const record = { ...original, controlSocket: await socketIdentity(first.controlSocketPath) };
    await writeFile(ownershipPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try {
      await expect(manager(runtime, executable).start()).rejects.toThrow("SSH guardian request failed");
      expect(await pathExists(first.socketPath)).toBe(true);
      expect(await pathExists(first.controlSocketPath)).toBe(true);
      expect(JSON.parse(await readFile(ownershipPath, "utf8"))).toEqual(record);
    } finally {
      forged.stop(true);
      await rm(first.controlSocketPath, { force: true });
    }
  });

  test("guardian and agent survive parent SIGKILL and replacement recovery starts fresh without numeric signals", async () => {
    const { runtime, executable } = await fixture();
    const parentScript = path.join(path.dirname(runtime), "parent.ts");
    await writeFile(parentScript, [
      `import { ManagedSshAgent } from ${JSON.stringify(path.resolve(import.meta.dir, "credential-ssh-agent.ts"))};`,
      "const [runtime, sshAgentPath, cliPath] = Bun.argv.slice(2);",
      "const agent = new ManagedSshAgent({ runtimeDirectory: runtime!, sshAgentPath: sshAgentPath!, uatuArgv: [process.execPath, cliPath!] });",
      "await agent.start();",
      "console.log('ready');",
      "await new Promise(() => {});",
    ].join("\n"), { mode: 0o600 });
    const parent = Bun.spawn([process.execPath, parentScript, runtime, executable, CLI_ARGV[1]!], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await readLine(parent.stdout)).toBe("ready");
    const previous = await ownership(runtime);

    parent.kill("SIGKILL");
    await parent.exited;
    expect(processExists(previous.agentPid)).toBe(true);
    expect(processExists(previous.supervisorPid)).toBe(true);

    const kill = spyOn(process, "kill");
    const replacement = manager(runtime, executable);
    await replacement.recover();
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
    guardianPids.delete(previous.supervisorPid);
    expect(processExists(previous.agentPid)).toBe(false);
    expect(processExists(previous.supervisorPid)).toBe(false);
    expect(await pathExists(path.join(runtime, "ssh-agent.json"))).toBe(false);
    const sshAddPath = (await discoverExecutable("ssh-add")).path;
    if (!sshAddPath) throw new Error("OpenSSH ssh-add is required for this test");
    const oldAgentProbe = Bun.spawn([sshAddPath, "-l"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: process.env.PATH ?? "", SSH_AUTH_SOCK: replacement.socketPath },
    });
    expect(await oldAgentProbe.exited).not.toBe(0);

    await replacement.start();
    const current = await ownership(runtime);
    expect(current.nonce).not.toBe(previous.nonce);
  }, 15_000);
});

describe("unreadable ownership records", () => {
  // Version 2 shipped without a boot identity and remains readable after the
  // version 3 extension. The v1 format with { pid, socketDevice, socketInode }
  // existed solely in pre-merge feature-branch builds and never shipped.
  // Any other unreadable record means a different build's guardian or disk
  // damage. The error must name the file and give advice that
  // retires everything together: deleting only the record would orphan a
  // live guardian and strand its sockets as unowned artifacts.
  test("names the file and directs recovery at the whole runtime directory", async () => {
    const { runtime, executable } = await fixture();
    const recordPath = path.join(runtime, "ssh-agent.json");
    await writeFile(recordPath, JSON.stringify({ version: 99, nonce: "nope" }), { mode: 0o600 });

    await expect(manager(runtime, executable).start()).rejects.toThrow(recordPath);
    await expect(manager(runtime, executable).start()).rejects.toThrow(`remove ${runtime}`);
  });

  test("reports unparseable JSON separately from an unsupported version", async () => {
    const { runtime, executable } = await fixture();
    await writeFile(path.join(runtime, "ssh-agent.json"), "{ not json", { mode: 0o600 });

    await expect(manager(runtime, executable).start()).rejects.toThrow(/not valid JSON/);
  });

  test("treats the never-released v1 format as unsupported, with the same advice", async () => {
    const { runtime, executable } = await fixture();
    await writeFile(path.join(runtime, "ssh-agent.json"), JSON.stringify({
      version: 1, nonce: "a".repeat(64), pid: 1, socketDevice: 1, socketInode: 1,
    }), { mode: 0o600 });

    await expect(manager(runtime, executable).start()).rejects.toThrow(`remove ${runtime}`);
  });

  test("continues to parse the shipped version 2 ownership format", () => {
    const socket = { type: "socket" as const, uid: 501, mode: 0o600, device: 1, inode: 2 };
    const record = {
      version: 2 as const,
      nonce: "a".repeat(64),
      agentPid: 10,
      supervisorPid: 11,
      agentSocket: socket,
      controlSocket: { ...socket, inode: 3 },
    };

    expect(parseOwnership(record)).toEqual(record);
  });
});
