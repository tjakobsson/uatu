import { stat } from "node:fs/promises";
import path from "node:path";
import { collectRepositorySnapshots, collectRepositorySnapshotsByTarget, safeGit } from "../document/git-data";
import type { CompareTarget, RepositorySnapshot, RootGroup } from "../shared/types";
import type { RepositoryFreshness } from "../shared/document-updates";
import type { WatchEntry } from "./roots";
import { createRefreshScheduler, type RefreshSchedulerClock } from "./refresh-scheduler";
import { withGitCancellation } from "../document/git-base-ref";
import { createGitObserver, hasNarrowRoot, type GitObserver } from "./git-observer";
import { pollingRequested } from "./file-observer";

export const STALE_NOTICE_MS = 1000;
// Successive collections start at least this far apart. The first trigger
// after a quiet period still collects within the scheduler's debounce.
export const MIN_COLLECTION_GAP_MS = 2000;
// Only the polling fallback uses this; native observation has no timer.
export const GIT_POLL_INTERVAL_MS = 5000;
const realClock: RefreshSchedulerClock = {
  now: () => performance.now(),
  setTimer: (fn, delay) => { const timer = setTimeout(fn, delay); timer.unref?.(); return timer; },
  clearTimer: clearTimeout,
};
export type RepositoryResults = Record<CompareTarget, RepositorySnapshot[]>;
// Commit ages are Git's wall-clock `%cr` text ("5 seconds ago"). They advance
// without any repository change, so they don't count as one; displayed ages
// update with the next real change.
function repositoryFingerprint(results: RepositoryResults): string {
  return JSON.stringify(results, (key, value) => key === "relativeTime" ? undefined : value);
}

