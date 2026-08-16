export class ProviderTextReconciler {
  private readonly text = new Map<string, string>();

  cumulative(identity: string, value: string): string {
    const current = this.text.get(identity) ?? "";
    const merged = value.includes(current) ? value : current.includes(value) ? current : mergeText(current, value);
    this.text.set(identity, merged);
    return merged.startsWith(current) ? merged.slice(current.length) : "";
  }

  incremental(identity: string, delta: string): string {
    const current = this.text.get(identity) ?? "";
    const merged = mergeText(current, delta);
    this.text.set(identity, merged);
    return merged.slice(current.length);
  }

  value(identity: string): string {
    return this.text.get(identity) ?? "";
  }

  seed(identity: string, value: string): void {
    this.text.set(identity, mergeText(this.text.get(identity) ?? "", value));
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
