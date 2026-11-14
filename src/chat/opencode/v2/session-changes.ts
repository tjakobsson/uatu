import { createHash } from "node:crypto";

type State = { revision: number; owners: number; facets: Map<string, string> };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;

/** Observation order, deliberately not request order. Only digests are retained.
 * Active consumers pin their session, so eviction cannot reset their revision. */
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

  observe(session: string, facet: string, value: unknown, delta = false): void {
    const state = this.state(session);
    const key = facet.startsWith("event:") ? `event:${createHash("sha256").update(facet).digest("hex")}` : facet;
    const digest = createHash("sha256").update(JSON.stringify(canonical(value)) ?? "undefined").digest("hex");
    const previous = state.facets.get(key);
    if (previous === digest) return;
    // Unknown complete facets initialize state. A delta describes an actual
    // change, not a complete baseline, and therefore advances even when new.
    if (previous !== undefined || delta) state.revision++;
    state.facets.delete(key);
    state.facets.set(key, digest);
    // Complete native facets must not lose their baseline to streaming traffic.
    // Evicted delta identities conservatively bump when observed again.
    const deltas = [...state.facets.keys()].filter(key => key.startsWith("event:"));
    while (deltas.length > this.facetCapacity) state.facets.delete(deltas.shift()!);
  }
}
