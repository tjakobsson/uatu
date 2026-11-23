// The session-backend seam. The hub never touches process spawning (or, in
// the future, container runtimes) directly — it asks a backend to start a
// workspace session and gets back a session link: the Hub's one handle to
// that session, holding its loopback endpoint and session token. Everything
// above this interface (proxy, dashboard, auth) is backend-agnostic by
// construction: a future container/VM backend (containerd + a runtime shim,
// uatu serve inside the guest, port published to loopback) implements this
// same seam and nothing else changes.
//
// The local-process backend follows the session contract
// (src/session-contract/): it spawns `uatu serve` with the contract's argv
// and stdio, sends the policy bootstrap over descriptor 3, reads the ready
// line, verifies the readiness proof, and holds the session's stdin open for
// its whole life (EOF is the orphan backstop if the hub dies without
// handlers). SIGTERM is the clean stop.

import type { Subprocess } from "bun";
import { promises as fs } from "node:fs";
import { sendChildPolicyDescriptor, verifyPolicyReadiness } from "../session-contract/bootstrap";
import { createSessionLink, type SessionLink } from "../session-contract/link";
import { createChildPolicyAuthority } from "../session-contract/policy";
import {
  createReadyLineScanner,
  resolveUatuArgv,
  SESSION_STARTUP_INACTIVITY_MS,
  SESSION_STDIO,
  sessionServeArgv,
  type ReadyLine,
} from "../session-contract/spawn";

import { buildLocalCredentialEnvironment, type ResolvedCredentialContext } from "./credential-context";
import type { WorkspaceEntry } from "./registry";

export type RunningSession = {
  // The Hub's handle to the session: every request to it is addressed and
  // trusted through this link.
  link: SessionLink;
  // Resolves when the session exits, with its exit code.
  exited: Promise<number | null>;
  stop(): Promise<void>;
};

export interface SessionBackend {
  start(workspace: WorkspaceEntry, basePath: string, credentials: ResolvedCredentialContext): Promise<RunningSession>;
}

const SIGTERM_GRACE_MS = 3_000;

export type LocalBackendOptions = {
  // How to invoke the uatu CLI. In a compiled binary this is
  // [process.execPath]; from source it is ["bun", "run", "src/cli.ts"] —
  // the contract's resolveUatuArgv() picks based on how the current process
  // was started (the same detection cli.ts uses for the watchdog re-exec).
  uatuArgv?: string[];
  spawn?: typeof Bun.spawn;
  env?: NodeJS.ProcessEnv;
  terminationGraceMs?: number;
  startupInactivityMs?: number;
};

export class LocalProcessBackend implements SessionBackend {
  private readonly uatuArgv: string[];
  private readonly spawn: typeof Bun.spawn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly terminationGraceMs: number;
  private readonly startupInactivityMs: number;

  constructor(options: LocalBackendOptions = {}) {
    this.uatuArgv = options.uatuArgv ?? resolveUatuArgv();
    this.spawn = options.spawn ?? Bun.spawn;
    this.env = options.env ?? process.env;
    this.terminationGraceMs = options.terminationGraceMs ?? SIGTERM_GRACE_MS;
    this.startupInactivityMs = options.startupInactivityMs ?? SESSION_STARTUP_INACTIVITY_MS;
  }

