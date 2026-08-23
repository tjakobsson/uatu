import type { CloneProcess, CloneProcessFactory } from "./clone-process";
import {
  EMPTY_CLONE_CREDENTIAL_RESOLVER,
  type CloneCredentialResolver,
  type ResolvedCloneCredential,
} from "./credential-context";
import type { WorkspaceEntry } from "./registry";
import {
  normalizeAbsolutePath,
  PathReservationCoordinator,
  type PathReservation,
} from "./path-reservations";

export type CloneJobPhase = "cloning" | "registering" | "starting";
export type CloneJobResult =
  | { status: "succeeded"; workspaceId: string; target: string }
  | { status: "clone-failed" | "register-failed" | "start-failed" | "cleanup-failed"; target: string; error: string }
  | { status: "cancelled" | "timed-out"; target: string; reason?: "inactivity" | "lifetime" };

export type CloneJobEvent =
  | { id: number; type: "output"; data: { output: string } }
  | { id: number; type: "phase"; data: { phase: CloneJobPhase } }
  | { id: number; type: "result"; data: CloneJobResult };

type Registry = {
  byPath(target: string): WorkspaceEntry | undefined;
  register(target: string): Promise<WorkspaceEntry>;
  remove(workspaceId: string): Promise<boolean>;
};

// The lifecycle hooks mirror SessionManager: registration and assignment
// rollback must run inside the per-workspace lifecycle queue, or an
// assignment queued during a failing start could commit against a
// registration this job is about to remove.
type Sessions = {
  start(workspaceId: string, onFailure?: () => Promise<void>): Promise<unknown>;
  stop(workspaceId: string, onStopped?: () => Promise<void>): Promise<boolean>;
  runExclusive<T>(workspaceId: string, operation: () => Promise<T>): Promise<T>;
};

export type CloneJobTimer = {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
};

export type CloneJobManagerOptions = {
  processFactory: CloneProcessFactory;
  registry: Registry;
  sessions: Sessions;
  credentials?: CloneCredentialResolver;
  id?: () => string;
  timer?: CloneJobTimer;
  maxReplayBytes?: number;
  maxInputBytes?: number;
  inactivityMs?: number;
  lifetimeMs?: number;
  retentionMs?: number;
  reservations?: PathReservationCoordinator;
};

type Job = {
  id: string;
  owner: string;
  url: string;
  target: string;
  phase: CloneJobPhase;
  process?: CloneProcess;
  events: CloneJobEvent[];
  replayBytes: number;
  nextEventId: number;
  subscribers: Set<(event: CloneJobEvent) => void>;
  result?: CloneJobResult;
  stop?: Extract<CloneJobResult, { status: "cancelled" | "timed-out" }>;
  inactivityTimer?: unknown;
  lifetimeTimer?: unknown;
  expiryTimer?: unknown;
  registered?: WorkspaceEntry;
  credential?: ResolvedCloneCredential;
  sensitiveInputs: string[];
  pendingOutput: string;
  retainAssignment: boolean;
  assigned: boolean;
  done: Promise<void>;
  resolveDone(): void;
  reservation: PathReservation;
};

const defaultTimer: CloneJobTimer = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const SHUTDOWN_CLEANUP_ATTEMPTS = 2;

