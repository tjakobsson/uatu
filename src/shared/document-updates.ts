// The document topic uses snapshots for joining/recovery and path batches for
// live changes. Payload revisions belong to the child, independently of Hub
// transport cursors. The same reducer serves the Hub and the browser.
import type { CompareTarget, DocumentMeta, RepositorySnapshot, RootGroup, Scope, StatePayload } from "./types";
import type { WatchContext } from "./watch-context";

export type DiscoveryState = {
  status: "indexing" | "ready" | "recovering" | "error";
  discovered: number;
  message?: string;
};

export type RepositoryFreshness = {
  generation: number;
  status: "pending" | "ready" | "stale" | "error";
  message?: string;
};

export type RevisionedDocument = DocumentMeta & { revision: number };
export type DocumentRoot = Omit<RootGroup, "docs">;
export type RevisionedRoot = DocumentRoot & { docs: RevisionedDocument[] };
export type DocumentReference = { rootId: string; id: string };

export type DocumentSnapshot = Omit<StatePayload, "roots"> & {
  kind: "snapshot";
  epoch: string;
  revision: number;
  roots: RevisionedRoot[];
  discovery: DiscoveryState;
  repositoryState: RepositoryFreshness;
  latestChange?: { id: string; revision: number };
};

export type DocumentPatch = {
  kind: "patch";
  epoch: string;
  previousRevision: number;
  revision: number;
  generatedAt: number;
  scope: Scope;
  compareTarget: CompareTarget;
  // An unchanged context still receives a revision advance. No corpus data
  // needs to be resent just to invalidate widened search results.
  unscopedFingerprint: string;
  upserts: RevisionedDocument[];
  removals: DocumentReference[];
  roots?: DocumentRoot[];
  discovery?: DiscoveryState;
  repositories?: RepositorySnapshot[];
  repositoryState?: RepositoryFreshness;
  defaultDocumentId?: string | null;
  // Only an actual live edit carries intent. Discovery/repository messages
  // must not replay a previous target stored in a recovery snapshot.
  changedId: string | null;
};

export type DocumentUpdate = DocumentSnapshot | DocumentPatch;
export type ApplyDocumentUpdateResult = "applied" | "ignored" | "resync";

