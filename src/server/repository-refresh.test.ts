import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRepositoryRefresh, MIN_COLLECTION_GAP_MS } from "./repository-refresh";
import { REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS, type RefreshSchedulerClock } from "./refresh-scheduler";
import type { createGitObserver } from "./git-observer";
import { safeGit } from "../document/git-data";
import type { RepositoryFreshness } from "../shared/document-updates";
import type { RepositorySnapshot } from "../shared/types";

async function until(check: () => boolean) {
  const deadline = performance.now() + 8000;
  while (!check()) { if (performance.now() > deadline) throw new Error("repository event did not arrive"); await Bun.sleep(10); }
}

test("stopped collection cannot replace retained results or publish late", async () => {
  const gate = Promise.withResolvers<void>();
  let publications = 0;
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: () => { publications++; },
    collect: async () => { await gate.promise; return []; },
  });
  const work = refresh.refresh();
  expect(publications).toBe(1);
  refresh.stop();
  gate.resolve(); await work;
  expect(publications).toBe(1);
  expect(refresh.freshness.generation).toBe(0);
});

test("repeated requests during collection retain only one follow-up", async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: () => {},
    collect: async () => { if (++calls <= 2) await gate.promise; return [{ id: String(calls) }] as unknown as RepositorySnapshot[]; },
  });
  try {
    const first = refresh.refresh();
    for (let i = 0; i < 20; i++) refresh.request();
    expect(calls).toBe(2);
    gate.resolve(); await first;
    await until(() => refresh.freshness.generation === 2);
    expect(calls).toBe(4);
  } finally { gate.resolve(); refresh.stop(); }
});

function fakeObserver() {
  const state = { closed: 0, starts: 0, resyncs: 0, onFailure: null as ((error: unknown) => void) | null, onChange: null as ((name: string | null) => void) | null, start: () => Promise.resolve() };
  const observe = ((options: { onChange: (name: string | null) => void; onFailure: (error: unknown) => void }) => {
    state.onFailure = options.onFailure;
    state.onChange = options.onChange;
    return { start: () => { state.starts++; return state.start(); }, directories: () => [], close: () => { state.closed++; }, resync: async () => { state.resyncs++; } };
  }) as unknown as typeof createGitObserver;
  return { state, observe };
}

function intervalSpies() {
  const timer = { unref() {} } as ReturnType<typeof setInterval>;
  const set = spyOn(globalThis, "setInterval").mockReturnValue(timer);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  return { timer, set, clear, restore() { set.mockRestore(); clear.mockRestore(); } };
}

test("native observation runs no interval timer and is released with demand", async () => {
  const spies = intervalSpies();
  const { state, observe } = fakeObserver();
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: () => {}, collect: async () => [], observe });
  try {
    refresh.demand(true); refresh.demand(true);
    await until(() => state.starts === 1);
    expect(spies.set).not.toHaveBeenCalled();
    expect(refresh.polling).toBe(false);
    refresh.demand(false);
    expect(state.closed).toBe(1);
  } finally { refresh.stop(); spies.restore(); }
});

test("polling mode polls Git metadata on one shared timer, released with demand", () => {
  const spies = intervalSpies();
  const { state, observe } = fakeObserver();
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: () => {}, collect: async () => [], observe, usePolling: true });
  try {
    refresh.demand(true); refresh.demand(true);
    expect(spies.set).toHaveBeenCalledTimes(1);
    expect(state.starts).toBe(0);
    expect(refresh.polling).toBe(true);
    refresh.demand(false);
    expect(spies.clear).toHaveBeenCalledWith(spies.timer);
    expect(refresh.polling).toBe(false);
  } finally { refresh.stop(); spies.restore(); }
});

test("a watch that cannot start falls back to polling once, with one diagnostic", async () => {
  const spies = intervalSpies();
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const { state, observe } = fakeObserver();
  state.start = () => Promise.reject(new Error("too many watchers"));
  const fallbacks: unknown[] = [];
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: () => {}, collect: async () => [], observe, onFallback: error => { fallbacks.push(error); } });
  try {
    refresh.demand(true);
    await until(() => fallbacks.length === 1);
    expect(refresh.polling).toBe(true);
    expect(state.closed).toBe(1);
    expect(spies.set).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    refresh.demand(false);
    expect(spies.clear).toHaveBeenCalledWith(spies.timer);
  } finally { refresh.stop(); spies.restore(); errors.mockRestore(); }
});

test("a watcher error after start falls back to polling and recollects", async () => {
  const spies = intervalSpies();
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const { state, observe } = fakeObserver();
  let collections = 0;
  const fallbacks: unknown[] = [];
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: () => {}, observe,
    collect: async () => { collections++; return []; }, onFallback: error => { fallbacks.push(error); } });
  try {
    refresh.demand(true);
    await until(() => state.starts === 1 && refresh.freshness.status === "ready");
    const before = collections;
    state.onFailure!(new Error("watch lost"));
    state.onFailure!(new Error("watch lost again"));
    expect(fallbacks).toHaveLength(1);
    expect(refresh.polling).toBe(true);
    await until(() => collections > before);
    // The next demand period tries native observation again.
    refresh.demand(false);
    refresh.demand(true);
    await until(() => state.starts === 2);
    expect(refresh.polling).toBe(false);
  } finally { refresh.stop(); spies.restore(); errors.mockRestore(); }
});

