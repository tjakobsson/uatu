import type { DocumentMeta, RootGroup } from "../shared/types";
import type { DocumentPatch } from "../shared/document-updates";

export const fileKey = (doc: Pick<DocumentMeta, "rootId" | "id">): string => `${doc.rootId}\0${doc.id}`;
export const normalizeFileQuery = (value: string): string => value.trim().replaceAll("\\", "/").toLowerCase();
export const matchesFileQuery = (path: string, query: string): boolean => path.toLowerCase().includes(normalizeFileQuery(query));
const normalizedPath = (doc: DocumentMeta) => doc.relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function compareRecent(a: DocumentMeta, b: DocumentMeta): number {
  return b.mtimeMs - a.mtimeMs || compareText(normalizedPath(a), normalizedPath(b))
    || compareText(a.rootId, b.rootId) || compareText(a.id, b.id);
}

export function relativeWriteAge(mtimeMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - mtimeMs) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// Snapshots sort once. Patches remove/reinsert only affected entries, never
// revisiting filesystem or repository data to establish write order.
export class RecentModel {
  private readonly byKey = new Map<string, DocumentMeta>();
  readonly roots = new Map<string, string>();
  private ordered: DocumentMeta[] = [];
  reset(roots: readonly RootGroup[]): void {
    this.byKey.clear(); this.roots.clear();
    for (const root of roots) {
      this.roots.set(root.id, root.label);
      for (const doc of root.docs) this.byKey.set(fileKey(doc), doc);
    }
    this.ordered = [...this.byKey.values()].sort(compareRecent);
  }
  applyPatch(patch: DocumentPatch): void {
    if (patch.roots) {
      const remaining = new Set(patch.roots.map(root => root.id));
      for (const [key, doc] of this.byKey) if (!remaining.has(doc.rootId)) this.byKey.delete(key);
      this.ordered = this.ordered.filter(doc => remaining.has(doc.rootId));
      this.roots.clear();
      for (const root of patch.roots) this.roots.set(root.id, root.label);
    }
    for (const ref of [...patch.removals, ...patch.upserts]) {
      const key = fileKey(ref);
      const previous = this.byKey.get(key);
      if (!previous) continue;
      const index = this.position(previous);
      if (fileKey(this.ordered[index]!) === key) this.ordered.splice(index, 1);
      this.byKey.delete(key);
    }
    for (const doc of patch.upserts) {
      this.byKey.set(fileKey(doc), doc);
      this.ordered.splice(this.position(doc), 0, doc);
    }
  }
  private position(doc: DocumentMeta): number {
    let low = 0, high = this.ordered.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareRecent(this.ordered[middle]!, doc) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  get(key: string): DocumentMeta | undefined { return this.byKey.get(key); }
  entries(query = ""): readonly DocumentMeta[] {
    if (!normalizeFileQuery(query)) return this.ordered;
    return this.ordered.filter(doc => matchesFileQuery(this.searchPath(doc), query));
  }
  searchPath(doc: DocumentMeta): string {
    return `${this.roots.size > 1 ? `${this.roots.get(doc.rootId) ?? doc.rootId}/` : ""}${normalizedPath(doc)}`;
  }
}
