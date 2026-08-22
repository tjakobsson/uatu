import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveUatuArgv } from "./backend";
import {
  guardianMac,
  parseLegacyOwnership,
  parseOwnership,
  sameSocketIdentity,
  socketIdentity,
  type SocketIdentity,
  type LegacySshAgentOwnership,
  type SshAgentOwnership,
  type GuardianCommand,
} from "./credential-ssh-supervisor";

const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
const POLL_MS = 20;
const MAX_MESSAGE_BYTES = 4_096;

type SupervisorProcess = ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">>;

export type ManagedSshAgentOptions = {
  runtimeDirectory: string;
  sshAgentPath?: string;
  uatuArgv?: string[];
  servicePath?: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  spawnSupervisor?: (argv: string[], options: Parameters<typeof Bun.spawn>[1]) => SupervisorProcess;
};

// A recorded pid can have been recycled since the record was written — and
// recycled, in the worst case, by someone else's ssh-agent, which a bare
// process-name check would happily match. v1-era builds launched the agent
// as `ssh-agent -D -a <socketPath>`, so the recorded socket path appears in
// the agent's own argv; requiring it ties the pid to the recorded socket.
// When that association cannot be established, the pid is not signalled.
async function isRecordedLegacyAgent(pid: number, socketPath: string): Promise<boolean> {
  try {
    const result = Bun.spawnSync({ cmd: ["ps", "-p", String(pid), "-o", "command="], stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return false;
    const command = result.stdout.toString().trim();
    const [executable = ""] = command.split(" ");
    // Anchor the -a value at the end of the command line, where the v1
    // launch put it: `ssh-agent -D -a <socketPath>`. A substring match
    // would also accept an agent bound to e.g. `<socketPath>.backup`.
    return executable.endsWith("ssh-agent") && command.endsWith(` -a ${socketPath}`);
  } catch {
    return false;
  }
}

// The revalidate-before-unlink halves of legacy retirement. Termination can
// wait seconds, and another instance could complete its own migration in
// that window; removing anything the legacy record no longer describes
// would tear down that instance's fresh agent. (The hub state-root lease
// already serializes real deployments — this guards the window regardless.)
export async function removeSocketIfStillRecorded(socketPath: string, legacy: LegacySshAgentOwnership): Promise<void> {
  let identity: SocketIdentity | undefined;
  try {
    identity = await socketIdentity(socketPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (!identity) return;
  if (identity.device !== legacy.socketDevice || identity.inode !== legacy.socketInode) {
    throw new Error("SSH guardian artifact changed during cleanup");
  }
  await fs.rm(socketPath, { force: true });
}

export async function removeRecordIfStillLegacy(recordPath: string, legacy: LegacySshAgentOwnership): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(recordPath, "utf8");
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  let current: LegacySshAgentOwnership;
  try {
    current = parseLegacyOwnership(JSON.parse(raw));
  } catch {
    throw new Error("SSH agent ownership record changed during cleanup");
  }
  if (current.nonce !== legacy.nonce || current.pid !== legacy.pid
    || current.socketDevice !== legacy.socketDevice || current.socketInode !== legacy.socketInode) {
    throw new Error("SSH agent ownership record changed during cleanup");
  }
  await fs.rm(recordPath, { force: true });
}

// SIGTERM, wait, escalate to SIGKILL, wait again — and refuse to continue if
// the process still will not die. Proceeding anyway would delete the socket
// out from under a live agent and leak it with keys still in memory, which
// is the exact failure the migration exists to avoid. Mirrors stopChild in
// credential-ssh-supervisor.ts.
async function terminateLegacyAgent(pid: number, timeoutMs: number): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  }
  throw new Error("superseded SSH agent did not exit after SIGKILL");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function privateDirectory(directory: string): Promise<void> {
  const stats = await fs.lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("SSH agent runtime must be a directory");
  if ((stats.mode & 0o777) !== 0o700) throw new Error("SSH agent runtime has unsafe permissions");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("SSH agent runtime is not owned by the current user");
  }
}

async function readOwnership(filePath: string): Promise<SshAgentOwnership | undefined> {
  let stats;
  try { stats = await fs.lstat(filePath); } catch (error) { if (isMissing(error)) return undefined; throw error; }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_MESSAGE_BYTES || (stats.mode & 0o777) !== 0o600) {
    throw new Error("SSH agent ownership record is unsafe");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("SSH agent ownership record has the wrong owner");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `SSH agent ownership record at ${filePath} is not valid JSON. Stop uatu, remove that file, and start again.`,
      { cause: error },
    );
  }
  try {
    return parseOwnership(parsed);
  } catch (error) {
    // A v1 record is a recognised older format, not corruption: it predates
    // the agent/supervisor split. Hand it to the caller to retire rather
    // than refusing to start, which is what stranded upgraded installs.
    try {
      throw new LegacyOwnershipError(parseLegacyOwnership(parsed));
    } catch (legacyError) {
      if (legacyError instanceof LegacyOwnershipError) throw legacyError;
    }
    throw new Error(
      `SSH agent ownership record at ${filePath} is corrupt or has an unsupported version. `
        + "Stop uatu, remove that file, and start again.",
      { cause: error },
    );
  }
}

