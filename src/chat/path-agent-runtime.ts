import type { ChatProvider } from "./provider";
import type { AgentRuntime } from "./service";
import type { ChatAvailability, ChatStartupDiagnostics } from "./types";
import { discoverExecutableCandidates } from "./executable";
import { BoundedTextCapture, ManagedProcess } from "./managed-process";

// A version probe is one short-lived process, killed this long after it
// starts so a hung mount or a wedged install cannot run on. The deadline is
// also the answer's: output pipes a descendant still holds open are released
// then, keeping what was read so far.
const PROBE_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT_BYTES = 16 * 1024;
// How long a probe's leftover helpers get to leave after SIGTERM.
const PROBE_REAP_GRACE_MS = 500;

export type VersionProbeResult = {
  // The probe's exit code, or null when it was killed on timeout.
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
};

export type PathAgentMessages = {
  notInstalled: string;
  timedOut: (seconds: number) => string;
  startFailed: (detail: string) => string;
};

/** What makes one agent found on PATH different from another. */
export type PathAgentConfiguration = {
  // The executable's name on PATH, e.g. `claude`.
  binary: string;
  // The agent's name in its availability messages, e.g. `Claude Code`.
  displayName: string;
  // The arguments of the availability probe; `--version` when omitted.
  probeArgs?: string[];
  // The version in the probe's stdout, or null when it has none.
  parseVersion: (stdout: string) => string | null;
  // Overrides for the messages `pathAgentMessages` derives from the name.
  messages?: Partial<PathAgentMessages>;
};

export function pathAgentMessages(displayName: string): PathAgentMessages {
  return {
    notInstalled: `${displayName} is not installed or is not available on PATH.`,
    timedOut: seconds => `${displayName} did not answer a version probe within ${seconds}s.`,
    startFailed: detail => `${displayName} could not be started: ${detail}.`,
  };
}

export type PathAgentRuntimeOptions = {
  workspacePath: string;
  env?: NodeJS.ProcessEnv;
  // Every match for the binary on PATH in search order; the first is probed,
  // the rest are reported as shadowed in diagnostics.
  discoverCandidates?: (env: NodeJS.ProcessEnv) => Promise<string[]>;
  probe?: (executable: string, timeoutMs: number) => Promise<VersionProbeResult>;
  probeTimeoutMs?: number;
  now?: () => number;
};

/**
 * The runtime of an agent found on PATH with no long-lived idle process:
 * availability is executable discovery plus one bounded probe, and any
 * per-conversation processes are owned by the agent's provider, not here.
 *
 * Auth is deliberately not probed: a version probe answers without
 * credentials, and an unauthenticated install surfaces at the first turn as
 * that turn's failure, a per-conversation event, not an installation state.
 */
export class PathAgentRuntime {
  private readonly env: NodeJS.ProcessEnv;
  private readonly discover: NonNullable<PathAgentRuntimeOptions["discoverCandidates"]>;
  private readonly probe: NonNullable<PathAgentRuntimeOptions["probe"]>;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;
  private readonly messages: PathAgentMessages;

  private availability: ChatAvailability = { state: "idle" };
  private executable: string | null = null;
  private ensurePromise: Promise<ChatAvailability> | null = null;
  private closed = false;

  constructor(private readonly configuration: PathAgentConfiguration, options: PathAgentRuntimeOptions) {
    this.env = options.env ?? process.env;
    this.discover = options.discoverCandidates ?? (env => discoverExecutableCandidates(configuration.binary, env));
    const probeArgs = configuration.probeArgs ?? ["--version"];
    this.probe = options.probe ?? ((executable, timeoutMs) => runProbe([executable, ...probeArgs], timeoutMs));
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    const defaults = pathAgentMessages(configuration.displayName);
    // An override written as undefined counts as absent, never as a blank.
    const overrides = configuration.messages ?? {};
    this.messages = {
      notInstalled: overrides.notInstalled ?? defaults.notInstalled,
      timedOut: overrides.timedOut ?? defaults.timedOut,
      startFailed: overrides.startFailed ?? defaults.startFailed,
    };
  }

  /** Passive (3.3): reports what the last probe established, starts nothing. */
  peekStatus(): ChatAvailability {
    return this.availability;
  }

