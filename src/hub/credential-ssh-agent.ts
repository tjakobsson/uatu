import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
const POLL_MS = 20;

type AgentProcess = {
  readonly pid: number;
  readonly exited: Promise<number | null>;
  kill(signal?: number | NodeJS.Signals): void;
};

type AgentOwnership = {
  version: 1;
  nonce: string;
  pid: number;
  socketDevice: number;
  socketInode: number;
};

export type ManagedSshAgentOptions = {
  runtimeDirectory: string;
  sshAgentPath: string;
  servicePath?: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  spawn?: (argv: string[], options: Parameters<typeof Bun.spawn>[1]) => AgentProcess;
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function privateDirectory(directory: string): Promise<void> {
  const stats = await fs.lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("SSH agent runtime must be a directory");
  if ((stats.mode & 0o077) !== 0) throw new Error("SSH agent runtime has unsafe permissions");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("SSH agent runtime is not owned by the current user");
  }
}

async function readOwnership(filePath: string): Promise<AgentOwnership | undefined> {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o077) !== 0) {
    throw new Error("SSH agent ownership record is unsafe");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("SSH agent ownership record has the wrong owner");
  }
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    if (
      value.version !== 1
      || typeof value.nonce !== "string"
      || typeof value.pid !== "number"
      || typeof value.socketDevice !== "number"
      || typeof value.socketInode !== "number"
    ) throw new Error("invalid record");
    return value as AgentOwnership;
  } catch (error) {
    throw new Error("SSH agent ownership record is corrupt", { cause: error });
  }
}

export class ManagedSshAgent {
  readonly socketPath: string;
  private readonly ownershipPath: string;
  private readonly spawn: NonNullable<ManagedSshAgentOptions["spawn"]>;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly servicePath: string;
  private process?: AgentProcess;
  private ownership?: AgentOwnership;
  private starting?: Promise<string>;
  private stopping?: Promise<void>;

  constructor(private readonly options: ManagedSshAgentOptions) {
    this.socketPath = path.join(options.runtimeDirectory, "ssh-agent.sock");
    this.ownershipPath = path.join(options.runtimeDirectory, "ssh-agent.json");
    this.spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions) as AgentProcess);
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    this.servicePath = options.servicePath ?? process.env.PATH ?? "";
  }

  isRunning(): boolean {
    return this.process !== undefined && this.ownership !== undefined;
  }

  currentSocket(): string | undefined {
    return this.isRunning() ? this.socketPath : undefined;
  }

  start(): Promise<string> {
    if (this.isRunning()) return Promise.resolve(this.socketPath);
    this.starting ??= this.startOnce().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startOnce(): Promise<string> {
    await privateDirectory(this.options.runtimeDirectory);
    await this.recoverRecordWithoutSocket();
    try {
      await fs.lstat(this.socketPath);
      throw new Error("SSH agent socket already exists and is not owned by this Hub process");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const nonce = randomUUID();
    const child = this.spawn([this.options.sshAgentPath, "-D", "-a", this.socketPath], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: this.servicePath, LANG: "C", LC_ALL: "C" },
    });
    let exited = false;
    void child.exited.then(() => {
      exited = true;
      if (this.process === child) {
        this.process = undefined;
        this.ownership = undefined;
      }
    });

    try {
      const socket = await this.waitForSocket(child, () => exited);
      const ownership: AgentOwnership = {
        version: 1,
        nonce,
        pid: child.pid,
        socketDevice: Number(socket.dev),
        socketInode: Number(socket.ino),
      };
      await fs.writeFile(this.ownershipPath, `${JSON.stringify(ownership)}\n`, { flag: "wx", mode: 0o600 });
      this.process = child;
      this.ownership = ownership;
      return this.socketPath;
    } catch (error) {
      await this.terminateStartedChild(child);
      const record = await readOwnership(this.ownershipPath).catch(() => undefined);
      if (record?.nonce === nonce && record.pid === child.pid) await fs.rm(this.ownershipPath, { force: true });
      throw error;
    }
  }

  private async recoverRecordWithoutSocket(): Promise<void> {
    const record = await readOwnership(this.ownershipPath);
    if (!record) return;
    try {
      await fs.lstat(this.socketPath);
      throw new Error("stale SSH agent state includes an unverified socket; remove it only after verifying its owner");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await fs.rm(this.ownershipPath);
  }

  private async waitForSocket(child: AgentProcess, exited: () => boolean): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (exited()) throw new Error("managed SSH agent exited before its socket became ready");
      try {
        const stats = await fs.lstat(this.socketPath);
        if (stats.isSymbolicLink() || !stats.isSocket()) throw new Error("managed SSH agent created an unsafe socket path");
        if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
          throw new Error("managed SSH agent socket has the wrong owner");
        }
        if ((stats.mode & 0o077) !== 0) throw new Error("managed SSH agent socket has unsafe permissions");
        return stats;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await Bun.sleep(POLL_MS);
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may have exited at the timeout boundary.
    }
    throw new Error("managed SSH agent did not become ready before the timeout");
  }

  shutdown(): Promise<void> {
    this.stopping ??= this.stopOnce().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private async stopOnce(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    const child = this.process;
    const expected = this.ownership;
    if (!child || !expected) return;

    const record = await readOwnership(this.ownershipPath);
    const socket = await fs.lstat(this.socketPath).catch(error => isMissing(error) ? undefined : Promise.reject(error));
    if (
      !record
      || record.nonce !== expected.nonce
      || record.pid !== child.pid
      || !socket?.isSocket()
      || Number(socket.dev) !== expected.socketDevice
      || Number(socket.ino) !== expected.socketInode
    ) {
      throw new Error("refusing to signal an SSH agent whose ownership cannot be proven");
    }

    try {
      child.kill("SIGTERM");
    } catch {
      // An owned child can exit between ownership validation and signaling.
    }
    if (!(await this.waitForExit(child, this.stopTimeoutMs))) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may have exited at the grace-period boundary.
      }
      if (!(await this.waitForExit(child, this.stopTimeoutMs))) {
        throw new Error("managed SSH agent did not exit after SIGKILL");
      }
    }
    this.process = undefined;
    this.ownership = undefined;
    await this.removeOwnedArtifacts(expected);
  }

  private async waitForExit(child: AgentProcess, timeoutMs: number): Promise<boolean> {
    return Promise.race([
      child.exited.then(() => true),
      Bun.sleep(timeoutMs).then(() => false),
    ]);
  }

  private async terminateStartedChild(child: AgentProcess): Promise<void> {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    if (await this.waitForExit(child, this.stopTimeoutMs)) return;
    try {
      child.kill("SIGKILL");
    } catch {
      return;
    }
    await this.waitForExit(child, this.stopTimeoutMs);
  }

  private async removeOwnedArtifacts(expected: AgentOwnership | undefined): Promise<void> {
    if (expected) {
      const socket = await fs.lstat(this.socketPath).catch(error => isMissing(error) ? undefined : Promise.reject(error));
      if (socket && (Number(socket.dev) !== expected.socketDevice || Number(socket.ino) !== expected.socketInode)) {
        throw new Error("refusing to remove a replaced SSH agent socket");
      }
    }
    await fs.rm(this.socketPath, { force: true });
    await fs.rm(this.ownershipPath, { force: true });
  }
}