export class CloneJobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly reservations: PathReservationCoordinator;
  private readonly processFactory: CloneProcessFactory;
  private readonly registry: Registry;
  private readonly sessions: Sessions;
  private readonly credentials: CloneCredentialResolver;
  private readonly makeId: () => string;
  private readonly timer: CloneJobTimer;
  private readonly maxReplayBytes: number;
  private readonly maxInputBytes: number;
  private readonly inactivityMs: number;
  private readonly lifetimeMs: number;
  private readonly retentionMs: number;
  private closed = false;

  constructor(options: CloneJobManagerOptions) {
    this.processFactory = options.processFactory;
    this.registry = options.registry;
    this.sessions = options.sessions;
    this.credentials = options.credentials ?? EMPTY_CLONE_CREDENTIAL_RESOLVER;
    this.makeId = options.id ?? (() => crypto.randomUUID());
    this.timer = options.timer ?? defaultTimer;
    this.maxReplayBytes = options.maxReplayBytes ?? 64 * 1024;
    this.maxInputBytes = options.maxInputBytes ?? 8 * 1024;
    this.inactivityMs = options.inactivityMs ?? 10 * 60_000;
    this.lifetimeMs = options.lifetimeMs ?? 60 * 60_000;
    this.retentionMs = options.retentionMs ?? 5 * 60_000;
    this.reservations = options.reservations ?? new PathReservationCoordinator();
  }

  resolveCredential(url: string, credentialId?: string): Promise<ResolvedCloneCredential | undefined> {
    return this.credentials.resolve(url, credentialId);
  }

  create(
    owner: string,
    url: string,
    target: string,
    options: { credential?: ResolvedCloneCredential; retainAssignment?: boolean } = {},
  ): { jobId: string } {
    if (this.closed) throw new Error("clone job manager is closed");
    const normalizedTarget = normalizeAbsolutePath(target);

    let id: string;
    do id = this.makeId(); while (this.jobs.has(id));
    const reservation = this.reservations.acquire([normalizedTarget]);
    if (!reservation) throw new Error(`clone target is already reserved: ${normalizedTarget}`);
    let resolveDone!: () => void;
    const job: Job = {
      id,
      owner,
      url,
      target: normalizedTarget,
      phase: "cloning",
      credential: options.credential,
      sensitiveInputs: [],
      pendingOutput: "",
      retainAssignment: options.retainAssignment === true,
      assigned: false,
      events: [],
      replayBytes: 0,
      nextEventId: 1,
      subscribers: new Set(),
      done: new Promise(resolve => {
        resolveDone = resolve;
      }),
      resolveDone,
      reservation,
    };
    this.jobs.set(id, job);
    this.emit(job, "phase", { phase: "cloning" });
    job.lifetimeTimer = this.timer.set(() => void this.requestTimeout(job, "lifetime"), this.lifetimeMs);
    this.resetInactivity(job);
    void this.run(job);
    return { jobId: id };
  }

  has(owner: string, jobId: string): boolean {
    return this.owned(owner, jobId) !== undefined;
  }

  isTargetReserved(target: string): boolean {
    return this.reservations.isReserved(target);
  }

  reserveTarget(target: string): PathReservation | undefined {
    return this.reservations.acquire([target]);
  }

  subscribe(owner: string, jobId: string, afterEventId: number, listener: (event: CloneJobEvent) => void): (() => void) | null {
    const job = this.owned(owner, jobId);
    if (!job) return null;
    for (const event of job.events) {
      if (event.id > afterEventId) listener(event);
    }
    if (!job.result) job.subscribers.add(listener);
    return () => job.subscribers.delete(listener);
  }

  input(owner: string, jobId: string, value: string): "accepted" | "not-found" | "inactive" | "too-large" {
    const job = this.owned(owner, jobId);
    if (!job) return "not-found";
    if (job.result || job.stop || job.phase !== "cloning" || !job.process) return "inactive";
    if (new TextEncoder().encode(value).byteLength > this.maxInputBytes) return "too-large";
    const addedSensitiveInput = value !== "" && !job.sensitiveInputs.includes(value);
    if (addedSensitiveInput) job.sensitiveInputs.push(value);
    if (!job.process.writeLine(value)) {
      if (addedSensitiveInput) job.sensitiveInputs.splice(job.sensitiveInputs.indexOf(value), 1);
      return "inactive";
    }
    this.resetInactivity(job);
    return "accepted";
  }

  async cancel(owner: string, jobId: string): Promise<"cancelled" | "cleanup-failed" | "terminal" | "not-found"> {
    const job = this.owned(owner, jobId);
    if (!job) return "not-found";
    if (job.result) return "terminal";
    await this.requestStop(job, { status: "cancelled", target: job.target });
    await job.done;
    const result = this.owned(owner, jobId)?.result;
    return result?.status === "cancelled" ? "cancelled" : result?.status === "cleanup-failed" ? "cleanup-failed" : "terminal";
  }

  async close(): Promise<void> {
    this.closed = true;
    const tracked = [...this.jobs.values()].filter(job => !job.result || job.process);
    const failures = (await Promise.all(tracked.map(async job => {
      if (!job.result) {
        await this.requestStop(job, { status: "cancelled", target: job.target });
        await job.done;
      }
      let terminationError: unknown;
      for (let attempt = 0; job.process && attempt < SHUTDOWN_CLEANUP_ATTEMPTS; attempt += 1) {
        try {
          await this.terminateProcess(job);
        } catch (error) {
          terminationError = error;
          if (attempt + 1 < SHUTDOWN_CLEANUP_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        }
      }
      if (!job.process) job.reservation.release();
      return job.process
        ? new Error(`failed to terminate clone job '${job.id}': ${errorText(terminationError)}`)
        : undefined;
    }))).filter((failure): failure is Error => failure !== undefined);
    if (failures.length > 0) throw new AggregateError(failures, "failed to terminate all clone processes");
  }

  private owned(owner: string, id: string): Job | undefined {
    const job = this.jobs.get(id);
    return job?.owner === owner ? job : undefined;
  }

  // A selected SSH clone uses the managed agent's socket and loaded
  // identity for its whole process lifetime; holding the credential runtime
  // section that long defers an ssh-agent override until the clone exits.
  private withCredentialRuntime<T>(job: Job, operation: () => Promise<T>): Promise<T> {
    return job.credential?.process.type === "ssh" ? this.credentials.runExclusive(operation) : operation();
  }

  private async run(job: Job): Promise<void> {
    try {
      let exitCode: number;
      try {
        exitCode = await this.withCredentialRuntime(job, async () => {
          if (job.credential?.process.type === "ssh") {
            // Re-resolved inside the gate: a replacement pending at request
            // time may have retired the socket the request-time resolution
            // captured, and the nested usability check would then load the
            // key into the new agent while this context kept the old one.
            const fresh = await this.credentials.resolve(job.url, job.credential.credentialId);
            if (!fresh) throw new Error(`selected credential is no longer available: ${job.credential.credentialId}`);
            job.credential = fresh;
          }
          job.process = this.processFactory.start({
            url: job.url,
            target: job.target,
            credential: job.credential?.process,
            onOutput: output => {
              if (!job.result) {
                const safe = this.filterOutput(job, output);
                if (safe !== "") this.emit(job, "output", { output: safe });
                this.resetInactivity(job);
              }
            },
          });
          return job.process.exited;
        });
      } catch (error) {
        await this.finish(job, { status: "clone-failed", target: job.target, error: errorText(error) });
        return;
      }
      this.clearTimer(job.inactivityTimer);
      job.inactivityTimer = undefined;
      this.flushOutput(job);
      if (job.stop) {
        await this.finish(job, job.stop);
        return;
      }
      if (exitCode !== 0) {
        await this.finish(job, job.stop ?? { status: "clone-failed", target: job.target, error: `git clone exited ${exitCode}` });
        return;
      }
      await this.terminateProcess(job);
      if (job.stop) {
        await this.finish(job, job.stop);
        return;
      }

      this.setPhase(job, "registering");
      if (this.registry.byPath(job.target)) {
        await this.finish(job, {
          status: "register-failed",
          target: job.target,
          error: `workspace is already registered: ${job.target}`,
        });
        return;
      }
      try {
        job.registered = await this.registry.register(job.target);
      } catch (error) {
        await this.finish(job, job.stop ?? { status: "register-failed", target: job.target, error: errorText(error) });
        return;
      }
      if (job.stop) {
        await this.finishAfterRollback(job, job.registered);
        return;
      }

      if (job.credential && job.retainAssignment) {
        try {
          await this.sessions.runExclusive(job.registered.id, () =>
            this.credentials.assign(job.registered!.id, job.credential!));
          job.assigned = true;
        } catch (error) {
          const rollbackError = await this.rollback(job, job.registered);
          const detail = rollbackError ? `${errorText(error)}; registration rollback failed: ${rollbackError}` : errorText(error);
          await this.finish(job, rollbackError
            ? { status: "cleanup-failed", target: job.target, error: detail }
            : { status: "register-failed", target: job.target, error: detail });
          return;
        }
      }
      if (job.stop) {
        await this.finishAfterRollback(job, job.registered);
        return;
      }

      this.setPhase(job, "starting");
      // undefined = the lifecycle hook never ran and the rollback still must.
      let hookRollbackError: string | null | undefined;
      try {
        await this.sessions.start(job.registered.id, async () => {
          hookRollbackError = await this.rollbackWithinLifecycle(job, job.registered!);
        });
      } catch (error) {
        const rollbackError = hookRollbackError === undefined
          ? await this.rollback(job, job.registered)
          : hookRollbackError;
        if (job.stop) {
          await this.finish(job, rollbackError ? this.rollbackFailure(job, rollbackError) : job.stop);
          return;
        }
        const detail = rollbackError ? `${errorText(error)}; registration rollback failed: ${rollbackError}` : errorText(error);
        await this.finish(job, { status: "start-failed", target: job.target, error: detail });
        return;
      }
      if (job.stop) {
        try {
          await this.sessions.stop(job.registered.id, async () => {
            hookRollbackError = await this.rollbackWithinLifecycle(job, job.registered!);
          });
        } catch (error) {
          await this.finish(job, {
            status: "cleanup-failed",
            target: job.target,
            error: `clone cancellation could not stop the started session: ${errorText(error)}`,
          });
          return;
        }
        const rollbackError = hookRollbackError === undefined
          ? await this.rollback(job, job.registered)
          : hookRollbackError;
        await this.finish(job, rollbackError ? this.rollbackFailure(job, rollbackError) : job.stop);
        return;
      }
      await this.finish(job, { status: "succeeded", workspaceId: job.registered.id, target: job.target });
    } catch (error) {
      if (job.process) await this.terminateProcess(job).catch(() => undefined);
      await this.finish(job, { status: "clone-failed", target: job.target, error: errorText(error) });
    }
  }

  private requestTimeout(job: Job, reason: "inactivity" | "lifetime"): Promise<void> {
    return this.requestStop(job, { status: "timed-out", target: job.target, reason });
  }

  private async requestStop(job: Job, result: Extract<CloneJobResult, { status: "cancelled" | "timed-out" }>): Promise<void> {
    if (job.result || job.stop) return;
    job.stop = result;
    if (job.process) {
      try {
        await this.terminateProcess(job);
      } catch (error) {
        await this.finish(job, {
          status: "cleanup-failed",
          target: job.target,
          error: `clone process cleanup failed: ${errorText(error)}`,
        });
      }
    }
  }

  private async finish(job: Job, result: CloneJobResult): Promise<void> {
    if (job.result) return;
    this.flushOutput(job);
    if (job.process && result.status !== "succeeded" && result.status !== "cleanup-failed") {
      try {
        await this.terminateProcess(job);
      } catch (error) {
        result = {
          status: "cleanup-failed",
          target: job.target,
          error: `clone process cleanup failed: ${errorText(error)}`,
        };
      }
    }
    if (job.stop && result.status !== "cleanup-failed") result = job.stop;
    job.result = result;
    this.clearTimer(job.inactivityTimer);
    this.clearTimer(job.lifetimeTimer);
    // Only a retained process can still be operating on the clone target.
    // Registry and session cleanup failures remain represented by their own
    // managers and must not permanently poison this in-memory reservation.
    if (!job.process) job.reservation.release();
    this.emit(job, "result", result);
    job.subscribers.clear();
    job.url = "";
    job.credential = undefined;
    job.sensitiveInputs.length = 0;
    job.pendingOutput = "";
    job.resolveDone();
    job.expiryTimer = this.timer.set(() => {
      if (job.process) return;
      this.jobs.delete(job.id);
      job.events.length = 0;
    }, this.retentionMs);
  }

  private async terminateProcess(job: Job): Promise<void> {
    const process = job.process;
    if (!process) return;
    await process.terminate();
    if (job.process === process) job.process = undefined;
  }

  private setPhase(job: Job, phase: CloneJobPhase): void {
    job.phase = phase;
    this.emit(job, "phase", { phase });
  }

  // Queues the rollback as its own lifecycle operation. Callers already
  // inside a lifecycle hook use rollbackWithinLifecycle directly — queueing
  // from there would deadlock behind the operation they are part of.
  private rollback(job: Job, entry: WorkspaceEntry): Promise<string | null> {
    return this.sessions.runExclusive(entry.id, () => this.rollbackWithinLifecycle(job, entry));
  }

  private async rollbackWithinLifecycle(job: Job, entry: WorkspaceEntry): Promise<string | null> {
    let unassigned = false;
    try {
      if (job.assigned && job.credential) {
        await this.credentials.unassign(entry.id, job.credential);
        job.assigned = false;
        unassigned = true;
      }
      if (!(await this.registry.remove(entry.id))) throw new Error("workspace registration was not removed");
      return null;
    } catch (error) {
      if (unassigned && job.credential) {
        try {
          await this.credentials.assign(entry.id, job.credential);
          job.assigned = true;
        } catch (restoreError) {
          return `${errorText(error)}; credential assignment restoration failed: ${errorText(restoreError)}`;
        }
      }
      return errorText(error);
    }
  }

  private async finishAfterRollback(job: Job, entry: WorkspaceEntry): Promise<void> {
    const rollbackError = await this.rollback(job, entry);
    await this.finish(job, rollbackError ? this.rollbackFailure(job, rollbackError) : job.stop!);
  }

  private rollbackFailure(job: Job, error: string): CloneJobResult {
    return {
      status: "cleanup-failed",
      target: job.target,
      error: `clone cancellation could not remove the workspace registration: ${error}`,
    };
  }

  private emit(job: Job, type: "output", data: { output: string }): void;
  private emit(job: Job, type: "phase", data: { phase: CloneJobPhase }): void;
  private emit(job: Job, type: "result", data: CloneJobResult): void;
  private emit(job: Job, type: CloneJobEvent["type"], data: CloneJobEvent["data"]): void {
    const event = { id: job.nextEventId++, type, data } as CloneJobEvent;
    for (const subscriber of job.subscribers) subscriber(event);
    if (event.type === "output") {
      const retained = tailByBytes(event.data.output, this.maxReplayBytes);
      if (retained === "") return;
      const replayEvent: CloneJobEvent = { ...event, data: { output: retained } };
      job.replayBytes += new TextEncoder().encode(retained).byteLength;
      job.events.push(replayEvent);
    } else {
      job.events.push(event);
    }
    while (job.replayBytes > this.maxReplayBytes) {
      const index = job.events.findIndex(candidate => candidate.type === "output");
      if (index < 0) break;
      const [removed] = job.events.splice(index, 1);
      if (removed.type === "output") job.replayBytes -= new TextEncoder().encode(removed.data.output).byteLength;
    }
  }

  private resetInactivity(job: Job): void {
    if (job.result || job.stop || job.phase !== "cloning") return;
    this.clearTimer(job.inactivityTimer);
    job.inactivityTimer = this.timer.set(() => void this.requestTimeout(job, "inactivity"), this.inactivityMs);
  }

  private filterOutput(job: Job, chunk: string, final = false): string {
    let value = job.pendingOutput + chunk;
    job.pendingOutput = "";
    for (const secret of job.sensitiveInputs) {
      while (value.includes(secret)) value = value.replaceAll(secret, "");
    }
    if (value === "") return value;

    let held = 0;
    for (const secret of job.sensitiveInputs) {
      const maximum = Math.min(secret.length - 1, value.length);
      for (let length = maximum; length > held; length -= 1) {
        if (value.endsWith(secret.slice(0, length))) {
          held = length;
          break;
        }
      }
    }
    if (held > 0) {
      if (!final) job.pendingOutput = value.slice(-held);
      return value.slice(0, -held);
    }
    return value;
  }

  private flushOutput(job: Job): void {
    const safe = this.filterOutput(job, "", true);
    if (safe !== "") this.emit(job, "output", { output: safe });
  }

  private clearTimer(handle: unknown): void {
    if (handle !== undefined) this.timer.clear(handle);
  }
}

function tailByBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(encoded.slice(encoded.byteLength - maxBytes)).replace(/^\uFFFD+/, "");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
