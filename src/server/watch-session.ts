// The live-reload engine: owns the chokidar watcher, the debounced rescan +
// git-snapshot refresh cycle, contextual SSE subscribers, and terminal token.

import chokidar from "chokidar";
import path from "node:path";
import type { ReadableStreamDefaultController } from "node:stream/web";

import { loadIgnoreMatcher, type IgnoreMatcher } from "../ignore/engine";
import { collectRepositorySnapshots } from "../document/git-data";
import {
  DEFAULT_COMPARE_TARGET,
  defaultDocumentId,
  findDocument,
  hasDocument,
  type BuildSummary,
  type CompareTarget,
  type MonoConfigPayload,
  type RepositorySnapshot,
  type RootGroup,
  type Scope,
  type StatePayload,
  type TerminalAvailability,
  type TerminalConfigPayload,
} from "../shared/types";
import { BUILD, formatBuildIdentifier } from "../shared/version";
import {
  DEFAULT_WATCH_CONTEXT,
  type WatchContext,
} from "../shared/watch-context";
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
  repositories: RepositorySnapshot[] = [],
  terminalEnabled?: boolean,
  terminalConfig?: TerminalConfigPayload,
  monoConfig?: MonoConfigPayload,
  compareTarget: CompareTarget = DEFAULT_COMPARE_TARGET,
  unscopedFingerprint?: string,
): StatePayload {
  return {
    roots,
    repositories,
    compareTarget,
    ...(unscopedFingerprint === undefined ? {} : { unscopedFingerprint }),
    initialFollow,
    defaultDocumentId: defaultDocumentId(roots),
    changedId: changedId && hasDocument(roots, changedId) ? changedId : null,
    generatedAt: Date.now(),
    build: BUILD_SUMMARY,
    scope,
    ...(terminalEnabled === undefined ? {} : { terminal: (terminalEnabled ? "enabled" : "disabled") as TerminalAvailability }),
    ...(terminalEnabled && terminalConfig && (terminalConfig.fontFamily || terminalConfig.fontSize || terminalConfig.clipboard)
      ? { terminalConfig }
      : {}),
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

export const REFRESH_DEBOUNCE_MS = 150;
// Upper bound on how long a sustained event stream may defer a refresh. A
// trailing debounce alone lets sub-150 ms event cadences postpone the rescan
// indefinitely; the cap guarantees bounded staleness while still letting
// normal bursts (save storms, git checkout) coalesce. A robustness bound,
// not a tunable — intentionally not configurable.
export const REFRESH_MAX_WAIT_MS = 2000;

type RefreshSchedulerClock = {
  now(): number;
  setTimer(fn: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
};

const realClock: RefreshSchedulerClock = {
  now: () => Date.now(),
  setTimer: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimer: timer => clearTimeout(timer),
};

// Trailing debounce with a max-wait cap. One timer: on every event the timer
// is re-armed, but its delay is clamped so it never fires later than
// `batchStartedAt + REFRESH_MAX_WAIT_MS`, where the batch starts at the first
// event after the previous fire. A parallel max-wait timeout was rejected in
// design — two timers firing near-simultaneously would need dedup guarding.
export function createRefreshScheduler(
  fire: (changedId: string | null) => void,
  clock: RefreshSchedulerClock = realClock,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingChangedId: string | null = null;
  let batchStartedAt: number | null = null;

  return {
    schedule(changedId: string | null) {
      if (changedId) {
        pendingChangedId = changedId;
      }

      const now = clock.now();
      if (batchStartedAt === null) {
        batchStartedAt = now;
      }

      if (timer) {
        clock.clearTimer(timer);
      }

      const deadline = batchStartedAt + REFRESH_MAX_WAIT_MS;
      const delay = Math.max(0, Math.min(REFRESH_DEBOUNCE_MS, deadline - now));
      timer = clock.setTimer(() => {
        timer = null;
        batchStartedAt = null;
        const nextChangedId = pendingChangedId;
        pendingChangedId = null;
        fire(nextChangedId);
      }, delay);
    },
    cancel() {
      if (timer) {
        clock.clearTimer(timer);
        timer = null;
      }
      batchStartedAt = null;
      pendingChangedId = null;
    },
  };
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
  // The unscoped index holds every viewable doc under the watched roots,
  // ignoring the current pin. Server-side direct-link dispatch consults this
  // so a navigation to `/guides/setup.md` while pinned to `README.md` still
  // returns the SPA shell — the SPA then renders a "session pinned" message
  // (see design D4) instead of the request looking like a 404.
  let unscopedRoots: RootGroup[] = [];
  let stateFingerprint = "";
  let unscopedFingerprint = "";
  let repositoriesByTarget: Record<CompareTarget, RepositorySnapshot[]> = {
    base: [],
    "last-commit": [],
  };
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  const subscribers = new Set<{ controller: EventController; context: WatchContext }>();
  const matcherCache = new Map<string, IgnoreMatcher>();

  const watchPaths = entries.map(entry => entry.absolutePath);
  const dirRoots = entries.filter(entry => entry.kind === "dir").map(entry => entry.absolutePath);
  const constrainedDocumentId = entries.length === 1 && entries[0]?.kind === "file"
    ? entries[0].absolutePath
    : null;

  const isPathIgnored = buildWatcherIgnorePredicate(dirRoots, matcherCache);

  let watcher: ReturnType<typeof chokidar.watch> | null = null;

  const applyScope = (source: RootGroup[], scope: Scope): RootGroup[] => {
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

  const normalizeContext = (context: WatchContext): WatchContext => {
    if (constrainedDocumentId) {
      return { ...context, scope: { kind: "file", documentId: constrainedDocumentId } };
    }
    return context.scope.kind === "file" && !canSetFileScope(unscopedRoots, context.scope.documentId)
      ? { ...context, scope: { kind: "folder" } }
      : context;
  };

  const payloadFor = (context: WatchContext, changedId: string | null = null): StatePayload => {
    const normalized = normalizeContext(context);
    const roots = applyScope(unscopedRoots, normalized.scope);
    return createStatePayload(
      roots,
      initialFollow,
      changedId,
      normalized.scope,
      repositoriesByTarget[normalized.compareTarget],
      terminalEnabled,
      terminalConfig,
      monoConfig,
      normalized.compareTarget,
      unscopedFingerprint,
    );
  };

  const collectAllRepositorySnapshots = async (
    nextRoots: RootGroup[],
  ): Promise<Record<CompareTarget, RepositorySnapshot[]>> => {
    const previous = repositoriesByTarget;
    const [base, lastCommit] = await Promise.all([
      collectRepositorySnapshots(entries, nextRoots, "base").catch(error => {
        console.error(`uatu: failed to refresh base change data: ${error instanceof Error ? error.message : String(error)}`);
        return previous.base;
      }),
      collectRepositorySnapshots(entries, nextRoots, "last-commit").catch(error => {
        console.error(`uatu: failed to refresh last-commit change data: ${error instanceof Error ? error.message : String(error)}`);
        return previous["last-commit"];
      }),
    ]);
    return { base, "last-commit": lastCommit };
  };

  const refresh = async (changedId: string | null) => {
    metrics?.set("refresh.in_flight", 1);
    const startedAt = Date.now();
    try {
      const nextRoots = await scanRoots(entries, { respectGitignore, matcherCache });
      const nextRepositories = await collectAllRepositorySnapshots(nextRoots);
      const nextFingerprint = createContextFingerprint(nextRoots, nextRepositories);
      const nextUnscopedFingerprint = hashCorpus(fingerprintRoots(nextRoots));
      const changedDoc = changedId ? findDocument(nextRoots, changedId) : undefined;
      const changedDocumentId =
        changedDoc && changedDoc.kind !== "binary" ? changedId : null;
      // The unscoped fingerprint participates on its own: in a scoped
      // session, an out-of-scope change alters neither the visible
      // fingerprint nor `changedId`, yet a client holding widened search
      // results needs to hear about it.
      const shouldBroadcast =
        nextFingerprint !== stateFingerprint
        || changedDocumentId !== null
        || nextUnscopedFingerprint !== unscopedFingerprint;

      unscopedRoots = nextRoots;
      repositoriesByTarget = nextRepositories;
      stateFingerprint = nextFingerprint;
      unscopedFingerprint = nextUnscopedFingerprint;

      if (shouldBroadcast) {
        broadcast(changedDocumentId);
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

  const refreshScheduler = createRefreshScheduler(nextChangedId => {
    void refresh(nextChangedId).catch(error => {
      console.error(`uatu: failed to refresh state: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  const scheduleRefresh = (changedId: string | null) => {
    metrics?.inc("refresh.scheduled_total");
    refreshScheduler.schedule(changedId);
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

    // Eligibility for follow is decided after the upcoming refresh — by then
    // the rescanned roots tell us whether the path is text or binary.
    const changedId = eventName !== "unlink" ? absolutePath : null;
    scheduleRefresh(changedId);
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
      unscopedRoots = scanned;
      repositoriesByTarget = await collectAllRepositorySnapshots(scanned);
      stateFingerprint = createContextFingerprint(scanned, repositoriesByTarget);
      unscopedFingerprint = hashCorpus(fingerprintRoots(scanned));
      reconcileTimer = setInterval(() => {
        metrics?.inc("reconcile.ticks_total");
        void refresh(null).catch(error => {
          console.error(`uatu: failed to reconcile state: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, 5000);
    },
    stop() {
      refreshScheduler.cancel();

      if (reconcileTimer) {
        clearInterval(reconcileTimer);
      }

      for (const subscriber of subscribers) {
        try {
          subscriber.controller.close();
        } catch {
          // The browser may already have closed the SSE stream.
        }
      }

      subscribers.clear();
      return watcher ? watcher.close() : Promise.resolve();
    },
    getRoots(context: WatchContext = DEFAULT_WATCH_CONTEXT) {
      return applyScope(unscopedRoots, normalizeContext(context).scope);
    },
    getUnscopedRoots() {
      return unscopedRoots;
    },
    getRepositories(context: WatchContext = DEFAULT_WATCH_CONTEXT) {
      return repositoriesByTarget[context.compareTarget];
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
    getStatePayload(changedId: string | null = null, context: WatchContext = DEFAULT_WATCH_CONTEXT) {
      return payloadFor(context, changedId);
    },
    eventsResponse(context: WatchContext = DEFAULT_WATCH_CONTEXT) {
      let currentSubscriber: { controller: EventController; context: WatchContext } | null = null;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const normalizedContext = normalizeContext(context);
          currentSubscriber = { controller, context: normalizedContext };
          subscribers.add(currentSubscriber);
          controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(payloadFor(normalizedContext))}\n\n`));
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

  function broadcast(changedId: string | null) {
    for (const subscriber of subscribers) {
      try {
        // Once an invalid pin widens, folder scope becomes this subscriber's
        // current context. Retaining the stale file id would re-pin the client
        // if that path were recreated later in the same connection.
        subscriber.context = normalizeContext(subscriber.context);
        const message = encoder.encode(`event: state\ndata: ${JSON.stringify(payloadFor(subscriber.context, changedId))}\n\n`);
        subscriber.controller.enqueue(message);
      } catch {
        subscribers.delete(subscriber);
      }
    }
  }
}

// Collapse a corpus fingerprint to a short opaque token. The full string
// grows with the tree and travels in every SSE payload, so clients get a
// hash to compare, never the corpus itself. djb2 is plenty: this is a
// staleness hint, not an integrity check.
function hashCorpus(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
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

function createContextFingerprint(
  roots: RootGroup[],
  repositories: Record<CompareTarget, RepositorySnapshot[]>,
): string {
  return `${fingerprintRoots(roots)}\nbase:${fingerprintRepositories(repositories.base)}\nlast-commit:${fingerprintRepositories(repositories["last-commit"])}`;
}

function fingerprintRepositories(repositories: RepositorySnapshot[]): string {
  return JSON.stringify(
    repositories.map(repository => ({
      id: repository.id,
      rootPath: repository.rootPath,
      watchedRootIds: repository.watchedRootIds,
      metadata: repository.metadata,
      status: repository.status,
      base: repository.base,
      changedFiles: repository.changedFiles,
      gitIgnoredFiles: repository.gitIgnoredFiles,
      configWarnings: repository.configWarnings,
      commitLog: repository.commitLog.map(commit => ({
        sha: commit.sha,
        subject: commit.subject,
        message: commit.message,
        author: commit.author,
      })),
    })),
  );
}
