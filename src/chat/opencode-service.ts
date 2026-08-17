import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import type { ChatAvailability, ChatProbeOutcome, ChatStartupDiagnostics } from "./types";
import { discoverOpenCodeCandidates } from "./executable";
import { describeProbe } from "./diagnostics";

const HOSTNAME = "127.0.0.1";
// Generous by design. Too long only means Chat appears a moment late behind the
// existing `starting` state; too short means Chat is permanently broken with no
// way for the user to say why. A cold OpenCode start on a slow filesystem (a
// WSL2 `/mnt/*` workspace, a cold page cache) does not fit in ten seconds.
const STARTUP_TIMEOUT_MS = 30_000;
// Once OpenCode answers at all it has bound, so a server that then refuses to
// become healthy must fail fast instead of occupying the whole budget.
const HEALTH_PHASE_MS = 5_000;
// Per-probe ceiling. Without it a connection that is accepted but never
// answered consumes the entire remaining window as a single attempt.
const PROBE_TIMEOUT_MS = 2_000;
const HEALTH_INTERVAL_MS = 100;
const TERM_GRACE_MS = 3_000;
const STDERR_LIMIT_BYTES = 16 * 1024;
const BIND_ATTEMPTS = 3;

export type SpawnedOpenCode = {
  pid: number;
  exited: Promise<number | null>;
  stderr: ReadableStream<Uint8Array>;
  // Captured for diagnostics only. Readiness never depends on OpenCode's output
  // format — that is a property of the user's independently-installed binary,
  // not of the pinned SDK, so nothing here feeds control flow.
  stdout?: ReadableStream<Uint8Array>;
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
  // Returns every `opencode` on PATH in search order; the first is used and the
  // rest are reported as shadowed in diagnostics.
  discoverCandidates?: (env: NodeJS.ProcessEnv) => Promise<string[]>;
  // Resolves the OpenCode version on the failure path only, when no health body
  // ever arrived to carry it.
  probeVersion?: (executable: string) => Promise<string | null>;
  allocatePort?: () => Promise<number>;
  spawn?: (argv: string[], options: Parameters<typeof Bun.spawn>[1]) => SpawnedOpenCode;
  fetch?: FetchLike;
  randomPassword?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  killGroup?: (pid: number, signal: NodeJS.Signals | 0) => void;
  // Injected so budget behavior is deterministic under test: a stubbed `sleep`
  // that resolves immediately would otherwise spin against the real clock.
  now?: () => number;
  startupTimeoutMs?: number;
  probeTimeoutMs?: number;
  healthIntervalMs?: number;
  termGraceMs?: number;
  stderrLimitBytes?: number;
  bindAttempts?: number;
};

