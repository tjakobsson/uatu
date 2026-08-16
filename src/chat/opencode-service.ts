import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import type { ChatAvailability } from "./types";
import { discoverOpenCodeExecutable } from "./executable";

const HOSTNAME = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 10_000;
const HEALTH_INTERVAL_MS = 100;
const TERM_GRACE_MS = 3_000;
const STDERR_LIMIT_BYTES = 16 * 1024;
const BIND_ATTEMPTS = 3;

export type SpawnedOpenCode = {
  pid: number;
  exited: Promise<number | null>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal: NodeJS.Signals): void;
};

export type OpenCodeConnection = {
  endpoint: string;
  password: string;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type OpenCodeServiceOptions = {
  workspacePath: string;
  env?: NodeJS.ProcessEnv;
  discoverExecutable?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  allocatePort?: () => Promise<number>;
  spawn?: (argv: string[], options: Parameters<typeof Bun.spawn>[1]) => SpawnedOpenCode;
  fetch?: FetchLike;
  randomPassword?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  killGroup?: (pid: number, signal: NodeJS.Signals | 0) => void;
  startupTimeoutMs?: number;
  healthIntervalMs?: number;
  termGraceMs?: number;
  stderrLimitBytes?: number;
  bindAttempts?: number;
};

export class OpenCodeService {
  private readonly workspacePath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly discover: NonNullable<OpenCodeServiceOptions["discoverExecutable"]>;
  private readonly allocatePort: NonNullable<OpenCodeServiceOptions["allocatePort"]>;
  private readonly spawn: NonNullable<OpenCodeServiceOptions["spawn"]>;
  private readonly fetch: FetchLike;
  private readonly randomPassword: NonNullable<OpenCodeServiceOptions["randomPassword"]>;
  private readonly sleep: NonNullable<OpenCodeServiceOptions["sleep"]>;
  private readonly killGroup: NonNullable<OpenCodeServiceOptions["killGroup"]>;
  private readonly startupTimeoutMs: number;
  private readonly healthIntervalMs: number;
  private readonly termGraceMs: number;
  private readonly stderrLimitBytes: number;
  private readonly bindAttempts: number;

  private availability: ChatAvailability = { state: "idle" };
  private connection: OpenCodeConnection | null = null;
  private process: ManagedProcess | null = null;
  private startPromise: Promise<ChatAvailability> | null = null;
  private disposePromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: OpenCodeServiceOptions) {
    this.workspacePath = options.workspacePath;
    this.env = options.env ?? process.env;
    this.discover = options.discoverExecutable ?? discoverOpenCodeExecutable;
    this.allocatePort = options.allocatePort ?? allocateLoopbackPort;
    this.spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions) as SpawnedOpenCode);
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.randomPassword = options.randomPassword ?? (() => randomBytes(32).toString("base64url"));
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.killGroup = options.killGroup ?? ((pid, signal) => process.kill(-pid, signal));
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.healthIntervalMs = options.healthIntervalMs ?? HEALTH_INTERVAL_MS;
    this.termGraceMs = options.termGraceMs ?? TERM_GRACE_MS;
    this.stderrLimitBytes = options.stderrLimitBytes ?? STDERR_LIMIT_BYTES;
    this.bindAttempts = options.bindAttempts ?? BIND_ATTEMPTS;
  }

  status(): Promise<ChatAvailability> {
    if (this.closed) return Promise.resolve(this.availability);
    if (this.availability.state === "ready" || this.availability.state === "unavailable") {
      return Promise.resolve(this.availability);
    }
    this.startPromise ??= this.start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  currentConnection(): OpenCodeConnection | null {
    return this.connection ? { ...this.connection } : null;
  }

  dispose(): Promise<void> {
    this.closed = true;
    this.disposePromise ??= this.disposeService();
    return this.disposePromise;
  }

  private async start(): Promise<ChatAvailability> {
    this.availability = { state: "starting" };
    const executable = await this.discover(this.env);
    if (this.closed) return this.stoppedAvailability();
    if (!executable) {
      return this.setUnavailable("not-installed", "OpenCode is not installed or is not available on PATH.");
    }

    let lastDiagnostic = "";
    for (let attempt = 0; attempt < this.bindAttempts; attempt += 1) {
      if (this.closed) return this.stoppedAvailability();
      const port = await this.allocatePort();
      const password = this.randomPassword();
      const endpoint = `http://${HOSTNAME}:${port}`;
      const capture = new BoundedTextCapture(this.stderrLimitBytes);
      let spawned: SpawnedOpenCode;
      try {
        spawned = this.spawn([
          executable,
          "serve",
          "--hostname",
          HOSTNAME,
          "--port",
          String(port),
        ], {
          cwd: this.workspacePath,
          env: buildOpenCodeEnvironment(this.env, password),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          detached: process.platform !== "win32",
        } as Parameters<typeof Bun.spawn>[1]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.setUnavailable("startup-failed", `OpenCode could not be started: ${message}`);
      }

      const managed = new ManagedProcess(spawned, capture, this.killGroup, this.sleep, this.termGraceMs);
      this.process = managed;
      capture.consume(spawned.stderr);
      try {
        const version = await this.waitUntilReady(endpoint, password, spawned.exited);
        if (this.closed) {
          await managed.terminate();
          return this.stoppedAvailability();
        }
        this.connection = { endpoint, password };
        this.availability = { state: "ready", version };
        void spawned.exited.then(code => this.handleUnexpectedExit(managed, code));
        return this.availability;
      } catch (error) {
        await managed.terminate();
        await capture.done;
        if (this.process === managed) this.process = null;
        const detail = capture.snapshot();
        lastDiagnostic = [error instanceof Error ? error.message : String(error), detail].filter(Boolean).join("\n");
        if (!isBindFailure(lastDiagnostic) || attempt === this.bindAttempts - 1) break;
      }
    }

    if (this.closed) return this.stoppedAvailability();
    const suffix = lastDiagnostic ? ` ${lastDiagnostic}` : "";
    return this.setUnavailable("startup-failed", `OpenCode did not become ready.${suffix}`);
  }

  private async waitUntilReady(endpoint: string, password: string, exited: Promise<number | null>): Promise<string> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let didExit = false;
    const earlyExit = exited.then(code => {
      didExit = true;
      throw new Error(`OpenCode exited with code ${code ?? "unknown"} before becoming ready.`);
    });
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

    while (Date.now() < deadline) {
      if (this.closed) throw new Error("OpenCode startup was cancelled.");
      const remaining = Math.max(1, deadline - Date.now());
      try {
        const response = await Promise.race([
          this.fetch(`${endpoint}/global/health`, {
            headers: { authorization },
            signal: AbortSignal.timeout(remaining),
          }),
          earlyExit,
        ]);
        if (response.ok) {
          const body = await response.json() as { healthy?: unknown; version?: unknown };
          if (body.healthy === true) return typeof body.version === "string" && body.version ? body.version : "unknown";
        }
      } catch (error) {
        if (didExit) throw error;
      }
      await Promise.race([this.sleep(Math.min(this.healthIntervalMs, remaining)), earlyExit]);
    }
    throw new Error(`OpenCode health check timed out after ${this.startupTimeoutMs}ms.`);
  }

  private async handleUnexpectedExit(managed: ManagedProcess, code: number | null): Promise<void> {
    if (this.process !== managed) return;
    await managed.capture.done;
    this.process = null;
    this.connection = null;
    if (!this.closed) {
      const detail = managed.capture.snapshot();
      this.setUnavailable("startup-failed", `OpenCode exited unexpectedly with code ${code ?? "unknown"}.${detail ? ` ${detail}` : ""}`);
    }
  }

  private async disposeService(): Promise<void> {
    const starting = this.startPromise;
    const active = this.process;
    if (active) await active.terminate();
    await starting?.catch(() => undefined);
    if (this.process && this.process !== active) await this.process.terminate();
    this.process = null;
    this.connection = null;
    this.stoppedAvailability();
  }

  private setUnavailable(reason: "not-installed" | "startup-failed" | "unsupported", message: string): ChatAvailability {
    this.connection = null;
    this.availability = { state: "unavailable", reason, message };
    return this.availability;
  }

  private stoppedAvailability(): ChatAvailability {
    return this.setUnavailable("startup-failed", "OpenCode chat has stopped with this workspace.");
  }
}

