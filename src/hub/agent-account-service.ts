/**
 * The Hub's Agent accounts service (design D1, D3, D4).
 *
 * - Runtimes: one per agent, started on the first request that needs it and
 *   stopped after `idleMs` without a request, but never while one of its
 *   logins is pending.
 * - Status: each agent's last read, re-read when a request finds it older
 *   than `refreshMs`. A read waits at most `readWaitMs` for runtimes still
 *   starting; the page polls until they settle.
 * - Attempts: one per agent and target. A new attempt cancels the earlier
 *   one. Each attempt settles to complete, failed, expired or cancelled, and
 *   stays visible for `retainMs` after it settles.
 * - Redirect delivery: only to the attempt's own loopback callback (see
 *   `agent-account-redirect.ts`).
 *
 * Secrets pass through and are never kept: a key, code or pasted address is
 * handed to the agent and dropped. Any agent message that echoes one back is
 * scrubbed before it reaches a response.
 */

import { randomUUID } from "node:crypto";

import type { ChatAccountChange } from "../chat/types";

import { AccountOperationError, AttemptExpiredError, agentErrorMessage, type AccountAdapter, type StartedLogin } from "./agent-account-adapter";
import { confineRedirect, deliverRedirect, type RedirectFetch } from "./agent-account-redirect";
import type { AccountRuntime, AccountRuntimeFactory } from "./agent-account-runtime";
import type {
  AccountAgentId,
  AccountAgentStatus,
  AccountAttempt,
  AccountAttemptState,
  AgentAccountsSnapshot,
} from "./agent-account-types";

export const ACCOUNT_AGENTS: ReadonlyArray<{ agent: AccountAgentId; name: string; loginCommand: string }> = [
  { agent: "opencode", name: "OpenCode", loginCommand: "opencode auth login" },
  { agent: "claude", name: "Claude Code", loginCommand: "claude auth login" },
];

const IDLE_MS = 5 * 60_000;
const ATTEMPT_TTL_MS = 10 * 60_000;
const RETAIN_MS = 5 * 60_000;
const REFRESH_MS = 2_000;
const READ_WAIT_MS = 4_000;
const SETTLE_WAIT_MS = 3_000;

export type Timers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export class AgentNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentNotReadyError";
  }
}

export class AttemptNotFoundError extends Error {
  constructor() {
    super("That login is no longer in progress.");
    this.name = "AttemptNotFoundError";
  }
}

export type AgentAccountServiceOptions = {
  runtimes: AccountRuntimeFactory;
  /**
   * Called after a login, logout or switch took effect, so running
   * workspaces can re-read and replay it. Awaited: the next change for the
   * same agent waits for it (design D6).
   */
  onChanged?: (agent: AccountAgentId, change: ChatAccountChange) => Promise<void> | void;
  fetch?: RedirectFetch;
  now?: () => number;
  timers?: Timers;
  sleep?: (ms: number) => Promise<void>;
  idleMs?: number;
  attemptTtlMs?: number;
  retainMs?: number;
  refreshMs?: number;
  readWaitMs?: number;
  settleWaitMs?: number;
};

type AgentEntry = {
  agent: AccountAgentId;
  // Login changes for this agent run one at a time, each through its
  // workspace notification, so a replayed removal cannot overtake a newer login.
  changes: Promise<void>;
  runtime: AccountRuntime | null;
  adapter: AccountAdapter | null;
  starting: Promise<void> | null;
  refreshing: Promise<void> | null;
  refreshedAt: number;
  status: AccountAgentStatus;
  idleTimer: unknown;
};

type AttemptEntry = {
  attempt: AccountAttempt;
  login: StartedLogin;
  secrets: string[];
  cancelled: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
  expiryTimer: unknown;
  retainTimer: unknown;
};

/** Removes every submitted secret from a message the agent produced. */
export function scrubSecrets(message: string, secrets: readonly string[]): string {
  let scrubbed = message;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length >= 4) scrubbed = scrubbed.split(trimmed).join("[redacted]");
  }
  return scrubbed;
}

function initialStatus(agent: AccountAgentId): AccountAgentStatus {
  const descriptor = ACCOUNT_AGENTS.find(entry => entry.agent === agent)!;
  return {
    agent,
    name: descriptor.name,
    state: "idle",
    capabilities: { login: false, logout: false, activate: false },
    targets: [],
    methods: [],
    loginCommand: descriptor.loginCommand,
  };
}

/** What the HTTP surface needs of the service. */
export type AgentAccountsApi = Pick<AgentAccountService, "read" | "connectKey" | "startLogin" | "submitCode" | "submitRedirect" | "cancel" | "logout" | "activate">;