export class OpenCodeService {
  private readonly workspacePath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly discover: NonNullable<OpenCodeServiceOptions["discoverCandidates"]>;
  private readonly probeVersion: NonNullable<OpenCodeServiceOptions["probeVersion"]>;
  private readonly allocatePort: NonNullable<OpenCodeServiceOptions["allocatePort"]>;
  private readonly spawn: NonNullable<OpenCodeServiceOptions["spawn"]>;
  private readonly fetch: FetchLike;
  private readonly randomPassword: NonNullable<OpenCodeServiceOptions["randomPassword"]>;
  private readonly sleep: NonNullable<OpenCodeServiceOptions["sleep"]>;
  private readonly killGroup: NonNullable<OpenCodeServiceOptions["killGroup"]>;
  private readonly now: () => number;
  private readonly startupTimeoutMs: number;
  private readonly probeTimeoutMs: number;
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
    this.discover = options.discoverCandidates ?? discoverOpenCodeCandidates;
    this.probeVersion = options.probeVersion ?? probeOpenCodeVersion;
    this.allocatePort = options.allocatePort ?? allocateLoopbackPort;
    this.spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions) as SpawnedOpenCode);
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.randomPassword = options.randomPassword ?? (() => randomBytes(32).toString("base64url"));
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.killGroup = options.killGroup ?? ((pid, signal) => process.kill(-pid, signal));
    this.now = options.now ?? (() => Date.now());
    // Explicit option wins (tests, the real-OpenCode integration test), then the
    // operator's environment, then the default. Environment rather than a CLI
    // flag because the hub builds its session children's argv itself, so a flag
    // could never reach a hub-hosted workspace — which is where this is needed.
    this.startupTimeoutMs = options.startupTimeoutMs ?? resolveStartupTimeoutMs(this.env) ?? STARTUP_TIMEOUT_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
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
    const startedAt = this.now();
    const candidates = await this.discover(this.env);
    const executable = candidates[0] ?? null;
    if (this.closed) return this.stoppedAvailability();
    if (!executable) {
      return this.setUnavailable("not-installed", "OpenCode is not installed or is not available on PATH.");
    }

    let lastDiagnostic = "";
    let lastEndpoint: string | null = null;
    let lastStdout = "";
    let lastStderr = "";
    let progress = newProbeProgress();
    for (let attempt = 0; attempt < this.bindAttempts; attempt += 1) {
      if (this.closed) return this.stoppedAvailability();
      const port = await this.allocatePort();
      const password = this.randomPassword();
      const endpoint = `http://${HOSTNAME}:${port}`;
      lastEndpoint = endpoint;
      // Both captures redact the generated password. Structurally it is never
      // placed in a diagnostic field; scrubbing covers the case where OpenCode
      // itself echoes its own environment into its output.
      const capture = new BoundedTextCapture(this.stderrLimitBytes, password);
      const stdoutCapture = new BoundedTextCapture(this.stderrLimitBytes, password);
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
          stdout: "pipe",
          stderr: "pipe",
          detached: process.platform !== "win32",
        } as Parameters<typeof Bun.spawn>[1]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Same structured evidence as a failed probe loop: a binary that was
        // removed, lost its execute bit, or cannot spawn is exactly the case
        // a pasted Diagnostics block needs to attribute.
        const version = await this.probeVersion(executable).catch(() => null);
        return this.setUnavailable("startup-failed", `OpenCode could not be started: ${message}`, {
          executable,
          shadowedExecutables: candidates.slice(1),
          version,
          endpoint,
          elapsedMs: this.now() - startedAt,
          probes: 0,
          lastProbe: { kind: "none" },
          stdout: "",
          stderr: "",
        });
      }

      const managed = new ManagedProcess(spawned, capture, this.killGroup, this.sleep, this.termGraceMs);
      this.process = managed;
      capture.consume(spawned.stderr);
      if (spawned.stdout) stdoutCapture.consume(spawned.stdout);
      else stdoutCapture.close();
      progress = newProbeProgress();
      try {
        const version = await this.waitUntilReady(endpoint, password, spawned.exited, progress);
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
        await stdoutCapture.done;
        if (this.process === managed) this.process = null;
        lastStderr = capture.snapshot();
        lastStdout = stdoutCapture.snapshot();
        lastDiagnostic = error instanceof Error ? error.message : String(error);
        if (!isBindFailure([lastDiagnostic, lastStderr].join("\n")) || attempt === this.bindAttempts - 1) break;
      }
    }

    if (this.closed) return this.stoppedAvailability();
    // Only now — startup has already failed, so the extra subprocess costs the
    // happy path nothing, and the version is the field that eliminates a whole
    // hypothesis class in one line.
    const version = await this.probeVersion(executable).catch(() => null);
    return this.setUnavailable("startup-failed", `OpenCode did not become ready. ${lastDiagnostic}`.trim(), {
      executable,
      shadowedExecutables: candidates.slice(1),
      version,
      endpoint: lastEndpoint,
      elapsedMs: this.now() - startedAt,
      probes: progress.attempts,
      lastProbe: progress.lastOutcome,
      stdout: lastStdout,
      stderr: lastStderr,
    });
  }

  // Discards a cached failure and starts over. User-initiated only: retrying a
  // slow start automatically would just multiply the wait. A retry that lands
  // while one is in flight joins it through `startPromise` rather than spawning
  // a second OpenCode.
  retry(): Promise<ChatAvailability> {
    if (this.closed) return Promise.resolve(this.availability);
    if (this.availability.state === "unavailable") this.availability = { state: "idle" };
    return this.status();
  }

  /**
   * Terminates any current OpenCode and starts over. This is the retry path
   * for adapter-level incompatibility: the runtime itself still reports
   * "ready" then, so a bare `retry()` would re-probe the same process — and
   * with it the same binary the user may have just replaced on disk.
   */
  async restart(): Promise<ChatAvailability> {
    if (this.closed) return this.availability;
    await this.startPromise?.catch(() => undefined);
    // Detached before terminating so the exit reads as commanded, not
    // unexpected — `handleUnexpectedExit` ignores a non-current process.
    const active = this.process;
    this.process = null;
    this.connection = null;
    if (active) await active.terminate();
    if (this.closed) return this.stoppedAvailability();
    this.availability = { state: "idle" };
    return this.status();
  }

  private async waitUntilReady(
    endpoint: string,
    password: string,
    exited: Promise<number | null>,
    progress: ProbeProgress,
  ): Promise<string> {
    const started = this.now();
    // The bind budget runs until OpenCode answers at all; from the first HTTP
    // response a short health slice applies, because a server that has bound
    // and then refuses to become healthy must not occupy the whole window.
    let deadline = started + this.startupTimeoutMs;
    let didExit = false;
    const earlyExit = exited.then(code => {
      didExit = true;
      throw new Error(`OpenCode exited with code ${code ?? "unknown"} before becoming ready.`);
    });
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

    while (this.now() < deadline) {
      if (this.closed) throw new Error("OpenCode startup was cancelled.");
      const remaining = Math.max(1, deadline - this.now());
      progress.attempts += 1;
      try {
        const response = await Promise.race([
          this.fetch(`${endpoint}/global/health`, {
            headers: { authorization },
            signal: AbortSignal.timeout(Math.min(this.probeTimeoutMs, remaining)),
          }),
          earlyExit,
        ]);
        // Any HTTP response proves OpenCode bound. That is a protocol-level
        // fact, unlike anything it prints, so it is what the phase split keys
        // on and what distinguishes "never bound" from "bound but unhealthy".
        if (!progress.answered) {
          progress.answered = true;
          // The full slice even when the first answer lands late in the bind
          // budget: the health phase exists to shorten the wait after binding,
          // not to shrink into whatever remainder happens to be left. Worst
          // case the total runs one health phase past the bind budget.
          deadline = this.now() + HEALTH_PHASE_MS;
        }
        if (response.ok) {
          const body = await response.json().catch(() => null) as { healthy?: unknown; version?: unknown } | null;
          if (body?.healthy === true) {
            progress.lastOutcome = { kind: "healthy", status: response.status };
            return typeof body.version === "string" && body.version ? body.version : "unknown";
          }
          progress.lastOutcome = { kind: "unhealthy-body", status: response.status };
        } else {
          progress.lastOutcome = { kind: "http-status", status: response.status };
        }
      } catch (error) {
        if (didExit) throw error;
        progress.lastOutcome = classifyProbeFailure(error);
      }
      await Promise.race([this.sleep(Math.min(this.healthIntervalMs, Math.max(1, deadline - this.now()))), earlyExit]);
    }

    const elapsed = this.now() - started;
    throw new Error(progress.answered
      ? `OpenCode answered at ${endpoint} but never became healthy within ${elapsed}ms (${describeProbe(progress.lastOutcome)}).`
      : `OpenCode never accepted a health request at ${endpoint} within ${elapsed}ms (${describeProbe(progress.lastOutcome)}).`);
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

  private setUnavailable(
    reason: "not-installed" | "startup-failed" | "unsupported",
    message: string,
    diagnostics?: ChatStartupDiagnostics,
  ): ChatAvailability {
    this.connection = null;
    this.availability = diagnostics
      ? { state: "unavailable", reason, message, diagnostics }
      : { state: "unavailable", reason, message };
    return this.availability;
  }

  private stoppedAvailability(): ChatAvailability {
    return this.setUnavailable("startup-failed", "OpenCode chat has stopped with this workspace.");
  }
}

