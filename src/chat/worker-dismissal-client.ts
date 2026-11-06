import { appUrl } from "../shared/app-url";
import type { LiveChannel, LiveSubscriptionHandle } from "../shell/live-channel";
import type { CompactWorker } from "./compact-work";
import { workerIsActive } from "./worker-state";

type Entry = { executionId: string; revision: number; dismissed: boolean };
type IdentityFence = { generation: number; ids: Set<string>; resolvedAt?: number };
type DismissalAttempt = { sources: readonly string[]; pending: Set<string>; current: boolean };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const MAX_IDENTITIES = 8192;
const path = () => appUrl("/api/personal-worker-dismissals");

/** Provider-proven occurrence anchors only; never child ids or UI references. */
export function workerExecutionIds(worker: CompactWorker): string[] {
  // A projected empty set is a refusal, not permission to retry malformed or
  // deliberately withheld provider aliases through the compatibility path.
  if (worker.dismissalIds !== undefined) return [...new Set(worker.dismissalIds)];
  return [...new Set([worker.activity?.executionId, ...(worker.activity?.executionAliases ?? [])].filter((id): id is string => Boolean(id)))];
}

export function workerDismissible(worker: CompactWorker): boolean {
  if (worker.activity?.kind === "working" || worker.activity?.kind === "needs-answer") return false;
  return !workerIsActive(worker.state) || worker.activity?.kind === "unavailable" || worker.activity?.kind === "ended"
    || worker.state === "unknown" && worker.activity === undefined;
}

export function visibleWorkers(workers: readonly CompactWorker[], dismissed: ReadonlySet<string>): CompactWorker[] {
  return workers.filter(worker => !workerDismissible(worker) || !workerExecutionIds(worker).some(id => dismissed.has(id)));
}

/** Private presentation only. No provider calls, polling, or browser fallback. */
export class WorkerDismissalClient {
  private healthError = "";
  // Explicit failed POSTs belong to their execution, not to the next storage
  // read or automatic retirement. Keep at most the existing identity budget.
  private actionFailures = new Map<string, string>();

  get error(): string {
    return [...new Set([this.healthError, ...this.actionFailures.values()].filter(Boolean))].join(" ");
  }
  private conversation: string | null = null;
  private epoch = 0;
  private entries = new Map<string, Entry>();
  private retired = new Map<string, number>();
  private activeIdentities = new Set<string>();
  private provenGroups = new Map<string, readonly string[]>();
  private recoveredAt = new Map<string, number>();
  private observationSequence = 0;
  private retirementAttempts = new Map<string, number>();
  private retirements = new Map<string, number>();
  private retirementRunning = false;
  private read: AbortController | null = null;
  private writes = new Set<AbortController>();
  private pendingDismissals = new Map<AbortController, DismissalAttempt[]>();
  private queued = false;
  private subscription: LiveSubscriptionHandle | null = null;
  private generation: number | null = null;
  private capacityExceeded = false;
  private identityUnavailable = false;
  private unscopedIdentity = false;
  // Native launch continuity only. Never a dismissal identity or alias.
  private identityFences = new Map<string, IdentityFence>();
  private identityFenceSize = 0;
  private activityGeneration = 0;
  private readonly fetcher: Fetcher;
  private readonly changed: () => void;

  constructor(private readonly options: { fetcher?: Fetcher; changed: () => void; channel?: Pick<LiveChannel, "subscribe"> }) {
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.changed = options.changed;
  }

  get dismissed(): ReadonlySet<string> {
    if (this.capacityExceeded || this.identityUnavailable) return new Set(); // Never lose a visibility fence to hide work.
    return new Set([...this.entries.values()].filter(entry => entry.dismissed && !this.retired.has(entry.executionId)).map(entry => entry.executionId));
  }

