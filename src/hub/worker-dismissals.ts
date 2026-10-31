// Private presentation state. The Hub lease supplies single-process ownership;
// this queue serializes evidence reads, revision checks and atomic commits.
import { constants, promises as fs } from "node:fs";

export type WorkerDismissalScope = { user: string; workspaceId: string; conversationId: string };
export type WorkerDismissalEvidence = { executionId: string; signature: string; active: boolean; dismissible: boolean };
export type WorkerDismissalMutation = { executionId: string; expectedRevision: number; operation: "dismiss" | "retire" };
export type WorkerDismissalEntry = { executionId: string; revision: number; dismissed: boolean };
export type WorkerDismissalState = { version: 1; conversationId: string; entries: WorkerDismissalEntry[] };
export type WorkerDismissalNotice = "changed" | "unavailable" | "ready";
type RecordEntry = WorkerDismissalScope & WorkerDismissalEntry & { signature: string };
type CausalFence = { dismissal: bigint; activity: bigint };
type Observation = { record: RecordEntry; signature: string; fence: CausalFence; order: bigint };
type MutationAuthority = { scope: WorkerDismissalScope; executionId: string; pending: number; activity?: { signature: string; order: bigint } };
export class WorkerDismissalsError extends Error {
  constructor(readonly code: "invalid-input" | "unavailable" | "conflict" | "capacity" | "not-found", message: string) { super(message); }
}
const fail = (code: WorkerDismissalsError["code"], message: string): never => { throw new WorkerDismissalsError(code, message); };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export function dismissalIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
function key(scope: WorkerDismissalScope, executionId: string): string { return JSON.stringify([scope.user, scope.workspaceId, scope.conversationId, executionId]); }
function sameScope(a: WorkerDismissalScope, b: WorkerDismissalScope): boolean { return a.user === b.user && a.workspaceId === b.workspaceId && a.conversationId === b.conversationId; }

