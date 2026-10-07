import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { classifyFile, classifyFileName } from "../document/classify";
import type { DiscoveryState, DocumentRoot, RevisionedDocument, RevisionedRoot } from "../shared/document-updates";
import type { IgnoreMatcher } from "../ignore/engine";
import type { WatchEntry } from "./roots";
import { NewestDocument } from "./newest-document";
import { createWatchPolicy, rootRelative } from "./watch-policy";
import { createRefreshScheduler, type RefreshSchedulerClock } from "./refresh-scheduler";

type Job = { id: string; stats?: Stats; order: number; live: boolean; attempts: number };
export type FileIndexBatch = {
  upserts: RevisionedDocument[];
  removals: { rootId: string; id: string }[];
  changedId: string | null;
  changedOrder: number;
  discovery: DiscoveryState;
};
export type FileIndexOptions = {
  revision: () => number;
  publish: (batch: FileIndexBatch) => void;
  classify?: typeof classifyFile;
  stat?: (id: string) => Promise<Stats>;
  concurrency?: number;
  clock?: RefreshSchedulerClock;
  onWork?: (kind: "stat" | "classify" | "batch") => void;
};

export class FileIndex {
  readonly policy: ReturnType<typeof createWatchPolicy>;
  readonly documents = new Map<string, RevisionedDocument>();
  readonly newest = new NewestDocument();
  private directories = new Map<string, Set<string>>();
  private jobs = new Map<string, Job>();
  private requested = new Set<string>();
  private current = new Map<string, number>();
  private pending = new Map<string, { doc: RevisionedDocument | null; live: boolean; order: number }>();
  private active = 0;
  private ready = false;
  private initialComplete = false;
  private initialPublished = false;
  private stopped = false;
  private error: string | undefined;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduler: ReturnType<typeof createRefreshScheduler>;
  private waiters: (() => void)[] = [];
  private publicationWaiters: (() => void)[] = [];
  private pathWaiters = new Map<string, (() => void)[]>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(readonly entry: WatchEntry, matcher: IgnoreMatcher, private options: FileIndexOptions) {
    this.policy = createWatchPolicy(entry, matcher);
    this.scheduler = createRefreshScheduler(() => this.flush(), options.clock);
  }

  get discovery(): DiscoveryState {
    return {
      status: this.error ? "error" : this.initialComplete && (this.initialPublished || this.pending.size === 0) ? "ready" : "indexing",
      discovered: this.documents.size,
      ...(this.error ? { message: this.error } : {}),
    };
  }
  get hasPendingChanges(): boolean { return this.pending.size > 0; }

  metadata(): DocumentRoot {
    return { id: this.entry.absolutePath, path: this.entry.kind === "dir" ? this.entry.absolutePath : this.entry.parentDir,
      label: path.basename(this.entry.absolutePath) || this.entry.absolutePath, hiddenCount: this.policy.hidden.size };
  }