  select(conversation: string | null): void {
    if (conversation === this.conversation) return;
    this.reset(); this.conversation = conversation;
    if (!conversation) return;
    this.subscription = this.options.channel?.subscribe({ topic: "personal" }, {
      ready: generation => this.live(generation),
      data: (data, _cursor, generation) => {
        if ((data as { category?: unknown })?.category === "worker-dismissals") this.live(generation);
      },
      dropped: () => { this.fence(); this.entries.clear(); this.changed(); },
      unavailable: () => {
        this.fence(); this.entries.clear();
        this.healthError = "Personal worker dismissal storage is unavailable. Rows and active requests remain visible; chat is still available.";
        this.changed();
      },
    }) ?? null;
    this.refresh();
  }

  private live(generation: number): void {
    if (this.generation !== generation) { this.fence(); this.generation = generation; }
    this.refresh();
  }

  refresh(): void {
    if (!this.conversation) return;
    if (this.read || this.writes.size) { this.queued = true; return; }
    this.queued = false;
    const conversation = this.conversation, epoch = this.epoch, observation = this.observationSequence, read = new AbortController();
    this.read = read;
    void this.fetcher(`${path()}?conversationId=${encodeURIComponent(conversation)}`, { signal: read.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("read");
        const entries = await this.parse(response, conversation);
        if (epoch !== this.epoch || read.signal.aborted) return;
        this.acceptDismissals(entries, observation);
        this.confirmIdentities(entries, observation);
        this.entries = entries; this.healthError = this.retirementWarning(); this.changed();
      }).catch(() => {
        if (epoch !== this.epoch || read.signal.aborted) return;
        this.entries.clear(); this.healthError = "Could not read saved worker dismissals. Rows remain visible; chat is still available."; this.changed();
      }).finally(() => {
        if (this.read !== read) return;
        this.read = null;
        if (this.queued) this.refresh();
      });
  }

  /** Whether this explicit action saved; retained feedback may belong to another execution. */
  async dismiss(executionId?: string, aliases: readonly string[] = []): Promise<boolean> {
    if (this.identityUnavailable) {
      this.healthError = this.retirementWarning(); this.changed(); return false;
    }
    if (this.capacityExceeded) {
      this.healthError = "Worker dismissal tracking is full. Rows remain visible; reopen this conversation before dismissing more work."; this.changed(); return false;
    }
    if (!executionId) {
      this.healthError = "Cannot save this dismissal: the worker's exact execution identity is unverified."; this.changed(); return false;
    }
    return this.mutate(executionId, "dismiss", aliases);
  }

  async dismissMany(groups: readonly (readonly string[])[]): Promise<boolean> {
    if (!groups.length) return true;
    if (this.identityUnavailable || this.capacityExceeded) {
      this.healthError = this.retirementWarning(); this.changed(); return false;
    }
    const unique = new Map<string, readonly string[]>();
    const identities = new Set<string>();
    for (const ids of groups) {
      if (!ids[0]) { this.healthError = "Cannot save this dismissal: the worker's exact execution identity is unverified."; this.changed(); return false; }
      for (const id of ids) {
        identities.add(id);
        if (identities.size > MAX_IDENTITIES) {
          this.healthError = "Worker dismissal tracking is full. Rows remain visible; chat is still available."; this.changed(); return false;
        }
      }
      unique.set(ids[0], [...new Set([...(unique.get(ids[0]) ?? []), ...ids])]);
    }
    return this.mutate([...unique.keys()][0]!, "dismiss", [], [...unique.values()]);
  }

