import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
const POLL_MS = 20;
const MAX_MESSAGE_BYTES = 4_096;
const CONTROL_VERSION = 1;
const BOOT_ID_PATTERN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export type GuardianCommand = "status" | "stop";

export function guardianMac(nonce: string, command: GuardianCommand, challenge: string): string {
  return createHmac("sha256", nonce).update(`uatu-ssh-guardian-v1\n${command}\n${challenge}`).digest("hex");
}

export type SocketIdentity = {
  type: "socket";
  uid: number;
  mode: number;
  device: number;
  inode: number;
};

type SshAgentOwnershipBase = {
  nonce: string;
  agentPid: number;
  supervisorPid: number;
  agentSocket: SocketIdentity;
  controlSocket: SocketIdentity;
};

export type SshAgentOwnership = SshAgentOwnershipBase & (
  | { version: 2 }
  | { version: 3; bootId: string }
);

type SupervisorConfig = {
  version: 1 | 2;
  nonce: string;
  runtimeDirectory: string;
  sshAgentPath: string;
  agentSocketPath: string;
  controlSocketPath: string;
  ownershipPath: string;
  servicePath: string;
  bootId?: string;
};

type AgentProcess = {
  readonly pid: number;
  readonly exited: Promise<number | null>;
  kill(signal?: number | NodeJS.Signals): void;
};

export type SshAgentSupervisorOptions = {
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  spawnAgent?: (argv: string[], options: Parameters<typeof Bun.spawn>[1]) => AgentProcess;
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function isBootId(value: unknown): value is string {
  return typeof value === "string" && BOOT_ID_PATTERN.test(value);
}

export async function socketIdentity(socketPath: string): Promise<SocketIdentity> {
  const stats = await fs.lstat(socketPath);
  if (stats.isSymbolicLink() || !stats.isSocket()) throw new Error("SSH guardian path is not a socket");
  if ((stats.mode & 0o777) !== 0o600) throw new Error("SSH guardian socket has unsafe permissions");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("SSH guardian socket has the wrong owner");
  }
  return {
    type: "socket",
    uid: stats.uid,
    mode: stats.mode & 0o777,
    device: Number(stats.dev),
    inode: Number(stats.ino),
  };
}

export function sameSocketIdentity(actual: SocketIdentity, expected: SocketIdentity): boolean {
  return actual.type === expected.type
    && actual.uid === expected.uid
    && actual.mode === expected.mode
    && actual.device === expected.device
    && actual.inode === expected.inode;
}

export function parseOwnership(value: unknown): SshAgentOwnership {
  const baseKeys = ["version", "nonce", "agentPid", "supervisorPid", "agentSocket", "controlSocket"];
  const version = typeof value === "object" && value !== null && "version" in value ? value.version : undefined;
  const keys = version === 3 ? [...baseKeys, "bootId"] : baseKeys;
  if (!exactObject(value, keys)) {
    throw new Error("invalid record");
  }
  const identity = (candidate: unknown): candidate is SocketIdentity => exactObject(candidate, ["type", "uid", "mode", "device", "inode"])
    && candidate.type === "socket"
    && [candidate.uid, candidate.mode, candidate.device, candidate.inode]
      .every(item => typeof item === "number" && Number.isSafeInteger(item) && item >= 0);
  if ((value.version !== 2 && value.version !== 3)
    || (value.version === 3 && !isBootId(value.bootId))
    || typeof value.nonce !== "string" || !/^[a-f0-9]{64}$/.test(value.nonce)
    || typeof value.agentPid !== "number" || !Number.isSafeInteger(value.agentPid) || value.agentPid <= 0
    || typeof value.supervisorPid !== "number" || !Number.isSafeInteger(value.supervisorPid) || value.supervisorPid <= 0
    || !identity(value.agentSocket) || !identity(value.controlSocket)) throw new Error("invalid record");
  return value as SshAgentOwnership;
}

async function privateDirectory(directory: string): Promise<void> {
  const stats = await fs.lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("SSH agent runtime must be a directory");
  if ((stats.mode & 0o777) !== 0o700) throw new Error("SSH agent runtime has unsafe permissions");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("SSH agent runtime is not owned by the current user");
  }
}