  async start(workspace: WorkspaceEntry, basePath: string, credentials: ResolvedCredentialContext): Promise<RunningSession> {
    const argv = sessionServeArgv(this.uatuArgv, workspace.path, basePath);

    const projected = await buildLocalCredentialEnvironment({
      workspace,
      context: credentials,
      uatuArgv: this.uatuArgv,
      sourceEnv: this.env,
    });
    const authority = createChildPolicyAuthority(workspace.id, basePath);
    let child: Subprocess<"pipe", "pipe", "pipe">;
    try {
      child = this.spawn(argv, {
        // stdin stays a pipe we hold open — closing it (including by hub
        // death) is the session's signal to exit.
        stdio: [...SESSION_STDIO],
        // Explicit rather than implicit: Bun's default inherit snapshots the
        // environment at process start and does not see later mutations. The hub
        // builds this argv itself, so environment is the only channel an operator
        // knob (UATU_OPENCODE_STARTUP_TIMEOUT_MS) has into a session's Chat.
        env: projected.env,
      });
    } catch (error) {
      authority.dispose();
      await fs.rm(projected.runtimeDirectory, { recursive: true, force: true });
      throw error;
    }

    // Extra-descriptor ownership transfers to us. Always close the parent
    // endpoint, including bootstrap failure; stdin remains the lifetime pipe.
    const descriptor = child.stdio?.[3];
    let bootstrapped = false;
    if (typeof descriptor === "number") {
      bootstrapped = await sendChildPolicyDescriptor(descriptor, () => authority.bootstrap());
    }

    const stderrTail = collectTail(child.stderr);

    let ready: ReadyLine;
    try {
      ready = await readReadyLine(child.stdout, this.startupInactivityMs, child);
    } catch (error) {
      authority.dispose();
      await terminate(child, this.terminationGraceMs);
      await fs.rm(projected.runtimeDirectory, { recursive: true, force: true });
      const tail = stderrTail.snapshot();
      const detail = tail ? `\n${tail}` : "";
      throw new Error(
        `session for '${workspace.id}' failed to start: ${error instanceof Error ? error.message : String(error)}${detail}`,
      );
    }

    // Policy trust needs both halves: the session consumed the bootstrap,
    // and it then proved so on its own listener.
    const trusted = bootstrapped && await verifyPolicyReadiness(ready.url.origin, basePath, authority);
    if (!trusted) authority.dispose();
    const link = createSessionLink({
      workspaceId: workspace.id,
      instanceId: authority.instanceId,
      basePath,
      endpoint: ready.endpoint,
      token: ready.token,
      authority: trusted ? authority : null,
    });
    const session: RunningSession = {
      link,
      exited: child.exited.then(code => code ?? null).catch(() => null),
      stop: async () => {
        link.withdraw();
        await terminate(child, this.terminationGraceMs);
        await fs.rm(projected.runtimeDirectory, { recursive: true, force: true });
      },
    };
    void session.exited
      .then(async () => {
        link.withdraw();
        await fs.rm(projected.runtimeDirectory, { recursive: true, force: true });
      })
      .catch(() => undefined);
    return session;
  }
}

// Reads the session's stdout until the contract's ready line, or rejects on
// inactivity / early exit. The timer re-arms on every stdout chunk: a slow
// start that keeps talking (the CLI's supervised startup heartbeat) can take
// as long as it needs, while a silent session is still bounded.
async function readReadyLine(
  stream: ReadableStream<Uint8Array>,
  inactivityMs: number,
  child: Subprocess,
): Promise<ReadyLine> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const scanner = createReadyLineScanner();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let rejectInactive!: (error: Error) => void;
  const timeout = new Promise<never>((_, reject) => {
    rejectInactive = reject;
  });
  const armTimeout = () => {
    clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(
      () => rejectInactive(new Error(`no session URL or startup output on stdout within ${Math.round(inactivityMs / 1000)}s`)),
      inactivityMs,
    );
  };
  armTimeout();
  const earlyExit = child.exited.then(code => {
    throw new Error(`child exited (code ${code}) before printing a session URL`);
  });

  try {
    for (;;) {
      const next = await Promise.race([reader.read(), timeout, earlyExit]);
      if (next.done) {
        throw new Error("child stdout closed before printing a session URL");
      }
      armTimeout();
      const ready = scanner.push(decoder.decode(next.value, { stream: true }));
      if (ready) return ready;
    }
  } finally {
    clearTimeout(timeoutHandle);
    reader.releaseLock();
  }
}

// Best-effort rolling capture of the child's stderr for failure reporting.
function collectTail(stream: ReadableStream<Uint8Array>): { snapshot(): string } {
  const decoder = new TextDecoder();
  let tail = "";
  void (async () => {
    try {
      for await (const chunk of stream) {
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(-2000);
      }
    } catch {
      // Stream closed — keep what we have.
    }
  })();
  return { snapshot: () => tail.trim() };
}

async function terminate(child: Subprocess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) return;
  }
  const grace = new Promise<void>(resolve => setTimeout(resolve, graceMs));
  const exited = child.exited.then(() => "exited" as const, () => "unconfirmed" as const);
  const winner = await Promise.race([exited, grace.then(() => "timeout" as const)]);
  if (winner !== "exited") {
    try {
      child.kill("SIGKILL");
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) return;
    }
    const killed = await Promise.race([
      child.exited.then(() => true, () => false),
      new Promise<false>(resolve => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (!killed && child.exitCode === null && child.signalCode === null) {
      throw new Error("session child exit could not be confirmed after termination");
    }
  }
}
