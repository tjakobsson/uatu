// The live-reload engine: owns the chokidar watcher, the debounced rescan +
// git-snapshot refresh cycle, the SSE subscriber set, and the server-session
// state shared across clients (scope, compare target, terminal token).

import chokidar from "chokidar";
import path from "node:path";
import type { ReadableStreamDefaultController } from "node:stream/web";

import { loadIgnoreMatcher, type IgnoreMatcher } from "../ignore/engine";
import { collectRepositorySnapshots } from "../review/load";
import {
  DEFAULT_COMPARE_TARGET,
  defaultDocumentId,
  findDocument,
  hasDocument,
  type BuildSummary,
  type MonoConfigPayload,
  type RepositoryReviewSnapshot,
  type ReviewCompareTarget,
  type RootGroup,
  type Scope,
  type StatePayload,
  type TerminalAvailability,
  type TerminalConfigPayload,
} from "../shared/types";
import { BUILD, formatBuildIdentifier } from "../shared/version";
import { DEFAULT_RESPECT_GITIGNORE, scanRoots, type WatchEntry } from "./roots";

export const BUILD_SUMMARY: BuildSummary = {
  version: BUILD.version,
  branch: BUILD.branch,
  commitSha: BUILD.commitSha,
  commitShort: BUILD.commitShort,
  release: BUILD.release,
  identifier: formatBuildIdentifier(BUILD),
};

const encoder = new TextEncoder();

type EventController = ReadableStreamDefaultController<Uint8Array>;

export function canSetFileScope(roots: RootGroup[], documentId: string): boolean {
  const document = findDocument(roots, documentId);
  return Boolean(document && document.kind !== "binary");
}

export function createStatePayload(
  roots: RootGroup[],
  initialFollow: boolean,
  changedId: string | null = null,
  scope: Scope = { kind: "folder" },
  repositories: RepositoryReviewSnapshot[] = [],
  terminalEnabled?: boolean,
  terminalConfig?: TerminalConfigPayload,
  monoConfig?: MonoConfigPayload,
  compareTarget: ReviewCompareTarget = DEFAULT_COMPARE_TARGET,
): StatePayload {
  return {
    roots,
    repositories,
    compareTarget,
    initialFollow,
    defaultDocumentId: defaultDocumentId(roots),
    changedId: changedId && hasDocument(roots, changedId) ? changedId : null,
    generatedAt: Date.now(),
    build: BUILD_SUMMARY,
    scope,
    ...(terminalEnabled === undefined ? {} : { terminal: (terminalEnabled ? "enabled" : "disabled") as TerminalAvailability }),
    ...(terminalEnabled && terminalConfig && (terminalConfig.fontFamily || terminalConfig.fontSize) ? { terminalConfig } : {}),
    ...(monoConfig && monoConfig.fontFamily ? { monoConfig } : {}),
  };
}

export type WatchSessionOptions = {
  usePolling?: boolean;
  respectGitignore?: boolean;
  terminalEnabled?: boolean;
  terminalConfig?: TerminalConfigPayload;
  monoConfig?: MonoConfigPayload;
  // Optional metrics registry. When provided, the watch session will
  // increment counters for watcher events and refresh lifecycle. Callers
  // construct the registry so it can be shared with the snapshot writer
  // and the /debug/metrics endpoint.
  metrics?: import("../debug/metrics").MetricsRegistry;
};

// 32 random bytes, base64url-encoded — sufficient entropy that brute-forcing
// over the localhost websocket is not viable. Regenerated per server start.
function createTerminalToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Builds the predicate chokidar consults to decide whether to attach a native
// watcher to a path. Two layers:
//   1. Always exclude any path with a `.git` segment between it and a watched
//      root. `.git/` is git's working metadata; transient files inside it
//      (notably `.git/index.lock`) race with native fs.watch on macOS and
//      crash the process with EINVAL when chokidar emits an unhandled error.
//      This is the ONLY hardcoded directory we filter here — the broader
//      indexer denylist (`node_modules`, `.next`, etc.) is intentionally NOT
//      mirrored, because in the typical case it's already covered by the
//      user's `.gitignore` and spreading the heuristic into the watcher
//      would deepen an existing hack rather than minimize it.
//   2. Defer to the per-root IgnoreMatcher (built from built-in defaults +
//      .uatu.json tree.exclude + .gitignore) for everything else.
export function buildWatcherIgnorePredicate(
  dirRoots: string[],
  matcherCache: Map<string, IgnoreMatcher>,
): (testPath: string) => boolean {
  return (testPath: string): boolean => {
    for (const rootPath of dirRoots) {
      const rel = path.relative(rootPath, testPath);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
        continue;
      }
      if (rel.split(path.sep).includes(".git")) {
        return true;
      }
      const matcher = matcherCache.get(rootPath);
      if (!matcher) {
        continue;
      }
      return matcher.toChokidarIgnored()(testPath);
    }
    return false;
  };
}