export function buildOpenCodeEnvironment(source: NodeJS.ProcessEnv, password: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) if (value !== undefined) env[name] = value;
  env.OPENCODE_SERVER_PASSWORD = password;
  return env;
}

export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, HOSTNAME, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

class BoundedTextCapture {
  private bytes = new Uint8Array();
  private resolveDone!: () => void;
  readonly done = new Promise<void>(resolve => {
    this.resolveDone = resolve;
  });

  constructor(private readonly limit: number) {}

  consume(stream: ReadableStream<Uint8Array>): void {
    void (async () => {
      try {
        for await (const chunk of stream) {
          const combined = new Uint8Array(this.bytes.length + chunk.length);
          combined.set(this.bytes);
          combined.set(chunk, this.bytes.length);
          this.bytes = combined.length <= this.limit ? combined : combined.slice(combined.length - this.limit);
        }
      } catch {
        // Preserve the diagnostics collected before the stream closed.
      } finally {
        this.resolveDone();
      }
    })();
  }

  snapshot(): string {
    return new TextDecoder().decode(this.bytes).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  }
}

class ManagedProcess {
  private terminating: Promise<void> | null = null;

  constructor(
    private readonly process: SpawnedOpenCode,
    readonly capture: BoundedTextCapture,
    private readonly killGroup: (pid: number, signal: NodeJS.Signals | 0) => void,
    private readonly sleep: (milliseconds: number) => Promise<void>,
    private readonly termGraceMs: number,
  ) {}

  terminate(): Promise<void> {
    this.terminating ??= this.terminateOnce();
    return this.terminating;
  }

  private async terminateOnce(): Promise<void> {
    signalProcess(this.process, this.killGroup, "SIGTERM");
    if (!await settlesWithin(this.process.exited, this.termGraceMs, this.sleep)) {
      signalProcess(this.process, this.killGroup, "SIGKILL");
      await this.process.exited.catch(() => undefined);
    }
    await this.capture.done;
  }
}

function signalProcess(child: SpawnedOpenCode, killGroup: (pid: number, signal: NodeJS.Signals | 0) => void, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") child.kill(signal);
    else killGroup(child.pid, signal);
  } catch {
    // The child may have exited between state inspection and signaling.
  }
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    sleep(milliseconds).then(() => false),
  ]);
}

function isBindFailure(message: string): boolean {
  return /EADDRINUSE|address already in use|failed to bind/i.test(message);
}