function parseConfig(value: unknown): SupervisorConfig {
  const baseKeys = ["version", "nonce", "runtimeDirectory", "sshAgentPath", "agentSocketPath", "controlSocketPath", "ownershipPath", "servicePath"];
  const version = typeof value === "object" && value !== null && "version" in value ? value.version : undefined;
  const keys = version === 2 ? [...baseKeys, "bootId"] : baseKeys;
  if (!exactObject(value, keys) || (value.version !== 1 && value.version !== 2)
    || (value.version === 2 && !isBootId(value.bootId))
    || typeof value.nonce !== "string" || !/^[a-f0-9]{64}$/.test(value.nonce)) {
    throw new Error("invalid SSH supervisor startup configuration");
  }
  for (const key of keys.slice(2)) {
    if (typeof value[key] !== "string") throw new Error("invalid SSH supervisor startup configuration");
  }
  const config = value as SupervisorConfig;
  if (!path.isAbsolute(config.runtimeDirectory) || !path.isAbsolute(config.sshAgentPath)) {
    throw new Error("SSH supervisor paths must be absolute");
  }
  if (config.agentSocketPath !== path.join(config.runtimeDirectory, "ssh-agent.sock")
    || config.controlSocketPath !== path.join(config.runtimeDirectory, "ssh-agent-control.sock")
    || config.ownershipPath !== path.join(config.runtimeDirectory, "ssh-agent.json")) {
    throw new Error("invalid SSH supervisor runtime paths");
  }
  return config;
}

class BoundedLineReader {
  private buffer = Buffer.alloc(0);
  private readonly waiting: Array<{ resolve(value: string): void; reject(error: Error): void; timer: Timer }> = [];
  private ended = false;
  private failure?: Error;
  private delivered = 0;

  constructor(stream: NodeJS.ReadableStream) {
    stream.on("data", chunk => {
      if (this.failure || this.ended) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buffer = Buffer.concat([this.buffer, bytes]);
      if (this.buffer.length > MAX_MESSAGE_BYTES) {
        this.fail(new Error("SSH supervisor startup message is too large"));
        return;
      }
      this.drain();
    });
    stream.on("end", () => { this.ended = true; this.drain(); });
    stream.on("close", () => { this.ended = true; this.drain(); });
    stream.on("error", error => this.fail(error));
    stream.resume();
  }

  read(timeoutMs: number): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiting.findIndex(item => item.timer === timer);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new Error("SSH supervisor startup handshake timed out"));
      }, timeoutMs);
      this.waiting.push({ resolve, reject, timer });
      this.drain();
    });
  }

  expectEnd(timeoutMs: number): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.buffer.length > 0) return Promise.reject(new Error("SSH supervisor received trailing startup input"));
    if (this.ended) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("SSH supervisor startup pipe did not close"));
      }, timeoutMs);
      const onData = () => {
        cleanup();
        reject(new Error("SSH supervisor received trailing startup input"));
      };
      const onEnd = () => {
        cleanup();
        if (this.buffer.length === 0) resolve();
        else reject(new Error("SSH supervisor received trailing startup input"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
        process.stdin.off("close", onEnd);
      };
      process.stdin.once("data", onData);
      process.stdin.once("end", onEnd);
      process.stdin.once("close", onEnd);
    });
  }

  private drain(): void {
    while (this.waiting.length > 0) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) {
        if (this.ended) this.fail(new Error("SSH supervisor startup pipe closed"));
        return;
      }
      const item = this.waiting.shift()!;
      clearTimeout(item.timer);
      if (newline > MAX_MESSAGE_BYTES) {
        item.reject(new Error("SSH supervisor startup message is too large"));
      } else {
        this.delivered += 1;
        if (this.delivered > 2) {
          item.reject(new Error("SSH supervisor received too many startup messages"));
          this.fail(new Error("SSH supervisor received too many startup messages"));
          return;
        }
        item.resolve(this.buffer.subarray(0, newline).toString("utf8"));
      }
      this.buffer = this.buffer.subarray(newline + 1);
    }
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const item of this.waiting.splice(0)) {
      clearTimeout(item.timer);
      item.reject(error);
    }
  }
}