export function sameDocumentContext(a: WatchContext, b: WatchContext): boolean {
  return a.compareTarget === b.compareTarget && a.scope.kind === b.scope.kind
    && (a.scope.kind === "folder" || (b.scope.kind === "file" && a.scope.documentId === b.scope.documentId));
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

type IndexedRoot = {
  metadata: DocumentRoot;
  documents: Map<string, RevisionedDocument>;
  rows: RevisionedDocument[];
  positions: Map<string, number>;
};

export class DocumentStateIndex {
  private header: Omit<DocumentSnapshot, "roots"> | null = null;
  private roots = new Map<string, IndexedRoot>();
  private documents = new Map<string, Map<string, RevisionedDocument>>();
  private binaries = 0;

  get epoch(): string | null { return this.header?.epoch ?? null; }
  get revision(): number | null { return this.header?.revision ?? null; }
  get discovery(): DiscoveryState | undefined { return this.header?.discovery; }
  get latestChange(): DocumentSnapshot["latestChange"] { return this.header?.latestChange; }
  get binaryCount(): number { return this.binaries; }
  get documentCount(): number { let count = 0; for (const root of this.roots.values()) count += root.documents.size; return count; }

  find(id: string, rootId?: string): RevisionedDocument | undefined {
    return rootId === undefined
      ? this.documents.get(id)?.values().next().value
      : this.roots.get(rootId)?.documents.get(id);
  }

  apply(update: DocumentUpdate): ApplyDocumentUpdateResult {
    if (!update.epoch || !validRevision(update.revision)) return "resync";
    if (update.kind === "snapshot") return this.replace(update);
    const header = this.header;
    if (!header || update.epoch !== header.epoch || !sameDocumentContext(header, update)
      || !validRevision(update.previousRevision) || update.revision <= update.previousRevision) return "resync";
    if (update.revision <= header.revision) return "ignored";
    if (update.previousRevision !== header.revision) return "resync";

    // Validate the entire batch before mutating any entry. A malformed tail
    // must not leave the Hub's retained snapshot partially applied.
    const newRoots = update.roots && new Map(update.roots.map(root => [root.id, root]));
    if (newRoots && newRoots.size !== update.roots!.length) return "resync";
    const seen = new Map<string, Set<string>>();
    for (const doc of update.upserts) {
      if (!(newRoots?.has(doc.rootId) ?? this.roots.has(doc.rootId))
        || !validRevision(doc.revision) || doc.revision > update.revision
        || doc.revision < (this.find(doc.id, doc.rootId)?.revision ?? 0)) return "resync";
      let ids = seen.get(doc.rootId);
      if (!ids) seen.set(doc.rootId, ids = new Set());
      if (ids.has(doc.id)) return "resync";
      ids.add(doc.id);
    }
    for (const removal of update.removals) {
      if (!this.roots.has(removal.rootId) || seen.get(removal.rootId)?.has(removal.id)) return "resync";
    }

    if (newRoots) {
      for (const [id, root] of this.roots) {
        if (newRoots.has(id)) continue;
        for (const doc of root.documents.values()) this.remove(doc);
        this.roots.delete(id);
      }
      for (const [id, metadata] of newRoots) {
        const root = this.roots.get(id);
        if (root) root.metadata = { ...metadata };
        else this.roots.set(id, { metadata: { ...metadata }, documents: new Map(), rows: [], positions: new Map() });
      }
    }
    for (const removal of update.removals) this.remove(removal);
    for (const doc of update.upserts) this.put(doc);
    this.header = {
      ...header,
      revision: update.revision,
      generatedAt: update.generatedAt,
      unscopedFingerprint: update.unscopedFingerprint,
      changedId: update.changedId,
      ...(update.changedId ? { latestChange: { id: update.changedId, revision: update.revision } } : {}),
      ...(update.defaultDocumentId === undefined ? {} : { defaultDocumentId: update.defaultDocumentId }),
      ...(update.discovery ? { discovery: update.discovery } : {}),
      ...(update.repositories ? { repositories: update.repositories } : {}),
      ...(update.repositoryState ? { repositoryState: update.repositoryState } : {}),
    };
    return "applied";
  }

  // Materializing a full inventory is deliberately explicit. Normal patch
  // application only visits entries in that patch.
  snapshot(): DocumentSnapshot | null {
    if (!this.header) return null;
    return {
      ...this.header,
      roots: [...this.roots.values()].map(root => ({
        ...root.metadata,
        docs: [...root.documents.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      })),
    };
  }

  // Browser-facing arrays are updated in place by path. Consumers must treat
  // these as read-only views and use snapshot() for an independent baseline.
  view(): DocumentSnapshot | null {
    return this.header ? { ...this.header, roots: [...this.roots.values()].map(root => ({ ...root.metadata, docs: root.rows })) } : null;
  }

  private replace(snapshot: DocumentSnapshot): ApplyDocumentUpdateResult {
    if (this.header?.epoch === snapshot.epoch) {
      if (!sameDocumentContext(this.header, snapshot)) return "resync";
      if (snapshot.revision < this.header.revision) return "ignored";
    }
    const roots = new Map<string, IndexedRoot>();
    for (const { docs, ...metadata } of snapshot.roots) {
      if (roots.has(metadata.id)) return "resync";
      const documents = new Map<string, RevisionedDocument>();
      for (const doc of docs) {
        if (doc.rootId !== metadata.id || documents.has(doc.id)
          || !validRevision(doc.revision) || doc.revision > snapshot.revision) return "resync";
        documents.set(doc.id, doc);
      }
      roots.set(metadata.id, { metadata, documents, rows: [...docs], positions: new Map(docs.map((doc, index) => [doc.id, index])) });
    }
    const { roots: _, ...header } = snapshot;
    this.header = header;
    this.roots = roots;
    this.binaries = snapshot.roots.reduce((count, root) => count + root.docs.filter(doc => doc.kind === "binary").length, 0);
    this.documents.clear();
    for (const root of roots.values()) for (const doc of root.documents.values()) this.put(doc);
    return "applied";
  }

  private put(doc: RevisionedDocument): void {
    const root = this.roots.get(doc.rootId)!;
    if (root.documents.get(doc.id)?.kind === "binary") this.binaries--;
    if (doc.kind === "binary") this.binaries++;
    root.documents.set(doc.id, doc);
    const position = root.positions.get(doc.id);
    if (position !== undefined) root.rows[position] = doc;
    else { root.positions.set(doc.id, root.rows.length); root.rows.push(doc); }
    let entries = this.documents.get(doc.id);
    if (!entries) this.documents.set(doc.id, entries = new Map());
    entries.set(doc.rootId, doc);
  }

  private remove(reference: DocumentReference): void {
    const root = this.roots.get(reference.rootId);
    const position = root?.positions.get(reference.id);
    if (root && position !== undefined) {
      if (root.documents.get(reference.id)?.kind === "binary") this.binaries--;
      const last = root.rows.pop()!;
      if (position < root.rows.length) { root.rows[position] = last; root.positions.set(last.id, position); }
      root.positions.delete(reference.id);
      root.documents.delete(reference.id);
    }
    const entries = this.documents.get(reference.id);
    entries?.delete(reference.rootId);
    if (entries?.size === 0) this.documents.delete(reference.id);
  }
}

// Missing pins during discovery are not evidence of deletion. The session
// calls this against its authoritative index, never a client-filtered subset.
export function normalizeDocumentContext(
  context: WatchContext,
  discovery: DiscoveryState,
  find: (id: string) => DocumentMeta | undefined,
): WatchContext {
  if (context.scope.kind === "folder" || discovery.status !== "ready") return context;
  const doc = find(context.scope.documentId);
  return doc && doc.kind !== "binary" ? context : { ...context, scope: { kind: "folder" } };
}

export function projectDocumentSnapshot(
  snapshot: DocumentSnapshot,
  context: WatchContext,
  repositories: RepositorySnapshot[] = context.compareTarget === snapshot.compareTarget ? snapshot.repositories : [],
): DocumentSnapshot {
  const scope = context.scope;
  if (scope.kind === "folder") return { ...snapshot, ...context, repositories };
  const roots = snapshot.roots.flatMap(root => {
    const docs = root.docs.filter(doc => doc.id === scope.documentId);
    return docs.length ? [{ ...root, docs }] : [];
  });
  const doc = roots[0]?.docs[0];
  return {
    ...snapshot, ...context, roots, repositories,
    defaultDocumentId: doc && doc.kind !== "binary" ? doc.id : null,
    changedId: snapshot.changedId === scope.documentId ? snapshot.changedId : null,
    latestChange: snapshot.latestChange?.id === scope.documentId ? snapshot.latestChange : undefined,
  };
}

export function unseenSnapshotChange(index: DocumentStateIndex, snapshot: DocumentSnapshot): string | null {
  const change = snapshot.latestChange;
  if (!change) return null;
  return index.epoch !== snapshot.epoch || change.revision > (index.latestChange?.revision ?? -1) ? change.id : null;
}

export function projectDocumentPatch(
  patch: DocumentPatch,
  context: WatchContext,
  // The caller supplies root headers for this context on membership changes.
  // Otherwise an empty pin could not receive its first discovered entry.
  roots?: DocumentRoot[],
  repositories?: RepositorySnapshot[],
): DocumentPatch {
  const scope = context.scope;
  const projected: DocumentPatch = {
    ...patch, ...context,
    upserts: scope.kind === "folder" ? patch.upserts : patch.upserts.filter(doc => doc.id === scope.documentId),
    removals: scope.kind === "folder" ? patch.removals : patch.removals.filter(doc => doc.id === scope.documentId),
    changedId: scope.kind === "folder" || patch.changedId === scope.documentId ? patch.changedId : null,
  };
  if (context.compareTarget !== patch.compareTarget) delete projected.repositories;
  if (repositories !== undefined) projected.repositories = repositories;
  if (scope.kind === "file") {
    delete projected.roots;
    delete projected.defaultDocumentId;
    const selected = projected.upserts[0];
    if (selected) projected.defaultDocumentId = selected.kind === "binary" ? null : selected.id;
    else if (projected.removals.length) projected.defaultDocumentId = null;
  }
  if (roots !== undefined) projected.roots = roots;
  return projected;
}