// `UATU_OPENCODE_STARTUP_TIMEOUT_MS` lets an operator widen the budget on a
// build already in the field. An unusable value falls back to the default
// rather than failing: Chat is optional to a workspace, so a typo here must not
// stop documents from being served. Mirrors `parseTimeout` in watchdog/main.ts.
export function resolveStartupTimeoutMs(env: NodeJS.ProcessEnv): number | undefined {
  const value = env.UATU_OPENCODE_STARTUP_TIMEOUT_MS;
  if (value === undefined || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
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

  constructor(private readonly limit: number, private readonly secret?: string) {}

  // For a stream that will never arrive, so `done` still settles.
  close(): void {
    this.resolveDone();
  }

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
    // The password is base64url, so its literal form is the only encoding that
    // can appear here — there is no quoted or percent-encoded variant to match.
    const text = this.decoded();
    return this.secret ? text.split(this.secret).join("[redacted]") : text;
  }

  private decoded(): string {
    return new TextDecoder().decode(this.bytes).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  }
}

// A short, bounded `opencode --version`. Runs only after startup has already
// failed, so the happy path pays nothing; its own failure is itself diagnostic
// and must not mask the original error, so every path resolves rather than
// throws.
export async function probeOpenCodeVersion(executable: string, timeoutMs = 3_000): Promise<string | null> {
  try {
    const child = Bun.spawn([executable, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    try {
      const text = (await new Response(child.stdout).text()).trim();
      return await child.exited === 0 && text ? text.split("\n")[0]!.trim() : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
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

type ProbeProgress = {
  attempts: number;
  answered: boolean;
  lastOutcome: ChatProbeOutcome;
};

function newProbeProgress(): ProbeProgress {
  return { attempts: 0, answered: false, lastOutcome: { kind: "none" } };
}

// Keys on Bun's error shapes rather than on anything OpenCode prints. This is a
// coupling to a pinned dependency with a compile-time surface, unlike the
// binary's output format — and an unrecognized shape becomes `unknown` rather
// than being mistaken for a refusal, so a Bun change degrades attribution
// instead of inverting it.
export function classifyProbeFailure(error: unknown): ChatProbeOutcome {
  const code = (error as { code?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") return { kind: "refused" };
  if (name === "TimeoutError" || name === "AbortError") return { kind: "abandoned" };
  return { kind: "unknown", error: error instanceof Error ? error.message : String(error) };
}

