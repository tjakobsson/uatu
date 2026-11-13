// The session-backend seam. The hub never touches process spawning (or, in
// the future, container runtimes) directly — it asks a backend to start a
// session for a workspace and gets back a loopback HTTP endpoint plus the
// child's session token. Everything above this interface (proxy, dashboard,
// auth) is backend-agnostic by construction: a future container/VM backend
// (containerd + a runtime shim, uatu serve inside the guest, port published
// to loopback) implements this same contract and nothing else changes.
//
// The local-process backend wraps the desktop-wrapper-proven child contract:
//   spawn `uatu serve <folder> --no-open --exit-on-stdin-close --base-path …`
//   → first stdout line is the tokened session URL
//   → the supervisor holds the child's stdin open for its whole life
//     (EOF is the orphan backstop if the hub dies without handlers)
//   → SIGTERM is the clean stop.

import type { Subprocess } from "bun";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { createChildPolicyAuthority, type ChildPolicyRequest, type VerifiedChatPolicy } from "./child-policy";
import { sendChildPolicyDescriptor } from "./child-policy-bootstrap";

import { buildLocalCredentialEnvironment, type ResolvedCredentialContext } from "./credential-context";
import type { WorkspaceEntry } from "./registry";

export type SessionEndpoint = {
  hostname: string;
  port: number;
};

export type RunningSession = {
  workspaceId: string;
  instanceId: string;
  policyTrust: "ready" | "unavailable";
  basePath: string;
  endpoint: SessionEndpoint;
  // The child's per-session terminal token (null when the child's terminal
  // feature is unavailable). Held hub-side only — never surfaced to
  // browsers; the hub brokers it during proxying.
  token: string | null;
  // Resolves when the child exits, with its exit code.
  exited: Promise<number | null>;
  stop(): Promise<void>;
};

const policyAuthorities = new WeakMap<RunningSession, ReturnType<typeof createChildPolicyAuthority>>();
export function signSessionChatPolicy(session: RunningSession, request: ChildPolicyRequest, policy: VerifiedChatPolicy): string | null {
  try { return session.policyTrust === "ready" ? policyAuthorities.get(session)?.sign(request, policy) ?? null : null; }
  catch { return null; }
}

export interface SessionBackend {
  start(workspace: WorkspaceEntry, basePath: string, credentials: ResolvedCredentialContext): Promise<RunningSession>;
}

// INACTIVITY timeout, not a startup deadline: the child emits periodic
// progress lines while preparing (a large tree's watcher setup alone can
// take minutes — chokidar attaches at roughly 5ms per file on macOS), so
// any stdout output re-arms the timer and only a silent child — hung, or an
// old build that predates the heartbeat AND takes longer than this — is
// killed. The child's heartbeat is itself capped (its
// STARTUP_HEARTBEAT_MAX_DURATION_SECONDS), so a child that wedges without
// exiting stops re-arming this timer and is reaped one inactivity window
// after that cap.
const STARTUP_INACTIVITY_TIMEOUT_MS = 30_000;
const SIGTERM_GRACE_MS = 3_000;

export type LocalBackendOptions = {
  // How to invoke the uatu CLI. In a compiled binary this is
  // [process.execPath]; from source it is ["bun", "run", "src/cli.ts"] —
  // resolveUatuArgv() picks based on how the current process was started
  // (the same detection cli.ts uses for the watchdog re-exec).
  uatuArgv?: string[];
  spawn?: typeof Bun.spawn;
  env?: NodeJS.ProcessEnv;
  terminationGraceMs?: number;
  startupInactivityMs?: number;
};

export function resolveUatuArgv(): string[] {
  const scriptPath = typeof Bun.argv[1] === "string" ? Bun.argv[1] : "";
  if (/\.(ts|js)$/.test(scriptPath)) {
    return [process.execPath, scriptPath];
  }
  return [process.execPath];
}

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
    this.startupInactivityMs = options.startupInactivityMs ?? STARTUP_INACTIVITY_TIMEOUT_MS;
  }

  async start(workspace: WorkspaceEntry, basePath: string, credentials: ResolvedCredentialContext): Promise<RunningSession> {
    const argv = [
      ...this.uatuArgv,
      "serve",
      workspace.path,
      "--no-open",
      "--exit-on-stdin-close",
      "--hub-policy-bootstrap",
      "--port",
      "0",
      "--base-path",
      basePath,
      // The hub owns its origin root, so its sessions declare the whole
      // origin as PWA scope — an installed webapp treats the dashboard,
      // login, and sibling sessions as in-app (no iOS browser chrome).
      "--manifest-scope",
      "origin",
    ];

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
        // death) is the child's signal to exit.
        stdio: ["pipe", "pipe", "pipe", "socket-fd"],
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

    let url: URL;
    try {
      const line = await readFirstUrlLine(child.stdout, this.startupInactivityMs, child);
      url = new URL(line);
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

    const session: RunningSession = {
      workspaceId: workspace.id,
      instanceId: authority.instanceId,
      policyTrust: "unavailable",
      basePath,
      endpoint: { hostname: url.hostname, port: Number.parseInt(url.port, 10) },
      token: url.searchParams.get("t"),
      exited: child.exited.then(code => code ?? null).catch(() => null),
      stop: async () => {
        withdraw();
        await terminate(child, this.terminationGraceMs);
        await fs.rm(projected.runtimeDirectory, { recursive: true, force: true });
      },
    };
    const withdraw = () => {
      session.policyTrust = "unavailable";
      policyAuthorities.delete(session);
      authority.dispose();
    };
    if (bootstrapped) {
      const challenge = randomBytes(32).toString("base64url");
      try {
        const response = await fetch(new URL(`${basePath}api/internal/hub-policy-proof`, url), {
          method: "POST", headers: { "content-type": "application/json", origin: url.origin },
          body: JSON.stringify({ challenge }), signal: AbortSignal.timeout(2000),
        });
        const proof = response.ok ? await response.json() as { proof?: unknown } : null;
        if (typeof proof?.proof === "string" && authority.verifyProof(challenge, proof.proof)) {
          policyAuthorities.set(session, authority);
          session.policyTrust = "ready";
        }
      } catch { /* Missing/old/invalid child trust never falls back to token. */ }
    }
    if (session.policyTrust !== "ready") authority.dispose();
    void session.exited
      .then(async () => {
        withdraw();
        await fs.rm(projected.runtimeDirectory, { recursive: true, force: true });
      })
      .catch(() => undefined);
    return session;
  }
}

// Reads the child's stdout until the first line containing an http:// URL —
// the CLI's supervisor contract — or rejects on inactivity / early exit.
// The timer re-arms on every stdout chunk: a slow start that keeps talking
// (the CLI's supervised startup heartbeat) can take as long as it needs,
// while a silent child is still bounded.
async function readFirstUrlLine(
  stream: ReadableStream<Uint8Array>,
  inactivityMs: number,
  child: Subprocess,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffered = "";

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
      buffered += decoder.decode(next.value, { stream: true });
      // Parse COMPLETE lines only. The contract is a URL line; matching the
      // raw buffer would accept a chunk-split fragment ("http://127" parses
      // as host 0.0.0.127 with a NaN port) and register an unreachable
      // session. Scanned lines are dropped so the buffer stays bounded.
      const lastNewline = buffered.lastIndexOf("\n");
      if (lastNewline >= 0) {
        const match = buffered.slice(0, lastNewline).match(/http:\/\/\S+/);
        if (match) {
          return match[0];
        }
        buffered = buffered.slice(lastNewline + 1);
      }
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
