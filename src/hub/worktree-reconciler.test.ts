import { describe, expect, test } from "bun:test";

import type { WorktreeCheckout, WorktreeInventory } from "../shared/worktree-contract";
import { WorktreeReconciler, worktreeInventoryFingerprint, type WorktreeReconcilerTimers } from "./worktree-reconciler";

// A deterministic clock: timers fire only when the test advances time.
function fakeClock() {
  let now = 1_000;
  let next = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: WorktreeReconcilerTimers = {
    setTimeout(callback, delayMs) {
      const id = next++;
      pending.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    now: () => now,
    pending: () => pending.size,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

const main: WorktreeCheckout = {
  checkoutId: "c-main", repositoryId: "r", workspaceId: "atlas", path: "/repo/atlas", branch: "main",
  detached: false, main: true, ownership: "main", availability: "present", registered: true, running: false, locked: false,
};

function inventory(checkouts: WorktreeCheckout[]): WorktreeInventory {
  return { repositoryId: "r", sourceWorkspaceId: "atlas", status: "ready", checkouts, refs: { local: ["main"], remote: [], fetchedAt: null } };
}

// A controllable Git: each read resolves when the test says so and returns
// whatever the "repository" holds at that moment.
function fakeRepository(initial: WorktreeCheckout[]) {
  let state = initial;
  const waiting: Array<() => void> = [];
  let reads = 0;
  let manual = false;
  return {
    set(next: WorktreeCheckout[]) { state = next; },
    get reads() { return reads; },
    hold() { manual = true; },
    release() { manual = false; for (const resolve of waiting.splice(0)) resolve(); },
    async read(): Promise<WorktreeInventory> {
      reads += 1;
      if (manual) await new Promise<void>(resolve => waiting.push(resolve));
      return inventory(state);
    },
  };
}

function setup(initial: WorktreeCheckout[] = [main]) {
  const clock = fakeClock();
  const repository = fakeRepository(initial);
  const changes: Array<{ source: string; inventory: WorktreeInventory }> = [];
  const registered = new Map([["atlas", "atlas"], ["atlas-child", "atlas"]]);
  const reconciler = new WorktreeReconciler({
    inventory: () => repository.read(),
    sourceFor: id => registered.get(id),
    onChange: (source, value) => changes.push({ source, inventory: value }),
    minIntervalMs: 5_000,
    periodMs: 60_000,
    now: clock.now,
    timers: clock.timers,
  });
  return { clock, repository, changes, reconciler };
}

const external: WorktreeCheckout = {
  checkoutId: "c-ext", repositoryId: "r", path: "/repo/elsewhere", branch: "agent/tree", detached: false, main: false,
  ownership: "external", availability: "present", registered: false, running: false, locked: false,
};

describe("coalescing", () => {
  test("requests while a read is in flight collapse into one trailing read", async () => {
    const { repository, reconciler } = setup();
    repository.hold();
    const first = reconciler.request("atlas", "manual");
    const joined = [reconciler.request("atlas", "activity"), reconciler.request("atlas-child", "open"), reconciler.request("atlas", "manual")];
    expect(repository.reads).toBe(1);
    repository.release();
    await first;
    await flush();
    repository.release();
    await Promise.all(joined);
    // One in flight + exactly one trailing read for three joiners.
    expect(repository.reads).toBe(2);
  });

  test("activity bursts inside the minimum interval become one read at the boundary", async () => {
    const { clock, repository, reconciler } = setup();
    await reconciler.request("atlas", "open");
    expect(repository.reads).toBe(1);
    const burst = Array.from({ length: 5 }, () => reconciler.request("atlas", "activity"));
    await clock.advance(1_000);
    burst.push(reconciler.request("atlas-child", "subscribe"));
    expect(repository.reads).toBe(1);
    await clock.advance(3_999);
    expect(repository.reads).toBe(1);
    await clock.advance(1);
    expect(repository.reads).toBe(2);
    await Promise.all(burst);
    expect(repository.reads).toBe(2);
    expect(clock.pending()).toBe(0);
  });

  test("manual and open reads are not rate-limited and also satisfy a scheduled read", async () => {
    const { clock, repository, reconciler } = setup();
    await reconciler.request("atlas", "open");
    const scheduled = reconciler.request("atlas", "activity");
    await reconciler.request("atlas", "manual");
    expect(repository.reads).toBe(2);
    await reconciler.request("atlas", "open");
    expect(repository.reads).toBe(3);
    await scheduled;
    await clock.advance(10_000);
    expect(repository.reads).toBe(3);
  });

  test("an unregistered workspace is never read", async () => {
    const { repository, reconciler } = setup();
    expect(await reconciler.request("ghost", "manual")).toBeUndefined();
    expect(repository.reads).toBe(0);
  });
});

describe("change detection and publication", () => {
  test("the first read is a baseline; only an observable change is published", async () => {
    const { clock, repository, changes, reconciler } = setup();
    await reconciler.request("atlas", "open");
    expect(changes).toHaveLength(0);
    await reconciler.request("atlas", "manual");
    expect(changes).toHaveLength(0);
    // Reordering is not a change.
    repository.set([main]);
    await reconciler.request("atlas", "manual");
    expect(changes).toHaveLength(0);
    repository.set([main, external]);
    await clock.advance(5_000);
    await reconciler.request("atlas-child", "activity");
    expect(changes.map(change => change.source)).toEqual(["atlas"]);
  });

  test("an external discovery is published as external and unregistered — never registered or opened", async () => {
    const { repository, changes, reconciler } = setup();
    await reconciler.request("atlas", "open");
    repository.set([main, external]);
    const read = await reconciler.request("atlas", "manual");
    const discovered = read!.checkouts.find(checkout => checkout.checkoutId === "c-ext")!;
    expect(discovered).toMatchObject({ ownership: "external", registered: false });
    expect(discovered.workspaceId).toBeUndefined();
    expect(changes).toHaveLength(1);
  });

  test("missing and replaced registrations are reported as such, without recreation or switching", async () => {
    const child: WorktreeCheckout = { ...external, checkoutId: "c-child", workspaceId: "atlas-child", parentWorkspaceId: "atlas", registered: true, ownership: "uatu", branch: "feature/x", sourceRef: "main" };
    const { repository, changes, reconciler } = setup([main, child]);
    await reconciler.request("atlas", "open");
    repository.set([main, { ...child, availability: "missing" }]);
    await reconciler.request("atlas", "manual");
    repository.set([main, { ...child, availability: "replaced", ownership: "uncertain" }]);
    await reconciler.request("atlas", "manual");
    expect(changes.map(change => change.inventory.checkouts[1]!.availability)).toEqual(["missing", "replaced"]);
    // Provenance fields pass through untouched; the registration stays.
    expect(changes.every(change => change.inventory.checkouts[1]!.workspaceId === "atlas-child")).toBe(true);
    expect(changes[0]!.inventory.checkouts[1]!.sourceRef).toBe("main");
  });

  test("the fingerprint ignores refs and order but not ownership, availability or running", () => {
    const base = inventory([main, external]);
    const same = { ...inventory([external, main]), refs: { local: ["x"], remote: ["origin/y"], fetchedAt: 5 } };
    expect(worktreeInventoryFingerprint(base)).toBe(worktreeInventoryFingerprint(same));
    for (const changed of [{ ownership: "uncertain" as const }, { availability: "missing" as const }, { running: true }]) {
      expect(worktreeInventoryFingerprint(inventory([main, { ...external, ...changed }]))).not.toBe(worktreeInventoryFingerprint(base));
    }
  });
});

describe("committed operations", () => {
  test("a rebaseline absorbs a change a committed operation already announced", async () => {
    const { repository, changes, reconciler } = setup();
    await reconciler.request("atlas", "open");
    repository.set([main, external]);
    await reconciler.rebaseline("atlas-child");
    expect(changes).toHaveLength(0);
    await reconciler.request("atlas", "manual");
    expect(changes).toHaveLength(0);
    expect(await reconciler.rebaseline("ghost")).toBeUndefined();
  });
});

describe("bounded periodic cadence", () => {
  test("runs only while a page is interested and stops when the last one leaves", async () => {
    const { clock, repository, reconciler } = setup();
    await clock.advance(120_000);
    expect(repository.reads).toBe(0);
    const releaseA = reconciler.retain("atlas");
    const releaseB = reconciler.retain("atlas-child");
    await clock.advance(60_000);
    expect(repository.reads).toBe(1);
    await clock.advance(60_000);
    expect(repository.reads).toBe(2);
    releaseA();
    await clock.advance(60_000);
    expect(repository.reads).toBe(3);
    releaseB();
    releaseB();
    await clock.advance(600_000);
    expect(repository.reads).toBe(3);
    expect(clock.pending()).toBe(0);
    expect(reconciler.interested()).toEqual([]);
  });

  test("a periodic tick does not double a read the minimum interval already covers", async () => {
    const { clock, repository, reconciler } = setup();
    reconciler.retain("atlas");
    await clock.advance(59_000);
    await reconciler.request("atlas", "activity");
    expect(repository.reads).toBe(1);
    await clock.advance(1_000);
    // The tick lands inside the interval: deferred to its boundary, once.
    expect(repository.reads).toBe(1);
    await clock.advance(4_000);
    expect(repository.reads).toBe(2);
  });

  test("dispose cancels every timer and ignores later requests", async () => {
    const { clock, repository, reconciler } = setup();
    reconciler.retain("atlas");
    await reconciler.request("atlas", "open");
    void reconciler.request("atlas", "activity");
    reconciler.dispose();
    expect(clock.pending()).toBe(0);
    expect(await reconciler.request("atlas", "manual")).toBeUndefined();
    expect(repository.reads).toBe(1);
  });
});
