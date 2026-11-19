import type { OpenCode } from "@opencode/client";
import path from "node:path";
import { HistoryReuse, historyVersion } from "../../history-reuse";
import { measureChatWork } from "../../performance";
import { number as numberField } from "../normalization";
import { prepareStoredMessage } from "./normalization";
import type { LauncherEvidence } from "./background";
import type { InboxFacts, InboxReportFact, RecordSnapshot } from "./session-changes";

type StoredMessage = Record<string, unknown>;
type NativeReadOrder = Readonly<{ started: number; completed: number }>;
export type PendingOutcomeRead = NativeReadOrder & {
  reports: readonly { child: string; at?: number; digest: string }[];
  overflow?: true;
};
export const parentCounterproofMaxFacts = 256;
export const parentCounterproofMaxBytes = 65_536;
type CompleteHistory = { messages: StoredMessage[]; nativeReadOrder: NativeReadOrder };
type Qualification = {
  recordsAfter: number; pendingAfter: number;
  recordSnapshot?: RecordSnapshot;
  /** Deny-only: a positive inbox read completed before registration. */
  inboxSnapshot?: InboxFacts;
  rawSignature?: string;
  visibility?: NativeReadOrder & { boundary: string | null };
};
type Order = { current(): number; next(): number };

/** Owns native transcript IO and its entire reusable lifetime. Observations can
 * retire reuse, never cancel healthy waiters, publish outcomes or start IO. */
export class V2NativeHistory {
  private readonly reuse: HistoryReuse<StoredMessage[], Qualification>;
  private readonly readOrders = new WeakMap<StoredMessage[], NativeReadOrder>();
  private readonly workspace: string;

  constructor(private readonly options: {
    client: ReturnType<typeof OpenCode.make>;
    directory: string;
    version(): string | undefined;
    historyOrder: Order;
    recordOrder: Order;
    readSignal(signal: AbortSignal): AbortSignal;
    observeHistory(session: string, messages: StoredMessage[]): void;
    observeRecord(value: unknown, requestedId: string | undefined): void;
    snapshotRecord(session: string): RecordSnapshot | undefined;
    observeInbox(session: string, entries: unknown, facts: InboxFacts): void;
    inboxFacts(session: string): InboxFacts | undefined;
  }) {
    this.workspace = path.resolve(options.directory);
    this.reuse = new HistoryReuse(undefined, undefined, () => ({
      recordsAfter: options.recordOrder.current(), pendingAfter: options.historyOrder.current(),
    }));
  }

  async complete(session: string, signal: AbortSignal): Promise<CompleteHistory> {
    signal.throwIfAborted();
    this.qualifyRecordSnapshot(session);
    this.qualifyInboxSnapshot(session);
    const snapshot = this.options.snapshotRecord(session), known = this.options.inboxFacts(session);
    const reading = this.reuse.readShared(session, this.options.version(), owner => {
      const sharedSignal = this.options.readSignal(owner);
      return this.coveredRead(sharedSignal, () => this.readComplete(session, sharedSignal));
    }, signal);
    // readShared registers synchronously and defers its loader. Seed only this
    // entry, before native IO, without replacing a shared/installed baseline.
    const entry = this.reuse.peekObservation(session, this.options.version());
    if (entry && !("recordSnapshot" in entry)) {
      entry.recordSnapshot = snapshot;
      if (known && (known.reports.length || known.overflow)) entry.inboxSnapshot = known;
    }
    const messages = await reading;
    signal.throwIfAborted();
    return { messages, nativeReadOrder: this.readOrders.get(messages)! };
  }

