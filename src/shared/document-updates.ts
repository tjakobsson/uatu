// The document topic uses snapshots for joining/recovery and path batches for
// live changes. Payload revisions belong to the child, independently of Hub
// transport cursors. The same reducer serves the Hub and the browser.
import type { CompareTarget, DocumentMeta, FolderEntry, RepositorySnapshot, RootGroup, Scope, StatePayload } from "./types";
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
export type RevisionedFolder = FolderEntry;
export type DocumentRoot = Omit<RootGroup, "docs" | "folders">;
export type RevisionedRoot = DocumentRoot & { docs: RevisionedDocument[]; folders?: RevisionedFolder[] };
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
  showIgnored?: boolean;
  initialShowIgnored?: boolean;
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
  // Git-ignored folder entries, keyed by folder id within a root.
  folderUpserts?: RevisionedFolder[];
  folderRemovals?: DocumentReference[];
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
  return (a.showIgnored !== false) === (b.showIgnored !== false) && a.compareTarget === b.compareTarget && a.scope.kind === b.scope.kind
    && (a.scope.kind === "folder" || (b.scope.kind === "file" && a.scope.documentId === b.scope.documentId));
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

type IndexedRoot = {
  metadata: DocumentRoot;
  folders: Map<string, RevisionedFolder>;
  documents: Map<string, RevisionedDocument>;
  rows: RevisionedDocument[];
  positions: Map<string, number>;
};

function sameSearchDocument(a: RevisionedDocument | undefined, b: RevisionedDocument): boolean {
  return a !== undefined && a.revision === b.revision && a.mtimeMs === b.mtimeMs
    && a.name === b.name && a.relativePath === b.relativePath && a.kind === b.kind
    && a.gitIgnoreStatus === b.gitIgnoreStatus && a.ignoreVisibilityException === b.ignoreVisibilityException;
}

export class DocumentStateIndex {
  private header: Omit<DocumentSnapshot, "roots"> | null = null;
  private roots = new Map<string, IndexedRoot>();
  private documents = new Map<string, Map<string, RevisionedDocument>>();
  private binaries = 0;
  // Local ownership token, independent of transport revisions. Repository and
  // discovery messages can advance the stream without changing searchable files.
  private corpus = {};
  // Changes whenever a folder entry is added, removed or listed.
  private folderTree = {};

  get epoch(): string | null { return this.header?.epoch ?? null; }
  get revision(): number | null { return this.header?.revision ?? null; }
  get corpusVersion(): object { return this.corpus; }
  get folderVersion(): object { return this.folderTree; }
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
    const seenFolders = new Map<string, Set<string>>();
    for (const folder of update.folderUpserts ?? []) {
      if (!(newRoots?.has(folder.rootId) ?? this.roots.has(folder.rootId))
        || !validRevision(folder.revision) || folder.revision > update.revision
        || !folder.relativePath.endsWith("/")) return "resync";
      let ids = seenFolders.get(folder.rootId);
      if (!ids) seenFolders.set(folder.rootId, ids = new Set());
      if (ids.has(folder.id)) return "resync";
      ids.add(folder.id);
    }
    for (const removal of update.folderRemovals ?? []) {
      if (!this.roots.has(removal.rootId) || seenFolders.get(removal.rootId)?.has(removal.id)) return "resync";
    }

    if (update.upserts.some(doc => !sameSearchDocument(this.find(doc.id, doc.rootId), doc))
      || update.removals.some(doc => this.find(doc.id, doc.rootId) !== undefined)
      || newRoots && (newRoots.size !== this.roots.size
        || [...newRoots].some(([id, root]) => this.roots.get(id)?.metadata.path !== root.path))) this.corpus = {};