export class AgentAccountService {
  private readonly entries = new Map<AccountAgentId, AgentEntry>();
  private readonly attempts = new Map<string, AttemptEntry>();
  private readonly fetch: RedirectFetch;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly idleMs: number;
  private readonly attemptTtlMs: number;
  private readonly retainMs: number;
  private readonly refreshMs: number;
  private readonly readWaitMs: number;
  private readonly settleWaitMs: number;
  private disposed = false;

  constructor(private readonly options: AgentAccountServiceOptions) {
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.timers = options.timers ?? { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.attemptTtlMs = options.attemptTtlMs ?? ATTEMPT_TTL_MS;
    this.retainMs = options.retainMs ?? RETAIN_MS;
    this.refreshMs = options.refreshMs ?? REFRESH_MS;
    this.readWaitMs = options.readWaitMs ?? READ_WAIT_MS;
    this.settleWaitMs = options.settleWaitMs ?? SETTLE_WAIT_MS;
    for (const { agent } of ACCOUNT_AGENTS) {
      this.entries.set(agent, {
        agent,
        changes: Promise.resolve(),
        runtime: null,
        adapter: null,
        starting: null,
        refreshing: null,
        refreshedAt: Number.NEGATIVE_INFINITY,
        status: initialStatus(agent),
        idleTimer: null,
      });
    }
  }

  /** Whether an agent's runtime is running (for tests and diagnostics). */
  isRunning(agent: AccountAgentId): boolean {
    return this.entry(agent).runtime !== null;
  }

  snapshot(): AgentAccountsSnapshot {
    return {
      agents: ACCOUNT_AGENTS.map(({ agent }) => structuredClone(this.entry(agent).status)),
      attempts: [...this.attempts.values()].map(entry => ({ ...entry.attempt })).sort((a, b) => a.startedAt - b.startedAt),
    };
  }

  /**
   * The status of every agent: starts runtimes that are not running, re-reads
   * stale statuses, and waits a bounded time for both before answering.
   */
  async read(): Promise<AgentAccountsSnapshot> {
    if (this.disposed) return this.snapshot();
    const pending: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      this.touch(entry);
      if (!entry.runtime) pending.push(this.ensureStarted(entry));
      else if (entry.starting) pending.push(entry.starting);
      else if (entry.adapter && this.now() - entry.refreshedAt >= this.refreshMs) pending.push(this.refresh(entry));
    }
    if (pending.length) await Promise.race([Promise.allSettled(pending), this.sleep(this.readWaitMs)]);
    return this.snapshot();
  }

  async connectKey(agent: AccountAgentId, target: string, methodId: string, key: string, answers: Record<string, unknown>): Promise<AgentAccountsSnapshot> {
    const entry = this.entry(agent);
    await this.serialized(entry, async () => {
      const adapter = await this.adapterFor(entry);
      await this.scrubbed([key], () => adapter.connectKey(target, methodId, key, answers));
      await this.changed(entry, { kind: "added" });
    });
    return this.snapshot();
  }

  async startLogin(agent: AccountAgentId, target: string, methodId: string, answers: Record<string, unknown>): Promise<AgentAccountsSnapshot> {
    const entry = this.entry(agent);
    const adapter = await this.adapterFor(entry);
    for (const existing of this.attempts.values()) {
      if (existing.attempt.agent === agent && existing.attempt.target === target && existing.attempt.state === "pending") {
        await this.cancelEntry(existing);
      }
    }
    const login = await this.scrubbed([], () => adapter.startLogin(target, methodId, answers));
    const startedAt = this.now();
    const expiresAt = login.expiresAt !== undefined && login.expiresAt > startedAt ? login.expiresAt : startedAt + this.attemptTtlMs;
    let resolveSettled!: () => void;
    const settled = new Promise<void>(resolve => {
      resolveSettled = resolve;
    });
    const attempt: AttemptEntry = {
      attempt: {
        id: randomUUID(),
        agent,
        target,
        methodId,
        url: login.url,
        instructions: login.instructions,
        completion: login.completion,
        state: "pending",
        startedAt,
        expiresAt,
      },
      login,
      secrets: [],
      cancelled: false,
      settled,
      resolveSettled,
      expiryTimer: null,
      retainTimer: null,
    };
    this.attempts.set(attempt.attempt.id, attempt);
    attempt.expiryTimer = this.timers.setTimeout(() => void this.expire(attempt), Math.max(0, expiresAt - startedAt));
    void login.waitForCompletion().then(
      () => this.settle(attempt, "complete"),
      error => {
        if (attempt.cancelled) return this.settle(attempt, "cancelled");
        if (error instanceof AttemptExpiredError) return this.settle(attempt, "expired");
        return this.settle(attempt, "failed", scrubSecrets(agentErrorMessage(error, "The login failed."), attempt.secrets));
      },
    );
    return this.snapshot();
  }

