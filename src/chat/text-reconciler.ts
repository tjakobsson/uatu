export class ProviderTextReconciler {
  private readonly text = new Map<string, string>();
  // Length of each identity's text at its last cumulative confirmation. A
  // delta arriving while nothing has been appended since that confirmation
  // can be a straggler the cumulative already folded in (the classic stream's
  // full text often lands before the native stream's lagging delta) — those
  // are dropped. Once anything incremental has been appended, an identical
  // chunk is legitimate repetition ("\n\n" twice, a repeated token) and must
  // append; content-based dedup here corrupted streamed text.
  private readonly confirmed = new Map<string, number>();

  cumulative(identity: string, value: string): string {
    const current = this.text.get(identity) ?? "";
    const merged = value.includes(current) ? value : current.includes(value) ? current : mergeText(current, value);
    this.text.set(identity, merged);
    this.confirmed.set(identity, merged.length);
    return merged.startsWith(current) ? merged.slice(current.length) : "";
  }

  incremental(identity: string, delta: string): string {
    const current = this.text.get(identity) ?? "";
    const confirmedLength = this.confirmed.get(identity) ?? -1;
    if (delta && current.length === confirmedLength && (current.endsWith(delta) || current.includes(delta))) return "";
    this.text.set(identity, current + delta);
    return delta;
  }

  value(identity: string): string {
    return this.text.get(identity) ?? "";
  }

  seed(identity: string, value: string): void {
    const merged = mergeText(this.text.get(identity) ?? "", value);
    this.text.set(identity, merged);
    this.confirmed.set(identity, merged.length);
  }
}

function mergeText(current: string, incoming: string): string {
  if (!incoming || current.endsWith(incoming) || current.includes(incoming)) return current;
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  const maximum = Math.min(current.length, incoming.length);
  for (let overlap = maximum; overlap > 0; overlap -= 1) {
    if (current.endsWith(incoming.slice(0, overlap))) return current + incoming.slice(overlap);
  }
  return current + incoming;
}