async function waitForSocket(socketPath: string, child: AgentProcess, timeoutMs: number): Promise<SocketIdentity> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  void child.exited.then(() => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) throw new Error("managed SSH agent exited before its socket became ready");
    try {
      return await socketIdentity(socketPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await Bun.sleep(POLL_MS);
  }
  throw new Error("managed SSH agent did not become ready before the timeout");
}

async function waitForExit(child: AgentProcess, timeoutMs: number): Promise<boolean> {
  return Promise.race([child.exited.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
}

async function stopChild(child: AgentProcess, timeoutMs: number): Promise<void> {
  try { child.kill("SIGTERM"); } catch {
    if (await waitForExit(child, timeoutMs)) return;
    throw new Error("managed SSH agent could not be sent SIGTERM");
  }
  if (await waitForExit(child, timeoutMs)) return;
  try { child.kill("SIGKILL"); } catch {
    if (await waitForExit(child, timeoutMs)) return;
    throw new Error("managed SSH agent could not be sent SIGKILL");
  }
  if (!(await waitForExit(child, timeoutMs))) throw new Error("managed SSH agent did not exit after SIGKILL");
}

async function restoreQuarantine(quarantinePath: string, originalPath: string): Promise<void> {
  try {
    await fs.lstat(originalPath);
  } catch (error) {
    if (isMissing(error)) {
      await fs.rename(quarantinePath, originalPath);
      return;
    }
  }
  throw new Error("SSH guardian artifact changed during cleanup; quarantine preserved");
}

async function quarantineSocket(
  socketPath: string,
  expected: SocketIdentity,
  nonce: string,
  allowMissing = false,
): Promise<string | undefined> {
  const quarantinePath = `${socketPath}.${nonce}.quarantine`;
  try { await fs.lstat(quarantinePath); throw new Error("SSH guardian quarantine path already exists"); }
  catch (error) { if (!isMissing(error)) throw error; }
  try {
    await fs.rename(socketPath, quarantinePath);
  } catch (error) {
    if (isMissing(error) && allowMissing) return undefined;
    throw error;
  }
  try {
    const actual = await socketIdentity(quarantinePath);
    if (!sameSocketIdentity(actual, expected)) throw new Error("SSH guardian socket identity changed during cleanup");
    return quarantinePath;
  } catch (error) {
    await restoreQuarantine(quarantinePath, socketPath).catch(() => undefined);
    throw error;
  }
}

async function unlinkQuarantinedSocket(
  quarantinePath: string,
  originalPath: string,
  expected: SocketIdentity,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    let actual: SocketIdentity;
    try {
      actual = await socketIdentity(quarantinePath);
    } catch (error) {
      if (isMissing(error)) return;
      await restoreQuarantine(quarantinePath, originalPath).catch(() => undefined);
      throw error;
    }
    if (!sameSocketIdentity(actual, expected)) {
      await restoreQuarantine(quarantinePath, originalPath).catch(() => undefined);
      throw new Error("SSH guardian socket quarantine was replaced");
    }
    try {
      await fs.rm(quarantinePath);
      return;
    } catch (error) {
      if (isMissing(error)) return;
      lastError = error;
      await Bun.sleep(POLL_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("SSH guardian socket quarantine could not be removed");
}

async function quarantineCommittedRecord(config: SupervisorConfig, ownership: SshAgentOwnership): Promise<void> {
  const quarantinePath = `${config.ownershipPath}.${config.nonce}.quarantine`;
  try { await fs.lstat(quarantinePath); throw new Error("SSH guardian record quarantine already exists"); }
  catch (error) { if (!isMissing(error)) throw error; }
  try {
    await fs.rename(config.ownershipPath, quarantinePath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  try {
    const record = await readCommittedRecord(quarantinePath);
    if (JSON.stringify(record) !== JSON.stringify(ownership)) throw new Error("SSH guardian ownership record changed during cleanup");
    await fs.rm(quarantinePath);
  } catch (error) {
    await restoreQuarantine(quarantinePath, config.ownershipPath).catch(() => undefined);
    throw error;
  }
}

async function readCommittedRecord(filePath: string): Promise<SshAgentOwnership> {
  const stats = await fs.lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_MESSAGE_BYTES || (stats.mode & 0o777) !== 0o600) {
    throw new Error("SSH supervisor ownership commit is unsafe");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("SSH supervisor ownership commit has the wrong owner");
  }
  return parseOwnership(JSON.parse(await fs.readFile(filePath, "utf8")));
}

export async function runSshAgentSupervisor(options: SshAgentSupervisorOptions = {}): Promise<number> {
  const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const lines = new BoundedLineReader(process.stdin);
  let config: SupervisorConfig;
  try {
    config = parseConfig(JSON.parse(await lines.read(startTimeoutMs)));
    await privateDirectory(config.runtimeDirectory);
  } catch {
    return 2;
  }

  for (const artifact of [config.agentSocketPath, config.controlSocketPath]) {
    try { await fs.lstat(artifact); return 2; } catch (error) { if (!isMissing(error)) return 2; }
  }

  let stopping = false;
  let committed = false;
  let ownership: SshAgentOwnership | undefined;
  let child: AgentProcess | undefined;
  let childExited = false;
  let controlIdentity: SocketIdentity | undefined;
  let agentIdentity: SocketIdentity | undefined;
  let controlQuarantine: string | undefined;
  let agentQuarantine: string | undefined;
  let listener: Bun.UnixSocketListener<{ bytes: number; input: string }> | undefined;
  let resolveStop!: () => void;
  const stopRequested = new Promise<void>(resolve => { resolveStop = resolve; });

  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    resolveStop();
  };
  const handleSignal = () => requestStop();
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  process.on("SIGHUP", handleSignal);

  try {
    listener = Bun.listen<{ bytes: number; input: string }>({
      unix: config.controlSocketPath,
      data: { bytes: 0, input: "" },
      socket: {
        open(socket) { socket.data = { bytes: 0, input: "" }; },
        data(socket, data) {
          socket.data.bytes += data.byteLength;
          if (socket.data.bytes > MAX_MESSAGE_BYTES) { socket.end(); return; }
          socket.data.input += data.toString("utf8");
          const newline = socket.data.input.indexOf("\n");
          if (newline < 0) return;
          try {
            const message = JSON.parse(socket.data.input.slice(0, newline)) as Record<string, unknown>;
            const command = message.command;
            const challenge = message.challenge;
            if (committed && !stopping && exactObject(message, ["version", "command", "challenge"])
              && message.version === CONTROL_VERSION
              && (command === "status" || command === "stop")
              && typeof challenge === "string" && /^[a-f0-9]{64}$/.test(challenge)) {
              socket.write(`${JSON.stringify({
                version: CONTROL_VERSION,
                command,
                challenge,
                mac: guardianMac(config.nonce, command, challenge),
              })}\n`);
              socket.end();
              if (command === "stop") setTimeout(requestStop, 0);
              return;
            }
          } catch {
            // Invalid and unauthenticated requests receive the same reply.
          }
          socket.write("{\"version\":1,\"error\":\"authentication failed\"}\n");
          socket.end();
        },
      },
    });
    await fs.chmod(config.controlSocketPath, 0o600);
    controlIdentity = await socketIdentity(config.controlSocketPath);
    const spawn = options.spawnAgent ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions) as AgentProcess);
    child = spawn([config.sshAgentPath, "-D", "-a", config.agentSocketPath], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: config.servicePath, LANG: "C", LC_ALL: "C" },
    });
    void child.exited.then(() => { childExited = true; }, () => { childExited = true; });
    agentIdentity = await waitForSocket(config.agentSocketPath, child, startTimeoutMs);
    const ownershipFields = {
      nonce: config.nonce,
      agentPid: child.pid,
      supervisorPid: process.pid,
      agentSocket: agentIdentity,
      controlSocket: controlIdentity,
    };
    ownership = config.bootId
      ? { version: 3, bootId: config.bootId, ...ownershipFields }
      : { version: 2, ...ownershipFields };
    process.stdout.write(`${JSON.stringify({ ready: ownership })}\n`);
    const commit = JSON.parse(await lines.read(startTimeoutMs)) as Record<string, unknown>;
    if (!exactObject(commit, ["commit"]) || commit.commit !== config.nonce) throw new Error("invalid SSH supervisor commit");
    await lines.expectEnd(startTimeoutMs);
    const record = await readCommittedRecord(config.ownershipPath);
    if (JSON.stringify(record) !== JSON.stringify(ownership)) throw new Error("SSH supervisor ownership commit does not match");
    if (childExited) throw new Error("managed SSH agent exited before ownership commit");
    const [currentAgent, currentControl] = await Promise.all([
      socketIdentity(config.agentSocketPath),
      socketIdentity(config.controlSocketPath),
    ]);
    if (!sameSocketIdentity(currentAgent, ownership.agentSocket)
      || !sameSocketIdentity(currentControl, ownership.controlSocket)
      || childExited) throw new Error("SSH guardian sockets changed before ownership commit");
    committed = true;
    process.stdout.write(`${JSON.stringify({ ack: config.nonce })}\n`);

    void child.exited.then(requestStop, requestStop);
    await stopRequested;
    controlQuarantine = await quarantineSocket(config.controlSocketPath, ownership.controlSocket, config.nonce);
    agentQuarantine = await quarantineSocket(
      config.agentSocketPath,
      ownership.agentSocket,
      config.nonce,
      childExited,
    );
    listener.stop(true);
    if (!childExited) await stopChild(child, stopTimeoutMs);
    await child.exited.catch(() => undefined);
    childExited = true;
    const committedOwnership = ownership;
    const socketCleanup = await Promise.allSettled([agentQuarantine, controlQuarantine]
      .flatMap((item, index) => item ? [unlinkQuarantinedSocket(
        item,
        index === 0 ? config.agentSocketPath : config.controlSocketPath,
        index === 0 ? committedOwnership.agentSocket : committedOwnership.controlSocket,
        stopTimeoutMs,
      )] : []));
    if (socketCleanup.some(result => result.status === "rejected")) throw new Error("SSH guardian socket cleanup failed");
    await quarantineCommittedRecord(config, committedOwnership);
    return 0;
  } catch {
    let socketProofFailed = false;
    if (!controlQuarantine && controlIdentity) {
      try {
        controlQuarantine = await quarantineSocket(config.controlSocketPath, controlIdentity, config.nonce, !committed);
      } catch {
        socketProofFailed = true;
      }
    }
    listener?.stop(true);
    let childStopped = child === undefined;
    if (child) {
      try {
        await stopChild(child, stopTimeoutMs);
        await child.exited.catch(() => undefined);
        childStopped = true;
      } catch {
        childStopped = false;
      }
    }
    if (!agentQuarantine && childStopped && agentIdentity) {
      try {
        agentQuarantine = await quarantineSocket(
          config.agentSocketPath,
          agentIdentity,
          config.nonce,
          !committed || childExited,
        );
      } catch {
        socketProofFailed = true;
      }
    }
    const quarantineCleanup = [
      agentQuarantine && agentIdentity
        ? unlinkQuarantinedSocket(agentQuarantine, config.agentSocketPath, agentIdentity, stopTimeoutMs)
        : undefined,
      controlQuarantine && controlIdentity
        ? unlinkQuarantinedSocket(controlQuarantine, config.controlSocketPath, controlIdentity, stopTimeoutMs)
        : undefined,
    ].filter((item): item is Promise<void> => item !== undefined);
    const socketsRemoved = !socketProofFailed && (await Promise.allSettled(quarantineCleanup))
      .every(result => result.status === "fulfilled");
    if (ownership && childStopped && socketsRemoved && !committed) {
      await quarantineCommittedRecord(config, ownership).catch(() => undefined);
    }
    return 1;
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    process.off("SIGHUP", handleSignal);
  }
}