  observe(workers: readonly CompactWorker[]): void {
    // A later native generation cannot re-admit a replay from an older one.
    for (const worker of workers) {
      const generation = worker.activity?.generation;
      if (Number.isSafeInteger(generation) && generation! > this.activityGeneration) this.activityGeneration = generation!;
    }
    const activeNow = new Set<string>();
    const groups = new Map<string, readonly string[]>();
    let resolveIdentities = false;
    for (const worker of workers) {
      const ids = workerExecutionIds(worker);
      for (const id of ids) if (groups.size < MAX_IDENTITIES || groups.has(id)) groups.set(id, ids);
      const active = worker.activity?.kind === "working" || worker.activity?.kind === "needs-answer";
      const ref = worker.activity?.launchRef, generation = worker.activity?.generation;
      const scoped = typeof ref === "string" && ref.length > 0 && new TextEncoder().encode(ref).length <= 512
        && !/[\u0000-\u001f\u007f]/.test(ref) && Number.isSafeInteger(generation) && generation! >= 0;
      if (active && !ids.length) {
        // No safe scope exists for a retirement write (for example a provider
        // alias overflow). Fail open for this selection rather than letting a
        // later unavailable row resurrect marks we could not safely retire.
        this.identityUnavailable = true;
        if (!scoped) this.unscopedIdentity = true;
        else {
          let pending = this.identityFences.get(ref!);
          if (!pending) {
            if (this.identityFenceSize >= MAX_IDENTITIES) this.capacityExceeded = true;
            else {
              pending = { generation: generation!, ids: new Set() };
              this.identityFences.set(ref!, pending); this.identityFenceSize++;
            }
          }
          if (pending) {
            if (pending.generation !== generation) this.unscopedIdentity = true;
            // A new incomplete frame invalidates any in-flight confirmation.
            if (pending.resolvedAt !== undefined) { pending.resolvedAt = undefined; ++this.observationSequence; }
          }
        }
        this.healthError = this.retirementWarning();
      }
      // The same proven launch may finish before its first qualified update.
      // Resolution is not retirement: even terminal/unavailable rows still need
      // a later authoritative non-dismissed revision for every qualified alias.
      if (ids.length && scoped) {
        const pending = this.identityFences.get(ref!);
        if (pending && pending.generation === generation && generation === this.activityGeneration) {
          let expanded = false;
          for (const id of ids) if (!pending.ids.has(id)) {
            if (this.identityFenceSize >= MAX_IDENTITIES) { this.capacityExceeded = true; break; }
            pending.ids.add(id); this.identityFenceSize++; expanded = true;
          }
          if (pending.resolvedAt === undefined || expanded) {
            pending.resolvedAt = ++this.observationSequence;
            resolveIdentities = true;
          }
        }
      }
      if (!active && !ids.some(id => this.retired.has(id))) continue;
      for (const id of ids) {
        if (active) for (const attempts of this.pendingDismissals.values()) for (const attempt of attempts) attempt.pending.delete(id);
        if (!this.retired.has(id) && this.retired.size >= MAX_IDENTITIES) {
          this.capacityExceeded = true;
          this.healthError = "Worker dismissal tracking is full. Rows remain visible; chat is still available.";
          continue;
        }
        if (active) {
          activeNow.add(id);
          if (!this.activeIdentities.has(id)) this.recoveredAt.set(id, ++this.observationSequence);
        }
        // Retain the durable revision this recovery superseded. A later
        // explicit dismissal on another device can supersede it in turn.
        if (active) this.retired.set(id, Math.max(this.retired.get(id) ?? 0, this.entries.get(id)?.revision ?? 0));
        else if (!this.retired.has(id)) this.retired.set(id, Math.max(0, ...ids.map(alias => this.retired.get(alias) ?? 0)));
        if (!this.entries.get(id)?.dismissed) continue;
        const revision = this.entries.get(id)!.revision;
        if (this.retirementAttempts.get(id) === revision) continue;
        this.retirementAttempts.set(id, revision);
        this.retirements.set(id, revision);
      }
    }
    this.activeIdentities = activeNow;
    this.provenGroups = groups;
    void this.retireNext();
    // One coalesced authoritative read per qualification/alias expansion, not
    // a polling loop. Earlier reads and mutation responses cannot discharge it.
    if (resolveIdentities) this.refresh();
  }