  snapshot(): RevisionedRoot {
    return { ...this.metadata(), docs: [...this.documents.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)) };
  }

  observe(event: string, id: string, stats?: Stats, priority = false): void {
    if (this.stopped) return;
    id = path.resolve(id);
    if (rootRelative(this.entry, id) === null) return;
    if (event === "addDir") return;
    const order = this.options.revision();
    if (event === "unlinkDir") {
      // The membership map includes in-flight files, so a late classifier
      // cannot resurrect a descendant removed with its parent directory.
      for (const child of [...(this.directories.get(id) ?? [])]) this.remove(child, order);
      return;
    }
    if (event === "unlink" || !this.policy.accepts(id, stats)) {
      this.remove(id, order);
      return;
    }
    if (event !== "add" && event !== "change") return;
    this.cancelRetry(id);
    this.current.set(id, order);
    const job: Job = { id, stats, order, live: !priority && (event === "change" || this.ready), attempts: 0 };
    this.track(id, true);
    if (priority && stats && classifyFileName(path.basename(id)) !== null) {
      this.run(job);
      return;
    }
    this.jobs.set(id, job);
    if (priority) this.requested.add(id);
    this.pump();
  }

  markReady(): void {
    this.ready = true;
    this.schedule();
    this.settle();
  }

  fail(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.schedule();
  }

  async idle(): Promise<void> {
    if (this.active || this.jobs.size || this.retryTimers.size) await new Promise<void>(resolve => this.waiters.push(resolve));
    this.flush();
    if (this.pending.size) await new Promise<void>(resolve => this.publicationWaiters.push(resolve));
  }
  async settled(id: string): Promise<void> {
    if (this.current.has(id)) await new Promise<void>(resolve => {
      const waiting = this.pathWaiters.get(id) ?? [];
      waiting.push(resolve); this.pathWaiters.set(id, waiting);
    });
    this.flush(id);
  }

  async request(id: string, stats: Stats): Promise<void> {
    const queued = this.jobs.get(id);
    if (queued && classifyFileName(path.basename(id)) !== null) {
      this.jobs.delete(id); this.requested.delete(id);
      this.run({ ...queued, stats: queued.stats ?? stats });
    } else if (queued) this.requested.add(id);
    else if (!this.current.has(id) && !this.pending.get(id)?.doc) this.observe("add", id, stats, true);
    await this.settled(id);
  }

  flush(preferredId?: string): void {
    this.scheduler.cancel();
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    if (this.stopped) return;
    const upserts: RevisionedDocument[] = [];
    const removals: { rootId: string; id: string }[] = [];
    let changedId: string | null = null;
    let changedOrder = 0;
    const pending = this.pending;
    const entries = function* () {
      const preferred = preferredId ? pending.get(preferredId) : undefined;
      if (preferred && preferredId) yield [preferredId, preferred] as const;
      yield* pending;
    };
    for (const [id, value] of entries()) {
      this.pending.delete(id);
      if (value.doc) {
        this.documents.set(id, value.doc);
        this.newest.update(value.doc);
        upserts.push(value.doc);
        if (value.live && value.doc.kind !== "binary" && value.order > changedOrder) {
          changedId = id;
          changedOrder = value.order;
        }
      } else {
        this.documents.delete(id);
        this.newest.remove(id);
        removals.push({ rootId: this.entry.absolutePath, id });
      }
      if (upserts.length + removals.length >= 256) break;
    }
    if (!this.pending.size && this.initialComplete) this.initialPublished = true;
    this.options.onWork?.("batch");
    this.options.publish({ upserts, removals, changedId, changedOrder, discovery: this.discovery });
    if (this.pending.size) this.drainTimer = setTimeout(() => this.flush(), 0);
    else for (const resolve of this.publicationWaiters.splice(0)) resolve();
  }

  stop(): void {
    this.stopped = true;
    this.scheduler.cancel();
    if (this.drainTimer) clearTimeout(this.drainTimer);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.jobs.clear();
    this.requested.clear();
    this.pending.clear();
    this.current.clear();
    for (const resolve of this.waiters.splice(0)) resolve();
    for (const resolve of this.publicationWaiters.splice(0)) resolve();
    for (const waiting of this.pathWaiters.values()) for (const resolve of waiting) resolve();
    this.pathWaiters.clear();
  }

  private track(id: string, add: boolean): void {
    const rootPath = this.entry.kind === "dir" ? this.entry.absolutePath : this.entry.parentDir;
    for (let parent = path.dirname(id); ; parent = path.dirname(parent)) {
      if (add) {
        let members = this.directories.get(parent);
        if (!members) this.directories.set(parent, members = new Set());
        members.add(id);
      } else {
        const members = this.directories.get(parent);
        members?.delete(id);
        if (members?.size === 0) this.directories.delete(parent);
      }
      if (parent === rootPath || path.dirname(parent) === parent) break;
    }
  }

  private remove(id: string, order: number): void {
    this.current.delete(id);
    this.cancelRetry(id);
    this.jobs.delete(id);
    this.requested.delete(id);
    this.track(id, false);
    if (this.documents.has(id) || this.pending.get(id)?.doc) {
      this.pending.set(id, { doc: null, order, live: false });
      this.schedule();
    }
    this.settle();
  }

  private pump(): void {
    while (!this.stopped && this.active < (this.options.concurrency ?? 8) && this.jobs.size) {
      const requested = this.requested.values().next().value;
      const id = requested ?? this.jobs.keys().next().value!;
      const job = this.jobs.get(id);
      this.requested.delete(id);
      this.jobs.delete(id);
      if (!job || this.current.get(id) !== job.order) continue;
      this.run(job);
    }
  }

  private run(job: Job): void {
    this.active++;
    void this.process(job).finally(() => {
      this.active--;
      if (this.current.get(job.id) === job.order && !this.retryTimers.has(job.id)) this.current.delete(job.id);
      this.pump();
      this.settle();
    });
  }

  private async process(job: Job): Promise<void> {
    try {
      if (!job.stats) this.options.onWork?.("stat");
      const stats = job.stats ?? await (this.options.stat ?? lstat)(job.id) as Stats;
      const valid = () => !this.stopped && this.current.get(job.id) === job.order;
      if (!valid()) return;
      if (!stats.isFile() || !this.policy.accepts(job.id, stats)) { this.remove(job.id, job.order); return; }
      const name = path.basename(job.id);
      this.options.onWork?.("classify");
      const kind = classifyFileName(name) ?? await (this.options.classify ?? classifyFile)(job.id, name);
      if (!valid()) return;
      const doc: RevisionedDocument = {
        id: job.id, rootId: this.entry.absolutePath, name, relativePath: rootRelative(this.entry, job.id)!,
        mtimeMs: stats.mtimeMs, kind, revision: job.order,
      };
      this.pending.set(job.id, { doc, live: job.live, order: job.order });
      this.schedule();
    } catch (error) {
      if (this.stopped || this.current.get(job.id) !== job.order) return;
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) this.remove(job.id, job.order);
      else if (job.attempts < 2) {
        // Retain the job's generation while its retry is outstanding.
        const retry = { ...job, stats: undefined, attempts: job.attempts + 1 };
        const timer = setTimeout(() => {
          this.retryTimers.delete(job.id);
          if (!this.stopped && this.current.get(job.id) === job.order) {
            this.jobs.set(job.id, retry);
            this.pump();
          }
          this.settle();
        }, 100 * retry.attempts);
        this.retryTimers.set(job.id, timer);
      } else this.fail(error);
    }
  }

  private schedule(): void {
    this.scheduler.schedule();
  }

  private settle(): void {
    for (const [id, waiting] of this.pathWaiters) {
      if (this.current.has(id)) continue;
      this.pathWaiters.delete(id);
      for (const resolve of waiting) resolve();
    }
    if (this.active || this.jobs.size || this.retryTimers.size) return;
    if (this.ready && !this.initialComplete) {
      this.initialComplete = true;
      if (!this.stopped) this.schedule();
    }
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private cancelRetry(id: string): void {
    const timer = this.retryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(id);
  }
}