  async submitCode(attemptId: string, code: string): Promise<AgentAccountsSnapshot> {
    const attempt = this.pendingAttempt(attemptId);
    if (attempt.attempt.completion !== "code" || !attempt.login.submitCode) {
      throw new AccountOperationError("This login does not take a code.");
    }
    attempt.secrets.push(code);
    this.touch(this.entry(attempt.attempt.agent));
    await this.scrubbed(attempt.secrets, () => attempt.login.submitCode!(code));
    await Promise.race([attempt.settled, this.sleep(this.settleWaitMs)]);
    return this.snapshot();
  }

  async submitRedirect(attemptId: string, address: string): Promise<AgentAccountsSnapshot> {
    const attempt = this.pendingAttempt(attemptId);
    if (attempt.attempt.completion !== "redirect" || !attempt.login.callback) {
      throw new AccountOperationError("This login does not take an address.");
    }
    // Refused before any request when it is not this attempt's own callback.
    const target = confineRedirect(address, attempt.login.callback);
    attempt.secrets.push(address, target.search.slice(1));
    this.touch(this.entry(attempt.attempt.agent));
    try {
      await deliverRedirect(target, this.fetch);
    } catch {
      throw new AccountOperationError("The login's listener on the Hub machine did not answer. Start the login again.");
    }
    await Promise.race([attempt.settled, this.sleep(this.settleWaitMs)]);
    return this.snapshot();
  }