export class WorkerDismissalsStore {
  private records = new Map<string, RecordEntry>();
  private available = false;
  private chain: Promise<unknown> = Promise.resolve();
  private counter = 0;
  private readonly listeners = new Set<(scope: WorkerDismissalScope, notice: WorkerDismissalNotice) => void>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  // Each map is bounded by existing retained records, not incoming events.
  private readonly pendingObservations = new Map<string, Observation>();
  private readonly observationFailures = new Map<string, Observation>();
  private observationScheduled = false;
  private warnOverdueObservations?: () => void;
  // Queue order alone cannot order synchronous activity against an in-flight
  // evidence read. Exact logical clocks fence retained records and admitted
  // mutations; restart has no outstanding requests/observations to order.
  private order = 0n;
  private readonly fences = new Map<string, CausalFence>();
  // Exact admitted conditional targets only; bounded independently of events.
  private readonly authorities = new Map<string, MutationAuthority>();
  private fence(id: string): CausalFence {
    let fence = this.fences.get(id);
    if (!fence) { fence = { dismissal: 0n, activity: 0n }; this.fences.set(id, fence); }
    return fence;
  }
  constructor(private readonly filePath: string, options: { maxEntries?: number; maxBytes?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 8192;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  }
  async load(): Promise<void> {
    this.available = false;
    this.authorities.clear(); this.fences.clear();
    this.pendingObservations.clear(); this.observationFailures.clear();
    try {
      const handle = await fs.open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let text: string;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > this.maxBytes
          || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("unsafe state");
        text = await handle.readFile("utf8");
      } finally { await handle.close(); }
      const data: unknown = JSON.parse(text);
      if (!object(data) || data.version !== 1 || Object.keys(data).some(k => k !== "version" && k !== "records")
        || !Array.isArray(data.records) || data.records.length > this.maxEntries) throw new Error("invalid state");
      const records = new Map<string, RecordEntry>();
      for (const record of data.records) {
        if (!object(record) || Object.keys(record).sort().join(",") !== "conversationId,dismissed,executionId,revision,signature,user,workspaceId"
          || ![record.user, record.workspaceId, record.conversationId, record.executionId, record.signature].every(dismissalIdentifier)
          || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0 || typeof record.dismissed !== "boolean") throw new Error("invalid record");
        const entry = record as RecordEntry; const id = key(entry, entry.executionId);
        if (records.has(id)) throw new Error("duplicate record");
        records.set(id, entry);
      }
      this.records = records; this.fences.clear(); this.available = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.records = new Map(); this.fences.clear(); this.available = true; }
    }
  }
  subscribe(listener: (scope: WorkerDismissalScope, notice: WorkerDismissalNotice) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation); this.chain = result.catch(() => undefined); return result;
  }
  private assertAvailable(): void { if (!this.available) fail("unavailable", "worker dismissals are unavailable"); }
  private async commit(records: Map<string, RecordEntry>): Promise<void> {
    if (records.size > this.maxEntries) fail("capacity", "worker dismissal entry capacity reached");
    const text = `${JSON.stringify({ version: 1, records: [...records.values()] })}\n`;
    if (Buffer.byteLength(text) > this.maxBytes) fail("capacity", "worker dismissal byte capacity reached");
    const temp = `${this.filePath}.${process.pid}.${++this.counter}.tmp`; let created = false;
    try {
      const handle = await fs.open(temp, "wx", 0o600); created = true;
      try { await handle.writeFile(text, "utf8"); await handle.chmod(0o600); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, this.filePath); created = false;
    } catch {
      if (created) await fs.rm(temp, { force: true }).catch(() => undefined);
      fail("unavailable", "failed to save worker dismissals");
    }
    this.records = records;
  }
  private notify(scopes: WorkerDismissalScope[], notice: WorkerDismissalNotice = "changed"): void {
    const unique = new Map(scopes.map(scope => [JSON.stringify([scope.user, scope.workspaceId]), scope]));
    for (const scope of unique.values()) for (const listener of this.listeners) {
      try { listener(scope, notice); } catch { /* A transport failure cannot undo a committed save. */ }
    }
  }
  // Called only by trusted Hub child-response hooks. This synchronous entry
  // point never waits for disk and creates neither records nor subscriptions.
  observe(workspaceId: string, conversationId: string, evidence: WorkerDismissalEvidence[]): void {
    if (!this.available) return;
    const order = ++this.order;
    const positives = new Map<string, WorkerDismissalEvidence>();
    for (const item of evidence) {
      if (!item.active || !dismissalIdentifier(item.executionId) || !dismissalIdentifier(item.signature)) continue;
      positives.set(item.executionId, item);
    }
    for (const authority of this.authorities.values()) {
      if (authority.scope.workspaceId !== workspaceId || authority.scope.conversationId !== conversationId) continue;
      const item = positives.get(authority.executionId);
      if (item) authority.activity = { signature: item.signature, order };
    }
    for (const [id, record] of this.records) {
      if (record.workspaceId !== workspaceId || record.conversationId !== conversationId) continue;
      const item = positives.get(record.executionId);
      if (!item) continue;
      const fence = this.fence(id); fence.activity = order;
      if (!record.dismissed && record.signature === item.signature) continue;
      this.pendingObservations.set(id, { record, signature: item.signature, fence, order });
    }
    this.scheduleObservations();
  }
  private scheduleObservations(): void {
    if (!this.pendingObservations.size) return;
    if (this.observationScheduled) { this.warnOverdueObservations?.(); return; }
    this.observationScheduled = true;
    const batch = new Map(this.pendingObservations); this.pendingObservations.clear();
    // A hung disk operation must neither block chat nor hide the private-state
    // failure. Keep its one operation in flight; never start replacement I/O.
    let overdue = false;
    const warn = () => {
      overdue = true;
      const changed: RecordEntry[] = [];
      const outstanding = new Map(batch);
      for (const [id, observation] of this.pendingObservations) {
        if (!outstanding.has(id) || outstanding.get(id)!.order < observation.order) outstanding.set(id, observation);
      }
      for (const [id, observation] of outstanding) {
        if (this.fences.get(id) !== observation.fence || observation.fence.dismissal > observation.order) continue;
        const previous = this.observationFailures.get(id);
        if (previous && previous.fence === observation.fence && previous.order > observation.order) continue;
        if (!previous || previous.fence !== observation.fence) changed.push(observation.record);
        this.observationFailures.set(id, observation);
      }
      // A failed read-triggered retry must not invalidate→read→retry in a
      // tight loop. One warning per failure episode; success invalidates.
      if (changed.length) this.notify(changed, "unavailable");
    };
    // One deadline covers this bounded episode, including activity arriving
    // after it expired while the sole disk operation is still in flight.
    this.warnOverdueObservations = () => { if (overdue) warn(); };
    const timer = setTimeout(warn, 1000); timer.unref?.();
    void this.enqueue(async () => {
      // A first record can be committed after this batch was scheduled. Merge
      // its captured activity before any later queued conditional mutation.
      for (const [id, observation] of this.pendingObservations) batch.set(id, observation);
      this.pendingObservations.clear();
      if (overdue) warn();
      const next = new Map(this.records); const changed: RecordEntry[] = [];
      for (const [id, observation] of batch) {
        const current = next.get(id);
        // Evidence-only revision advances do not supersede real activity.
        // Only a later explicit dismissal (or a forgotten record) fences it.
        if (!current || this.fences.get(id) !== observation.fence || observation.fence.dismissal > observation.order) continue;
        if (!current.dismissed && current.signature === observation.signature) continue;
        if (current.revision >= Number.MAX_SAFE_INTEGER - 1) fail("capacity", "worker dismissal revision exhausted");
        next.set(id, { ...current, signature: observation.signature, revision: current.revision + 1, dismissed: false });
        changed.push(current);
      }
      if (changed.length) await this.commit(next);
      const recovered: RecordEntry[] = [];
      for (const [id, observation] of batch) {
        const failed = this.observationFailures.get(id);
        if (!failed) continue;
        if (this.fences.get(id) !== failed.fence) { this.observationFailures.delete(id); continue; }
        const current = this.records.get(id);
        const covered = current && !current.dismissed && current.signature === failed.signature;
        if (covered || failed.fence.dismissal > failed.order || (failed.fence === observation.fence && failed.order <= observation.order)) {
          recovered.push(failed.record); this.observationFailures.delete(id);
        }
      }
      const committed = changed.filter(record => {
        const id = key(record, record.executionId); const observation = batch.get(id)!;
        return this.fences.get(id) === observation.fence && observation.fence.dismissal <= observation.order;
      });
      if (recovered.length) {
        const scopeKey = (scope: WorkerDismissalScope) => JSON.stringify([scope.user, scope.workspaceId]);
        const unhealthy = new Set([...this.observationFailures.values()].map(value => scopeKey(value.record)));
        const scopes = [...committed, ...recovered];
        this.notify(scopes.filter(scope => !unhealthy.has(scopeKey(scope))), "ready");
        this.notify(scopes.filter(scope => unhealthy.has(scopeKey(scope))));
      } else if (committed.length) this.notify(committed);
    }).catch(warn).finally(() => {
      clearTimeout(timer); this.observationScheduled = false; this.warnOverdueObservations = undefined;
      this.scheduleObservations();
    });
  }
  reconcile(scope: WorkerDismissalScope, read: () => Promise<WorkerDismissalEvidence[]>, mutation?: WorkerDismissalMutation): Promise<WorkerDismissalState> {
    // Private reads fail visibly while a retirement is unconfirmed. A read
    // also offers one bounded retry, never a timer-driven polling loop.
    const failures = [...this.observationFailures].filter(([, observation]) => sameScope(scope, observation.record));
    if (failures.length) {
      for (const [id, observation] of failures) {
        const pending = this.pendingObservations.get(id);
        if (!pending || pending.order < observation.order) this.pendingObservations.set(id, observation);
      }
      this.scheduleObservations();
      return Promise.reject(new WorkerDismissalsError("unavailable", "failed to retire worker dismissals; chat remains available"));
    }
    let authority: MutationAuthority | undefined;
    let authorityId: string | undefined;
    try {
      this.assertAvailable();
      if (![scope.user, scope.workspaceId, scope.conversationId].every(dismissalIdentifier)) fail("invalid-input", "invalid dismissal scope");
      if (mutation && (!dismissalIdentifier(mutation.executionId) || !Number.isSafeInteger(mutation.expectedRevision)
        || mutation.expectedRevision < 0 || (mutation.operation !== "dismiss" && mutation.operation !== "retire"))) fail("invalid-input", "invalid dismissal mutation");
      if (mutation) {
        authorityId = key(scope, mutation.executionId);
        authority = this.authorities.get(authorityId);
        if (!authority) {
          if (this.authorities.size >= this.maxEntries) fail("capacity", "worker dismissal pending target capacity reached");
          authority = { scope, executionId: mutation.executionId, pending: 0 };
          this.authorities.set(authorityId, authority);
        }
        authority.pending++;
      }
    } catch (error) { return Promise.reject(error); }
    // Admission, not eventual read start, orders the user's explicit action.
    const admissionOrder = ++this.order;
    return this.enqueue(async () => {
      try {
        this.assertAvailable();
        if (authority && this.authorities.get(authorityId!) !== authority) fail("unavailable", "worker dismissal authority was cleared");
        const evidence = await read();
        if (authority && this.authorities.get(authorityId!) !== authority) fail("unavailable", "worker dismissal authority was cleared");
        const next = new Map(this.records); const changed: WorkerDismissalScope[] = [];
        const matching = new Map<string, string[]>();
        for (const [id, record] of next) {
          if (record.workspaceId !== scope.workspaceId || record.conversationId !== scope.conversationId) continue;
          const ids = matching.get(record.executionId);
          if (ids) ids.push(id); else matching.set(record.executionId, [id]);
        }
        const seen = new Map<string, WorkerDismissalEvidence>();
        for (const item of evidence) {
          if (!dismissalIdentifier(item.executionId) || !dismissalIdentifier(item.signature)) fail("unavailable", "invalid authoritative worker identity");
          const duplicate = seen.get(item.executionId);
          if (duplicate && (duplicate.signature !== item.signature || duplicate.active !== item.active || duplicate.dismissible !== item.dismissible)) fail("unavailable", "ambiguous authoritative worker identity");
          seen.set(item.executionId, item);
          // Positive observations retire marks for every account, not just the
          // device making this read. Retired revisions are never evicted.
          for (const id of matching.get(item.executionId) ?? []) {
            const previous = next.get(id)!;
            if (previous.signature !== item.signature || (item.active && previous.dismissed)) {
              if (previous.revision >= Number.MAX_SAFE_INTEGER - 1) fail("capacity", "worker dismissal revision exhausted");
              next.set(id, { ...previous, signature: item.signature, revision: previous.revision + 1, dismissed: item.active ? false : previous.dismissed });
              changed.push(previous);
            }
          }
          const id = key(scope, item.executionId);
          if (!next.has(id)) {
            if (next.size >= this.maxEntries) fail("capacity", "worker dismissal entry capacity reached");
            next.set(id, { ...scope, executionId: item.executionId, signature: item.signature, revision: 0, dismissed: false }); changed.push(scope);
          }
        }
        // Commit activity fences even when the submitted operation is stale.
        if (changed.length) { await this.commit(next); this.notify(changed); }
        if (authority && this.authorities.get(authorityId!) !== authority) fail("unavailable", "worker dismissal authority was cleared");
        if (mutation) {
          const item = seen.get(mutation.executionId); const id = key(scope, mutation.executionId); const current = this.records.get(id);
          if (!item || !current) throw new WorkerDismissalsError("not-found", "execution not present in authoritative conversation");
          const fence = this.fence(id);
          const newerActivity = fence.activity > admissionOrder || (authority?.activity?.order ?? 0n) > admissionOrder;
          if (current.revision !== mutation.expectedRevision || (mutation.operation === "dismiss" && (!item.dismissible || newerActivity))) fail("conflict", "worker evidence changed; read current dismissals");
          // Retirement is conditional on positively verified active evidence;
          // the client cannot turn this into a generic Restore endpoint.
          if (mutation.operation === "retire" && !item.active) fail("conflict", "worker activity is not verified");
          const dismissed = mutation.operation === "dismiss";
          if (current.dismissed !== dismissed) {
            const updated = new Map(this.records).set(id, { ...current, dismissed });
            await this.commit(updated); this.notify([scope]);
          }
          // Activity after admission must still retire a save completing later.
          if (dismissed) fence.dismissal = admissionOrder;
        }
        return { version: 1, conversationId: scope.conversationId, entries: [...this.records.values()].filter(record => sameScope(scope, record))
          .map(({ executionId, revision, dismissed }) => ({ executionId, revision, dismissed })) };
      } finally {
        if (authority && this.authorities.get(authorityId!) === authority) {
          const id = key(scope, authority.executionId); const record = this.records.get(id);
          if (record && authority.activity && authority.activity.order > admissionOrder) {
            const fence = this.fence(id); fence.activity = authority.activity.order;
            if (record.dismissed || record.signature !== authority.activity.signature) {
              this.pendingObservations.set(id, { record, fence, ...authority.activity });
              this.scheduleObservations();
            }
          }
          if (--authority.pending === 0) this.authorities.delete(authorityId!);
        }
      }
    });
  }
  forgetWorkspace(workspaceId: string): Promise<void> {
    return this.enqueue(async () => {
      this.assertAvailable(); const next = new Map(this.records); const changed: RecordEntry[] = [];
      for (const [id, record] of next) if (record.workspaceId === workspaceId) { next.delete(id); changed.push(record); }
      if (changed.length) { await this.commit(next); this.notify(changed); }
      for (const record of changed) this.fences.delete(key(record, record.executionId));
      for (const [id, authority] of this.authorities) if (authority.scope.workspaceId === workspaceId) this.authorities.delete(id);
      for (const [id, observation] of this.pendingObservations) if (observation.record.workspaceId === workspaceId) this.pendingObservations.delete(id);
      for (const [id, observation] of this.observationFailures) if (observation.record.workspaceId === workspaceId) this.observationFailures.delete(id);
    });
  }
}
