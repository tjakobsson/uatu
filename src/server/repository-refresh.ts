import { stat } from "node:fs/promises";
import path from "node:path";
import { collectRepositorySnapshots, collectRepositorySnapshotsByTarget, safeGit } from "../document/git-data";
import type { CompareTarget, RepositorySnapshot, RootGroup } from "../shared/types";
import type { RepositoryFreshness } from "../shared/document-updates";
import type { WatchEntry } from "./roots";
import { createRefreshScheduler } from "./refresh-scheduler";
import { withGitCancellation } from "../document/git-base-ref";

export type RepositoryResults = Record<CompareTarget, RepositorySnapshot[]>;
export function createRepositoryRefresh(options: {
  entries: WatchEntry[];
  roots: () => RootGroup[];
  collect?: typeof collectRepositorySnapshots;
  publish: (results: RepositoryResults, freshness: RepositoryFreshness) => void;
  probeIntervalMs?: number;
  onProbe?: () => void;
}) {
  const collect = options.collect ?? collectRepositorySnapshots;
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
  const cancellation = new AbortController();
  const scheduler = createRefreshScheduler(() => { void refresh(); });

  async function refresh() {
    if (stopped) return;
    if (running) { dirty = true; return; }
    running = true;
    dirty = false;
    freshness = { ...freshness, status: freshness.generation ? "stale" : "pending" };
    options.publish(results, freshness);
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
      results = next;
      freshness = { status: dirty ? "stale" : "ready", generation: freshness.generation + 1 };
    } catch (error) {
      if (!stopped) freshness = { ...freshness, status: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
      running = false;
      if (!stopped) {
        options.publish(results, freshness);
        if (dirty) scheduler.schedule();
      }
    }
  }

  async function probe() {
    if (stopped || probing) return;
    probing = true;
    try {
      if (!probeFiles) {
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
      if (fingerprint !== null && next !== fingerprint) {
        probeFiles = null; // A branch switch can change the active ref path.
        dirty = true;
        scheduler.schedule();
      }
      fingerprint = next;
      options.onProbe?.();
    } finally { probing = false; }
  }

  return {
    get results() { return results; },
    get freshness() { return freshness; },
    request() { if (!stopped) { dirty = true; scheduler.schedule(); } },
    refresh,
    demand(active: boolean) {
      if (active === demanded || stopped) return;
      demanded = active;
      if (probeTimer) clearInterval(probeTimer);
      probeTimer = null;
      if (active) {
        void withGitCancellation(cancellation.signal, probe).catch(() => {});
        dirty = true; scheduler.schedule();
        probeTimer = setInterval(() => { void withGitCancellation(cancellation.signal, probe).catch(() => {}); }, options.probeIntervalMs ?? 5000);
        probeTimer.unref?.();
      }
    },
    stop() {
      stopped = true; scheduler.cancel();
      cancellation.abort();
      if (probeTimer) clearInterval(probeTimer);
    },
  };
}