class LegacyOwnershipError extends Error {
  constructor(readonly legacy: LegacySshAgentOwnership) {
    super("SSH agent ownership record uses the superseded v1 format");
    this.name = "LegacyOwnershipError";
  }
}

async function readLine(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
  child?: { exited: Promise<number | null> },
): Promise<string> {
  const reader = stream.getReader();
  let bytes = Buffer.alloc(0);
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("SSH supervisor handshake timed out")), timeoutMs);
  });
  const exited = child?.exited.then(code => { throw new Error(`SSH supervisor exited during startup (${code})`); });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), timeout, ...(exited ? [exited] : [])]);
      if (next.done) throw new Error("SSH supervisor closed its handshake pipe");
      bytes = Buffer.concat([bytes, Buffer.from(next.value)]);
      if (bytes.length > MAX_MESSAGE_BYTES) throw new Error("SSH supervisor handshake is too large");
      const newline = bytes.indexOf(10);
      if (newline >= 0) return bytes.subarray(0, newline).toString("utf8");
    }
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}

async function assertSocket(socketPath: string, expected: SshAgentOwnership["agentSocket"]): Promise<void> {
  const actual = await socketIdentity(socketPath);
  if (!sameSocketIdentity(actual, expected)) throw new Error("SSH guardian socket does not match its ownership record");
}

export class ManagedSshAgent {
  readonly socketPath: string;
  readonly controlSocketPath: string;
  private readonly ownershipPath: string;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private ownership?: SshAgentOwnership;
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(private readonly options: ManagedSshAgentOptions) {
    this.socketPath = path.join(options.runtimeDirectory, "ssh-agent.sock");
    this.controlSocketPath = path.join(options.runtimeDirectory, "ssh-agent-control.sock");
    this.ownershipPath = path.join(options.runtimeDirectory, "ssh-agent.json");
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  }

  isRunning(): boolean { return this.ownership !== undefined; }
  currentSocket(): string | undefined { return this.isRunning() ? this.socketPath : undefined; }

  start(): Promise<string> {
    return this.enqueue(() => this.startSerialized());
  }

  recover(): Promise<void> {
    return this.enqueue(async () => {
      await privateDirectory(this.options.runtimeDirectory);
      await this.recoverRecordedAgent();
      this.ownership = undefined;
    });
  }

  private async startSerialized(): Promise<string> {
    if (this.ownership) {
      try {
        await this.validateRunning(this.ownership);
        return this.socketPath;
      } catch (error) {
        if (!await this.waitForAllArtifactsToDisappear(this.ownership, false)) throw error;
        this.ownership = undefined;
      }
    }
    return this.startOnce();
  }

