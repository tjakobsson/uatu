// Git-based worktree reconciliation (task 5.1).
//
// The authoritative inventory is whatever `git worktree list` says right now
// (worktree-service.ts reads it). This module decides WHEN to read it and
// whom to tell when it changed:
//
//   open      the picker or a Hub view asked for the inventory — the user
//             is waiting for this answer
//   subscribe a page attached to the `worktrees` topic (page load, reconnect)
//   activity  a session started/stopped or an agent's observed activity
//             changed — an agent or a terminal may have run `git worktree`
//   manual    the user pressed Refresh
//   periodic  a bounded cadence, only while some visible page is interested
//
// Everything is coalesced per source workspace (one main checkout per
// repository, so this is per repository): one read at a time, and a request
// made while one runs is folded into ONE trailing read. `subscribe`,
// `activity` and `periodic` are additionally rate-limited — a burst of them
// inside the minimum interval becomes a single read at the interval
// boundary. `open` and `manual` have a user waiting on them and are never
// delayed beyond an in-flight read.
//
// What reconciliation never does: register a discovered tree, recreate a
// missing one, forget a replaced one, change provenance, or switch anybody's
// workspace. It reads, compares, and — only when the inventory's observable
// state changed — publishes a content-free invalidation.

import type { WorktreeCheckout, WorktreeInventory } from "../shared/worktree-contract";

export type WorktreeReconcileReason = "open" | "subscribe" | "activity" | "manual" | "periodic";

export type WorktreeReconcilerTimers = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const WORKTREE_RECONCILE_MIN_INTERVAL_MS = 5_000;
export const WORKTREE_RECONCILE_PERIOD_MS = 60_000;

export type WorktreeReconcilerOptions = {
  // The authoritative read. Never throws for an unidentifiable repository —
  // the service answers an explicitly stale "identity unknown" listing.
  inventory(sourceWorkspaceId: string): Promise<WorktreeInventory>;
  // Maps any workspace (a child, a main checkout) to the source workspace
  // whose repository it belongs to; undefined when it is not registered.
  sourceFor(workspaceId: string): string | undefined;
  // The inventory's observable state changed since the last read.
  onChange(sourceWorkspaceId: string, inventory: WorktreeInventory): void;
  minIntervalMs?: number;
  periodMs?: number;
  now?: () => number;
  timers?: WorktreeReconcilerTimers;
  // A read that throws is reported here and otherwise ignored: the next
  // trigger simply tries again.
  onError?: (error: unknown) => void;
};

type Slot = {
  running: Promise<WorktreeInventory> | null;
  // A request arrived while `running` was in flight: one trailing read.
  trailing: Promise<WorktreeInventory> | null;
  scheduled: {
    handle: unknown;
    promise: Promise<WorktreeInventory>;
    settle(outcome: Promise<WorktreeInventory>): void;
  } | null;
  lastStartedAt: number | null;
  fingerprint: string | null;
  interest: number;
};

