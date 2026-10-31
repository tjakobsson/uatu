import { appUrl } from "../shared/app-url";
import type { LiveChannel, LiveSubscriptionHandle } from "../shell/live-channel";
import type { CompactWorker } from "./compact-work";
import { workerIsActive } from "./worker-state";

type Entry = { executionId: string; revision: number; dismissed: boolean };
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
  error = "";
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
  private pendingDismissals = new Map<AbortController, Set<string>>();
  private queued = false;
  private subscription: LiveSubscriptionHandle | null = null;
  private generation: number | null = null;
  private capacityExceeded = false;
  private identityUnavailable = false;
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
        this.error = "Personal worker dismissal storage is unavailable. Rows and active requests remain visible; chat is still available.";
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
        this.entries = entries; this.error = this.retirementWarning(); this.changed();
      }).catch(() => {
        if (epoch !== this.epoch || read.signal.aborted) return;
        this.entries.clear(); this.error = "Could not read saved worker dismissals. Rows remain visible; chat is still available."; this.changed();
      }).finally(() => {
        if (this.read !== read) return;
        this.read = null;
        if (this.queued) this.refresh();
      });
  }

  async dismiss(executionId?: string, aliases: readonly string[] = []): Promise<void> {
    if (this.identityUnavailable) {
      this.error = this.retirementWarning(); this.changed(); return;
    }
    if (this.capacityExceeded) {
      this.error = "Worker dismissal tracking is full. Rows remain visible; reopen this conversation before dismissing more work."; this.changed(); return;
    }
    if (!executionId) {
      this.error = "Cannot save this dismissal: the worker's exact execution identity is unverified."; this.changed(); return;
    }
    await this.mutate(executionId, "dismiss", aliases);
  }

  observe(workers: readonly CompactWorker[]): void {
    const activeNow = new Set<string>();
    const groups = new Map<string, readonly string[]>();
    for (const worker of workers) {
      const ids = workerExecutionIds(worker);
      for (const id of ids) if (groups.size < MAX_IDENTITIES || groups.has(id)) groups.set(id, ids);
      const active = worker.activity?.kind === "working" || worker.activity?.kind === "needs-answer";
      if (active && !ids.length) {
        // No safe scope exists for a retirement write (for example a provider
        // alias overflow). Fail open for this selection rather than letting a
        // later unavailable row resurrect marks we could not safely retire.
        this.identityUnavailable = true;
        this.error = this.retirementWarning();
      }
      if (!active && !ids.some(id => this.retired.has(id))) continue;
      for (const id of ids) {
        if (active) for (const pending of this.pendingDismissals.values()) pending.delete(id);
        if (!this.retired.has(id) && this.retired.size >= MAX_IDENTITIES) {
          this.capacityExceeded = true;
          this.error = "Worker dismissal tracking is full. Rows remain visible; chat is still available.";
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

  private async mutate(executionId: string, operation: "dismiss" | "retire", aliases: readonly string[] = []): Promise<void> {
    if (!this.conversation) return;
    // A read begun before a commit must never overwrite its response.
    this.read?.abort(); this.read = null;
    const epoch = this.epoch, conversationId = this.conversation, observation = this.observationSequence, write = new AbortController();
    this.writes.add(write);
    const identities = [...new Set([executionId, ...aliases])];
    if (operation === "dismiss") this.pendingDismissals.set(write, new Set(identities));
    try {
      const response = await this.fetcher(path(), { method: "POST", signal: write.signal, cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, conversationId, executionId, expectedRevision: this.entries.get(executionId)?.revision ?? 0, operation }) });
      if (epoch !== this.epoch || write.signal.aborted) return;
      if (response.status === 409) {
        this.queued = true;
        this.error = "Worker status changed before dismissal could be saved. Refreshing saved dismissals.";
        return;
      }
      if (!response.ok) throw new Error("save");
      const entries = await this.parse(response, conversationId);
      if (epoch !== this.epoch || write.signal.aborted) return;
      this.acceptDismissals(entries, observation);
      // Concurrent full responses merge by durable per-execution revision.
      for (const [id, entry] of entries) if (entry.revision >= (this.entries.get(id)?.revision ?? -1)) this.entries.set(id, entry);
      // Clear old visibility fences only after durable success, provided no
      // positive activity arrived while this explicit action was in flight.
      if (operation === "dismiss" && identities.every(id => this.pendingDismissals.get(write)?.has(id))) {
        for (const id of identities) this.retired.delete(id);
      }
      this.error = this.retirementWarning();
    } catch {
      if (epoch !== this.epoch || write.signal.aborted) return;
      this.error = "Could not save worker dismissal changes. Chat remains available; this change is not confirmed across devices.";
    } finally {
      this.writes.delete(write);
      this.pendingDismissals.delete(write);
      if (epoch === this.epoch) { this.changed(); if (this.queued) this.refresh(); }
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
    if (this.identityUnavailable) return "Could not verify an active worker's complete execution identity or retire its saved dismissals. Saved dismissals are ignored on this page; reopen the conversation after identity is verified.";
    if (this.capacityExceeded) return "Worker dismissal tracking is full. Rows remain visible; chat is still available.";
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
    this.entries.clear(); this.retired.clear(); this.retirementAttempts.clear(); this.error = ""; this.capacityExceeded = false;
    this.identityUnavailable = false;
    this.activeIdentities.clear(); this.provenGroups.clear(); this.recoveredAt.clear(); this.observationSequence = 0;
  }
  dispose(): void { this.reset(); this.conversation = null; }
}
