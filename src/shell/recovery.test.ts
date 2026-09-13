import { describe, expect, test } from "bun:test";

import { createLifecycleRecovery, createStateReconciler, type LifecycleRecoveryTarget, type LifecycleRecoveryTimers } from "./recovery";

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
  // Timers under test control, so the ceiling can be crossed without waiting.
  function fakeTimers() {
    const scheduled: { id: number; delay: number; run: () => void }[] = [];
    let nextId = 1;
    const timers: LifecycleRecoveryTimers = {
      setTimeout(callback, delay) {
        const id = nextId++;
        scheduled.push({ id, delay, run: callback });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout(timer) {
        const index = scheduled.findIndex(entry => entry.id === (timer as unknown as number));
        if (index >= 0) scheduled.splice(index, 1);
      },
    };
    return {
      timers,
      pending: () => scheduled.length,
      // Fires the oldest pending timer, as the clock passing its delay would.
      elapse() {
        const entry = scheduled.shift();
        if (!entry) throw new Error("nothing scheduled");
        entry.run();
      },
    };
  }

  function harness(recover: () => Promise<unknown>, options: { timers?: LifecycleRecoveryTimers; ceilingMs?: number } = {}) {
    const win = fakeTarget();
    const doc = Object.assign(fakeTarget(), { visibilityState: "visible" });
    const releases: number[] = [];
    const lifecycle = createLifecycleRecovery({
      win,
      doc,
      recover,
      release: () => releases.push(1),
      ...options,
    });
    return { win, doc, lifecycle, releases };
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

  test("an unpersisted pagehide releases the connection, and a return to visible still recovers", async () => {
    // iOS backgrounding a standalone page: `pagehide` with `persisted: false`
    // — the shape of a discard — and then the same document runs again.
    let runs = 0;
    const h = harness(async () => { runs += 1; });

    h.doc.visibilityState = "hidden";
    h.doc.fire("visibilitychange");
    h.win.fire("pagehide", { persisted: false } as Partial<Event>);
    // Once for the hide, once for the pagehide: both are releases.
    expect(h.releases).toHaveLength(2);
    expect(runs).toBe(0);

    h.doc.visibilityState = "visible";
    h.doc.fire("visibilitychange");
    await flush();
    expect(runs).toBe(1);
  });

  test("a frozen page is released the same way and its restore recovers", async () => {
    let runs = 0;
    const h = harness(async () => { runs += 1; });

    h.win.fire("pagehide", { persisted: true } as Partial<Event>);
    expect(h.releases).toHaveLength(1);

    h.win.fire("pageshow", { persisted: true } as Partial<Event>);
    await flush();
    expect(runs).toBe(1);
  });

  test("a page hidden and shown again while a recovery is in flight is recovered once that recovery settles", async () => {
    // The in-flight recovery is waiting on its state fetch when the page is
    // hidden: the release suspends the channel that recovery installed. The
    // return must not be dropped as a duplicate — the recovery in flight
    // will end with no channel — but it must not pile on either.
    const gate = defer<void>();
    let runs = 0;
    const h = harness(async () => { runs += 1; if (runs === 1) await gate.promise; });

    h.win.fire("online");
    expect(runs).toBe(1);

    h.doc.visibilityState = "hidden";
    h.doc.fire("visibilitychange");
    expect(h.releases).toHaveLength(1);
    h.win.fire("pagehide", { persisted: false } as Partial<Event>);
    expect(h.releases).toHaveLength(2);

    h.doc.visibilityState = "visible";
    h.doc.fire("visibilitychange");
    h.win.fire("online");
    expect(runs).toBe(1);

    gate.resolve();
    await flush();
    expect(runs).toBe(2);
  });

  test("a hidden page released mid-recovery is not recovered until it is shown", async () => {
    const gate = defer<void>();
    let runs = 0;
    const h = harness(async () => { runs += 1; if (runs === 1) await gate.promise; });
    h.win.fire("online");
    h.doc.visibilityState = "hidden";
    h.doc.fire("visibilitychange");
    // A regained network while still hidden is a signal, and the follow-up
    // it queues is the owner's to gate (see shell/live.ts); the coalescer
    // itself only refuses to drop it.
    gate.resolve();
    await flush();
    expect(runs).toBe(1);
  });

  test("the ceiling releasing a hidden-then-shown recovery still runs the follow-up", () => {
    const clock = fakeTimers();
    let runs = 0;
    const h = harness(() => { runs += 1; return new Promise(() => {}); }, { timers: clock.timers });
    h.win.fire("online");
    h.win.fire("pagehide", { persisted: false } as Partial<Event>);
    h.doc.fire("visibilitychange");
    expect(runs).toBe(1);
    clock.elapse();
    expect(runs).toBe(2);
  });

  test("a hidden page is released through the lifecycle, so no separate listener is needed", () => {
    const h = harness(async () => {});
    h.doc.visibilityState = "hidden";
    h.doc.fire("visibilitychange");
    expect(h.releases).toHaveLength(1);
  });

  test("no pagehide removes a wake-up listener", () => {
    const h = harness(async () => {});
    const armed = () => ({
      pageshow: h.win.count("pageshow"),
      online: h.win.count("online"),
      pagehide: h.win.count("pagehide"),
      visibilitychange: h.doc.count("visibilitychange"),
    });
    const before = armed();
    expect(before).toEqual({ pageshow: 1, online: 1, pagehide: 1, visibilitychange: 1 });

    h.win.fire("pagehide", { persisted: false } as Partial<Event>);
    expect(armed()).toEqual(before);
    h.win.fire("pagehide", { persisted: true } as Partial<Event>);
    expect(armed()).toEqual(before);
  });

  test("a recovery that never settles stops holding the coalescer once the ceiling passes", () => {
    const clock = fakeTimers();
    let runs = 0;
    // A state fetch the network never answers, registered without a bound
    // of its own.
    const h = harness(() => { runs += 1; return new Promise(() => {}); }, { timers: clock.timers, ceilingMs: 30_000 });

    h.win.fire("online");
    expect(runs).toBe(1);
    // Still held: the signal is dropped.
    h.doc.fire("visibilitychange");
    expect(runs).toBe(1);

    clock.elapse();
    h.doc.fire("visibilitychange");
    expect(runs).toBe(2);
  });

  test("a recovery that settles in time cancels its ceiling", async () => {
    const clock = fakeTimers();
    const h = harness(async () => {}, { timers: clock.timers });
    h.win.fire("online");
    expect(clock.pending()).toBe(1);
    await flush();
    expect(clock.pending()).toBe(0);
  });

  test("an abandoned recovery settling late does not release the recovery that replaced it", async () => {
    const clock = fakeTimers();
    const first = defer<void>();
    const second = defer<void>();
    const pending = [first, second];
    let runs = 0;
    const h = harness(() => { runs += 1; return pending.shift()!.promise; }, { timers: clock.timers });

    h.win.fire("online");
    clock.elapse();
    h.win.fire("online");
    expect(runs).toBe(2);

    // The first, abandoned recovery finally answers. The second is still in
    // flight and must keep its slot.
    first.resolve();
    await flush();
    h.win.fire("online");
    expect(runs).toBe(2);

    second.resolve();
    await flush();
    h.win.fire("online");
    expect(runs).toBe(3);
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
