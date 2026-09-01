import type { ChatAvailability, ChatStartupDiagnostics } from "../types";
import { discoverExecutableCandidates } from "../executable";

// A version probe is one short-lived process; a hung mount or a wedged
// install must cost at most this before Chat reports what it saw.
const PROBE_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT_BYTES = 16 * 1024;

export type ClaudeProbeResult = {
  // The probe's exit code, or null when it was killed on timeout.
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
};

export type ClaudeRuntimeOptions = {
  workspacePath: string;
  env?: NodeJS.ProcessEnv;
  // Every `claude` on PATH in search order; the first is probed, the rest
  // are reported as shadowed in diagnostics.
  discoverCandidates?: (env: NodeJS.ProcessEnv) => Promise<string[]>;
  probe?: (executable: string, timeoutMs: number) => Promise<ClaudeProbeResult>;
  probeTimeoutMs?: number;
  now?: () => number;
};

/**
 * The Claude Code agent runtime (D4). Different in kind from OpenCode's:
 * there is no long-lived idle service to spawn and health-probe. Availability
 * is executable discovery plus one bounded `claude --version` probe, and the
 * per-conversation sessions are owned by the provider, not here.
 *
 * Auth is deliberately not probed: `--version` answers without credentials,
 * and an unauthenticated install surfaces at the first turn as that turn's
 * failure — a per-conversation event, not an installation state.
 */
export class ClaudeRuntime {
  private readonly env: NodeJS.ProcessEnv;
  private readonly discover: NonNullable<ClaudeRuntimeOptions["discoverCandidates"]>;
  private readonly probe: NonNullable<ClaudeRuntimeOptions["probe"]>;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;

  private availability: ChatAvailability = { state: "idle" };
  private executable: string | null = null;
  private ensurePromise: Promise<ChatAvailability> | null = null;
  private closed = false;

  constructor(options: ClaudeRuntimeOptions) {
    this.env = options.env ?? process.env;
    this.discover = options.discoverCandidates ?? (env => discoverExecutableCandidates("claude", env));
    this.probe = options.probe ?? runVersionProbe;
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Passive (3.3): reports what the last probe established, starts nothing. */
  peekStatus(): ChatAvailability {
    return this.availability;
  }

  /** The discovered executable, for the provider to hand to the SDK. */
  executablePath(): string | null {
    return this.executable;
  }

  /** Probe (or join the in-flight probe) and report the outcome. */
  ensure(): Promise<ChatAvailability> {
    if (this.closed) return Promise.resolve(this.availability);
    if (this.availability.state === "ready" || this.availability.state === "unavailable") {
      return Promise.resolve(this.availability);
    }
    this.ensurePromise ??= this.performProbe().finally(() => {
      this.ensurePromise = null;
    });
    return this.ensurePromise;
  }

  /** User-initiated recovery: forget the cached outcome and probe again. */
  async restart(): Promise<ChatAvailability> {
    if (this.closed) return this.availability;
    await this.ensurePromise?.catch(() => undefined);
    this.availability = { state: "idle" };
    this.executable = null;
    return this.ensure();
  }

  dispose(): void {
    this.closed = true;
  }

  private async performProbe(): Promise<ChatAvailability> {
    this.availability = { state: "starting" };
    const startedAt = this.now();
    const candidates = await this.discover(this.env);
    const executable = candidates[0] ?? null;
    const shadowed = candidates.slice(1);
    if (this.closed) return this.availability;
    if (!executable) {
      this.availability = {
        state: "unavailable",
        reason: "not-installed",
        message: "Claude Code is not installed or is not available on PATH.",
        diagnostics: this.diagnostics(null, shadowed, null, startedAt, { kind: "none" }, "", ""),
      };
      return this.availability;
    }

    let result: ClaudeProbeResult;
    try {
      result = await this.probe(executable, this.probeTimeoutMs);
    } catch (error) {
      result = { exitCode: null, stdout: "", stderr: "", timedOut: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (this.closed) return this.availability;

    const version = parseVersion(result.stdout);
    if (result.timedOut) {
      this.availability = {
        state: "unavailable",
        reason: "startup-failed",
        message: `Claude Code did not answer a version probe within ${Math.round(this.probeTimeoutMs / 1000)}s.`,
        diagnostics: this.diagnostics(executable, shadowed, version, startedAt, { kind: "abandoned" }, result.stdout, result.stderr),
      };
      return this.availability;
    }
    if (result.error !== undefined || result.exitCode !== 0 || version === null) {
      const detail = result.error ?? (result.exitCode !== 0 ? `version probe exited with ${result.exitCode}` : "version probe produced no recognizable version");
      this.availability = {
        state: "unavailable",
        reason: "startup-failed",
        message: `Claude Code could not be started: ${detail}.`,
        diagnostics: this.diagnostics(executable, shadowed, version, startedAt, { kind: "unknown", error: detail }, result.stdout, result.stderr),
      };
      return this.availability;
    }

    this.executable = executable;
    this.availability = { state: "ready", version };
    return this.availability;
  }

  private diagnostics(
    executable: string | null,
    shadowedExecutables: string[],
    version: string | null,
    startedAt: number,
    lastProbe: ChatStartupDiagnostics["lastProbe"],
    stdout: string,
    stderr: string,
  ): ChatStartupDiagnostics {
    return {
      executable,
      shadowedExecutables,
      version,
      // No server, no endpoint: the shape is shared with OpenCode's
      // diagnostics, and absence here is itself diagnostic.
      endpoint: null,
      elapsedMs: Math.max(0, this.now() - startedAt),
      probes: executable ? 1 : 0,
      lastProbe,
      stdout: stdout.slice(0, OUTPUT_LIMIT_BYTES),
      stderr: stderr.slice(0, OUTPUT_LIMIT_BYTES),
    };
  }
}

/** `<version> (Claude Code)` or a bare semver — take the leading version token. */
function parseVersion(stdout: string): string | null {
  const match = stdout.trim().match(/^(\d+\.\d+\.\d+\S*)/);
  return match ? match[1]! : null;
}

async function runVersionProbe(executable: string, timeoutMs: number): Promise<ClaudeProbeResult> {
  const child = Bun.spawn([executable, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode: timedOut ? null : exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
