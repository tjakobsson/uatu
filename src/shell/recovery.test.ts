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

// Payloads carry the server-side timestamp the reconciler orders by, so a
// test can state "the server produced this at 2" directly.
type Payload = { body: string; generatedAt: number };

function payload(body: string, generatedAt: number): Payload {
  return { body, generatedAt };
}

describe("createStateReconciler", () => {
  test("applies the payload it fetched and reports that it won", async () => {
    const applied: string[] = [];
    const reconciler = createStateReconciler<Payload>({
      fetchState: async () => payload("current", 1),
      applyState: value => applied.push(value.body),
      freshnessOf: value => value.generatedAt,
    });
    expect(await reconciler.reconcile()).toBe(true);
    expect(applied).toEqual(["current"]);
  });

  test("an out-of-order fetch cannot overwrite state the server produced earlier", async () => {
    const applied: string[] = [];
    const slow = defer<Payload>();
    const fast = defer<Payload>();
    const pending = [slow, fast];
    const reconciler = createStateReconciler<Payload>({
      fetchState: () => pending.shift()!.promise,
      applyState: value => applied.push(value.body),
      freshnessOf: value => value.generatedAt,
    });

    const first = reconciler.reconcile();
    const second = reconciler.reconcile();
    // The second request answers first, and the server produced its payload
    // later — it is the newer picture of the world.
    fast.resolve(payload("newer", 2));
    expect(await second).toBe(true);
    slow.resolve(payload("older", 1));
    expect(await first).toBe(false);
    expect(applied).toEqual(["newer"]);
  });

  test("the newest request still applies when an older one answered first", async () => {
    const applied: string[] = [];
    const older = defer<Payload>();
    const newer = defer<Payload>();
    const pending = [older, newer];
    const reconciler = createStateReconciler<Payload>({
      fetchState: () => pending.shift()!.promise,
      applyState: value => applied.push(value.body),
      freshnessOf: value => value.generatedAt,
    });

    const first = reconciler.reconcile();
    const second = reconciler.reconcile();
    // Replies arrive in issue order. Ordering by completion would have let the
    // first reply block the second, leaving the UI on the older context after
    // a rapid scope change.
    older.resolve(payload("older context", 1));
    expect(await first).toBe(true);
    newer.resolve(payload("newer context", 2));
    expect(await second).toBe(true);
    expect(applied).toEqual(["older context", "newer context"]);
  });

  test("the newest request wins even when the server stamped it earlier", async () => {
    // Overlapping scope changes: the server handles the later-issued request
    // first and stamps it earlier. Freshness alone would let the stale request
    // put the user back on the previous scope.
    const applied: string[] = [];
    const older = defer<Payload>();
    const newer = defer<Payload>();
    const pending = [older, newer];
    const reconciler = createStateReconciler<Payload>({
      fetchState: () => pending.shift()!.promise,
      applyState: value => applied.push(value.body),
      freshnessOf: value => value.generatedAt,
    });

    const first = reconciler.reconcile();
    const second = reconciler.reconcile();
    newer.resolve(payload("scope the user asked for", 100));
    expect(await second).toBe(true);
    older.resolve(payload("previous scope", 101));
    expect(await first).toBe(false);
    expect(applied).toEqual(["scope the user asked for"]);
  });

  test("a frame older than applied state is refused", () => {
    const applied: string[] = [];
    const reconciler = createStateReconciler<Payload>({
      fetchState: async () => payload("reconciled", 10),
      applyState: value => applied.push(value.body),
      freshnessOf: value => value.generatedAt,
    });

    // The initial frame of a stream opened just before the fetch answered: the
    // server produced it earlier, so it must not put the older roots back.
    expect(reconciler.acceptFrame(3)).toBe(true);
    return reconciler.reconcile().then(() => {
      expect(applied).toEqual(["reconciled"]);
      expect(reconciler.acceptFrame(4)).toBe(false);
      expect(reconciler.acceptFrame(11)).toBe(true);
    });
  });

  test("a stream frame the server produced later invalidates the fetch in flight", async () => {
    const applied: string[] = [];
    const slow = defer<Payload>();
    const reconciler = createStateReconciler<Payload>({
      fetchState: () => slow.promise,
      applyState: value => applied.push(value.body),
      freshnessOf: value => value.generatedAt,
    });

    const inFlight = reconciler.reconcile();
    // The stream delivered state the server produced after this fetch's.
    reconciler.acceptFrame(5);
    slow.resolve(payload("stale", 4));
    expect(await inFlight).toBe(false);
    expect(applied).toEqual([]);
  });

  test("a fetch the server answered after a buffered frame still applies", async () => {
    // The frame arrived later but the server produced it EARLIER — a frame
    // buffered before the fetch was issued and delivered while it was in
    // flight. Ordering by arrival would discard the fresher fetch.
    const applied: string[] = [];
    const slow = defer<Payload>();
    const reconciler = createStateReconciler<Payload>({
      fetchState: () => slow.promise,
      applyState: value => applied.push(value.body),
      freshnessOf: value => value.generatedAt,
    });

    const inFlight = reconciler.reconcile();
    reconciler.acceptFrame(1);
    slow.resolve(payload("fresher", 9));
    expect(await inFlight).toBe(true);
    expect(applied).toEqual(["fresher"]);
  });

  test("an out-of-order stream frame cannot lower the applied watermark", async () => {
    const applied: string[] = [];
    const reconciler = createStateReconciler<Payload>({
      fetchState: async () => payload("stale", 3),
      applyState: value => applied.push(value.body),
      freshnessOf: value => value.generatedAt,
    });

    reconciler.acceptFrame(7);
    reconciler.acceptFrame(2);
    expect(await reconciler.reconcile()).toBe(false);
    expect(applied).toEqual([]);
  });

  test("a newer request losing to a stream frame still bars the older one", async () => {
    // The newer request's payload is older than a frame that landed between
    // the two replies. It loses — but it has still answered, so the older
    // request that follows must not reinstate the context it was issued for.
    const applied: string[] = [];
    const older = defer<Payload>();
    const newer = defer<Payload>();
    const pending = [older, newer];
    const reconciler = createStateReconciler<Payload>({
      fetchState: () => pending.shift()!.promise,
      applyState: value => applied.push(value.body),
      freshnessOf: value => value.generatedAt,
    });

    const first = reconciler.reconcile();
    const second = reconciler.reconcile();
    reconciler.acceptFrame(50);
    newer.resolve(payload("scope the user asked for", 40));
    expect(await second).toBe(false);
    older.resolve(payload("previous scope", 60));
    expect(await first).toBe(false);
    expect(applied).toEqual([]);
  });

  test("a newer request that failed still bars the older one", async () => {
    const applied: string[] = [];
    const older = defer<Payload>();
    const newer = defer<Payload>();
    const pending = [older, newer];
    const reconciler = createStateReconciler<Payload>({
      fetchState: () => pending.shift()!.promise,
      applyState: value => applied.push(value.body),
      freshnessOf: value => value.generatedAt,
    });

    const first = reconciler.reconcile();
    const second = reconciler.reconcile().catch(() => "rejected");
    newer.reject(new Error("workspace unreachable"));
    expect(await second).toBe("rejected");
    older.resolve(payload("previous scope", 60));
    expect(await first).toBe(false);
    expect(applied).toEqual([]);
  });

  test("a failing fetch rejects without consuming the application slot", async () => {
    const applied: string[] = [];
    const outcomes: Array<() => Promise<Payload>> = [
      async () => { throw new Error("offline"); },
      async () => payload("recovered", 1),
    ];
    const reconciler = createStateReconciler<Payload>({
      fetchState: () => outcomes.shift()!(),
      applyState: value => applied.push(value.body),
      freshnessOf: value => value.generatedAt,
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

  test("a signal arriving during a recovery is safe to drop because every attempt ends with a channel", async () => {
    // The owner's contract (see shell/events.ts): a recovery installs a fresh
    // channel whether its state fetch succeeds or fails. That is what makes
    // dropping an overlapping signal safe rather than a lost wake-up — the
    // in-flight attempt already does everything the duplicate would ask for.
    const gate = defer<void>();
    const channels: string[] = [];
    const h = harness(async () => {
      try {
        await gate.promise;
        throw new Error("workspace unreachable");
      } finally {
        channels.push("installed");
      }
    });

    h.win.fire("pageshow", { persisted: true } as Partial<Event>);
    // Connectivity is restored while the doomed fetch is still in flight.
    h.win.fire("online");
    expect(channels).toHaveLength(0);

    gate.resolve();
    await flush();
    expect(channels).toEqual(["installed"]);
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