  private confirmIdentities(entries: ReadonlyMap<string, Entry>, observation: number): void {
    for (const [ref, pending] of this.identityFences) {
      if (pending.generation !== this.activityGeneration || pending.resolvedAt === undefined || pending.resolvedAt > observation || !pending.ids.size) continue;
      if (![...pending.ids].every(id => entries.get(id)?.dismissed === false
        && entries.get(id)!.revision >= (this.retired.get(id) ?? 0))) continue;
      this.identityFences.delete(ref); this.identityFenceSize -= 1 + pending.ids.size;
    }
    this.identityUnavailable = this.unscopedIdentity || this.identityFences.size > 0 || this.capacityExceeded;
  }

  private acceptDismissals(entries: ReadonlyMap<string, Entry>, observation: number): void {
    for (const entry of entries.values()) {
      const retiredRevision = this.retired.get(entry.executionId);
      if (retiredRevision === undefined) continue;
      if (!entry.dismissed && this.activeIdentities.has(entry.executionId)) {
        this.retired.set(entry.executionId, Math.max(retiredRevision, entry.revision));
        continue;
      }
      if (!entry.dismissed) continue;
      const aliases = this.provenGroups.get(entry.executionId) ?? [entry.executionId];
      if (entry.revision > retiredRevision && aliases.every(id => !this.activeIdentities.has(id) && (this.recoveredAt.get(id) ?? 0) <= observation)) {
        for (const id of aliases) this.retired.delete(id);
      }
    }
  }

  private async retireNext(): Promise<void> {
    if (this.retirementRunning || !this.retirements.size) return;
    this.retirementRunning = true;
    const epoch = this.epoch;
    try {
      for (const [id, revision] of this.retirements) {
        if (epoch !== this.epoch) return;
        this.retirements.delete(id);
        if (this.entries.get(id)?.dismissed && this.entries.get(id)?.revision === revision && this.retired.has(id)) await this.mutate(id, "retire");
      }
    } finally { if (epoch === this.epoch) this.retirementRunning = false; }
  }

  private async mutate(executionId: string, operation: "dismiss" | "retire", aliases: readonly string[] = [], batch?: readonly (readonly string[])[]): Promise<boolean> {
    if (!this.conversation) return false;
    // A read begun before a commit must never overwrite its response.
    this.read?.abort(); this.read = null;
    const epoch = this.epoch, conversationId = this.conversation, observation = this.observationSequence, write = new AbortController();
    this.writes.add(write);
    const attempts: DismissalAttempt[] = (batch ?? [[executionId, ...aliases]]).map(ids => {
      const identities = [...new Set(ids)];
      return { sources: identities, pending: new Set(identities), current: true };
    });
    if (operation === "dismiss") {
      // Only in-flight feedback ownership is superseded. Durable revisions and
      // activity fences keep their existing authority; no attempt ledger remains.
      for (const previousGroup of this.pendingDismissals.values()) for (const previous of previousGroup) {
        if (attempts.some(attempt => previous.sources.some(id => attempt.pending.has(id)))) previous.current = false;
      }
      this.pendingDismissals.set(write, attempts);
    }
    try {
      const response = await this.fetcher(path(), { method: "POST", signal: write.signal, cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify(batch ? { version: 1, conversationId, operation, targets: attempts.map(attempt => ({ executionId: attempt.sources[0], expectedRevision: this.entries.get(attempt.sources[0]!)?.revision ?? 0 })) }
          : { version: 1, conversationId, executionId, expectedRevision: this.entries.get(executionId)?.revision ?? 0, operation }) });
      if (epoch !== this.epoch || write.signal.aborted) return false;
      if (response.status === 409) {
        this.queued = true;
        for (const attempt of attempts) if (attempt.current) this.mutationFailure(attempt.sources[0]!, operation, operation === "dismiss"
          ? "Worker status changed before dismissal could be saved. Review current visibility before choosing to retry dismissal."
          : "Worker status changed before saved dismissal retirement could be confirmed. Active work stays visible.");
        return false;
      }
      if (!response.ok) throw new Error("save");
      const entries = await this.parse(response, conversationId);
      if (batch && attempts.some(attempt => entries.get(attempt.sources[0]!)?.dismissed !== true)) throw new Error("incomplete batch save response");
      if (epoch !== this.epoch || write.signal.aborted) return false;
      this.acceptDismissals(entries, observation);
      // Concurrent full responses merge by durable per-execution revision.
      for (const [id, entry] of entries) if (entry.revision >= (this.entries.get(id)?.revision ?? -1)) this.entries.set(id, entry);
      // Clear old visibility fences only after durable success, provided no
      // positive activity arrived while this explicit action was in flight.
      if (operation === "dismiss") for (const attempt of attempts) {
        if (attempt.sources.every(id => attempt.pending.has(id))) for (const id of attempt.sources) this.retired.delete(id);
        if (attempt.current) for (const id of attempt.sources) this.actionFailures.delete(id);
      }
      this.healthError = this.retirementWarning();
      return true;
    } catch {
      if (epoch !== this.epoch || write.signal.aborted) return false;
      for (const attempt of attempts) if (attempt.current) this.mutationFailure(attempt.sources[0]!, operation, operation === "dismiss"
        ? "Could not save worker dismissal changes. The attempt did not receive a successful save response; check current visibility before retrying. Chat remains available."
        : "Could not save worker dismissal changes. Chat remains available; this change is not confirmed across devices.");
      return false;
    } finally {
      this.writes.delete(write);
      this.pendingDismissals.delete(write);
      if (epoch === this.epoch) { this.changed(); if (this.queued) this.refresh(); }
    }
  }

