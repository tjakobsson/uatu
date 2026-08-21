import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ManagedSshAgent } from "./credential-ssh-agent";
import { discoverExecutable } from "./credential-tools";

const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const CLI_ARGV = [process.execPath, path.resolve(import.meta.dir, "../cli.ts")];

async function pathExists(filePath: string): Promise<boolean> {
  try { await lstat(filePath); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
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

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
    await child.exited.catch(() => undefined);
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; runtime: string; executable: string }> {
  const root = await mkdtemp("/tmp/uatu-ssh-supervisor-");
  roots.push(root);
  const runtime = path.join(root, "runtime");
  await mkdir(runtime, { mode: 0o700 });
  const executable = (await discoverExecutable("ssh-agent")).path;
  if (!executable) throw new Error("OpenSSH ssh-agent is required for this test");
  return { root, runtime, executable };
}

describe("SSH agent supervisor", () => {
  test("startup EOF before commit terminates the child and removes both sockets", async () => {
    const { runtime, executable } = await fixture();
    const nonce = "a".repeat(64);
    const agentSocketPath = path.join(runtime, "ssh-agent.sock");
    const controlSocketPath = path.join(runtime, "ssh-agent-control.sock");
    const child = Bun.spawn([...CLI_ARGV, "--ssh-agent-supervisor"], {
      detached: true,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    child.stdin.write(`${JSON.stringify({
      version: 1,
      nonce,
      runtimeDirectory: runtime,
      sshAgentPath: executable,
      agentSocketPath,
      controlSocketPath,
      ownershipPath: path.join(runtime, "ssh-agent.json"),
      servicePath: process.env.PATH ?? "",
    })}\n`);
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (await pathExists(agentSocketPath) && await pathExists(controlSocketPath)) break;
      await Bun.sleep(20);
    }
    expect(await pathExists(agentSocketPath)).toBe(true);
    child.stdin.end();
    expect(await child.exited).toBe(1);
    const ready = JSON.parse((await new Response(child.stdout).text()).trim()) as { ready: { agentPid: number } };
    children.splice(children.indexOf(child), 1);
    expect(() => process.kill(ready.ready.agentPid, 0)).toThrow();
    expect(await pathExists(agentSocketPath)).toBe(false);
    expect(await pathExists(controlSocketPath)).toBe(false);
    expect(await Bun.file(path.join(runtime, "ssh-agent.json")).exists()).toBe(false);
  });

  test("a TERM-ignoring direct child is escalated by the supervisor without touching a decoy", async () => {
    const { root, runtime } = await fixture();
    const fakeAgent = path.join(root, "fake-agent.ts");
    const termMarker = path.join(root, "term-received");
    await writeFile(fakeAgent, [
      "#!/usr/bin/env bun",
      "import { chmodSync, writeFileSync } from 'node:fs';",
      "const socketPath = Bun.argv[Bun.argv.indexOf('-a') + 1];",
      "const listener = Bun.listen({ unix: socketPath, socket: { data() {} } });",
      "chmodSync(socketPath, 0o600);",
      `process.on('SIGTERM', () => writeFileSync(${JSON.stringify(termMarker)}, 'term\\n'));`,
      "await new Promise(() => {});",
      "listener.stop(true);",
    ].join("\n"), { mode: 0o700 });
    await chmod(fakeAgent, 0o700);

    const decoySocket = path.join(root, "decoy.sock");
    const decoy = Bun.spawn([fakeAgent, "-D", "-a", decoySocket], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    children.push(decoy);
    for (let attempt = 0; attempt < 100 && !await pathExists(decoySocket); attempt += 1) await Bun.sleep(10);

    const agent = new ManagedSshAgent({
      runtimeDirectory: runtime,
      sshAgentPath: fakeAgent,
      uatuArgv: CLI_ARGV,
      stopTimeoutMs: 1_000,
    });
    await agent.start();
    await agent.shutdown();

    expect(await readFile(termMarker, "utf8")).toBe("term\n");
    expect(await pathExists(agent.socketPath)).toBe(false);
    expect(await pathExists(decoySocket)).toBe(true);
    expect(decoy.exitCode).toBeNull();
  });

  test("rejects trailing startup messages and cleans the uncommitted child and artifacts", async () => {
    const { runtime, executable } = await fixture();
    const nonce = "b".repeat(64);
    const agentSocketPath = path.join(runtime, "ssh-agent.sock");
    const controlSocketPath = path.join(runtime, "ssh-agent-control.sock");
    const ownershipPath = path.join(runtime, "ssh-agent.json");
    const child = Bun.spawn([...CLI_ARGV, "--ssh-agent-supervisor"], {
      detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    children.push(child);
    child.stdin.write(`${JSON.stringify({
      version: 1, nonce, runtimeDirectory: runtime, sshAgentPath: executable,
      agentSocketPath, controlSocketPath, ownershipPath, servicePath: process.env.PATH ?? "",
    })}\n`);
    const ready = JSON.parse(await readLine(child.stdout)) as { ready: unknown };
    await writeFile(ownershipPath, `${JSON.stringify(ready.ready)}\n`, { mode: 0o600 });
    child.stdin.write(`${JSON.stringify({ commit: nonce })}\n${JSON.stringify({ extra: true })}\n`);
    child.stdin.end();

    expect(await child.exited).toBe(1);
    children.splice(children.indexOf(child), 1);
    expect(await pathExists(agentSocketPath)).toBe(false);
    expect(await pathExists(controlSocketPath)).toBe(false);
    expect(await pathExists(ownershipPath)).toBe(false);
  });

  test("rejects commit after the direct child exits and cleans the ownership record", async () => {
    const { root, runtime } = await fixture();
    const fakeAgent = path.join(root, "short-agent.ts");
    await writeFile(fakeAgent, [
      "#!/usr/bin/env bun",
      "import { chmodSync } from 'node:fs';",
      "const socketPath = Bun.argv[Bun.argv.indexOf('-a') + 1];",
      "Bun.listen({ unix: socketPath, socket: { data() {} } });",
      "chmodSync(socketPath, 0o600);",
      "setTimeout(() => process.exit(0), 50);",
      "await new Promise(() => {});",
    ].join("\n"), { mode: 0o700 });
    const nonce = "c".repeat(64);
    const agentSocketPath = path.join(runtime, "ssh-agent.sock");
    const controlSocketPath = path.join(runtime, "ssh-agent-control.sock");
    const ownershipPath = path.join(runtime, "ssh-agent.json");
    const child = Bun.spawn([...CLI_ARGV, "--ssh-agent-supervisor"], {
      detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    children.push(child);
    child.stdin.write(`${JSON.stringify({
      version: 1, nonce, runtimeDirectory: runtime, sshAgentPath: fakeAgent,
      agentSocketPath, controlSocketPath, ownershipPath, servicePath: process.env.PATH ?? "",
    })}\n`);
    const ready = JSON.parse(await readLine(child.stdout)) as { ready: unknown };
    await writeFile(ownershipPath, `${JSON.stringify(ready.ready)}\n`, { mode: 0o600 });
    await Bun.sleep(100);
    child.stdin.write(`${JSON.stringify({ commit: nonce })}\n`);
    child.stdin.end();

    expect(await child.exited).toBe(1);
    children.splice(children.indexOf(child), 1);
    expect(await pathExists(controlSocketPath)).toBe(false);
    expect(await pathExists(ownershipPath)).toBe(false);
  });
});