  async inbox(session: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const started = this.options.historyOrder.next();
    const entries = await this.options.client.session.inbox.list({ sessionID: session }, { signal });
    signal.throwIfAborted();
    const completed = this.options.historyOrder.next();
    const reports: Array<PendingOutcomeRead["reports"][number]> = [], seen = new Set<string>(), known: InboxReportFact[] = [];
    let bytes = 0, overflow: true | undefined;
    for (const value of entries as Array<Record<string, unknown>>) {
      if (value.type !== "synthetic") continue;
      const message = { ...record(value.payload), id: value.id, type: value.type, time: value.time };
      const report = prepareStoredMessage(message).notification;
      if (report?.source !== "subagent" || !report.valid || !report.status || !report.worker) continue;
      const at = numberField(record(value.time).created), digest = historyVersion([value.id, at, report]);
      if (seen.has(digest)) continue;
      const fact = { child: report.worker, at, digest }, size = JSON.stringify(fact).length * 2;
      if (reports.length >= parentCounterproofMaxFacts || bytes + size > parentCounterproofMaxBytes) { overflow = true; break; }
      reports.push(fact); seen.add(digest); bytes += size;
      // The native id is retained only as deny-only coverage evidence; it is
      // outside the counterproof byte budget, which SessionChanges re-bounds.
      known.push(typeof value.id === "string" ? { ...fact, id: value.id } : fact);
    }
    const observation: PendingOutcomeRead = { started, completed, reports, ...(overflow ? { overflow } : {}) };
    this.options.observeInbox(session, entries, { started, reports: known, ...(overflow ? { overflow } : {}) });
    this.qualifyInbox(session, observation);
    this.qualifyInboxSnapshot(session);
    return { entries, observation };
  }

  /** The native reply is unchanged. Qualification and source observations run
   * at successful completion, before the caller can filter returned records. */
  async records<T>(request: () => Promise<T>, select: (reply: T) => readonly { value: unknown; requestedId?: string }[]): Promise<T> {
    const started = this.options.recordOrder.next();
    const reply = await request();
    for (const { value, requestedId } of select(reply)) {
      const completed = this.options.recordOrder.next();
      this.qualifyRecord(value, requestedId, { started, completed });
      this.options.observeRecord(value, requestedId);
      const subject = recordSubject(value, requestedId);
      if (subject) this.qualifyRecordSnapshot(subject);
    }
    return reply;
  }

  invalidate(session?: string): void { this.reuse.invalidate(session); }
  dispose(): void { this.reuse.dispose(); }

  private async readComplete(session: string, signal: AbortSignal): Promise<StoredMessage[]> {
    const finish = measureChatWork("opencode-read");
    const started = this.options.historyOrder.next();
    try {
      const byId = new Map<string, StoredMessage>();
      let cursor: string | undefined;
      do {
        const page = await this.options.client.message.list(cursor
          ? { sessionID: session, limit: 100, cursor }
          : { sessionID: session, order: "asc", limit: 100 }, { signal });
        signal.throwIfAborted();
        for (const item of page.data as StoredMessage[]) byId.set(identity(item), item);
        cursor = page.data.length ? page.cursor.next ?? undefined : undefined;
      } while (cursor);
      const messages = [...byId.values()].sort((a, b) => createdAt(a) - createdAt(b));
      // Qualify the current entry, not necessarily this loader's registration:
      // it may have been retired before its first native IO even started.
      // A pending replacement keeps one digest of native returns during its
      // lifetime. Differing replies deny its installation regardless of arrival
      // order; neither reply becomes newer truth or starts replacement IO.
      this.qualifyRecordSnapshot(session);
      const entry = this.reuse.peekObservation(session, this.options.version());
      if (entry) {
        const signature = historyVersion(messages);
        if (entry.rawSignature !== undefined && entry.rawSignature !== signature) this.reuse.invalidate(session);
        else entry.rawSignature = signature;
      }
      this.qualifyInboxSnapshot(session, messages);
      this.options.observeHistory(session, messages);
      this.readOrders.set(messages, { started, completed: this.options.historyOrder.next() });
      return messages;
    } finally { finish(); }
  }

  private qualifyInbox(session: string, observation: PendingOutcomeRead): void {
    const version = this.options.version(), entry = this.reuse.peekObservation(session, version);
    if (!entry || observation.completed <= entry.pendingAfter || !observation.reports.length && !observation.overflow) return;
    const complete = this.reuse.peek(session, version);
    if (!complete || inboxContradicts(complete, observation)) this.reuse.invalidate(session);
  }

  /** A known pre-registration report (the SessionChanges inbox facts) that
   * later disappears, by delivery, eviction or overflow, retires a transcript
   * that lacks it. A pending entry is checked when its transcript returns. */
  private qualifyInboxSnapshot(session: string, loaded?: StoredMessage[]): void {
    const version = this.options.version(), known = this.reuse.peekObservation(session, version)?.inboxSnapshot;
    const current = this.options.inboxFacts(session);
    // SessionChanges keeps the stored facts object across replies with an
    // unchanged raw digest, so identity means no known report disappeared.
    if (!known || current === known) return;
    const gone = { ...known, reports: known.reports.filter(report => !current?.reports.some(next => next.digest === report.digest)) };
    if (!gone.reports.length && !gone.overflow) return;
    const messages = loaded ?? this.reuse.peek(session, version);
    // Delivery may restamp the report's clock; its native id still covers it.
    // Evicted facts are undefined, so every known report counts as gone.
    if (messages && inboxContradicts(messages, gone)) this.reuse.invalidate(session);
  }

