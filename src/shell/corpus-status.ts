export type CorpusStatus = "loading" | "ready" | "index-error";
let status: CorpusStatus = "loading";
const listeners = new Set<() => void>();
export function corpusStatus(): CorpusStatus { return status; }
export function setCorpusStatus(next: CorpusStatus): void {
  status = next;
  for (const listener of listeners) listener();
}
export function onCorpusChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
