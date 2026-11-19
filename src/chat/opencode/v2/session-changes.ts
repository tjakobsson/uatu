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
 * native id, overflow) ordered by request start, because they are deny-only
 * qualification evidence for native-history reuse. Its digest and counter keep
 * the general rule. Active consumers pin their session, so eviction cannot reset
 * their revision. */
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

  /** Deny-only, non-owning view of an already observed record. Looking up a
   * snapshot neither creates state nor refreshes LRU/pins. Object identity detects
   * ABA; missing or recreated session state cannot revive an evicted snapshot. */
  snapshotRecord(session: string): RecordSnapshot | undefined {
    const state = this.sessions.get(session), facet = state?.facets.get("record");
    if (!state || !facet) return;
    return { unchanged: () => this.sessions.get(session) === state && state.facets.get("record") === facet };
  }

  /** The inbox facet's one writer. Facts from an older request never replace a
   * newer one's; facts past the counterproof bounds keep only overflow. A newer
   * reply with the stored reply's raw digest advances request order but keeps
   * the stored facts object, so held snapshots see that no report disappeared. */
  observeInbox(session: string, value: unknown, facts: InboxFacts, initialChange = false): void {
    this.observe(session, "inbox", value, initialChange);
    const state = this.sessions.get(session)!;
    if (state.inbox && facts.started <= state.inbox.started) return;
    const digest = state.facets.get("inbox")?.digest;
    if (state.inbox && digest !== undefined && digest === state.inbox.digest) { state.inbox.started = facts.started; return; }
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