  private async coveredRead<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let aborted!: () => void;
    const unavailable = new Promise<never>((_resolve, reject) => { aborted = () => reject(new Error("Native recovery unavailable")); });
    signal.addEventListener("abort", aborted, { once: true });
    try {
      const value = await Promise.race([read(), unavailable]);
      signal.throwIfAborted();
      return value;
    } finally { signal.removeEventListener("abort", aborted); }
  }

  private qualifyRecord(value: unknown, requestedId: string | undefined, order: NativeReadOrder): void {
    const info = record(value), id = text(info.id), directory = text(record(info.location).directory);
    const subject = recordSubject(value, requestedId);
    if (!subject || id !== subject || directory === undefined || path.resolve(directory) !== this.workspace) return;
    const version = this.options.version(), entry = this.reuse.peekObservation(subject, version);
    if (!entry || order.completed <= entry.recordsAfter) return;
    const boundary = text(record(info.revert).messageID) ?? null, previous = entry.visibility;
    if (previous && order.started < previous.started && boundary !== null && previous.boundary === null) this.reuse.invalidate(subject);
    else if (!previous || order.started > previous.started) {
      if (previous && previous.boundary !== null && previous.boundary !== boundary) this.reuse.invalidate(subject);
      else entry.visibility = { boundary, ...order };
    }
  }

  private qualifyRecordSnapshot(session: string): void {
    const snapshot = this.reuse.peekObservation(session, this.options.version())?.recordSnapshot;
    if (snapshot && !snapshot.unchanged()) this.reuse.invalidate(session);
  }
}

/** Overflow, or a relevant report that the transcript does not contain. */
function inboxContradicts(complete: readonly StoredMessage[], observation: Pick<InboxFacts, "reports" | "overflow">): boolean {
  if (observation.overflow) return true;
  const launches = new Map<string, LauncherEvidence[]>(), reports: Array<PendingOutcomeRead["reports"][number] & { id: string }> = [];
  for (const message of complete) {
    const prepared = prepareStoredMessage(message);
    for (const tool of prepared.tools.values()) if (tool.name === "subagent" && tool.fact.reportedChild) {
      const child = tool.fact.reportedChild, facts = launches.get(child) ?? [];
      facts.push(tool.fact); launches.set(child, facts);
    }
    const report = prepared.notification;
    if (report?.source === "subagent" && report.valid && report.status && report.worker) {
      const at = numberField(record(message.time).created);
      reports.push({ child: report.worker, at, digest: historyVersion([identity(message), at, report]), id: identity(message) });
    }
  }
  const missing = { ...observation, reports: observation.reports.filter(report => !reports.some(cached => cached.digest === report.digest
    || report.id !== undefined && cached.id === report.id && cached.child === report.child)) };
  return [...launches].some(([child, facts]) => pendingOutcomeSignature(missing, child, facts) !== undefined);
}

/** Also used by the independent worker activity veto; equality grants no report. */
export function pendingOutcomeSignature(read: Pick<PendingOutcomeRead, "reports">, child: string, launches: readonly LauncherEvidence[]): string | undefined {
  let start: number | undefined = Infinity;
  for (const launch of launches) {
    const at = launch.ran ?? launch.created;
    if (at === undefined) { start = undefined; break; }
    start = Math.min(start, at);
  }
  if (start === Infinity) start = undefined;
  const parts = [...new Set(read.reports.filter(report => report.child === child
    && (start === undefined || report.at === undefined || report.at >= start)).map(report => report.digest))].sort();
  return parts.length ? historyVersion(parts) : undefined;
}

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function recordSubject(value: unknown, requestedId: string | undefined): string | undefined {
  const id = text(record(value).id);
  return requestedId ?? (id !== undefined && id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(id) ? id : undefined);
}
function text(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function identity(value: unknown): string { return text(record(value).id) ?? ""; }
function createdAt(value: unknown): number { const at = record(record(value).time).created; return typeof at === "number" && Number.isFinite(at) ? at : 0; }
