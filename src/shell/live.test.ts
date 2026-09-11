import { afterEach, describe, expect, test } from "bun:test";

import { resetAppBasePathForTests } from "../shared/app-url";
import type { LiveChannel } from "./live-channel";
import {
  disposeLiveChannel,
  installLiveChannelForTests,
  liveChannel,
  recoverLiveChannel,
  registerRecoveryWork,
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

  test("a discarded page disposes the channel; a frozen one keeps it", () => {
    let disposed = 0;
    const channel = {
      connect() {},
      dispose() { disposed += 1; },
    } as unknown as LiveChannel;
    installLiveChannelForTests(channel);
    const win = fakeTarget();
    setGlobal("window", win);
    setGlobal("document", fakeTarget());
    watchPageLifecycle();

    win.fire("pagehide", { persisted: true });
    expect(disposed).toBe(0);
    win.fire("pagehide", { persisted: false });
    expect(disposed).toBe(1);
  });
});