  /** The discovered executable, for the provider to run. */
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
    const { messages } = this;
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
        message: messages.notInstalled,
        diagnostics: this.diagnostics(null, shadowed, null, startedAt, { kind: "none" }, "", ""),
      };
      return this.availability;
    }

    let result: VersionProbeResult;
    try {
      result = await this.probe(executable, this.probeTimeoutMs);
    } catch (error) {
      result = { exitCode: null, stdout: "", stderr: "", timedOut: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (this.closed) return this.availability;

    const version = this.parseVersion(result.stdout);
    if (result.timedOut) {
      this.availability = {
        state: "unavailable",
        reason: "startup-failed",
        message: messages.timedOut(Math.round(this.probeTimeoutMs / 1000)),
        diagnostics: this.diagnostics(executable, shadowed, version, startedAt, { kind: "abandoned" }, result.stdout, result.stderr),
      };
      return this.availability;
    }
    if (result.error !== undefined || result.exitCode !== 0 || version === null) {
      const detail = result.error ?? (result.exitCode !== 0 ? `version probe exited with ${result.exitCode}` : "version probe produced no recognizable version");
      this.availability = {
        state: "unavailable",
        reason: "startup-failed",
        message: messages.startFailed(detail),
        diagnostics: this.diagnostics(executable, shadowed, version, startedAt, { kind: "unknown", error: detail }, result.stdout, result.stderr),
      };
      return this.availability;
    }

    this.executable = executable;
    this.availability = { state: "ready", version };
    return this.availability;
  }

  // Only a non-empty string is a version. A parser that throws on output it
  // does not expect (a banner, truncated JSON) or answers anything else (a
  // JSON field that is absent, empty or not a string) has found none.
  private parseVersion(stdout: string): string | null {
    let version: unknown;
    try {
      version = this.configuration.parseVersion(stdout);
    } catch {
      return null;
    }
    return typeof version === "string" && version !== "" ? version : null;
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

/**
 * The chat service's view of a PATH agent: lifecycle from the runtime, and a
 * provider built from the executable the last probe found.
 */
export function pathAgentRuntime(runtime: PathAgentRuntime, createProvider: (executable: string) => ChatProvider): AgentRuntime {
  return {
    status: () => Promise.resolve(runtime.peekStatus()),
    ensure: () => runtime.ensure(),
    restart: () => runtime.restart(),
    dispose: async () => runtime.dispose(),
    createProvider: () => {
      const executable = runtime.executablePath();
      return executable ? createProvider(executable) : null;
    },
  };
}

/** Run one version probe. It answers by `timeoutMs` whatever its child or a
 * descendant holding its pipes does: a child still running then is killed and
 * reported as timed out; one that exited keeps its exit code. Either way the
 * output read so far is the evidence. Exported for its own tests. */
export async function runProbe(argv: string[], timeoutMs: number): Promise<VersionProbeResult> {
  const child = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // A group leader, so whatever the probe starts can be reaped with it.
    detached: process.platform !== "win32",
  } as Parameters<typeof Bun.spawn>[1]) as unknown as ReturnType<typeof Bun.spawn> & { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> };
  // Bounded from the start: the version leads the output, and nothing a
  // probe prints can grow this process's memory past the limit.
  const stdout = new BoundedTextCapture(OUTPUT_LIMIT_BYTES, undefined, "start");
  const stderr = new BoundedTextCapture(OUTPUT_LIMIT_BYTES, undefined, "start");
  stdout.consume(child.stdout);
  stderr.consume(child.stderr);
  let exitCode: number | null = null;
  let exited = false;
  const childExited = child.exited.then(code => { exitCode = code; exited = true; });
  let expire!: () => void;
  const deadline = new Promise<void>(resolve => { expire = resolve; });
  const timer = setTimeout(expire, timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    await Promise.race([Promise.all([stdout.done, stderr.done, childExited]), deadline]);
  } finally {
    clearTimeout(timer);
  }
  const timedOut = !exited;
  if (timedOut) child.kill("SIGKILL");
  stdout.release();
  stderr.release();
  // The answer does not wait, but nothing the probe started outlives it: its
  // process group is ended in the background (SIGTERM, a grace, SIGKILL).
  void new ManagedProcess(child, { termGraceMs: PROBE_REAP_GRACE_MS, escalation: "group" }).terminate().catch(() => undefined);
  return { exitCode: timedOut ? null : exitCode, stdout: stdout.text(), stderr: stderr.text(), timedOut };
}
