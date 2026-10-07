import type { RenderedDocument } from "../server/render-dispatch";
import type { FileFacts } from "../shared/types";
import { appUrl } from "../shared/app-url";
import { appState } from "../shell/state";
import { documentRevisionKey } from "../shell/document-state";
import { contextualAppUrl } from "../shell/watch-context";
import { fetchWithinBudget } from "../shell/bounded-fetch";
import { syncFileFactsStrip } from "./file-facts-strip";

type Provenance = { revision: string; generation: number; git?: FileFacts["git"]; gitState: FileFacts["gitState"] };
type FactsRequest = { id: string; controller: AbortController; active: boolean; promise: Promise<Provenance | null> };
const requests = new Map<string, FactsRequest>();

function discard(key: string): void {
  const request = requests.get(key);
  requests.delete(key);
  request?.controller.abort();
}
export function forgetDocumentFacts(id: string): void {
  for (const [key, request] of requests) if (request.id === id) discard(key);
}

export async function enrichDocumentFacts(payload: RenderedDocument, isCurrent: () => boolean): Promise<void> {
  if (!payload.fileFacts || !isCurrent()) return;
  const revision = documentRevisionKey(payload.id);
  const generation = appState.repositoryFreshness.generation;
  const key = `${payload.id}:${revision}:${generation}`;
  // Metadata must not consume all HTTP slots while the reader keeps saving
  // or navigating. Only the current provenance request may remain in flight.
  for (const [otherKey, request] of requests) if (otherKey !== key && request.active) discard(otherKey);
  let pending = requests.get(key);
  if (!pending) {
    const controller = new AbortController();
    const entry: FactsRequest = { id: payload.id, controller, active: true, promise: Promise.resolve(null) };
    entry.promise = fetchWithinBudget((input, init) => fetch(input, { ...init,
      signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
    }), contextualAppUrl(appUrl(`/api/document/facts?id=${encodeURIComponent(payload.id)}`)), 10_000,
      async response => response.ok ? await response.json() as Provenance : null).catch(() => null).finally(() => { entry.active = false; });
    pending = entry;
    requests.set(key, pending);
    while (requests.size > 16) discard(requests.keys().next().value!);
  }
  const facts = await pending.promise;
  if (requests.get(key) !== pending || !isCurrent() || documentRevisionKey(payload.id) !== revision || appState.repositoryFreshness.generation !== generation) return;
  if (facts && (facts.revision !== revision || facts.generation !== generation)) { requests.delete(key); return; }
  payload.fileFacts = { ...payload.fileFacts, git: facts?.git, gitState: facts?.gitState ?? "unavailable" };
  syncFileFactsStrip({ kind: "document", facts: payload.fileFacts });
  if (!facts) requests.delete(key);
}
