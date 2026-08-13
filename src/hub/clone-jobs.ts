import path from "node:path";

import type { CloneProcess, CloneProcessFactory } from "./clone-process";
import type { WorkspaceEntry } from "./registry";

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

type Sessions = {
  start(workspaceId: string): Promise<unknown>;
  stop(workspaceId: string): Promise<boolean>;
};

export type CloneJobTimer = {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
};

export type CloneJobManagerOptions = {
  processFactory: CloneProcessFactory;
  registry: Registry;
  sessions: Sessions;
  id?: () => string;
  timer?: CloneJobTimer;
  maxReplayBytes?: number;
  maxInputBytes?: number;
  inactivityMs?: number;
  lifetimeMs?: number;
  retentionMs?: number;
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
  done: Promise<void>;
  resolveDone(): void;
};

const defaultTimer: CloneJobTimer = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CloneJobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly reservations = new Map<string, string>();
  private readonly processFactory: CloneProcessFactory;
  private readonly registry: Registry;
  private readonly sessions: Sessions;
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
    this.makeId = options.id ?? (() => crypto.randomUUID());
    this.timer = options.timer ?? defaultTimer;
    this.maxReplayBytes = options.maxReplayBytes ?? 64 * 1024;
    this.maxInputBytes = options.maxInputBytes ?? 8 * 1024;
    this.inactivityMs = options.inactivityMs ?? 10 * 60_000;
    this.lifetimeMs = options.lifetimeMs ?? 60 * 60_000;
    this.retentionMs = options.retentionMs ?? 5 * 60_000;
  }

  create(owner: string, url: string, target: string): { jobId: string } {
    if (this.closed) throw new Error("clone job manager is closed");
    const normalizedTarget = path.normalize(path.resolve(target));
    if (this.reservations.has(normalizedTarget)) throw new Error(`clone target is already reserved: ${normalizedTarget}`);

    let id: string;
    do id = this.makeId(); while (this.jobs.has(id));
    let resolveDone!: () => void;
    const job: Job = {
      id,
      owner,
      url,
      target: normalizedTarget,
      phase: "cloning",
      events: [],
      replayBytes: 0,
      nextEventId: 1,
      subscribers: new Set(),
      done: new Promise(resolve => {
        resolveDone = resolve;
      }),
      resolveDone,
    };
    this.jobs.set(id, job);
    this.reservations.set(normalizedTarget, id);
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
    return this.reservations.has(path.normalize(path.resolve(target)));
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
    if (!job.process.writeLine(value)) return "inactive";
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
    const active = [...this.jobs.values()].filter(job => !job.result);
    await Promise.all(active.map(async job => {
      await this.requestStop(job, { status: "cancelled", target: job.target });
      await job.done;
    }));
  }

  private owned(owner: string, id: string): Job | undefined {
    const job = this.jobs.get(id);
    return job?.owner === owner ? job : undefined;
  }

  private async run(job: Job): Promise<void> {
    try {
      try {
        job.process = this.processFactory.start({
          url: job.url,
          target: job.target,
          onOutput: output => {
            if (!job.result) {
              this.emit(job, "output", { output });
              this.resetInactivity(job);
            }
          },
        });
      } catch (error) {
        await this.finish(job, { status: "clone-failed", target: job.target, error: errorText(error) });
        return;
      }

      const exitCode = await job.process.exited;
      this.clearTimer(job.inactivityTimer);
      job.inactivityTimer = undefined;
      if (job.stop) {
        await this.finish(job, job.stop);
        return;
      }
      if (exitCode !== 0) {
        await this.finish(job, job.stop ?? { status: "clone-failed", target: job.target, error: `git clone exited ${exitCode}` });
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

      this.setPhase(job, "starting");
      try {
        await this.sessions.start(job.registered.id);
      } catch (error) {
        const rollbackError = await this.rollback(job.registered);
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
          await this.sessions.stop(job.registered.id);
        } catch (error) {
          await this.finish(job, {
            status: "cleanup-failed",
            target: job.target,
            error: `clone cancellation could not stop the started session: ${errorText(error)}`,
          });
          return;
        }
        await this.finishAfterRollback(job, job.registered);
        return;
      }
      await this.finish(job, { status: "succeeded", workspaceId: job.registered.id, target: job.target });
    } catch (error) {
      if (job.process) await job.process.terminate().catch(() => undefined);
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
        await job.process.terminate();
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
    if (job.process && result.status !== "succeeded" && result.status !== "cleanup-failed") {
      try {
        await job.process.terminate();
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
    // A failed cleanup can leave a process or session still using the target.
    // Keep it reserved rather than allowing a second clone to overlap it.
    if (result.status !== "cleanup-failed") this.reservations.delete(job.target);
    this.emit(job, "result", result);
    job.subscribers.clear();
    job.process = undefined;
    job.url = "";
    job.resolveDone();
    job.expiryTimer = this.timer.set(() => {
      this.jobs.delete(job.id);
      job.events.length = 0;
    }, this.retentionMs);
  }

  private setPhase(job: Job, phase: CloneJobPhase): void {
    job.phase = phase;
    this.emit(job, "phase", { phase });
  }

  private async rollback(entry: WorkspaceEntry): Promise<string | null> {
    try {
      await this.registry.remove(entry.id);
      return null;
    } catch (error) {
      return errorText(error);
    }
  }

  private async finishAfterRollback(job: Job, entry: WorkspaceEntry): Promise<void> {
    const rollbackError = await this.rollback(entry);
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