// Without an `error` listener, chokidar's underlying EventEmitter throws
// synchronously when an "error" event fires — taking the host process down.
// Real-world failures we have seen include `EINVAL` from a `watch` syscall
// against `.git/index.lock` after git unlinks it. The contract here is
// "process does not crash"; logging policy is intentionally minimal.
export function attachWatcherCrashGuard(emitter: NodeJS.EventEmitter): void {
  emitter.on("error", err => {
    const code =
      err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string"
        ? ` (${(err as NodeJS.ErrnoException).code})`
        : "";
    const message = err instanceof Error ? err.message : String(err);
    console.error(`uatu: watcher error${code}: ${message}`);
  });
}

export type WatchSession = ReturnType<typeof createWatchSession>;

export function createWatchSession(
  entries: WatchEntry[],
  initialFollow: boolean,
  options: WatchSessionOptions = {},
) {
  const respectGitignore = options.respectGitignore ?? DEFAULT_RESPECT_GITIGNORE;
  const terminalEnabled = options.terminalEnabled ?? false;
  const terminalConfig: TerminalConfigPayload | undefined = options.terminalConfig;
  const monoConfig: MonoConfigPayload | undefined = options.monoConfig;
  const terminalToken = createTerminalToken();
  const metrics = options.metrics;
  let roots: RootGroup[] = [];
  let repositories: RepositoryReviewSnapshot[] = [];
  // The unscoped index holds every viewable doc under the watched roots,
  // ignoring the current pin. Server-side direct-link dispatch consults this
  // so a navigation to `/guides/setup.md` while pinned to `README.md` still
  // returns the SPA shell — the SPA then renders a "session pinned" message
  // (see design D4) instead of the request looking like a 404.
  let unscopedRoots: RootGroup[] = [];
  let stateFingerprint = "";
  let scope: Scope = { kind: "folder" };
  // Server-session compare target shared across all connected clients, exactly
  // like `scope`. Defaults to the reviewer's view; changed via setCompareTarget.
  let compareTarget: ReviewCompareTarget = DEFAULT_COMPARE_TARGET;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingChangedId: string | null = null;
  const subscribers = new Set<EventController>();
  const matcherCache = new Map<string, IgnoreMatcher>();

  const watchPaths = entries.map(entry => entry.absolutePath);
  const dirRoots = entries.filter(entry => entry.kind === "dir").map(entry => entry.absolutePath);

  const isPathIgnored = buildWatcherIgnorePredicate(dirRoots, matcherCache);

  let watcher: ReturnType<typeof chokidar.watch> | null = null;

  const applyScope = (source: RootGroup[]): RootGroup[] => {
    if (scope.kind === "folder") {
      return source;
    }

    const pinnedId = scope.documentId;
    const pinnedRoots: RootGroup[] = [];

    for (const root of source) {
      const doc = root.docs.find(candidate => candidate.id === pinnedId);
      if (!doc) {
        continue;
      }

      pinnedRoots.push({
        ...root,
        docs: [doc],
      });
    }

    return pinnedRoots;
  };

  const refresh = async (changedId: string | null) => {
    metrics?.set("refresh.in_flight", 1);
    const startedAt = Date.now();
    try {
      const nextRoots = await scanRoots(entries, { respectGitignore, matcherCache });
      const nextRepositories = await collectRepositorySnapshots(entries, nextRoots, compareTarget).catch(error => {
        console.error(`uatu: failed to refresh git review data: ${error instanceof Error ? error.message : String(error)}`);
        return repositories;
      });

      if (scope.kind === "file" && !hasDocument(nextRoots, scope.documentId)) {
        scope = { kind: "folder" };
      }

      const visibleRoots = applyScope(nextRoots);
      const nextFingerprint = createStateFingerprint(visibleRoots, nextRepositories, compareTarget);
      const changedDoc = changedId ? findDocument(visibleRoots, changedId) : undefined;
      const changedDocumentId =
        changedDoc && changedDoc.kind !== "binary" ? changedId : null;
      const shouldBroadcast = nextFingerprint !== stateFingerprint || changedDocumentId !== null;

      roots = visibleRoots;
      unscopedRoots = nextRoots;
      repositories = nextRepositories;
      stateFingerprint = nextFingerprint;

      if (shouldBroadcast) {
        broadcast(createStatePayload(roots, initialFollow, changedDocumentId, scope, repositories, terminalEnabled, terminalConfig, monoConfig, compareTarget));
      }
      metrics?.inc("refresh.completed_total");
      metrics?.set("refresh.last_success_at", Date.now());
      metrics?.set("refresh.last_duration_ms", Date.now() - startedAt);
    } catch (err) {
      metrics?.inc("refresh.errored_total");
      throw err;
    } finally {
      metrics?.set("refresh.in_flight", 0);
    }
  };

  const scheduleRefresh = (changedId: string | null) => {
    metrics?.inc("refresh.scheduled_total");
    if (changedId) {
      pendingChangedId = changedId;
    }

    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }

    refreshTimer = setTimeout(() => {
      const nextChangedId = pendingChangedId;
      pendingChangedId = null;
      void refresh(nextChangedId).catch(error => {
        console.error(`uatu: failed to refresh state: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 150);
  };

  const handleWatcherEvent = (eventName: string, filePath: string) => {
    metrics?.inc(`watcher.events_total.${eventName}`);
    const absolutePath = path.resolve(filePath);

    // A root's `.gitignore` or `.uatu.json` itself just changed — drop the
    // cached matcher so the upcoming scanRoots call rebuilds it from the new
    // rules. Both files feed the per-root IgnoreMatcher (.uatu.json tree.exclude
    // and tree.respectGitignore are read via loadTreeConfig in ignore-engine).
    const baseName = path.basename(absolutePath);
    if (baseName === ".gitignore" || baseName === ".uatu.json") {
      const parentDir = path.dirname(absolutePath);
      if (dirRoots.includes(parentDir)) {
        matcherCache.delete(parentDir);
      }
    }

    if (scope.kind === "file" && eventName === "unlink" && absolutePath === scope.documentId) {
      scope = { kind: "folder" };
      scheduleRefresh(null);
      return;
    }

    if (scope.kind === "file" && absolutePath !== scope.documentId) {
      return;
    }

    // Eligibility for follow is decided after the upcoming refresh — by then
    // the rescanned roots tell us whether the path is text or binary.
    const changedId = eventName !== "unlink" ? absolutePath : null;
    scheduleRefresh(changedId);
  };

  const setScope = (next: Scope): Scope => {
    if (next.kind === "file") {
      if (scope.kind === "file" && scope.documentId === next.documentId) {
        return scope;
      }
      scope = { kind: "file", documentId: next.documentId };
    } else {
      if (scope.kind === "folder") {
        return scope;
      }
      scope = { kind: "folder" };
    }

    scheduleRefresh(null);
    return scope;
  };

  // Mirrors setScope: server-session view state shared across clients. A change
  // triggers a recompute + SSE rebroadcast (the compare target is folded into
  // the state fingerprint, so the broadcast fires even when the two targets
  // happen to produce identical scores).
  const setCompareTarget = (next: ReviewCompareTarget): ReviewCompareTarget => {
    if (compareTarget === next) {
      return compareTarget;
    }
    compareTarget = next;
    scheduleRefresh(null);
    return compareTarget;
  };

  return {
    async start() {
      // Pre-load matchers so the chokidar `ignored` predicate has something to
      // consult during the watcher's very first stat sweep. The cache is also
      // threaded into every subsequent scanRoots call so we don't re-read
      // `.uatu.json` / `.gitignore` on every refresh.
      for (const rootPath of dirRoots) {
        const matcher = await loadIgnoreMatcher({ rootPath, respectGitignore });
        matcherCache.set(rootPath, matcher);
      }

      watcher = chokidar.watch(watchPaths, {
        ignoreInitial: true,
        usePolling: options.usePolling ?? false,
        interval: 100,
        awaitWriteFinish: {
          // Loosened from 25ms in 2026-05 (see add-watch-freeze-diagnostics)
          // to reduce main-thread fs.stat pressure during heavy file churn.
          stabilityThreshold: 100,
          pollInterval: 250,
        },
        ignored: isPathIgnored,
      });

      const watcherReady = new Promise<void>(resolve => {
        watcher!.once("ready", () => {
          resolve();
        });
      });

      watcher.on("all", handleWatcherEvent);
      attachWatcherCrashGuard(watcher);

      await watcherReady;
      const scanned = await scanRoots(entries, { respectGitignore, matcherCache });
      repositories = await collectRepositorySnapshots(entries, scanned, compareTarget).catch(error => {
        console.error(`uatu: failed to initialize git review data: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });
      unscopedRoots = scanned;
      roots = applyScope(scanned);
      stateFingerprint = createStateFingerprint(roots, repositories, compareTarget);
      reconcileTimer = setInterval(() => {
        metrics?.inc("reconcile.ticks_total");
        void refresh(null).catch(error => {
          console.error(`uatu: failed to reconcile state: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, 5000);
    },
    stop() {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }

      if (reconcileTimer) {
        clearInterval(reconcileTimer);
      }

      for (const subscriber of subscribers) {
        try {
          subscriber.close();
        } catch {
          // The browser may already have closed the SSE stream.
        }
      }

      subscribers.clear();
      return watcher ? watcher.close() : Promise.resolve();
    },
    getRoots() {
      return roots;
    },
    getUnscopedRoots() {
      return unscopedRoots;
    },
    getScope() {
      return scope;
    },
    getCompareTarget() {
      return compareTarget;
    },
    setCompareTarget,
    getRepositories() {
      return repositories;
    },
    getTerminalToken() {
      return terminalToken;
    },
    isTerminalEnabled() {
      return terminalEnabled;
    },
    getSseSubscriberCount() {
      return subscribers.size;
    },
    // Test-only handle: lets the regression suite emit synthetic chokidar
    // errors against the real underlying watcher to verify the crash guard.
    // Not part of the production API surface.
    _internalWatcher(): NodeJS.EventEmitter | null {
      return watcher;
    },
    setScope,
    getStatePayload(changedId: string | null = null) {
      return createStatePayload(roots, initialFollow, changedId, scope, repositories, terminalEnabled, terminalConfig, monoConfig, compareTarget);
    },
    eventsResponse() {
      let currentSubscriber: EventController | null = null;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          currentSubscriber = controller;
          subscribers.add(controller);
          controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(createStatePayload(roots, initialFollow, null, scope, repositories, terminalEnabled, terminalConfig, monoConfig, compareTarget))}\n\n`));
        },
        cancel() {
          if (currentSubscriber) {
            subscribers.delete(currentSubscriber);
            currentSubscriber = null;
          }
        },
      });

      return new Response(stream, {
        headers: {
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream",
        },
      });
    },
  };

  function broadcast(payload: StatePayload) {
    const message = encoder.encode(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);

    for (const subscriber of subscribers) {
      try {
        subscriber.enqueue(message);
      } catch {
        subscribers.delete(subscriber);
      }
    }
  }
}

function fingerprintRoots(roots: RootGroup[]): string {
  return JSON.stringify(
    roots.map(root => ({
      id: root.id,
      docs: root.docs.map(doc => ({
        id: doc.id,
        relativePath: doc.relativePath,
        mtimeMs: doc.mtimeMs,
        kind: doc.kind,
      })),
    })),
  );
}

function createStateFingerprint(
  roots: RootGroup[],
  repositories: RepositoryReviewSnapshot[],
  compareTarget: ReviewCompareTarget,
): string {
  return `${compareTarget}\n${fingerprintRoots(roots)}\n${fingerprintRepositories(repositories)}`;
}

function fingerprintRepositories(repositories: RepositoryReviewSnapshot[]): string {
  return JSON.stringify(
    repositories.map(repository => ({
      id: repository.id,
      rootPath: repository.rootPath,
      watchedRootIds: repository.watchedRootIds,
      metadata: repository.metadata,
      reviewLoad: repository.reviewLoad,
      commitLog: repository.commitLog.map(commit => ({
        sha: commit.sha,
        subject: commit.subject,
        message: commit.message,
        author: commit.author,
      })),
    })),
  );
}
