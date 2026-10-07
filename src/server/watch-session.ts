// Session coordination. File events own the index; Git runs independently.
import type chokidar from "chokidar";
import { lstat, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { loadIgnoreMatcher } from "../ignore/engine";
import { collectRepositorySnapshots } from "../document/git-data";
import type { BuildSummary, RootGroup } from "../shared/types";
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
};

type Subscriber = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  context: WatchContext;
  keepalive: ReturnType<typeof setInterval> | null;
};
type ObservedRoot = {
  index: FileIndex;
  watcher: FileObserver;
  ready: boolean;
  finish: () => void;
};

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
  let latestChange: DocumentSnapshot["latestChange"];
  let generatedAt = Date.now();
  let stopped = false;
  let startPromise: Promise<void> | null = null;
  let publishedRepositories: RepositoryResults | null = null;
  const nextRevision = () => ++sequence;
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
    if (root && policy && root.index.policy !== policy) snapshot.docs = snapshot.docs.filter(doc => policy.accepts(doc.id));
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
  const newest = (): string | null => {
    let best: ReturnType<typeof find>;
    for (const root of roots.values()) {
      const id = root.index.newest.id;
      const candidate = id ? root.index.documents.get(id) : undefined;
      if (candidate && (!best || candidate.mtimeMs > best.mtimeMs || candidate.mtimeMs === best.mtimeMs && candidate.relativePath.localeCompare(best.relativePath) < 0)) best = candidate;
    }
    return best?.id ?? null;
  };

  const repositories = createRepositoryRefresh({ entries, roots: unscopedRoots, collect: options.collectRepositories,
    onProbe: () => metrics?.inc("reconcile.ticks_total"),
    publish: (results, freshness) => {
      if (stopped) return;
      const changed = results !== publishedRepositories;
      publishedRepositories = results;
      publish({ upserts: [], removals: [], changedId: null, repositoryState: freshness }, changed);
    },
  });

  function snapshot(context: WatchContext = DEFAULT_WATCH_CONTEXT, changedId: string | null = null): DocumentSnapshot {
    const normalized = normalize(context);
    const state: DocumentSnapshot = {
      kind: "snapshot", epoch, revision, workspaceApiRevision: WORKSPACE_API_REVISION,
      roots: unscopedRoots(), repositories: repositories.results[normalized.compareTarget], compareTarget: normalized.compareTarget,
      initialFollow, defaultDocumentId: discovery().status === "ready" ? newest() : null, changedId, generatedAt, build: BUILD_SUMMARY,
      scope: { kind: "folder" }, discovery: discovery(), repositoryState: repositories.freshness,
      unscopedFingerprint: `${epoch}:${corpusRevision}`, terminal: options.terminalEnabled ? "enabled" : "disabled",
      ...(latestChange && find(latestChange.id)?.kind !== "binary" && find(latestChange.id) ? { latestChange } : {}),
    };
    return projectDocumentSnapshot(state, normalized, state.repositories);
  }

  function send(subscriber: Subscriber, value: DocumentSnapshot | DocumentPatch) {
    try { subscriber.controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(value)}\n\n`)); }
    catch { drop(subscriber, "failed"); }
  }
  function publish(fields: Pick<DocumentPatch, "upserts" | "removals" | "changedId"> & Partial<DocumentPatch>, repo = false) {
    if (stopped) return;
    const previousRevision = revision;
    revision = nextRevision();
    if (fields.changedId) latestChange = { id: fields.changedId, revision };
    generatedAt = Math.max(Date.now(), generatedAt + 1);
    const patch: DocumentPatch = {
      kind: "patch", epoch, previousRevision, revision, generatedAt,
      ...DEFAULT_WATCH_CONTEXT, unscopedFingerprint: `${epoch}:${corpusRevision}`,
      discovery: discovery(), defaultDocumentId: discovery().status === "ready" ? newest() : null, ...fields,
    };
    for (const subscriber of subscribers) {
      const context = normalize(subscriber.context);
      if (!sameDocumentContext(context, subscriber.context)) {
        subscriber.context = context;
        send(subscriber, snapshot(context, patch.changedId));
        continue;
      }
      const headers = entries.filter(entry => context.scope.kind === "folder" || roots.get(entry.absolutePath)?.index.documents.has(context.scope.documentId)).map(rootHeader);
      send(subscriber, projectDocumentPatch(patch, context, headers, repo ? repositories.results[context.compareTarget] : undefined));
    }
    metrics?.inc("refresh.completed_total");
    metrics?.set("refresh.last_success_at", Date.now());
  }
  function fileBatch(root: ObservedRoot, batch: FileIndexBatch) {
    if (stopped || roots.get(root.index.entry.absolutePath) !== root) return;
    const policy = policies.get(root.index.entry.absolutePath)!;
    const upserts = batch.upserts.filter(doc => policy.accepts(doc.id));
    const removals = [...batch.removals, ...batch.upserts.filter(doc => !policy.accepts(doc.id)).map(doc => ({ rootId: doc.rootId, id: doc.id }))];
    if (batch.upserts.length || batch.removals.length) {
      corpusRevision++;
      repositories.request();
    }
    const changedId = batch.changedOrder > latestFollowOrder && batch.changedId && policy.accepts(batch.changedId) ? batch.changedId : null;
    if (changedId) latestFollowOrder = batch.changedOrder;
    publish({ upserts, removals, changedId });
  }

  async function observe(entry: WatchEntry, staged = false): Promise<ObservedRoot | null> {
    const matcher = await loadIgnoreMatcher({ rootPath: entry.kind === "dir" ? entry.absolutePath : entry.parentDir,
      respectGitignore: options.respectGitignore ?? DEFAULT_RESPECT_GITIGNORE, isSingleFileRoot: entry.kind === "file" });
    if (stopped) return null;
    let root!: ObservedRoot;
    const index = new FileIndex(entry, matcher, { revision: nextRevision, classify: options.classify, publish: batch => fileBatch(root, batch),
      onWork: kind => metrics?.inc(`index.${kind}_total`),
    });
    policies.set(entry.absolutePath, index.policy);
    const watcher = options.watch ? options.watch(entry.absolutePath, {
      ignoreInitial: false, alwaysStat: true, followSymlinks: false, atomic: true, awaitWriteFinish: false,
      usePolling: options.usePolling ?? false, interval: 100, ignored: index.policy.ignored,
    }) : observeFiles(entry, { ignored: index.policy.ignored, usePolling: options.usePolling, renew: staged,
      onWork: kind => metrics?.inc(`index.${kind}_total`),
    });
    const ready = Promise.withResolvers<void>();
    root = { index, watcher, ready: false, finish: () => ready.resolve() };
    owned.add(root);
    if (!staged) { roots.set(entry.absolutePath, root); prepared.get(entry.absolutePath)?.resolve(root); }
    watcher.on("all", (event, file, stats) => {
      if (stopped || !owned.has(root)) return;
      metrics?.inc(`watcher.events_total.${event}`);
      if (isPolicyFile(entry, path.resolve(file)) && (root.ready || event === "change" || event === "unlink")) {
        void recover(entry, true).catch(() => {});
        return;
      }
      index.observe(event, file, stats);
    });
    watcher.once("ready", () => {
      root.ready = true; index.markReady();
      void index.idle().then(() => ready.resolve());
    });
    watcher.on("error", error => {
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
    const promise = (async () => {
      do {
        pendingPolicyRecovery.delete(entry.absolutePath);
        const old = roots.get(entry.absolutePath);
        const next = await observe(entry, true);
        if (!next || stopped) return;
        roots.set(entry.absolutePath, next);
        rootErrors.delete(entry.absolutePath);
        failures.delete(entry.absolutePath);
        if (old) { owned.delete(old); old.index.stop(); old.finish(); await old.watcher.close(); }
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
      stopped = true; repositories.stop();
      for (const pending of prepared.values()) pending.resolve(null);
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      for (const subscriber of [...subscribers]) {
        drop(subscriber, "completed");
        try { subscriber.controller.close(); } catch { /* Peer already closed. */ }
      }
      await Promise.all([...owned].map(async root => { root.index.stop(); root.finish(); await root.watcher.close(); }));
      owned.clear();
    },
    async recover() { await Promise.all(entries.map(entry => recover(entry))); },
    requestRepositoryRefresh() { repositories.request(); },
    async ensureDocument(id: string) {
      const existing = find(id);
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
        return find(id);
      }
      return undefined;
    },
    findDocument: find,
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
