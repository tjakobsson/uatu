// Session coordination. File events own the index; Git runs independently.
import type chokidar from "chokidar";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { loadIgnoreMatcher } from "../ignore/engine";
import { collectRepositorySnapshots } from "../document/git-data";
import { isFollowableFile, type BuildSummary, type RootGroup } from "../shared/types";
import { BUILD, BUNDLED_WEB_REVISION, formatBuildIdentifier, WORKSPACE_API_REVISION } from "../shared/version";
import { DEFAULT_WATCH_CONTEXT, type WatchContext } from "../shared/watch-context";
import { normalizeDocumentContext, projectDocumentPatch, projectDocumentSnapshot, sameDocumentContext,
  type DiscoveryState, type DocumentPatch, type DocumentSnapshot, type DocumentRoot } from "../shared/document-updates";
import { StreamLifecycleMetrics, type StreamOutcome } from "../debug/stream-metrics";
import { DEFAULT_RESPECT_GITIGNORE, shouldDenyPath, type WatchEntry } from "./roots";
import { FileIndex, type FileIndexBatch, type FileIndexOptions } from "./file-index";
import { isPolicyFile, rootRelative } from "./watch-policy";
import { createRepositoryRefresh, type RepositoryResults } from "./repository-refresh";
import { observeFiles, type FileObserver } from "./file-observer";
import { classifyGitIgnored, collectIgnoredInventory } from "./git-ignore";
import { isDocumentVisible } from "../shared/file-visibility";
import { createRefreshScheduler } from "./refresh-scheduler";
import { NewestDocument } from "./newest-document";
import { MediaDelivery } from "./media-delivery";

export { createRefreshScheduler, REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS } from "./refresh-scheduler";
export const DOCUMENT_KEEPALIVE_MS = 15_000;
export const BUILD_SUMMARY: BuildSummary = {
  version: BUILD.version, branch: BUILD.branch, commitSha: BUILD.commitSha, commitShort: BUILD.commitShort,
  release: BUILD.release, identifier: formatBuildIdentifier(BUILD), bundledWebRevision: BUNDLED_WEB_REVISION,
};
const encoder = new TextEncoder();
const KEEPALIVE_FRAME = ": keepalive\n\n";

export type WatchSessionOptions = {
  collectRepositories?: typeof collectRepositorySnapshots;
  usePolling?: boolean;
  respectGitignore?: boolean;
  terminalEnabled?: boolean;
  keepaliveIntervalMs?: number;
  metrics?: import("../debug/metrics").MetricsRegistry;
  // Controlled classification and observation in lifecycle/resource tests.
  classify?: FileIndexOptions["classify"];
  watch?: typeof chokidar.watch;
  // Live-write window size per root (tests use a small one).
  ignoredWindowLimit?: number;
};

type Subscriber = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  context: WatchContext;
  keepalive: ReturnType<typeof setInterval> | null;
};
type ObservedRoot = {
  visibleNewest: NewestDocument;
  classificationWaiters: Map<string, { revision: number; resolve: () => void }[]>;
  index: FileIndex;
  watcher: FileObserver;
  ready: boolean;
  finish: () => void;
};

async function policyRevision(entry: WatchEntry): Promise<string> {
  if (entry.kind !== "dir") return "";
  return (await Promise.all([".uatu.json"].map(async name => {
    const stats = await stat(path.join(entry.absolutePath, name), { bigint: true }).catch(() => null);
    return stats ? `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}` : "unreadable";
  }))).join("|");
}

export class FolderListingError extends Error {
  constructor(readonly status: 400 | 404, message: string) { super(message); }
}
const DIRECTORY = { isDirectory: () => true, isSymbolicLink: () => false };

