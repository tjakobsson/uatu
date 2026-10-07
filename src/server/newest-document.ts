import type { DocumentMeta } from "../shared/types";

// Indexed max heap: updates/removals cost O(log N), catch-up is O(1), and
// repeated saves do not accumulate stale heap nodes.
export class NewestDocument {
  private heap: DocumentMeta[] = [];
  private positions = new Map<string, number>();
  get id(): string | null { return this.heap[0]?.id ?? null; }

  update(doc: DocumentMeta): void {
    this.remove(doc.id);
    if (doc.kind === "binary") return;
    this.heap.push(doc);
    this.positions.set(doc.id, this.heap.length - 1);
    this.up(this.heap.length - 1);
  }

  remove(id: string): void {
    const index = this.positions.get(id);
    if (index === undefined) return;
    const last = this.heap.pop()!;
    this.positions.delete(id);
    if (index === this.heap.length) return;
    this.heap[index] = last;
    this.positions.set(last.id, index);
    this.down(this.up(index));
  }

  private before(a: DocumentMeta, b: DocumentMeta): boolean {
    return a.mtimeMs > b.mtimeMs || (a.mtimeMs === b.mtimeMs && a.relativePath.localeCompare(b.relativePath) < 0);
  }
  private swap(a: number, b: number): void {
    [this.heap[a], this.heap[b]] = [this.heap[b]!, this.heap[a]!];
    this.positions.set(this.heap[a]!.id, a);
    this.positions.set(this.heap[b]!.id, b);
  }
  private up(index: number): number {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.before(this.heap[index]!, this.heap[parent]!)) break;
      this.swap(index, parent);
      index = parent;
    }
    return index;
  }
  private down(index: number): void {
    while (index * 2 + 1 < this.heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.heap.length && this.before(this.heap[child + 1]!, this.heap[child]!)) child++;
      if (!this.before(this.heap[child]!, this.heap[index]!)) break;
      this.swap(index, child);
      index = child;
    }
  }
}