test("an observer event requests a repository collection", async () => {
  const { state, observe } = fakeObserver();
  let collections = 0;
  let events = 0;
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: () => {}, observe,
    collect: async () => { collections++; return []; }, onObserverEvent: () => { events++; } });
  try {
    refresh.demand(true);
    await until(() => state.starts === 1 && refresh.freshness.status === "ready");
    const before = collections;
    state.onChange!("main");
    expect(events).toBe(1);
    await until(() => collections > before);
  } finally { refresh.stop(); }
});

function fakeClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: RefreshSchedulerClock = {
    now: () => now,
    setTimer: (fn, delay) => { const id = ++next; timers.set(id, { at: now + delay, fn }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: timer => { timers.delete(timer as unknown as number); },
  };
  const settle = async () => { for (let i = 0; i < 5; i++) await Bun.sleep(0); };
  return {
    clock,
    now: () => now,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

test("collections start promptly after a quiet period and no closer than the gap under sustained triggers", async () => {
  const time = fakeClock();
  const starts: number[] = [];
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: () => {}, clock: time.clock,
    collect: async (_entries, _roots, target) => { if (target === "base") starts.push(time.now()); return []; },
  });
  try {
    refresh.request();
    await time.advance(REFRESH_DEBOUNCE_MS);
    expect(starts).toEqual([REFRESH_DEBOUNCE_MS]);

    for (let i = 0; i < 50; i++) { refresh.request(); await time.advance(100); }
    const lastTrigger = time.now() - 100;
    await time.advance(5_000);
    const gaps = starts.slice(1).map((start, index) => start - starts[index]!);
    expect(gaps.every(value => value >= MIN_COLLECTION_GAP_MS)).toBe(true);
    expect(starts.at(-1)!).toBeGreaterThan(lastTrigger);

    // A trigger after a quiet period collects within the debounce again.
    const quiet = time.now();
    refresh.request();
    await time.advance(REFRESH_DEBOUNCE_MS);
    expect(starts.at(-1)).toBe(quiet + REFRESH_DEBOUNCE_MS);
  } finally { refresh.stop(); }
});

test("metadata-only commits in a linked worktree refresh Git without file events", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uatu-repository-probe-"));
  const main = path.join(directory, "main");
  const linked = path.join(directory, "linked");
  await mkdir(main);
  const git = async (cwd: string, args: string[]) => { const result = await safeGit(cwd, args); if (!result.ok) throw new Error(result.stderr); return result; };
  let collections = 0;
  let events = 0;
  const refresh = createRepositoryRefresh({ entries: [{ kind: "dir", absolutePath: linked }], roots: () => [], publish: () => {},
    collect: async () => { collections++; return []; }, onObserverEvent: () => { events++; },
  });
  try {
    await git(main, ["init", "--initial-branch=main"]);
    await writeFile(path.join(main, "README.md"), "# Unchanged document\n");
    await git(main, ["add", "."]);
    const commit = ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit"];
    await git(main, [...commit, "-m", "initial"]);
    await git(main, ["worktree", "add", "-b", "feature", linked]);
    refresh.demand(true);
    await until(() => collections >= 2 && refresh.freshness.status === "ready");
    // The observer opens its handles asynchronously; an event proves it is
    // live. Rewrite the sentinel until one arrives, since a write before the
    // handles open is never reported.
    for (let attempt = 0; events === 0; attempt++) {
      if (attempt > 400) throw new Error("the Git observer never reported an event");
      await writeFile(path.join(main, ".git", `uatu-sentinel-${attempt}`), "");
      await Bun.sleep(20);
    }
    const before = collections;
    await git(linked, [...commit, "--allow-empty", "-m", "metadata only"]);
    await until(() => collections > before && refresh.freshness.status === "ready");
    expect(refresh.polling).toBe(false);
    expect(collections).toBeGreaterThanOrEqual(4);
    expect(await readFile(path.join(linked, "README.md"), "utf8")).toBe("# Unchanged document\n");
  } finally { refresh.stop(); await rm(directory, { recursive: true, force: true }); }
}, 15000);

test("a refresh that finds nothing new publishes nothing", async () => {
  const published: RepositoryFreshness[] = [];
  const snapshot = [{ id: "repo" }] as unknown as RepositorySnapshot[];
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: (_results, freshness) => { published.push(freshness); },
    collect: async () => structuredClone(snapshot),
  });
  try {
    await refresh.refresh();
    const results = refresh.results;
    expect(published).toEqual([{ status: "pending", generation: 0 }, { status: "ready", generation: 1 }]);
    await refresh.refresh();
    await refresh.refresh();
    expect(published).toHaveLength(2);
    expect(refresh.freshness).toEqual({ status: "ready", generation: 1 });
    expect(refresh.results).toBe(results);
  } finally { refresh.stop(); }
});