  async cancel(attemptId: string): Promise<AgentAccountsSnapshot> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new AttemptNotFoundError();
    if (attempt.attempt.state === "pending") await this.cancelEntry(attempt);
    return this.snapshot();
  }

  async logout(agent: AccountAgentId, target: string, credentialId: string): Promise<AgentAccountsSnapshot> {
    const entry = this.entry(agent);
    await this.serialized(entry, async () => {
      const adapter = await this.adapterFor(entry);
      await this.scrubbed([], () => adapter.logout(target, credentialId));
      await this.changed(entry, { kind: "removed", target, credential: credentialId });
    });
    return this.snapshot();
  }

  async activate(agent: AccountAgentId, credentialId: string): Promise<AgentAccountsSnapshot> {
    const entry = this.entry(agent);
    await this.serialized(entry, async () => {
      const adapter = await this.adapterFor(entry);
      await this.scrubbed([], () => adapter.activate(credentialId));
      await this.changed(entry, { kind: "activated", credential: credentialId });
    });
    return this.snapshot();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const attempt of this.attempts.values()) {
      this.timers.clearTimeout(attempt.expiryTimer);
      this.timers.clearTimeout(attempt.retainTimer);
      if (attempt.attempt.state === "pending") {
        attempt.cancelled = true;
        await attempt.login.cancel().catch(() => undefined);
      }
    }
    this.attempts.clear();
    await Promise.all([...this.entries.values()].map(entry => this.stopRuntime(entry)));
  }

  private entry(agent: AccountAgentId): AgentEntry {
    const entry = this.entries.get(agent);
    if (!entry) throw new AccountOperationError("Unknown agent.");
    return entry;
  }

  private pendingAttempt(attemptId: string): AttemptEntry {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new AttemptNotFoundError();
    if (attempt.attempt.state !== "pending") throw new AccountOperationError("That login has already ended. Start it again.");
    return attempt;
  }

  private hasPendingAttempt(agent: AccountAgentId): boolean {
    return [...this.attempts.values()].some(attempt => attempt.attempt.agent === agent && attempt.attempt.state === "pending");
  }

  private touch(entry: AgentEntry): void {
    this.timers.clearTimeout(entry.idleTimer);
    entry.idleTimer = this.timers.setTimeout(() => void this.idle(entry), this.idleMs);
  }

  private async idle(entry: AgentEntry): Promise<void> {
    entry.idleTimer = null;
    if (this.disposed || !entry.runtime) return;
    if (this.hasPendingAttempt(entry.agent) || entry.starting) {
      this.touch(entry);
      return;
    }
    await this.stopRuntime(entry);
  }

  private async stopRuntime(entry: AgentEntry): Promise<void> {
    this.timers.clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    const runtime = entry.runtime;
    entry.runtime = null;
    entry.adapter = null;
    entry.starting = null;
    entry.refreshedAt = Number.NEGATIVE_INFINITY;
    // The last read stays on show; the next request starts a runtime and re-reads.
    if (entry.status.state === "ready") entry.status = { ...entry.status, state: "idle" };
    await runtime?.stop().catch(() => undefined);
  }

  private ensureStarted(entry: AgentEntry): Promise<void> {
    if (entry.runtime) return entry.starting ?? Promise.resolve();
    const runtime = this.options.runtimes(entry.agent);
    entry.runtime = runtime;
    entry.status = { ...entry.status, state: "starting" };
    entry.starting = (async () => {
      try {
        const started = await runtime.start();
        if (entry.runtime !== runtime) {
          await runtime.stop().catch(() => undefined);
          return;
        }
        if (started.state !== "ready") {
          entry.adapter = null;
          entry.status = { ...initialStatus(entry.agent), state: started.state, message: started.message };
          // Nothing to keep running; the next request tries again.
          entry.runtime = null;
          await runtime.stop().catch(() => undefined);
          return;
        }
        entry.adapter = started.adapter;
        entry.status = {
          ...entry.status,
          ...(started.version ? { version: started.version } : {}),
          ...(started.generation ? { generation: started.generation } : {}),
        };
        await this.refreshNow(entry);
      } catch (error) {
        entry.adapter = null;
        entry.runtime = null;
        entry.status = { ...initialStatus(entry.agent), state: "unavailable", message: agentErrorMessage(error, "The agent did not start.") };
        await runtime.stop().catch(() => undefined);
      } finally {
        if (entry.runtime === runtime || entry.runtime === null) entry.starting = null;
      }
    })();
    return entry.starting;
  }

  private refresh(entry: AgentEntry): Promise<void> {
    entry.refreshing ??= this.refreshNow(entry).finally(() => {
      entry.refreshing = null;
    });
    return entry.refreshing;
  }

  private async refreshNow(entry: AgentEntry): Promise<void> {
    const adapter = entry.adapter;
    if (!adapter) return;
    try {
      const read = await adapter.status();
      if (entry.adapter !== adapter) return;
      entry.refreshedAt = this.now();
      entry.status = {
        ...initialStatus(entry.agent),
        state: "ready",
        ...(entry.status.version ? { version: entry.status.version } : {}),
        ...(entry.status.generation ? { generation: entry.status.generation } : {}),
        capabilities: { ...adapter.capabilities },
        targets: read.targets,
        methods: read.methods,
        ...(read.claude ? { claude: read.claude } : {}),
      };
    } catch (error) {
      if (entry.adapter !== adapter) return;
      // A runtime that stopped answering is restarted by the next request.
      const message = agentErrorMessage(error, "The agent stopped answering.");
      await this.stopRuntime(entry);
      entry.status = { ...entry.status, state: "unavailable", message };
    }
  }

  private async adapterFor(entry: AgentEntry): Promise<AccountAdapter> {
    if (this.disposed) throw new AgentNotReadyError("The Hub is shutting down.");
    this.touch(entry);
    await this.ensureStarted(entry);
    if (!entry.adapter) throw new AgentNotReadyError(entry.status.message ?? `${entry.status.name} is not available.`);
    return entry.adapter;
  }

  /** Runs `operation` after every earlier change for this agent, and holds the next until it ends. */
  private serialized<T>(entry: AgentEntry, operation: () => Promise<T>): Promise<T> {
    const run = entry.changes.then(operation);
    entry.changes = run.then(() => undefined, () => undefined);
    return run;
  }

  private async changed(entry: AgentEntry, change: ChatAccountChange): Promise<void> {
    await this.refresh(entry);
    try {
      await this.options.onChanged?.(entry.agent, change);
    } catch {
      // Workspaces re-read when their agent next starts; a failed notification must not fail the login.
    }
  }

  private async scrubbed<T>(secrets: readonly string[], operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AccountOperationError) {
        throw new AccountOperationError(scrubSecrets(error.message, secrets), error.field);
      }
      throw new AccountOperationError(scrubSecrets(agentErrorMessage(error, "The agent refused the request."), secrets));
    }
  }

  private async cancelEntry(attempt: AttemptEntry): Promise<void> {
    attempt.cancelled = true;
    await attempt.login.cancel().catch(() => undefined);
    this.settle(attempt, "cancelled");
  }

  private async expire(attempt: AttemptEntry): Promise<void> {
    if (attempt.attempt.state !== "pending") return;
    this.settle(attempt, "expired");
    attempt.cancelled = true;
    await attempt.login.cancel().catch(() => undefined);
  }

  private settle(attempt: AttemptEntry, state: Exclude<AccountAttemptState, "pending">, message?: string): void {
    if (attempt.attempt.state !== "pending") return;
    attempt.attempt = { ...attempt.attempt, state, ...(message ? { message } : {}) };
    // The secrets have done their job; nothing keeps them past the attempt.
    attempt.secrets = [];
    this.timers.clearTimeout(attempt.expiryTimer);
    attempt.retainTimer = this.timers.setTimeout(() => {
      if (this.attempts.get(attempt.attempt.id) === attempt) this.attempts.delete(attempt.attempt.id);
    }, this.retainMs);
    const entry = this.entry(attempt.attempt.agent);
    this.touch(entry);
    if (state === "complete") {
      void this.serialized(entry, () => this.changed(entry, { kind: "added" })).finally(() => attempt.resolveSettled());
    } else {
      attempt.resolveSettled();
    }
  }
}