// Only what a user can observe in the picker or dashboard. The order of
// `git worktree list` is not a change; neither is a refs listing the service
// re-reads on every call.
export function worktreeInventoryFingerprint(inventory: WorktreeInventory): string {
  const checkout = (entry: WorktreeCheckout) => [
    entry.checkoutId, entry.workspaceId ?? "", entry.parentWorkspaceId ?? "", entry.path, entry.branch ?? "",
    entry.detached, entry.main, entry.ownership, entry.availability, entry.registered, entry.running,
    entry.locked, entry.sourceRef ?? "",
  ];
  return JSON.stringify([
    inventory.repositoryId,
    inventory.status,
    inventory.error?.code ?? "",
    [...inventory.checkouts].map(checkout).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}

export class WorktreeReconciler {
  private readonly slots = new Map<string, Slot>();
  private readonly minIntervalMs: number;
  private readonly periodMs: number;
  private readonly now: () => number;
  private readonly timers: WorktreeReconcilerTimers;
  private periodic: unknown = null;
  private disposed = false;

  constructor(private readonly options: WorktreeReconcilerOptions) {
    this.minIntervalMs = options.minIntervalMs ?? WORKTREE_RECONCILE_MIN_INTERVAL_MS;
    this.periodMs = options.periodMs ?? WORKTREE_RECONCILE_PERIOD_MS;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? {
      setTimeout: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        if (typeof handle.unref === "function") handle.unref();
        return handle;
      },
      clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  private slot(source: string): Slot {
    let slot = this.slots.get(source);
    if (!slot) {
      slot = { running: null, trailing: null, scheduled: null, lastStartedAt: null, fingerprint: null, interest: 0 };
      this.slots.set(source, slot);
    }
    return slot;
  }

  // Asks for a reconciliation of the repository `workspaceId` belongs to.
  // Resolves with the inventory that satisfied it, or undefined for a
  // workspace that is not registered.
  request(workspaceId: string, reason: WorktreeReconcileReason): Promise<WorktreeInventory | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    const source = this.options.sourceFor(workspaceId);
    if (source === undefined) return Promise.resolve(undefined);
    const slot = this.slot(source);
    if (slot.running) {
      // Folded into one trailing read after the one in flight: whatever
      // happened meanwhile is seen, and N requests cost one read.
      slot.trailing ??= slot.running.then(() => undefined, () => undefined).then(() => {
        slot.trailing = null;
        return this.run(source, slot);
      });
      return slot.trailing;
    }
    if (reason === "manual" || reason === "open") {
      // A read somebody is waiting for satisfies a read that was waiting for the interval
      // boundary too: its waiters get this read rather than being dropped.
      const waiting = slot.scheduled;
      this.cancelScheduled(slot);
      const read = this.run(source, slot);
      waiting?.settle(read);
      return read;
    }
    const since = slot.lastStartedAt === null ? Infinity : this.now() - slot.lastStartedAt;
    if (since >= this.minIntervalMs && !slot.scheduled) return this.run(source, slot);
    if (slot.scheduled) return slot.scheduled.promise;
    // Inside the minimum interval: one read at the boundary, shared by every
    // request that arrives before it.
    let resolve!: (value: WorktreeInventory) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<WorktreeInventory>((ok, fail) => { resolve = ok; reject = fail; });
    const settle = (outcome: Promise<WorktreeInventory>) => { outcome.then(resolve, reject); };
    const handle = this.timers.setTimeout(() => {
      slot.scheduled = null;
      if (this.disposed) return;
      if (slot.running) {
        slot.trailing ??= slot.running.then(() => undefined, () => undefined).then(() => {
          slot.trailing = null;
          return this.run(source, slot);
        });
        settle(slot.trailing);
      } else settle(this.run(source, slot));
    }, this.minIntervalMs - since);
    slot.scheduled = { handle, promise, settle };
    // An unobserved scheduled read must not surface as an unhandled rejection.
    promise.catch(() => undefined);
    return promise;
  }

  private cancelScheduled(slot: Slot): void {
    if (!slot.scheduled) return;
    this.timers.clearTimeout(slot.scheduled.handle);
    slot.scheduled = null;
  }

  // A read that updates the baseline WITHOUT announcing a change: used right
  // after a committed Uatu operation, which has already invalidated every
  // interested page itself.
  async rebaseline(workspaceId: string): Promise<WorktreeInventory | undefined> {
    if (this.disposed) return undefined;
    const source = this.options.sourceFor(workspaceId);
    if (source === undefined) return undefined;
    const slot = this.slot(source);
    if (slot.running) await slot.running.catch(() => undefined);
    return this.run(source, slot, false);
  }

  private run(source: string, slot: Slot, announce = true): Promise<WorktreeInventory> {
    slot.lastStartedAt = this.now();
    const token = {};
    let current: object | null = token;
    const running = (async () => {
      try {
        const inventory = await this.options.inventory(source);
        const fingerprint = worktreeInventoryFingerprint(inventory);
        const previous = slot.fingerprint;
        slot.fingerprint = fingerprint;
        // The first read establishes the baseline: every interested page was
        // already told to fetch when it attached.
        if (announce && previous !== null && previous !== fingerprint && !this.disposed) {
          try {
            this.options.onChange(source, inventory);
          } catch (error) {
            this.options.onError?.(error);
          }
        }
        return inventory;
      } finally {
        // Cleared before the caller resumes, so a request made right after
        // this read settled is not mistaken for one that raced it.
        if (current === token) slot.running = null;
        current = null;
      }
    })();
    if (current === token) slot.running = running;
    running.catch(error => this.options.onError?.(error));
    return running;
  }

  // Slots are bounded by the registered source workspaces (sourceFor never
  // names anything else); a source that stops being registered is dropped
  // explicitly, so a forgotten repository leaves nothing behind.
  forgetSource(sourceWorkspaceId: string): void {
    const slot = this.slots.get(sourceWorkspaceId);
    if (!slot) return;
    this.cancelScheduled(slot);
    this.slots.delete(sourceWorkspaceId);
    if (!this.interested().length) this.disarmPeriodic();
  }

  // A visible page subscribed to this workspace's worktree topic. The
  // periodic cadence runs only while at least one such interest exists.
  retain(workspaceId: string): () => void {
    const source = this.options.sourceFor(workspaceId);
    if (source === undefined || this.disposed) return () => undefined;
    const slot = this.slot(source);
    slot.interest += 1;
    this.armPeriodic();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      slot.interest -= 1;
      if (slot.interest < 0) slot.interest = 0;
      if (![...this.slots.values()].some(candidate => candidate.interest > 0)) this.disarmPeriodic();
    };
  }

  interested(): string[] {
    return [...this.slots.entries()].filter(([, slot]) => slot.interest > 0).map(([source]) => source);
  }

  private armPeriodic(): void {
    if (this.periodic !== null || this.disposed) return;
    this.periodic = this.timers.setTimeout(() => {
      this.periodic = null;
      const sources = this.interested();
      for (const source of sources) void this.request(source, "periodic").catch(() => undefined);
      if (sources.length > 0) this.armPeriodic();
    }, this.periodMs);
  }

  private disarmPeriodic(): void {
    if (this.periodic === null) return;
    this.timers.clearTimeout(this.periodic);
    this.periodic = null;
  }

  // The last fingerprint for a source — lets a caller that read the
  // inventory itself (a committed operation) update the baseline so the
  // next reconciliation does not report the same change twice.
  observe(sourceWorkspaceId: string, inventory: WorktreeInventory): void {
    const slot = this.slots.get(sourceWorkspaceId);
    if (slot) slot.fingerprint = worktreeInventoryFingerprint(inventory);
  }

  dispose(): void {
    this.disposed = true;
    this.disarmPeriodic();
    for (const slot of this.slots.values()) this.cancelScheduled(slot);
    this.slots.clear();
  }
}
