import { afterEach, describe, expect, test } from "bun:test";

import { resetAppBasePathForTests } from "../shared/app-url";
import type { LiveChannel } from "./live-channel";
import { createLiveChannel } from "./live-channel";
import {
  disposeLiveChannel,
  installLiveChannelForTests,
  awaitConfirmedLive,
  installManualRecoveryForTests,
  isManualRecoveryInFlight,
  liveChannel,
  onManualRecovery,
  recoverLiveChannel,
  registerRecoveryWork,
  requestManualRecovery,
  watchPageLifecycle,
} from "./live";

const savedGlobals = new Map<string, unknown>();

function setGlobal(key: string, value: unknown) {
  if (!savedGlobals.has(key)) savedGlobals.set(key, Reflect.get(globalThis, key));
  Reflect.set(globalThis, key, value);
}

afterEach(() => {
  disposeLiveChannel();
  installLiveChannelForTests(null);
  installManualRecoveryForTests(null);
  for (const [key, value] of savedGlobals) Reflect.set(globalThis, key, value);
  savedGlobals.clear();
  resetAppBasePathForTests();
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function fakeTarget() {
  const listeners = new Map<string, ((event: Event) => void)[]>();
  return {
    visibilityState: "visible",
    addEventListener(type: string, listener: (event: Event) => void) {
      const bucket = listeners.get(type) ?? [];
      bucket.push(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      const bucket = listeners.get(type) ?? [];
      const index = bucket.indexOf(listener);
      if (index >= 0) bucket.splice(index, 1);
    },
    fire(type: string, event: Record<string, unknown> = {}) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, ...event } as unknown as Event);
    },
    querySelector() { return null; },
  };
}

class CountingSource {
  static instances: CountingSource[] = [];
  closed = false;
  constructor(readonly url: string) { CountingSource.instances.push(this); }
  addEventListener() {}
  close() { this.closed = true; }
}