test("a changed result advances the generation without a stale notice first", async () => {
  const published: RepositoryFreshness[] = [];
  let head = "a";
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: (_results, freshness) => { published.push(freshness); },
    collect: async () => [{ id: head }] as unknown as RepositorySnapshot[],
  });
  try {
    await refresh.refresh();
    head = "b";
    await refresh.refresh();
    expect(published.map(freshness => freshness.status)).toEqual(["pending", "ready", "ready"]);
    expect(refresh.freshness).toEqual({ status: "ready", generation: 2 });
  } finally { refresh.stop(); }
});

test("a slow refresh is announced stale once the grace passes", async () => {
  const published: RepositoryFreshness[] = [];
  let gate: PromiseWithResolvers<void> | null = null;
  let head = "a";
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], staleNoticeMs: 20,
    publish: (_results, freshness) => { published.push(freshness); },
    collect: async () => { await gate?.promise; return [{ id: head }] as unknown as RepositorySnapshot[]; },
  });
  try {
    await refresh.refresh();
    gate = Promise.withResolvers<void>();
    head = "b";
    const work = refresh.refresh();
    await until(() => published.length === 3);
    expect(published[2]).toEqual({ status: "stale", generation: 1 });
    gate.resolve(); await work;
    expect(published.slice(3)).toEqual([{ status: "ready", generation: 2 }]);
  } finally { gate?.resolve(); refresh.stop(); }
});

test("a commit age that only advanced with the clock is not a repository change", async () => {
  const published: RepositoryFreshness[] = [];
  let age = "5 seconds ago";
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: (_results, freshness) => { published.push(freshness); },
    collect: async () => [{ id: "repo", commitLog: [{ sha: "abc1234", relativeTime: age }] }] as unknown as RepositorySnapshot[],
  });
  try {
    await refresh.refresh();
    age = "2 minutes ago";
    await refresh.refresh();
    expect(published).toHaveLength(2);
    expect(refresh.freshness).toEqual({ status: "ready", generation: 1 });
  } finally { refresh.stop(); }
});

async function layout() {
  const repository = await mkdtemp(path.join(os.tmpdir(), "uatu-repository-narrow-"));
  await mkdir(path.join(repository, "docs"));
  await writeFile(path.join(repository, "README.md"), "# Readme\n");
  const git = async (args: string[]) => { const result = await safeGit(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args]); if (!result.ok) throw new Error(result.stderr); };
  await git(["init", "--initial-branch=main"]);
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
  return repository;
}

test("each polling tick collects, so polling still sees what only native events would", async () => {
  const repository = await layout();
  let collections = 0;
  let polls = 0;
  const refresh = createRepositoryRefresh({ entries: [{ kind: "dir", absolutePath: repository }], roots: () => [],
    publish: () => {}, usePolling: true, pollIntervalMs: 20, minCollectionGapMs: 0,
    collect: async () => { collections++; return []; }, onPoll: () => { polls++; } });
  try {
    refresh.demand(true);
    await until(() => polls >= 2 && refresh.freshness.status === "ready");
    const before = collections;
    await until(() => collections > before);
  } finally { refresh.stop(); await rm(repository, { recursive: true, force: true }); }
});

test("a collection follows the observer's start, covering changes made while its watches were installed", async () => {
  const { state, observe } = fakeObserver();
  const started = Promise.withResolvers<void>();
  state.start = () => started.promise;
  let collections = 0;
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: () => {}, observe, minCollectionGapMs: 0,
    collect: async () => { collections++; return []; } });
  try {
    refresh.demand(true);
    await until(() => collections >= 2 && refresh.freshness.status === "ready");
    const before = collections;
    started.resolve();
    await until(() => collections > before);
  } finally { refresh.stop(); }
});

test("a collection that finds a different set of repositories re-resolves the observer", async () => {
  const { state, observe } = fakeObserver();
  let status = "non-git";
  let head = "a";
  const snapshot = () => [{ id: "/repo", rootPath: "/repo", metadata: { status, commitShort: head } }] as unknown as RepositorySnapshot[];
  const refresh = createRepositoryRefresh({ entries: [], roots: () => [], publish: () => {}, observe, minCollectionGapMs: 0, collect: async () => snapshot() });
  try {
    refresh.demand(true);
    await until(() => state.starts === 1 && refresh.freshness.status === "ready");
    await refresh.refresh();
    expect(state.resyncs).toBe(0);
    // git init above a narrow root: the next collection sees a repository.
    status = "git";
    await refresh.refresh();
    expect(state.resyncs).toBe(1);
    // An ordinary change inside the same repository does not.
    head = "b";
    await refresh.refresh();
    expect(state.resyncs).toBe(1);
  } finally { refresh.stop(); }
});