  private mutationFailure(executionId: string, operation: "dismiss" | "retire", message: string): void {
    if (operation === "retire") { this.healthError = message; return; }
    if (this.actionFailures.has(executionId) || this.actionFailures.size < MAX_IDENTITIES) this.actionFailures.set(executionId, message);
    else {
      this.capacityExceeded = true;
      this.healthError = this.retirementWarning();
    }
  }

  private async parse(response: Response, conversation: string): Promise<Map<string, Entry>> {
    const value = await response.json();
    if (value?.version !== 1 || value.conversationId !== conversation || !Array.isArray(value.entries) || value.entries.length > MAX_IDENTITIES) throw new Error("invalid dismissal response");
    const entries = new Map<string, Entry>();
    for (const entry of value.entries) {
      if (typeof entry?.executionId !== "string" || !entry.executionId || !Number.isSafeInteger(entry.revision) || entry.revision < 0 || typeof entry.dismissed !== "boolean" || entries.has(entry.executionId)) throw new Error("invalid dismissal entry");
      entries.set(entry.executionId, entry);
    }
    return entries;
  }

  private retirementWarning(): string {
    if (this.capacityExceeded) return "Worker dismissal tracking is full. Rows remain visible; chat is still available.";
    if (this.identityUnavailable) return "Could not verify an active worker's complete execution identity or retire its saved dismissals. Saved dismissals are ignored on this page; reopen the conversation after identity is verified.";
    return [...this.entries.values()].some(entry => entry.dismissed && this.retired.has(entry.executionId))
      ? "Could not confirm saved dismissal retirement. Active work stays visible; an old dismissal may return after reload." : "";
  }

  private fence(): void {
    this.epoch++; this.read?.abort(); this.read = null; this.queued = false;
    for (const write of this.writes) write.abort();
    this.writes.clear();
    this.pendingDismissals.clear();
    this.retirements.clear(); this.retirementRunning = false;
  }
  private reset(): void {
    this.fence(); this.subscription?.close(); this.subscription = null; this.generation = null;
    this.entries.clear(); this.retired.clear(); this.retirementAttempts.clear(); this.healthError = ""; this.actionFailures.clear(); this.capacityExceeded = false;
    this.identityUnavailable = false;
    this.unscopedIdentity = false; this.identityFences.clear(); this.identityFenceSize = 0; this.activityGeneration = 0;
    this.activeIdentities.clear(); this.provenGroups.clear(); this.recoveredAt.clear(); this.observationSequence = 0;
  }
  dispose(): void { this.reset(); this.conversation = null; }
}