  private async startOnce(): Promise<string> {
    await privateDirectory(this.options.runtimeDirectory);
    await this.recoverRecordedAgent();
    const sshAgentPath = this.options.sshAgentPath;
    if (!sshAgentPath) throw new Error("OpenSSH ssh-agent is unavailable");
    for (const artifact of [this.socketPath, this.controlSocketPath, this.ownershipPath]) {
      try { await fs.lstat(artifact); throw new Error("unowned SSH guardian artifact already exists"); }
      catch (error) { if (!isMissing(error)) throw error; }
    }

    const nonce = randomBytes(32).toString("hex");
    const uatuArgv = this.options.uatuArgv ?? resolveUatuArgv();
    const spawn = this.options.spawnSupervisor ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions) as SupervisorProcess);
    const child = spawn([...uatuArgv, "--ssh-agent-supervisor"], {
      detached: true,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { PATH: this.options.servicePath ?? process.env.PATH ?? "", LANG: "C", LC_ALL: "C" },
    });
    const input = child.stdin;
    let ownership: SshAgentOwnership | undefined;
    try {
      input.write(`${JSON.stringify({
        version: 1,
        nonce,
        runtimeDirectory: this.options.runtimeDirectory,
        sshAgentPath,
        agentSocketPath: this.socketPath,
        controlSocketPath: this.controlSocketPath,
        ownershipPath: this.ownershipPath,
        servicePath: this.options.servicePath ?? process.env.PATH ?? "",
      })}\n`);
      const ready = JSON.parse(await readLine(child.stdout, this.startTimeoutMs, child)) as { ready?: unknown };
      ownership = parseOwnership(ready.ready);
      if (ownership.nonce !== nonce) throw new Error("SSH supervisor returned the wrong nonce");
      await assertSocket(this.socketPath, ownership.agentSocket);
      await assertSocket(this.controlSocketPath, ownership.controlSocket);

      const record = await fs.open(this.ownershipPath, "wx", 0o600);
      try {
        await record.chmod(0o600);
        await record.writeFile(`${JSON.stringify(ownership)}\n`);
        await record.sync();
      } finally {
        await record.close();
      }
      const runtimeDirectory = await fs.open(this.options.runtimeDirectory, "r");
      try {
        await runtimeDirectory.sync();
      } finally {
        await runtimeDirectory.close();
      }
      input.write(`${JSON.stringify({ commit: nonce })}\n`);
      input.end();
      const ack = JSON.parse(await readLine(child.stdout, this.startTimeoutMs, child)) as { ack?: unknown };
      if (ack.ack !== nonce) throw new Error("SSH supervisor did not acknowledge ownership commit");
      await child.stdout.cancel().catch(() => undefined);
      child.unref();
      this.ownership = ownership;
      return this.socketPath;
    } catch (error) {
      input.end();
      await Promise.race([child.exited, Bun.sleep(this.stopTimeoutMs * 3)]).catch(() => undefined);
      throw error;
    }
  }

  // Retire an agent recorded in the superseded v1 format. The record names a
  // pid and the device+inode of the socket it owned; both must still agree
  // before anything is signalled, because a pid alone can have been reused.
  // Everything else fails closed, exactly like the unowned-artifact checks
  // the v2 paths apply: only artifacts this record provably describes are
  // ever removed.
  private async retireLegacyAgent(legacy: LegacySshAgentOwnership): Promise<void> {
    // v1 predates the control socket entirely, so one existing alongside a
    // v1 record was made by something else — treat it as unowned.
    try {
      await fs.lstat(this.controlSocketPath);
      throw new Error("unowned SSH guardian artifact already exists");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    let socket: "missing" | "recorded" | "foreign";
    try {
      const actual = await socketIdentity(this.socketPath);
      socket = actual.device === legacy.socketDevice && actual.inode === legacy.socketInode
        ? "recorded"
        : "foreign";
    } catch (error) {
      if (!isMissing(error)) throw error;
      socket = "missing";
    }
    // A socket the record does not describe belongs to someone else —
    // possibly a concurrently starting agent. Unlinking it would disconnect
    // whatever owns it, so refuse, like every other unowned artifact.
    if (socket === "foreign") throw new Error("unowned SSH guardian artifact already exists");

    if (socket === "recorded" && await isRecordedLegacyAgent(legacy.pid, this.socketPath)) {
      await terminateLegacyAgent(legacy.pid, this.stopTimeoutMs);
    }

    // Termination awaited above, so revalidate immediately before unlinking:
    // anything the legacy record no longer describes stays untouched.
    if (socket === "recorded") await removeSocketIfStillRecorded(this.socketPath, legacy);
    await removeRecordIfStillLegacy(this.ownershipPath, legacy);
  }

  private async recoverRecordedAgent(): Promise<void> {
    let record: SshAgentOwnership | undefined;
    try {
      record = await readOwnership(this.ownershipPath);
    } catch (error) {
      if (!(error instanceof LegacyOwnershipError)) throw error;
      await this.retireLegacyAgent(error.legacy);
      await this.assertNoGuardianQuarantines();
      return;
    }
    if (!record) {
      for (const artifact of [this.socketPath, this.controlSocketPath]) {
        try {
          await fs.lstat(artifact);
          throw new Error("unowned SSH guardian artifact already exists");
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      await this.assertNoGuardianQuarantines();
      return;
    }
    await assertSocket(this.socketPath, record.agentSocket);
    await assertSocket(this.controlSocketPath, record.controlSocket);
    await this.request(record, "stop");
    await this.waitForAllArtifactsToDisappear(record);
    await this.assertNoGuardianQuarantines();
  }

  shutdown(): Promise<void> {
    return this.enqueue(() => this.stopOnce());
  }

  private async stopOnce(): Promise<void> {
    const expected = this.ownership;
    if (!expected) return;
    const record = await readOwnership(this.ownershipPath);
    if (!record) {
      if (await this.waitForAllArtifactsToDisappear(expected, false)) {
        this.ownership = undefined;
        return;
      }
      throw new Error("refusing to stop an SSH agent whose ownership cannot be proven");
    }
    if (JSON.stringify(record) !== JSON.stringify(expected)) {
      throw new Error("refusing to stop an SSH agent whose ownership cannot be proven");
    }
    await assertSocket(this.socketPath, record.agentSocket);
    await assertSocket(this.controlSocketPath, record.controlSocket);
    await this.request(record, "stop");
    await this.waitForAllArtifactsToDisappear(record);
    this.ownership = undefined;
  }

  private async validateRunning(expected: SshAgentOwnership): Promise<void> {
    const record = await readOwnership(this.ownershipPath);
    if (!record || JSON.stringify(record) !== JSON.stringify(expected)) {
      throw new Error("SSH guardian ownership cannot be proven");
    }
    await assertSocket(this.socketPath, expected.agentSocket);
    await assertSocket(this.controlSocketPath, expected.controlSocket);
    await this.request(expected, "status");
    const current = await readOwnership(this.ownershipPath);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error("SSH guardian ownership changed during status check");
    }
    await assertSocket(this.socketPath, expected.agentSocket);
    await assertSocket(this.controlSocketPath, expected.controlSocket);
  }

  private async request(record: SshAgentOwnership, command: GuardianCommand): Promise<void> {
    const challenge = randomBytes(32).toString("hex");
    await new Promise<void>(async (resolve, reject) => {
      let settled = false;
      let client: Bun.Socket<{ input: string; bytes: number }> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { client?.terminate(); } catch { /* The socket may already be closed. */ }
        error ? reject(error) : resolve();
      };
      const failed = () => finish(new Error("SSH guardian request failed"));
      const timer = setTimeout(failed, this.stopTimeoutMs);
      try {
        client = await Bun.connect<{ input: string; bytes: number }>({
          unix: this.controlSocketPath,
          data: { input: "", bytes: 0 },
          socket: {
            open(socket) {
              client = socket;
              if (settled) { socket.terminate(); return; }
              socket.write(`${JSON.stringify({ version: 1, command, challenge })}\n`);
            },
            data(socket, data) {
              socket.data.bytes += data.byteLength;
              if (socket.data.bytes > MAX_MESSAGE_BYTES) { failed(); return; }
              socket.data.input += data.toString("utf8");
              const newline = socket.data.input.indexOf("\n");
              if (newline < 0) return;
              try {
                const response = JSON.parse(socket.data.input.slice(0, newline)) as Record<string, unknown>;
                if (Object.keys(response).sort().join("\0") !== ["version", "command", "challenge", "mac"].sort().join("\0")
                  || response.version !== 1 || response.command !== command || response.challenge !== challenge
                  || typeof response.mac !== "string" || !/^[a-f0-9]{64}$/.test(response.mac)) { failed(); return; }
                const supplied = Buffer.from(response.mac, "hex");
                const expected = Buffer.from(guardianMac(record.nonce, command, challenge), "hex");
                supplied.length === expected.length && timingSafeEqual(supplied, expected) ? finish() : failed();
              } catch { failed(); }
            },
            close() { if (!settled) failed(); },
            connectError() { failed(); },
            error() { failed(); },
          },
        });
        if (settled) client.terminate();
      } catch {
        failed();
      }
    });
  }

  private quarantinePaths(record: SshAgentOwnership): string[] {
    return [this.socketPath, this.controlSocketPath, this.ownershipPath]
      .map(artifact => `${artifact}.${record.nonce}.quarantine`);
  }

  private async waitForAllArtifactsToDisappear(
    record: SshAgentOwnership,
    throwOnTimeout = true,
  ): Promise<boolean> {
    const deadline = Date.now() + this.stopTimeoutMs * 3;
    let remaining: string[] = [];
    const artifacts = [this.socketPath, this.controlSocketPath, this.ownershipPath, ...this.quarantinePaths(record)];
    while (Date.now() < deadline) {
      remaining = (await Promise.all(artifacts.map(async artifact => {
        try { await fs.lstat(artifact); return artifact; } catch (error) { if (isMissing(error)) return undefined; throw error; }
      }))).filter((artifact): artifact is string => artifact !== undefined);
      if (remaining.length === 0) return true;
      await Bun.sleep(POLL_MS);
    }
    if (!throwOnTimeout) return false;
    throw new Error(`SSH guardian artifacts did not disappear before the timeout: ${remaining.map(item => path.basename(item)).join(", ")}`);
  }

  private async assertNoGuardianQuarantines(): Promise<void> {
    const entries = await fs.readdir(this.options.runtimeDirectory);
    const quarantine = /^(?:ssh-agent\.sock|ssh-agent-control\.sock|ssh-agent\.json)\.[a-f0-9]{64}\.quarantine$/;
    if (entries.some(entry => quarantine.test(entry))) {
      throw new Error("SSH guardian quarantine artifacts require manual recovery");
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }
}