describe("the page's live channel singleton", () => {
  test("is created once, keyed by the hub-shaped base path, and opens the hub's live route", () => {
    CountingSource.instances = [];
    setGlobal("document", { querySelector: () => ({ getAttribute: () => "/s/docs%20site/" }) });
    setGlobal("EventSource", CountingSource);
    resetAppBasePathForTests();

    const channel = liveChannel();
    expect(liveChannel()).toBe(channel);
    channel.connect();
    expect(CountingSource.instances).toHaveLength(1);
    const url = new URL(CountingSource.instances[0]!.url, "http://hub.invalid");
    expect(url.pathname).toBe("/api/hub/live");
    expect(url.searchParams.get("ws")).toBe("docs site");
    expect(url.searchParams.get("activity")).toBe("1");
  });

  test("a page served at the root opens the stream without a workspace or activity", () => {
    CountingSource.instances = [];
    setGlobal("document", { querySelector: () => null });
    setGlobal("EventSource", CountingSource);
    resetAppBasePathForTests();

    liveChannel().connect();
    expect(CountingSource.instances[0]!.url).toBe("/api/hub/live");
  });

  test("a wake-up burst reconnects the one channel once and runs every consumer's reconciliation", async () => {
    let connects: { resumed?: boolean }[] = [];
    const gate = defer<void>();
    const work: string[] = [];
    const channel = {
      connect(options?: { resumed?: boolean }) { connects.push(options ?? {}); },
      dispose() {},
    } as unknown as LiveChannel;
    installLiveChannelForTests(channel);
    const win = fakeTarget();
    const doc = fakeTarget();
    setGlobal("window", win);
    setGlobal("document", doc);

    const unregisterDocument = registerRecoveryWork(async () => { work.push("document"); await gate.promise; });
    registerRecoveryWork(async () => { work.push("inventory"); throw new Error("inventory unreachable"); });
    watchPageLifecycle();

    // The burst a phone produces on resume: all three in the same tick.
    win.fire("pageshow", { persisted: true });
    doc.fire("visibilitychange");
    win.fire("online");
    expect(connects).toEqual([{ resumed: true }]);
    expect(work).toEqual(["document", "inventory"]);

    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    // One failing consumer does not stop the coalescer; a genuinely later
    // signal recovers again, and unregistered work is left out.
    unregisterDocument();
    win.fire("online");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(connects).toEqual([{ resumed: true }, { resumed: true }]);
    expect(work).toEqual(["document", "inventory", "inventory"]);
    connects = [];
  });

  test("the channel is superseded before any reconciliation runs", async () => {
    const order: string[] = [];
    const channel = {
      connect() { order.push("connect"); },
      dispose() {},
    } as unknown as LiveChannel;
    installLiveChannelForTests(channel);
    registerRecoveryWork(async () => { order.push("fetch"); });
    await recoverLiveChannel();
    expect(order).toEqual(["connect", "fetch"]);
  });

  test("a hidden page releases its stream; a regained network while hidden leaves it released; showing the page reconnects", async () => {
    let suspends = 0;
    const connects: { resumed?: boolean }[] = [];
    const channel = {
      connect(options?: { resumed?: boolean }) { connects.push(options ?? {}); },
      suspend() { suspends += 1; },
      dispose() {},
    } as unknown as LiveChannel;
    installLiveChannelForTests(channel);
    const win = fakeTarget();
    const doc = fakeTarget();
    setGlobal("window", win);
    setGlobal("document", doc);
    watchPageLifecycle();
    expect(suspends).toBe(0);

    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    expect(suspends).toBe(1);
    expect(connects).toEqual([]);

    win.fire("online");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(connects).toEqual([]);

    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(connects).toEqual([{ resumed: true }]);
  });

  test("a page booted in a background tab releases the stream boot opened", () => {
    let suspends = 0;
    const channel = {
      connect() {},
      suspend() { suspends += 1; },
      dispose() {},
    } as unknown as LiveChannel;
    installLiveChannelForTests(channel);
    const doc = fakeTarget();
    doc.visibilityState = "hidden";
    setGlobal("window", fakeTarget());
    setGlobal("document", doc);
    watchPageLifecycle();
    expect(suspends).toBe(1);
  });

  test("a pagehide releases the channel whether or not the browser promises a restore, and never disposes it", () => {
    let disposed = 0;
    let suspends = 0;
    const channel = {
      connect() {},
      suspend() { suspends += 1; },
      dispose() { disposed += 1; },
    } as unknown as LiveChannel;
    installLiveChannelForTests(channel);
    const win = fakeTarget();
    setGlobal("window", win);
    setGlobal("document", fakeTarget());
    watchPageLifecycle();

    win.fire("pagehide", { persisted: true });
    expect(suspends).toBe(1);
    // iOS backgrounding a standalone page: the shape of a discard, but the
    // document lives on.
    win.fire("pagehide", { persisted: false });
    expect(suspends).toBe(2);
    expect(disposed).toBe(0);
  });

  test("a wake-up after an unpersisted pagehide reconnects the same channel", async () => {
    const connects: { resumed?: boolean }[] = [];
    const channel = {
      connect(options?: { resumed?: boolean }) { connects.push(options ?? {}); },
      suspend() {},
      dispose() {},
    } as unknown as LiveChannel;
    installLiveChannelForTests(channel);
    const win = fakeTarget();
    const doc = fakeTarget();
    setGlobal("window", win);
    setGlobal("document", doc);
    watchPageLifecycle();

    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    win.fire("pagehide", { persisted: false });
    expect(connects).toEqual([]);

    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(connects).toEqual([{ resumed: true }]);
  });

  test("subscriptions and cursors survive the release and are re-presented on the next connect", () => {
    CountingSource.instances = [];
    setGlobal("EventSource", CountingSource);
    const channel = createLiveChannel({
      ws: null,
      activity: false,
      openSource: url => new CountingSource(url),
      fetcher: async () => new Response("{}"),
    });
    installLiveChannelForTests(channel);
    const win = fakeTarget();
    const doc = fakeTarget();
    setGlobal("window", win);
    setGlobal("document", doc);
    channel.connect();
    channel.subscribe({ topic: "document", key: "k" }, {}, { cursor: "doc-7" });
    channel.subscribe({ topic: "conversation", key: "one" }, {}, { cursor: "conv-3" });
    watchPageLifecycle();
    expect(CountingSource.instances).toHaveLength(1);

    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    win.fire("pagehide", { persisted: false });
    // The socket is gone, the subscriptions are not.
    expect(CountingSource.instances[0]!.closed).toBe(true);
    expect(channel.subscriptions()).toEqual([
      { topic: "document", key: "k", cursor: "doc-7" },
      { topic: "conversation", key: "one", cursor: "conv-3" },
    ]);

    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    expect(CountingSource.instances).toHaveLength(2);
    const query = new URL(CountingSource.instances[1]!.url, "http://hub.invalid").searchParams;
    expect(query.get("reconnect")).toBe("1");
    expect(JSON.parse(query.get("subs")!)).toEqual([
      { topic: "document", key: "k", cursor: "doc-7" },
      { topic: "conversation", key: "one", cursor: "conv-3" },
    ]);
  });
});

