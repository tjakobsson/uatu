import { createHash } from "node:crypto";
import { parentCounterproofMaxBytes, parentCounterproofMaxFacts } from "./native-history";

export type InboxReportFact = Readonly<{ child: string; at?: number; digest: string; id?: string }>;
/** Request-ordered facts of one complete inbox read; overflow means unknown. */
export type InboxFacts = Readonly<{ started: number; reports: readonly InboxReportFact[]; overflow?: true }>;
type State = { revision: number; owners: number; facets: Map<string, { digest: string }>;
  /** Stored facts, the latest request start that confirmed them and their raw reply digest. */
  inbox?: { facts: InboxFacts; started: number; digest?: string } };
export type RecordSnapshot = Readonly<{ unchanged(): boolean }>;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;

/** Observation order, deliberately not request order. Only digests are retained.
 * Exception: the inbox facet also keeps bounded report facts (digest, child, at,
 * native id, overflow) ordered by request start, from complete reads and streamed
 * enqueue/delivery/cancel deltas, because they are deny-only qualification
 * evidence for native-history reuse. Its digest and counter keep the general
 * rule. A streamed revert stage is an ordinary digest facet ("stage") that record
 * snapshots also cover. Active consumers pin their session, so eviction cannot
 * reset their revision. */
export class SessionChanges {
  private readonly sessions = new Map<string, State>();
  constructor(private readonly capacity = 8192, private readonly facetCapacity = 256) {}

  private state(session: string): State {
    let state = this.sessions.get(session);
    if (state) this.sessions.delete(session);
    else state = { revision: 0, owners: 0, facets: new Map() };
    this.sessions.set(session, state);
    for (const [id, candidate] of this.sessions) {
      if (this.sessions.size <= this.capacity) break;
      if (!candidate.owners && id !== session) this.sessions.delete(id);
    }
    return state;
  }

  capture(session: string): { unchanged: () => boolean; release: () => void } {
    const state = this.state(session), revision = state.revision;
    state.owners++;
    let released = false;
    return { unchanged: () => !released && state.revision === revision,
      release: () => { if (!released) { released = true; state.owners--; } } };
  }

  /** A successful local mutation fences every earlier capture, even on replay. */
  advance(session: string): void { this.state(session).revision++; }

  /** Deny-only, non-owning view of an already observed record or streamed
   * revert stage. Looking up a snapshot neither creates state nor refreshes
   * LRU/pins. Object identity detects ABA; missing or recreated session state
   * cannot revive an evicted snapshot. With only a stage known, any later record
   * observation counts as a change. */
  snapshotRecord(session: string): RecordSnapshot | undefined {
    const state = this.sessions.get(session), facet = state?.facets.get("record"), stage = state?.facets.get("stage");
    if (!state || !facet && !stage) return;
    return { unchanged: () => this.sessions.get(session) === state && state.facets.get("record") === facet && state.facets.get("stage") === stage };
  }

  /** A streamed revert stage, kept as the digest-only "stage" facet for record
   * snapshots. A commit or clear frame forgets it without creating state. */
  observeRevertStage(session: string, messageId: string | null): void {
    if (messageId !== null) this.observe(session, "stage", messageId);
    else this.sessions.get(session)?.facets.delete("stage");
  }

  /** The inbox facet's one writer. Facts from an older request never replace a
   * newer one's; facts past the counterproof bounds keep only overflow. A newer
   * reply with the stored reply's raw digest advances request order but keeps
   * the stored facts object, so held snapshots see that no report disappeared. */
  observeInbox(session: string, value: unknown, facts: InboxFacts, initialChange = false): void {
    this.observe(session, "inbox", value, initialChange);
    const state = this.sessions.get(session)!;
    if (state.inbox && facts.started <= state.inbox.started) return;
    // A newer complete read lacking a known report (one only streamed, say)
    // changes the facet for captured consumers even when its raw digest is new.
    if (state.inbox?.facts.reports.some(known => !facts.reports.some(fact => fact.digest === known.digest))) state.revision++;
    const digest = state.facets.get("inbox")?.digest;
    if (state.inbox && digest !== undefined && digest === state.inbox.digest) { state.inbox.started = facts.started; return; }
    this.storeInbox(state, facts, digest);
  }

  /** Streamed deltas update the same request-ordered facts: an enqueue adds its
   * report; a delivery or cancellation removes the report with that native id.
   * A removal never creates state, and a delta has no raw reply digest. */
  observeInboxDelta(session: string, started: number, delta: { add: InboxReportFact; overflow?: true } | { remove: string }): void {
    const state = "add" in delta ? this.state(session) : this.sessions.get(session), previous = state?.inbox;
    if (!state || previous && started <= previous.started) return;
    const kept = previous?.facts.reports ?? [];
    if ("remove" in delta) {
      if (!kept.some(fact => fact.id === delta.remove)) return;
      this.storeInbox(state, { started, reports: kept.filter(fact => fact.id !== delta.remove), ...(previous!.facts.overflow ? { overflow: true } : {}) });
    } else this.storeInbox(state, { started, reports: delta.overflow ? kept : [...kept.filter(fact => fact.digest !== delta.add.digest), delta.add],
      ...(delta.overflow || previous?.facts.overflow ? { overflow: true } : {}) });
  }

  private storeInbox(state: State, facts: InboxFacts, digest?: string): void {
    const bytes = facts.reports.reduce((sum, fact) => sum + JSON.stringify(fact).length * 2, 0);
    state.inbox = { started: facts.started, digest, facts: facts.reports.length > parentCounterproofMaxFacts || bytes > parentCounterproofMaxBytes
      ? { started: facts.started, reports: [], overflow: true } : facts };
  }

  /** Non-owning, like record snapshots: no state creation, LRU refresh or pin.
   * Undefined after eviction, so a held snapshot sees its facts gone. */
  inboxFacts(session: string): InboxFacts | undefined { return this.sessions.get(session)?.inbox?.facts; }

  observe(session: string, facet: string, value: unknown, initialChange = false): void {
    const state = this.state(session);
    const key = facet.startsWith("event:") ? `event:${createHash("sha256").update(facet).digest("hex")}` : facet;
    const digest = createHash("sha256").update(JSON.stringify(canonical(value)) ?? "undefined").digest("hex");
    const previous = state.facets.get(key);
    if (previous?.digest === digest) return;
    // Unknown complete facets initialize state. Native deltas and relevant
    // positive counterproof can explicitly deny an earlier capture even when new.
    if (previous !== undefined || initialChange) state.revision++;
    state.facets.delete(key);
    state.facets.set(key, { digest });
    // Complete native facets must not lose their baseline to streaming traffic.
    // Evicted delta identities conservatively bump when observed again.
    const deltas = [...state.facets.keys()].filter(key => key.startsWith("event:"));
    while (deltas.length > this.facetCapacity) state.facets.delete(deltas.shift()!);
  }
}