export type WatchSession = ReturnType<typeof createWatchSession>;
export function createWatchSession(entries: WatchEntry[], initialFollow: boolean, options: WatchSessionOptions = {}) {
  const epoch = crypto.randomUUID();
  const terminalToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const metrics = options.metrics;
  const streamMetrics = new StreamLifecycleMetrics(metrics);
  const roots = new Map<string, ObservedRoot>();
  const policies = new Map<string, FileIndex["policy"]>();
  const prepared = new Map(entries.map(entry => [entry.absolutePath, Promise.withResolvers<ObservedRoot | null>()]));
  const owned = new Set<ObservedRoot>();
  const subscribers = new Set<Subscriber>();
  const recovery = new Map<string, Promise<void>>();
  const pendingPolicyRecovery = new Set<string>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const failures = new Map<string, number>();
  const rootErrors = new Map<string, string>();
  let sequence = 0;
  let revision = 0;
  let corpusRevision = 0;
  let latestFollowOrder = 0;
  const latestChanges = new Map<boolean, { id: string; revision: number; order: number }>();
  const cancellation = new AbortController();
  const classificationQueue = new Map<ObservedRoot, Set<string>>();
  let classificationRunning: Promise<void> | null = null;
  const initialShowIgnored = (): boolean => {
    if (options.respectGitignore === false) return true;
    for (const root of roots.values()) {
      if (root.index.entry.kind === "dir" && root.index.matcher.explicitInitialShowIgnored === false) return false;
    }
    return true;
  };
  let generatedAt = Date.now();
  let stopped = false;
  let startPromise: Promise<void> | null = null;
  let publishedRepositories: RepositoryResults | null = null;
  const nextRevision = () => ++sequence;
  const media = new MediaDelivery({ epoch, metrics, lookup: (rootId, relativePath) => {
    const root = roots.get(rootId);
    if (!root) return undefined;
    const entry = root.index.entry;
    const id = path.resolve(entry.kind === "dir" ? entry.absolutePath : entry.parentDir, relativePath);
    const doc = root.index.documents.get(id);
    if (!doc || doc.relativePath !== relativePath || !policies.get(rootId)?.accepts(id)) return undefined;
    root.index.pin(id);
    return { doc, entry, fingerprint: recovery.has(rootId) ? null : root.index.fingerprint(id, doc.revision) };
  } });
  const find = (id: string) => {
    for (const root of roots.values()) {
      const doc = root.index.documents.get(id);
      if (doc && policies.get(doc.rootId)?.accepts(id)) return doc;
    }
    return undefined;
  };
  const rootHeader = (entry: WatchEntry): DocumentRoot => roots.get(entry.absolutePath)?.index.metadata() ?? {
    id: entry.absolutePath, path: entry.kind === "dir" ? entry.absolutePath : entry.parentDir,
    label: path.basename(entry.absolutePath) || entry.absolutePath, hiddenCount: 0,
  };
  const unscopedRoots = () => entries.map(entry => {
    const root = roots.get(entry.absolutePath);
    const snapshot = root?.index.snapshot() ?? { ...rootHeader(entry), docs: [] };
    const policy = policies.get(entry.absolutePath);
    if (root && policy && root.index.policy !== policy) {
      snapshot.docs = snapshot.docs.filter(doc => policy.accepts(doc.id));
      if (snapshot.folders) snapshot.folders = snapshot.folders.filter(folder => policy.accepts(folder.id, DIRECTORY));
    }
    return snapshot;
  });
  const discovery = (): DiscoveryState => {
    const statuses = [...roots.values()].map(root => root.index.discovery);
    const message = rootErrors.values().next().value ?? statuses.find(state => state.message)?.message;
    return {
      status: message ? "error" : recovery.size ? "recovering" : roots.size !== entries.length || statuses.some(state => state.status !== "ready") ? "indexing" : "ready",
      discovered: statuses.reduce((n, state) => n + state.discovered, 0),
      ...(message ? { message } : {}),
    };
  };
  const normalize = (context: WatchContext): WatchContext => {
    if (entries.length === 1 && entries[0]?.kind === "file") return { ...context, scope: { kind: "file", documentId: entries[0].absolutePath } };
    return normalizeDocumentContext(context, discovery(), find);
  };
  const newest = (context: WatchContext = DEFAULT_WATCH_CONTEXT): string | null => {
    let best: ReturnType<typeof find>;
    for (const root of roots.values()) {
      const id = context.showIgnored === false ? root.visibleNewest.id : root.index.newest.id;
      const candidate = id ? root.index.documents.get(id) : undefined;
      if (candidate && (!best || candidate.mtimeMs > best.mtimeMs || candidate.mtimeMs === best.mtimeMs && candidate.relativePath.localeCompare(best.relativePath) < 0)) best = candidate;
    }
    return best?.id ?? null;
  };

  const repositories = createRepositoryRefresh({ entries, roots: unscopedRoots, collect: options.collectRepositories,
    usePolling: options.usePolling,
    onObserverEvent: () => metrics?.inc("git_observer.events_total"),
    // Git's exclude sources decide which folders are ignored as a whole.
    onIgnorePolicyChange: () => { queueAllClassifications(); recoverIgnoredFolders(); },
    onPoll: () => queueAllClassifications(),
    onFallback: () => metrics?.inc("git_observer.fallback_total"),
    publish: (results, freshness) => {
      if (stopped) return;
      const changed = results !== publishedRepositories;
      publishedRepositories = results;
      publish({ upserts: [], removals: [], changedId: null, repositoryState: freshness }, changed);
    },
  });

  const classificationScheduler = createRefreshScheduler(() => { void drainClassifications(); });
  function queueClassifications(root: ObservedRoot, ids: Iterable<string>) {
    if (stopped) return;
    let pending = classificationQueue.get(root);
    if (!pending) classificationQueue.set(root, pending = new Set());
    for (const id of ids) pending.add(id);
    classificationScheduler.schedule();
  }
  function queueAllClassifications() {
    for (const root of roots.values()) queueClassifications(root, root.index.documents.keys());
  }
  function finishClassifications(root: ObservedRoot) {
    for (const waiters of root.classificationWaiters.values()) for (const waiter of waiters) waiter.resolve();
    root.classificationWaiters.clear();
  }
  function drainClassifications(): Promise<void> {
    if (classificationRunning) return classificationRunning;
    classificationRunning = (async () => {
      while (!stopped && classificationQueue.size) {
        const [root, pending] = classificationQueue.entries().next().value!;
        const ids: string[] = [];
        for (const id of pending) { ids.push(id); if (ids.length === 256) break; }
        for (const id of ids) pending.delete(id);
        if (!pending.size) classificationQueue.delete(root);
        const before = ids.map(id => root.index.documents.get(id));
        const statuses = await classifyGitIgnored(root.index.entry.kind === "dir" ? root.index.entry.absolutePath : root.index.entry.parentDir, ids, cancellation.signal);
        if (stopped || roots.get(root.index.entry.absolutePath) !== root) { finishClassifications(root); continue; }
        const upserts: import("../shared/document-updates").RevisionedDocument[] = [];
        for (let i = 0; i < ids.length; i++) {
          const doc = before[i];
          if (!doc || root.index.documents.get(doc.id) !== doc || doc.gitIgnoreStatus === statuses[i]) continue;
          const next = { ...doc, gitIgnoreStatus: statuses[i]! };
          root.index.documents.set(doc.id, next);
          if (isDocumentVisible(next, false)) root.visibleNewest.update(next); else root.visibleNewest.remove(next.id);
          upserts.push(next);
        }
        if (upserts.length) { corpusRevision++; publish({ upserts, removals: [], changedId: null }); }
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i]!;
          const processed = before[i]?.revision ?? (root.index.documents.has(id) ? -1 : Infinity);
          const waiters = root.classificationWaiters.get(id) ?? [];
          const remaining = waiters.filter(waiter => {
            if (waiter.revision > processed) return true;
            waiter.resolve(); return false;
          });
          if (remaining.length) root.classificationWaiters.set(id, remaining);
          else root.classificationWaiters.delete(id);
        }
      }
    })().finally(() => {
      classificationRunning = null;
      if (!stopped && classificationQueue.size) return drainClassifications();
    });
    return classificationRunning;
  }

  // A reconnecting client follows the latest change only while that file is
  // still present and still one Follow can show (see `isFollowableFile`).
  const isFollowableLatestChange = (id: string): boolean => {
    const doc = find(id);
    return doc !== undefined && isFollowableFile(doc);
  };

  function snapshot(context: WatchContext = DEFAULT_WATCH_CONTEXT, changedId: string | null = null): DocumentSnapshot {
    const normalized = normalize(context);
    const state: DocumentSnapshot = {
      kind: "snapshot", epoch, revision, workspaceApiRevision: WORKSPACE_API_REVISION,
      roots: unscopedRoots(), repositories: repositories.results[normalized.compareTarget], compareTarget: normalized.compareTarget,
      initialFollow, initialShowIgnored: initialShowIgnored(), defaultDocumentId: discovery().status === "ready" ? newest(normalized) : null, changedId, generatedAt, build: BUILD_SUMMARY,
      scope: { kind: "folder" }, discovery: discovery(), repositoryState: repositories.freshness,
      unscopedFingerprint: `${epoch}:${corpusRevision}`, terminal: options.terminalEnabled ? "enabled" : "disabled",
      ...(() => {
        const latest = latestChanges.get(normalized.showIgnored !== false);
        return latest && isFollowableLatestChange(latest.id) && isDocumentVisible(find(latest.id)!, normalized.showIgnored)
          ? { latestChange: { id: latest.id, revision: latest.revision } } : {};
      })(),
    };
    return projectDocumentSnapshot(state, normalized, state.repositories);
  }

  function send(subscriber: Subscriber, value: DocumentSnapshot | DocumentPatch) {
    try { subscriber.controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(value)}\n\n`)); }
    catch { drop(subscriber, "failed"); }
  }
  function publish(fields: Pick<DocumentPatch, "upserts" | "removals" | "changedId"> & Partial<DocumentPatch>, repo = false, candidates: { id: string; order: number }[] = []) {
    if (stopped) return;
    const previousRevision = revision;
    revision = nextRevision();
    const previousOrders = new Map([...latestChanges].map(([show, latest]) => [show, latest.order]));
    for (const show of [true, false]) {
      const candidate = candidates.find(candidate => { const doc = find(candidate.id); return doc && isDocumentVisible(doc, show); });
      if (candidate && candidate.order > (latestChanges.get(show)?.order ?? 0)) latestChanges.set(show, { ...candidate, revision });
    }
    generatedAt = Math.max(Date.now(), generatedAt + 1);
    const patch: DocumentPatch = {
      kind: "patch", epoch, previousRevision, revision, generatedAt,
      ...DEFAULT_WATCH_CONTEXT, unscopedFingerprint: `${epoch}:${corpusRevision}`,
      initialShowIgnored: initialShowIgnored(), discovery: discovery(), defaultDocumentId: discovery().status === "ready" ? newest() : null, ...fields,
    };
    for (const subscriber of subscribers) {
      const context = normalize(subscriber.context);
      if (!sameDocumentContext(context, subscriber.context)) {
        subscriber.context = context;
        send(subscriber, snapshot(context, patch.changedId));
        continue;
      }
      const headers = entries.filter(entry => context.scope.kind === "folder" || roots.get(entry.absolutePath)?.index.documents.has(context.scope.documentId)).map(rootHeader);
      const candidate = candidates.find(candidate => { const doc = find(candidate.id); return candidate.order > (previousOrders.get(context.showIgnored !== false) ?? 0) && doc && isDocumentVisible(doc, context.showIgnored) && (context.scope.kind === "folder" || doc.id === context.scope.documentId); });
      send(subscriber, projectDocumentPatch({ ...patch, changedId: candidates.length ? candidate?.id ?? null : patch.changedId,
        defaultDocumentId: discovery().status === "ready" ? newest(context) : null }, context, headers, repo ? repositories.results[context.compareTarget] : undefined));
    }
    metrics?.inc("refresh.completed_total");
    metrics?.set("refresh.last_success_at", Date.now());
  }
  function fileBatch(root: ObservedRoot, batch: FileIndexBatch) {
    if (stopped || roots.get(root.index.entry.absolutePath) !== root) return;
    const policy = policies.get(root.index.entry.absolutePath)!;
    const upserts = batch.upserts.filter(doc => policy.accepts(doc.id));
    const removals = [...batch.removals, ...batch.upserts.filter(doc => !policy.accepts(doc.id)).map(doc => ({ rootId: doc.rootId, id: doc.id }))];
    const folderUpserts = (batch.folderUpserts ?? []).filter(folder => policy.accepts(folder.id, DIRECTORY));
    const folderRemovals = [...(batch.folderRemovals ?? []), ...(batch.folderUpserts ?? []).filter(folder => !policy.accepts(folder.id, DIRECTORY)).map(folder => ({ rootId: folder.rootId, id: folder.id }))];
    const folders = { ...(folderUpserts.length ? { folderUpserts } : {}), ...(folderRemovals.length ? { folderRemovals } : {}) };
    for (const doc of upserts) { if (isDocumentVisible(doc, false)) root.visibleNewest.update(doc); else root.visibleNewest.remove(doc.id); }
    for (const removal of removals) root.visibleNewest.remove(removal.id);
    if (batch.upserts.length || batch.removals.length) {
      corpusRevision++;
      // Git does not report ignored output, so a build needs no Git refresh.
      if (!batch.lane) repositories.request();
    }
    if (batch.lane) {
      // Already classified (inside an ignored folder) and never followed.
      publish({ upserts, removals, ...folders, changedId: null });
      return;
    }
    const changedId = batch.changedOrder > latestFollowOrder && batch.changedId && policy.accepts(batch.changedId) ? batch.changedId : null;
    if (changedId) latestFollowOrder = batch.changedOrder;
    publish({ upserts, removals, ...folders, changedId: null });
    queueClassifications(root, upserts.map(doc => doc.id));
    const candidates = (batch.followCandidates ?? (changedId ? [{ id: changedId, order: batch.changedOrder }] : [])).filter(candidate => policy.accepts(candidate.id));
    const classified = Promise.all(candidates.map(candidate => new Promise<void>(resolve => {
      const waiters = root.classificationWaiters.get(candidate.id) ?? [];
      waiters.push({ revision: candidate.order, resolve });
      root.classificationWaiters.set(candidate.id, waiters);
    })));
    if (candidates.length) {
      void drainClassifications();
      void classified.then(() => {
        if (stopped) return;
        const current = candidates.filter(candidate => find(candidate.id)?.revision === candidate.order);
        if (current.length) publish({ upserts: [], removals: [], changedId: null }, false, current);
      });
    }
  }

  async function observe(entry: WatchEntry, staged = false): Promise<ObservedRoot | null> {
    const policyBefore = await policyRevision(entry);
    const matcher = await loadIgnoreMatcher({ rootPath: entry.kind === "dir" ? entry.absolutePath : entry.parentDir,
      respectGitignore: options.respectGitignore ?? DEFAULT_RESPECT_GITIGNORE, isSingleFileRoot: entry.kind === "file" });
    // Folders Git ignores as a whole are listed, not walked.
    const ignored = entry.kind === "dir" ? await collectIgnoredInventory(entry.absolutePath, cancellation.signal) : null;
    if (stopped) return null;
    let root!: ObservedRoot;
    const index = new FileIndex(entry, matcher, { revision: nextRevision, classify: options.classify, publish: batch => fileBatch(root, batch), ignored,
      windowLimit: options.ignoredWindowLimit,
      onWork: kind => metrics?.inc(`index.${kind}_total`),
      onInvalidate: (id, descendants) => media.invalidate(entry.absolutePath, id, descendants),
    });
    policies.set(entry.absolutePath, index.policy);
    const watcher: FileObserver = options.watch ? options.watch(entry.absolutePath, {
      ignoreInitial: false, alwaysStat: true, followSymlinks: false, atomic: true, awaitWriteFinish: false,
      usePolling: options.usePolling ?? false, interval: 100, ignored: index.policy.ignored,
    }) : observeFiles(entry, { ignored: index.policy.ignored, usePolling: options.usePolling, renew: staged,
      unlisted: directory => index.isUnlistedDirectory(directory),
      classifyNew: directory => index.classifyNewDirectory(directory),
      onWork: kind => metrics?.inc(`index.${kind}_total`),
    });
    const ready = Promise.withResolvers<void>();
    root = { index, watcher, visibleNewest: new NewestDocument(), classificationWaiters: new Map(), ready: false, finish: () => ready.resolve() };
    owned.add(root);
    if (!staged) { roots.set(entry.absolutePath, root); prepared.get(entry.absolutePath)?.resolve(root); }
    watcher.on("all", (event, file, stats) => {
      if (stopped || !owned.has(root)) return;
      metrics?.inc(`watcher.events_total.${event}`);
      if (isPolicyFile(entry, path.resolve(file)) && (root.ready || event === "change" || event === "unlink")) {
        if (path.basename(file) === ".gitignore") {
          queueAllClassifications();
          // Policy metadata updates its own row, but is not Follow intent.
          index.observe(event, file, stats, true);
          // Which folders are ignored as a whole may have changed.
          if (entry.kind === "dir") void recover(entry, true).catch(() => {});
          return;
        }
        void recover(entry, true).catch(() => {});
        return;
      }
      index.observe(event, file, stats);
    });
    // Every path the native watcher saw, excluded ones included. The content
    // policy drops built-in folders (dist/, build/, node_modules) and
    // .uatu.json excludes that Git may still track; the Git observer filters
    // these by Git's own ignore rules. Accepted paths also arrive here and
    // coalesce with the file batch's own repository request.
    watcher.on("raw", (_event: string, file: string) => {
      if (!stopped && owned.has(root)) repositories.noteWorkingTreeChange(file);
    });
    watcher.once("ready", () => {
      root.ready = true; index.markReady();
      void index.idle().then(() => ready.resolve());
    });
    watcher.on("error", error => {
      media.invalidate(entry.absolutePath);
      metrics?.inc("watcher.errors_total");
      index.fail(error);
      rootErrors.set(entry.absolutePath, error instanceof Error ? error.message : String(error));
      ready.reject(error);
      if (!staged) scheduleRecovery(entry);
    });
    try { await ready.promise; }
    catch (error) {
      if (staged) { index.stop(); owned.delete(root); await watcher.close(); }
      throw error;
    }
    // Initial add events describe the watcher's baseline, not edits. A policy
    // changed after matcher loading can already be in that baseline, leaving
    // no change event to reconcile it. Check the registration gap explicitly.
    if (!stopped && policyBefore !== await policyRevision(entry)) {
      if (staged) pendingPolicyRecovery.add(entry.absolutePath);
      else await recover(entry, true);
    }
    return stopped ? null : root;
  }

  function scheduleRecovery(entry: WatchEntry) {
    if (stopped || retryTimers.has(entry.absolutePath)) return;
    const attempts = (failures.get(entry.absolutePath) ?? 0) + 1;
    failures.set(entry.absolutePath, attempts);
    if (attempts > 3) return;
    const timer = setTimeout(() => {
      retryTimers.delete(entry.absolutePath);
      void recover(entry).catch(() => scheduleRecovery(entry));
    }, 250 * 2 ** (attempts - 1));
    retryTimers.set(entry.absolutePath, timer);
  }
  function recover(entry: WatchEntry, policyChanged = false): Promise<void> {
    const current = recovery.get(entry.absolutePath);
    if (current) {
      if (policyChanged) pendingPolicyRecovery.add(entry.absolutePath);
      return current;
    }
    if (stopped) return Promise.resolve();
    media.invalidate(entry.absolutePath);
    const promise = (async () => {
      do {
        pendingPolicyRecovery.delete(entry.absolutePath);
        const old = roots.get(entry.absolutePath);
        const next = await observe(entry, true);
        if (!next || stopped) return;
        roots.set(entry.absolutePath, next);
        // Listed levels survive while their folder is still ignored.
        for (const level of old?.index.ignoredFolders.listedFolders ?? []) {
          if (next.index.ignoredFolders.isInside(level)) await listLevel(next, level).catch(() => {});
        }
        for (const doc of next.index.documents.values()) if (isDocumentVisible(doc, false)) next.visibleNewest.update(doc);
        queueClassifications(next, next.index.documents.keys());
        rootErrors.delete(entry.absolutePath);
        failures.delete(entry.absolutePath);
        if (old) { owned.delete(old); old.index.stop(); old.finish(); finishClassifications(old); await old.watcher.close(); }
        corpusRevision++;
        repositories.request();
        // A policy edit can arrive after the replacement loaded its matcher.
        // Keep one follow-up pass so coalescing cannot discard that edit.
      } while (!stopped && pendingPolicyRecovery.has(entry.absolutePath));
    })().catch(error => {
      rootErrors.set(entry.absolutePath, error instanceof Error ? error.message : String(error));
      throw error;
    }).finally(() => {
      recovery.delete(entry.absolutePath);
      pendingPolicyRecovery.delete(entry.absolutePath);
      if (stopped) return;
      revision = nextRevision(); generatedAt = Math.max(Date.now(), generatedAt + 1);
      for (const subscriber of subscribers) { subscriber.context = normalize(subscriber.context); send(subscriber, snapshot(subscriber.context)); }
    });
    recovery.set(entry.absolutePath, promise);
    publish({ upserts: [], removals: [], changedId: null });
    return promise;
  }

  function recoverIgnoredFolders() {
    for (const entry of entries) if (entry.kind === "dir") void recover(entry, true).catch(() => {});
  }

  // Lists one level of an ignored folder into the shared index: subfolders
  // become folder entries and files are admitted as documents. The watcher
  // reads the level from now on. Resolves once the level is published.
  async function listLevel(root: ObservedRoot, relative: string): Promise<"listed" | "missing"> {
    const entry = root.index.entry;
    if (entry.kind !== "dir") throw new FolderListingError(404, "not a directory root");
    const directory = path.join(entry.absolutePath, ...relative.split("/"));
    if (!root.index.ignoredFolders.isInside(relative)) throw new FolderListingError(404, "not an ignored folder");
    if (!root.index.policy.accepts(directory, DIRECTORY)) throw new FolderListingError(404, "folder not found");
    let current = entry.absolutePath;
    for (const segment of relative.split("/")) {
      current = path.join(current, segment);
      const stats = await lstat(current).catch(() => null);
      if (!stats) { root.index.forgetFolder(directory); await root.index.idle(); return "missing"; }
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new FolderListingError(404, "folder not found");
    }
    const contained = path.relative(await realpath(entry.absolutePath), await realpath(directory));
    if (contained === ".." || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) throw new FolderListingError(404, "folder not found");
    root.index.markListed(directory);
    const children = await readdir(directory, { withFileTypes: true }).catch(() => null);
    if (!children) { root.index.forgetFolder(directory); await root.index.idle(); return "missing"; }
    for (const child of children) {
      const file = path.join(directory, child.name);
      if (child.isSymbolicLink() || !root.index.policy.accepts(file, child)) continue;
      if (child.isDirectory()) root.index.admitFolder(file);
      else if (child.isFile()) {
        const stats = await lstat(file).catch(() => null);
        if (stats?.isFile()) root.index.observe("add", file, stats, true);
      }
    }
    root.watcher.reveal?.(directory);
    await root.index.idle();
    return "listed";
  }

  function drop(subscriber: Subscriber, outcome: StreamOutcome) {
    if (subscriber.keepalive) clearInterval(subscriber.keepalive);
    subscriber.keepalive = null;
    if (subscribers.delete(subscriber)) streamMetrics.closed("document", outcome);
    repositories.demand(subscribers.size > 0);
  }

  return {
    start() {
      startPromise ??= Promise.all(entries.map(entry => observe(entry).catch(error => {
        prepared.get(entry.absolutePath)?.resolve(null);
        rootErrors.set(entry.absolutePath, error instanceof Error ? error.message : String(error));
        scheduleRecovery(entry);
      }))).then(() => {
        if (!stopped) { publish({ upserts: [], removals: [], changedId: null }); repositories.request(); }
      });
      return startPromise;
    },
    async stop() {
      media.stop();
      stopped = true; repositories.stop(); cancellation.abort(); classificationScheduler.cancel(); classificationQueue.clear();
      for (const pending of prepared.values()) pending.resolve(null);
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      for (const subscriber of [...subscribers]) {
        drop(subscriber, "completed");
        try { subscriber.controller.close(); } catch { /* Peer already closed. */ }
      }
      await Promise.all([...owned].map(async root => { root.index.stop(); root.finish(); finishClassifications(root); await root.watcher.close(); }));
      await classificationRunning;
      owned.clear();
    },
    async recover() { await Promise.all(entries.map(entry => recover(entry))); },
    requestRepositoryRefresh() { queueAllClassifications(); repositories.request(); },
    async listFolder(rootId: string, relative: string): Promise<{ status: "listed" | "missing"; revision: number }> {
      const normalized = relative.replace(/\/+$/, "");
      if (!normalized || normalized.includes("\0") || normalized.split("/").some(segment => !segment || segment === "." || segment === "..")) {
        throw new FolderListingError(400, "invalid folder path");
      }
      const entry = entries.find(candidate => candidate.absolutePath === rootId);
      if (!entry) throw new FolderListingError(404, "unknown root");
      await recovery.get(rootId);
      const root = roots.get(rootId) ?? await prepared.get(rootId)?.promise;
      if (!root) throw new FolderListingError(404, "unknown root");
      const status = await listLevel(root, normalized);
      return { status, revision };
    },
    async ensureDocument(id: string) {
      const existing = find(id);
      if (existing) roots.get(existing.rootId)?.index.pin(id);
      if (existing && !recovery.has(existing.rootId)) return existing;
      for (const entry of entries) {
        const relative = rootRelative(entry, id);
        if (!relative || shouldDenyPath(relative)) continue;
        const root = roots.get(entry.absolutePath) ?? await prepared.get(entry.absolutePath)?.promise;
        if (!root) continue;
        // Apply the current policy even while an old inventory is retained.
        const matcher = await loadIgnoreMatcher({ rootPath: entry.kind === "dir" ? entry.absolutePath : entry.parentDir,
          respectGitignore: options.respectGitignore ?? DEFAULT_RESPECT_GITIGNORE, isSingleFileRoot: entry.kind === "file" });
        if (entry.kind === "dir" && matcher.shouldIgnore(relative)) continue;
        const base = entry.kind === "dir" ? entry.absolutePath : entry.parentDir;
        const realBase = await realpath(base);
        const realFile = await realpath(id).catch(() => null);
        if (!realFile) continue;
        const contained = path.relative(realBase, realFile);
        if (contained === ".." || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) continue;
        let current = base;
        let allowed = true;
        let leafStats: Stats | null = null;
        for (const segment of relative.split("/")) {
          current = path.join(current, segment);
          const stats = await lstat(current).catch(() => null);
          if (!stats || stats.isSymbolicLink()) { allowed = false; break; }
          leafStats = stats;
        }
        if (!allowed || !leafStats) continue;
        await root.index.request(id, leafStats);
        root.index.pin(id);
        return find(id);
      }
      return undefined;
    },
    findDocument: find,
    pinDocument(id: string) {
      for (const root of roots.values()) if (rootRelative(root.index.entry, path.resolve(id))) root.index.pin(id);
    },
    mediaResponse: (request: Request) => media.response(request),
    getDiscoveryState: discovery,
    documentRevision: (id: string) => `${epoch}:${find(id)?.revision ?? "missing"}`,
    repositoryGeneration: () => repositories.freshness.generation,
    getDocumentRoots(id: string, context: WatchContext = DEFAULT_WATCH_CONTEXT): RootGroup[] {
      const scope = normalize(context).scope;
      if (scope.kind === "file" && scope.documentId !== id) return [];
      const doc = find(id);
      const root = doc ? roots.get(doc.rootId) : undefined;
      return doc && root ? [{ ...root.index.metadata(), docs: [doc] }] : [];
    },
    getRoots(context: WatchContext = DEFAULT_WATCH_CONTEXT) { return snapshot(context).roots; },
    getUnscopedRoots: unscopedRoots,
    getRepositories(context: WatchContext = DEFAULT_WATCH_CONTEXT) { return repositories.results[context.compareTarget]; },
    getTerminalToken: () => terminalToken,
    isTerminalEnabled: () => options.terminalEnabled ?? false,
    getSseSubscriberCount: () => subscribers.size,
    _internalWatcher: () => roots.values().next().value?.watcher ?? null,
    getStatePayload(changedId: string | null = null, context: WatchContext = DEFAULT_WATCH_CONTEXT) {
      for (const root of roots.values()) if (root.index.hasPendingChanges) root.index.flush();
      return snapshot(context, changedId);
    },
    eventsResponse(context: WatchContext = DEFAULT_WATCH_CONTEXT, streamOptions: { reconnect?: boolean } = {}) {
      let subscriber: Subscriber | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const root of roots.values()) if (root.index.hasPendingChanges) root.index.flush();
          subscriber = { controller, context: normalize(context), keepalive: null };
          subscribers.add(subscriber);
          streamMetrics.opened("document", { reconnect: streamOptions.reconnect === true });
          send(subscriber, snapshot(subscriber.context));
          const current = subscriber;
          current.keepalive = setInterval(() => {
            try { controller.enqueue(encoder.encode(KEEPALIVE_FRAME)); } catch { drop(current, "failed"); }
          }, options.keepaliveIntervalMs ?? DOCUMENT_KEEPALIVE_MS);
          current.keepalive.unref?.();
          repositories.demand(true);
        },
        cancel() { if (subscriber) drop(subscriber, "cancelled"); subscriber = null; },
      });
      return new Response(stream, { headers: { "cache-control": "no-cache", connection: "keep-alive", "content-type": "text/event-stream" } });
    },
  };
}