    if (newRoots) {
      for (const [id, root] of this.roots) {
        if (newRoots.has(id)) continue;
        for (const doc of root.documents.values()) this.remove(doc);
        this.roots.delete(id);
      }
      for (const [id, metadata] of newRoots) {
        const root = this.roots.get(id);
        if (root) root.metadata = { ...metadata };
        else this.roots.set(id, { metadata: { ...metadata }, folders: new Map(), documents: new Map(), rows: [], positions: new Map() });
      }
    }
    for (const removal of update.removals) this.remove(removal);
    for (const doc of update.upserts) this.put(doc);
    if (update.folderUpserts?.length || update.folderRemovals?.length) {
      this.folderTree = {};
      for (const removal of update.folderRemovals ?? []) this.roots.get(removal.rootId)?.folders.delete(removal.id);
      for (const folder of update.folderUpserts ?? []) this.roots.get(folder.rootId)!.folders.set(folder.id, folder);
    }
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
        ...(root.folders.size ? { folders: [...root.folders.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)) } : {}),
      })),
    };
  }

  // Browser-facing arrays are updated in place by path. Consumers must treat
  // these as read-only views and use snapshot() for an independent baseline.
  view(): DocumentSnapshot | null {
    return this.header ? { ...this.header, roots: [...this.roots.values()].map(root => ({
      ...root.metadata, docs: root.rows, ...(root.folders.size ? { folders: [...root.folders.values()] } : {}),
    })) } : null;
  }

  private replace(snapshot: DocumentSnapshot): ApplyDocumentUpdateResult {
    if (this.header?.epoch === snapshot.epoch) {
      if (!sameDocumentContext(this.header, snapshot)) return "resync";
      if (snapshot.revision < this.header.revision) return "ignored";
    }
    const roots = new Map<string, IndexedRoot>();
    for (const { docs, folders: folderList = [], ...metadata } of snapshot.roots) {
      if (roots.has(metadata.id)) return "resync";
      const folders = new Map<string, RevisionedFolder>();
      for (const folder of folderList) {
        if (folder.rootId !== metadata.id || folders.has(folder.id) || !folder.relativePath.endsWith("/")
          || !validRevision(folder.revision) || folder.revision > snapshot.revision) return "resync";
        folders.set(folder.id, folder);
      }
      const documents = new Map<string, RevisionedDocument>();
      for (const doc of docs) {
        if (doc.rootId !== metadata.id || documents.has(doc.id)
          || !validRevision(doc.revision) || doc.revision > snapshot.revision) return "resync";
        documents.set(doc.id, doc);
      }
      roots.set(metadata.id, { metadata, folders, documents, rows: [...docs], positions: new Map(docs.map((doc, index) => [doc.id, index])) });
    }
    const { roots: _, ...header } = snapshot;
    // Full comparison is confined to replacement snapshots. Patches above only
    // inspect their changed paths and optional root headers, never the inventory.
    if (!this.header || this.header.epoch !== snapshot.epoch
      || roots.size !== this.roots.size || [...roots].some(([id, root]) => {
        const previous = this.roots.get(id);
        return !previous || previous.metadata.path !== root.metadata.path
          || previous.documents.size !== root.documents.size
          || [...root.documents.values()].some(doc => !sameSearchDocument(previous.documents.get(doc.id), doc));
      })) this.corpus = {};
    if (!this.header || this.header.epoch !== snapshot.epoch || roots.size !== this.roots.size || [...roots].some(([id, root]) => {
      const previous = this.roots.get(id)?.folders;
      return !previous || previous.size !== root.folders.size
        || [...root.folders.values()].some(folder => previous.get(folder.id)?.listed !== folder.listed);
    })) this.folderTree = {};
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
  const roots = snapshot.roots.flatMap(({ folders: _folders, ...root }) => {
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
  return index.epoch !== snapshot.epoch || change.revision > (index.revision ?? -1) ? change.id : null;
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
    delete projected.folderUpserts;
    delete projected.folderRemovals;
    delete projected.roots;
    delete projected.defaultDocumentId;
    const selected = projected.upserts[0];
    if (selected) projected.defaultDocumentId = selected.kind === "binary" ? null : selected.id;
    else if (projected.removals.length) projected.defaultDocumentId = null;
  }
  if (roots !== undefined) projected.roots = roots;
  return projected;
}
