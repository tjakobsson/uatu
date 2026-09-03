import { describe, expect, test } from "bun:test";

import { createLifecycleRecovery, createStateReconciler, type LifecycleRecoveryTarget } from "./recovery";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Drains the microtask queue so a settled recovery has released its slot.
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

function fakeTarget(): LifecycleRecoveryTarget & { fire(type: string, event?: Partial<Event>): void; count(type: string): number } {
  const listeners = new Map<string, ((event: Event) => void)[]>();
  return {
    addEventListener(type, listener) {
      const bucket = listeners.get(type) ?? [];
      bucket.push(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      const bucket = listeners.get(type) ?? [];
      const index = bucket.indexOf(listener);
      if (index >= 0) bucket.splice(index, 1);
    },
    fire(type, event = {}) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, ...event } as Event);
    },
    count(type) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

describe("createStateReconciler", () => {
  test("applies the payload it fetched and reports that it won", async () => {
    const applied: string[] = [];
    const reconciler = createStateReconciler<string>({
      fetchState: async () => "current",
      applyState: value => applied.push(value),
    });
    expect(await reconciler.reconcile()).toBe(true);
    expect(applied).toEqual(["current"]);
  });

  test("an out-of-order fetch cannot overwrite state a later fetch already applied", async () => {
    const applied: string[] = [];
    const slow = defer<string>();
    const fast = defer<string>();
    const pending = [slow, fast];
    const reconciler = createStateReconciler<string>({
      fetchState: () => pending.shift()!.promise,
      applyState: value => applied.push(value),
    });

    const first = reconciler.reconcile();
    const second = reconciler.reconcile();
    // The second request answers first — it is the newer picture of the world.
    fast.resolve("newer");
    expect(await second).toBe(true);
    slow.resolve("older");
    expect(await first).toBe(false);
    expect(applied).toEqual(["newer"]);
  });

  test("a stream frame applied mid-fetch invalidates the fetch in flight", async () => {
    const applied: string[] = [];
    const slow = defer<string>();
    const reconciler = createStateReconciler<string>({
      fetchState: () => slow.promise,
      applyState: value => applied.push(value),
    });

    const inFlight = reconciler.reconcile();
    // The replacement stream delivered its own authoritative state first.
    reconciler.noteApplied();
    slow.resolve("stale");
    expect(await inFlight).toBe(false);
    expect(applied).toEqual([]);
  });

  test("a failing fetch rejects without consuming the application slot", async () => {
    const applied: string[] = [];
    const outcomes: Array<() => Promise<string>> = [
      async () => { throw new Error("offline"); },
      async () => "recovered",
    ];
    const reconciler = createStateReconciler<string>({
      fetchState: () => outcomes.shift()!(),
      applyState: value => applied.push(value),
    });

    await expect(reconciler.reconcile()).rejects.toThrow("offline");
    expect(await reconciler.reconcile()).toBe(true);
    expect(applied).toEqual(["recovered"]);
  });
});

describe("createLifecycleRecovery", () => {
  function harness(recover: () => Promise<unknown>) {
    const win = fakeTarget();
    const doc = Object.assign(fakeTarget(), { visibilityState: "visible" });
    const discards: number[] = [];
    const lifecycle = createLifecycleRecovery({
      win,
      doc,
      recover,
      discard: () => discards.push(1),
    });
    return { win, doc, lifecycle, discards };
  }

  test("a restored page, a return to the foreground, and regained network each reconcile", async () => {
    let runs = 0;
    const h = harness(async () => { runs += 1; });

    h.win.fire("pageshow", { persisted: true } as Partial<Event>);
    await flush();
    h.doc.fire("visibilitychange");
    await flush();
    h.win.fire("online");
    await flush();

    expect(runs).toBe(3);
  });

  test("simultaneous wake signals converge to one reconciliation", async () => {
    const gate = defer<void>();
    let runs = 0;
    const h = harness(async () => { runs += 1; await gate.promise; });

    // The burst a phone produces on resume: all three in the same tick.
    h.win.fire("pageshow", { persisted: true } as Partial<Event>);
    h.doc.fire("visibilitychange");
    h.win.fire("online");
    expect(runs).toBe(1);

    gate.resolve();
    await flush();
    expect(runs).toBe(1);

    // A genuinely later signal still recovers.
    h.win.fire("online");
    expect(runs).toBe(2);
  });

  test("a first load does not reconcile — boot already installed a stream", () => {
    let runs = 0;
    const h = harness(async () => { runs += 1; });
    h.win.fire("pageshow", { persisted: false } as Partial<Event>);
    expect(runs).toBe(0);
  });

  test("a hidden page does not reconcile on visibility change", () => {
    let runs = 0;
    const h = harness(async () => { runs += 1; });
    h.doc.visibilityState = "hidden";
    h.doc.fire("visibilitychange");
    expect(runs).toBe(0);
  });

  test("a failed recovery does not wedge the coalescer", async () => {
    let runs = 0;
    const h = harness(async () => { runs += 1; throw new Error("still offline"); });
    h.win.fire("online");
    await flush();
    h.win.fire("online");
    expect(runs).toBe(2);
  });

  test("a discarded page tears the channel down; a frozen one does not", () => {
    const h = harness(async () => {});
    h.win.fire("pagehide", { persisted: true } as Partial<Event>);
    expect(h.discards).toHaveLength(0);
    h.win.fire("pagehide", { persisted: false } as Partial<Event>);
    expect(h.discards).toHaveLength(1);
  });

  test("disposal removes every listener and stops honouring signals", () => {
    let runs = 0;
    const h = harness(async () => { runs += 1; });
    h.lifecycle.dispose();
    expect(h.win.count("pageshow")).toBe(0);
    expect(h.win.count("online")).toBe(0);
    expect(h.win.count("pagehide")).toBe(0);
    expect(h.doc.count("visibilitychange")).toBe(0);
    h.lifecycle.request();
    expect(runs).toBe(0);
  });
});