describe("manual recovery", () => {
  type Status = "connecting" | "reconnecting" | "live";

  function fakeClock() {
    const scheduled: { id: number; run: () => void }[] = [];
    let nextId = 1;
    return {
      timers: {
        setTimeout(callback: () => void) {
          const id = nextId++;
          scheduled.push({ id, run: callback });
          return id as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout(timer: ReturnType<typeof setTimeout>) {
          const index = scheduled.findIndex(entry => entry.id === (timer as unknown as number));
          if (index >= 0) scheduled.splice(index, 1);
        },
      },
      pending: () => scheduled.length,
      elapse: () => scheduled.shift()!.run(),
    };
  }

  // A channel whose confirmation the test hands out by hand.
  function statusChannel() {
    const listeners = new Set<(status: Status) => void>();
    const connects: { resumed?: boolean }[] = [];
    const channel = {
      connect(options?: { resumed?: boolean }) { connects.push(options ?? {}); },
      onStatus(listener: (status: Status) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      suspend() {},
      dispose() {},
    } as unknown as LiveChannel;
    installLiveChannelForTests(channel);
    setGlobal("window", fakeTarget());
    setGlobal("document", fakeTarget());
    return { connects, emit: (status: Status) => { for (const listener of [...listeners]) listener(status); }, listeners };
  }

  test("recovers in place when the channel confirms live within the window", async () => {
    const clock = fakeClock();
    let reloads = 0;
    installManualRecoveryForTests({ reload: () => { reloads += 1; }, timers: clock.timers });
    const channel = statusChannel();
    const work: string[] = [];
    registerRecoveryWork(async () => { work.push("state"); });

    const attempt = requestManualRecovery();
    expect(isManualRecoveryInFlight()).toBe(true);
    // The same recovery a wake-up performs: the channel superseded, the
    // consumers' reconciliation run.
    expect(channel.connects).toEqual([{ resumed: true }]);
    expect(work).toEqual(["state"]);

    channel.emit("reconnecting");
    channel.emit("live");
    await attempt;
    expect(reloads).toBe(0);
    expect(isManualRecoveryInFlight()).toBe(false);
    expect(clock.pending()).toBe(0);
    expect(channel.listeners.size).toBe(0);
  });

  test("falls back to reloading when nothing confirms live within the window", async () => {
    const clock = fakeClock();
    let reloads = 0;
    installManualRecoveryForTests({ reload: () => { reloads += 1; }, timers: clock.timers });
    const channel = statusChannel();

    const attempt = requestManualRecovery();
    channel.emit("reconnecting");
    expect(reloads).toBe(0);
    clock.elapse();
    await attempt;
    expect(reloads).toBe(1);
    expect(isManualRecoveryInFlight()).toBe(false);
  });

  test("a request while an attempt is in flight joins it rather than starting another", async () => {
    const clock = fakeClock();
    let reloads = 0;
    installManualRecoveryForTests({ reload: () => { reloads += 1; }, timers: clock.timers });
    const channel = statusChannel();
    const seen: boolean[] = [];
    onManualRecovery(inFlight => seen.push(inFlight));

    const first = requestManualRecovery();
    const second = requestManualRecovery();
    expect(second).toBe(first);
    expect(channel.connects).toHaveLength(1);
    expect(clock.pending()).toBe(1);

    channel.emit("live");
    await first;
    expect(reloads).toBe(0);
    // Told once at registration, once when the attempt began, once when it ended.
    expect(seen).toEqual([false, true, false]);

    // Once settled, the next request is a fresh attempt.
    void requestManualRecovery();
    expect(channel.connects).toHaveLength(2);
  });

  test("a timed-out attempt on a stopped session does not reload: the indicator offers the start instead", async () => {
    const clock = fakeClock();
    let reloads = 0;
    let stopped = false;
    installManualRecoveryForTests({ reload: () => { reloads += 1; }, timers: clock.timers, sessionStopped: () => stopped });
    const channel = statusChannel();

    // The attempt was under way when the hub reported the session stopped.
    const attempt = requestManualRecovery();
    channel.emit("reconnecting");
    stopped = true;
    clock.elapse();
    await attempt;
    expect(reloads).toBe(0);
    expect(isManualRecoveryInFlight()).toBe(false);

    // Started again meanwhile: the next timeout reloads as before.
    stopped = false;
    const next = requestManualRecovery();
    clock.elapse();
    await next;
    expect(reloads).toBe(1);
  });

  test("awaitConfirmedLive settles on the channel confirming, or on the window elapsing, without a recovery or a reload", async () => {
    const clock = fakeClock();
    let reloads = 0;
    installManualRecoveryForTests({ reload: () => { reloads += 1; }, timers: clock.timers });
    const channel = statusChannel();

    const confirmed = awaitConfirmedLive();
    expect(channel.connects).toEqual([]);
    expect(clock.pending()).toBe(1);
    channel.emit("live");
    expect(await confirmed).toBe("live");
    expect(clock.pending()).toBe(0);
    expect(channel.listeners.size).toBe(0);

    const late = awaitConfirmedLive();
    clock.elapse();
    expect(await late).toBe("timeout");
    expect(reloads).toBe(0);
    expect(channel.connects).toEqual([]);
    expect(channel.listeners.size).toBe(0);
  });

  test("an explicit teardown cancels an attempt without reloading", async () => {
    const clock = fakeClock();
    let reloads = 0;
    installManualRecoveryForTests({ reload: () => { reloads += 1; }, timers: clock.timers });
    statusChannel();
    const attempt = requestManualRecovery();
    disposeLiveChannel();
    await attempt;
    expect(reloads).toBe(0);
    expect(isManualRecoveryInFlight()).toBe(false);
  });
});