export function createRepositoryRefresh(options: {
  entries: WatchEntry[];
  roots: () => RootGroup[];
  collect?: typeof collectRepositorySnapshots;
  publish: (results: RepositoryResults, freshness: RepositoryFreshness) => void;
  probeIntervalMs?: number;
  staleNoticeMs?: number;
  minCollectionGapMs?: number;
  // Polling mode skips native Git observation, like the content watcher.
  usePolling?: boolean;
  clock?: RefreshSchedulerClock;
  observe?: typeof createGitObserver;
  onObserverEvent?: () => void;
  onFallback?: (error: unknown) => void;
  // Each polling-fallback tick, for tests.
  onPoll?: () => void;
}) {
  const collect = options.collect ?? collectRepositorySnapshots;
  const clock = options.clock ?? realClock;
  const gap = options.minCollectionGapMs ?? MIN_COLLECTION_GAP_MS;
  let results: RepositoryResults = { base: [], "last-commit": [] };
  let freshness: RepositoryFreshness = { status: "pending", generation: 0 };
  let stopped = false;
  let running = false;
  let dirty = false;
  let demanded = false;
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let probing = false;
  let probeFiles: string[] | null = null;
  let fingerprint: string | null = null;
  // A narrow root's out-of-root edits have no file to stat, so each fallback
  // tick collects instead.
  let narrow = false;
  let observer: GitObserver | null = null;
  let fellBack = false;
  let demandEpoch = 0;
  let lastStart = -Infinity;
  let gapTimer: ReturnType<typeof setTimeout> | null = null;
  const cancellation = new AbortController();
  const scheduler = createRefreshScheduler(() => { paced(); }, clock);

  // Scheduled refreshes respect the minimum gap; a trigger inside it waits
  // for the gap and coalesces with anything else that arrives meanwhile.
  function paced() {
    if (stopped) return;
    if (running) { dirty = true; return; }
    const wait = lastStart + gap - clock.now();
    if (wait <= 0) { void refresh(); return; }
    dirty = true;
    armStaleNotice();
    gapTimer ??= clock.setTimer(() => { gapTimer = null; paced(); }, wait);
  }

  // A routine refresh finishes well inside this window. Announcing "stale" at
  // its start would swap the change overview and the facts strip to a
  // refreshing notice and back on every probe; only a slow one says so.
  let staleNotice: ReturnType<typeof setTimeout> | null = null;
  let staleAnnounced = false;
  let published: RepositoryFreshness | null = null;
  function emit() {
    published = freshness;
    options.publish(results, freshness);
  }
  function armStaleNotice() {
    if (freshness.status !== "ready" || staleNotice) return;
    staleNotice = clock.setTimer(announceStale, options.staleNoticeMs ?? STALE_NOTICE_MS);
  }
  function clearStaleNotice() {
    if (staleNotice) clock.clearTimer(staleNotice);
    staleNotice = null;
    staleAnnounced = false;
  }
  function announceStale() {
    staleNotice = null;
    if (stopped || freshness.status !== "ready") return;
    staleAnnounced = true;
    freshness = { ...freshness, status: "stale" };
    emit();
  }

  async function refresh() {
    if (stopped) return;
    if (running) { dirty = true; return; }
    running = true;
    dirty = false;
    lastStart = clock.now();
    if (gapTimer) { clock.clearTimer(gapTimer); gapTimer = null; }
    if (freshness.generation === 0 || freshness.status === "error") {
      freshness = { ...freshness, status: freshness.generation ? "stale" : "pending" };
      emit();
    } else armStaleNotice();
    try {
      const roots = options.roots();
      let next: RepositoryResults;
      if (!options.collect) next = await withGitCancellation(cancellation.signal, () => collectRepositorySnapshotsByTarget(options.entries, roots));
      else {
        const both = await withGitCancellation(cancellation.signal, () => Promise.allSettled([collect(options.entries, roots, "base"), collect(options.entries, roots, "last-commit")]));
        const [base, last] = both;
        if (base.status === "rejected") throw base.reason;
        if (last.status === "rejected") throw last.reason;
        next = { base: base.value, "last-commit": last.value };
      }
      if (stopped) return;
      // An identical result keeps its identity and generation, so clients
      // neither repaint repository views nor refetch Git facts.
      const changed = freshness.generation === 0 || repositoryFingerprint(next) !== repositoryFingerprint(results);
      if (changed) results = next;
      // A queued follow-up keeps any announced "stale" until it completes.
      const status = dirty && staleAnnounced ? "stale" : "ready";
      freshness = { status, generation: freshness.generation + (changed ? 1 : 0) };
    } catch (error) {
      if (!stopped) freshness = { ...freshness, status: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
      running = false;
      if (!stopped) {
        if (!dirty || freshness.status === "error") clearStaleNotice();
        if (freshness.status === "error" || freshness.generation !== published?.generation || freshness.status !== published.status) emit();
        if (dirty) scheduler.schedule();
      }
    }
  }

  async function probe() {
    if (stopped || probing) return;
    probing = true;
    try {
      if (!probeFiles) {
        narrow = await hasNarrowRoot(options.entries);
        const files = new Set<string>();
        for (const entry of options.entries) {
          if (stopped || !demanded) return;
          const cwd = entry.kind === "dir" ? entry.absolutePath : entry.parentDir;
          for (const name of ["HEAD", "index", "packed-refs", "refs", "logs/HEAD", "config", "refs/heads/main", "refs/heads/master", "refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master"]) {
            if (stopped || !demanded) return;
            const result = await safeGit(cwd, ["rev-parse", "--git-path", name]);
            if (result.ok) files.add(path.resolve(cwd, result.stdout.trim()));
          }
          const head = await safeGit(cwd, ["symbolic-ref", "-q", "HEAD"]);
          if (head.ok) {
            const ref = await safeGit(cwd, ["rev-parse", "--git-path", head.stdout.trim()]);
            if (ref.ok) files.add(path.resolve(cwd, ref.stdout.trim()));
          }
          const remote = await safeGit(cwd, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
          if (remote.ok) {
            const ref = await safeGit(cwd, ["rev-parse", "--git-path", remote.stdout.trim()]);
            if (ref.ok) files.add(path.resolve(cwd, ref.stdout.trim()));
          }
        }
        probeFiles = [...files];
      }
      if (stopped || !demanded) return;
      const next = (await Promise.all(probeFiles.map(async file => {
        const s = await stat(file).catch(() => null);
        return s ? `${file}:${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.ino}` : `${file}:missing`;
      }))).join("\n");
      if (stopped || !demanded) return;
      if (fingerprint !== null && (next !== fingerprint || narrow)) {
        if (next !== fingerprint) probeFiles = null; // A branch switch can change the active ref path.
        dirty = true;
        scheduler.schedule();
      }
      fingerprint = next;
      options.onPoll?.();
    } finally { probing = false; }
  }

  function startPolling() {
    void withGitCancellation(cancellation.signal, probe).catch(() => {});
    probeTimer = setInterval(() => { void withGitCancellation(cancellation.signal, probe).catch(() => {}); }, options.probeIntervalMs ?? GIT_POLL_INTERVAL_MS);
    probeTimer.unref?.();
  }

  // Native observation failed: poll for the rest of this demand period rather
  // than flap between the two. The next demand tries native watching again.
  function fallBack(error: unknown) {
    if (fellBack || !demanded || stopped) return;
    fellBack = true;
    observer?.close();
    observer = null;
    options.onFallback?.(error);
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`uatu: Git metadata watching failed (${reason}); checking every ${(options.probeIntervalMs ?? GIT_POLL_INTERVAL_MS) / 1000} s instead`);
    startPolling();
    // A change may have gone unreported while the watch was failing.
    dirty = true;
    scheduler.schedule();
  }

  function release() {
    observer?.close();
    observer = null;
    if (probeTimer) clearInterval(probeTimer);
    probeTimer = null;
    probeFiles = null;
    fingerprint = null;
    fellBack = false;
  }

  function request() { if (!stopped) { dirty = true; scheduler.schedule(); } }

  return {
    get results() { return results; },
    get freshness() { return freshness; },
    // Whether Git metadata is currently polled rather than observed.
    get polling() { return probeTimer !== null; },
    request,
    refresh,
    demand(active: boolean) {
      if (active === demanded || stopped) return;
      demanded = active;
      const epoch = ++demandEpoch;
      release();
      if (!active) return;
      dirty = true; scheduler.schedule();
      if (pollingRequested(options.usePolling)) { startPolling(); return; }
      const next = (options.observe ?? createGitObserver)({
        entries: options.entries,
        onChange: () => { options.onObserverEvent?.(); request(); },
        onFailure: error => { if (observer === next) fallBack(error); },
      });
      observer = next;
      void withGitCancellation(cancellation.signal, () => next.start()).then(() => {
        // A change between the first collection and the watches going live
        // reported nothing; collect once more now that they are.
        if (epoch === demandEpoch && observer === next) request();
      }, error => {
        if (epoch === demandEpoch && observer === next) fallBack(error);
      });
    },
    stop() {
      stopped = true; scheduler.cancel();
      cancellation.abort();
      if (staleNotice) clock.clearTimer(staleNotice);
      if (gapTimer) clock.clearTimer(gapTimer);
      release();
    },
  };
}
