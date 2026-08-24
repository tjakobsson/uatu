import { describe, expect, test } from "bun:test";

import { ConversationInventoryBroadcaster } from "./inventory-broadcaster";

describe("ConversationInventoryBroadcaster", () => {
  test("registers before providing one immediate initial signal", async () => {
    const broadcaster = new ConversationInventoryBroadcaster();
    const subscription = broadcaster.subscribe();

    expect(broadcaster.subscriberCount()).toBe(1);
    expect(await subscription.next()).toEqual({ value: undefined, done: false });
  });

  test("coalesces invalidations into at most one pending signal", async () => {
    const broadcaster = new ConversationInventoryBroadcaster();
    const subscription = broadcaster.subscribe();
    expect((await subscription.next()).done).toBe(false);

    broadcaster.invalidate();
    broadcaster.invalidate();
    broadcaster.invalidate();
    expect((await subscription.next()).done).toBe(false);

    let settled = false;
    const waiting = subscription.next().then(result => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    broadcaster.invalidate();
    expect(await waiting).toEqual({ value: undefined, done: false });
  });

  test("resolves a waiting next call when inventory is invalidated", async () => {
    const broadcaster = new ConversationInventoryBroadcaster();
    const subscription = broadcaster.subscribe();
    await subscription.next();

    const waiting = subscription.next();
    broadcaster.invalidate();

    expect(await waiting).toEqual({ value: undefined, done: false });
  });

  test("keeps subscriber signals independent and supports explicit cancellation", async () => {
    const broadcaster = new ConversationInventoryBroadcaster();
    const first = broadcaster.subscribe();
    const second = broadcaster.subscribe();
    await first.next();
    await second.next();

    broadcaster.invalidate();
    expect((await first.next()).done).toBe(false);
    expect((await second.next()).done).toBe(false);

    const waiting = first.next();

    first.cancel();
    broadcaster.invalidate();

    expect(broadcaster.subscriberCount()).toBe(1);
    expect((await waiting).done).toBe(true);
    expect((await second.next()).done).toBe(false);
  });

  test("AbortSignal closes pending and pre-aborted subscriptions", async () => {
    const broadcaster = new ConversationInventoryBroadcaster();
    const controller = new AbortController();
    const subscription = broadcaster.subscribe(controller.signal);
    await subscription.next();
    const waiting = subscription.next();

    controller.abort();

    expect((await waiting).done).toBe(true);
    expect(broadcaster.subscriberCount()).toBe(0);

    const alreadyAborted = broadcaster.subscribe(controller.signal);
    expect((await alreadyAborted.next()).done).toBe(true);
    expect(broadcaster.subscriberCount()).toBe(0);
  });

  test("iterator return cancels the subscription", async () => {
    const broadcaster = new ConversationInventoryBroadcaster();
    const subscription = broadcaster.subscribe();
    const iterator = subscription[Symbol.asyncIterator]();

    expect(await iterator.return?.()).toEqual({ value: undefined, done: true });
    expect(broadcaster.subscriberCount()).toBe(0);
    expect((await iterator.next()).done).toBe(true);
  });

  test("disposal closes all subscriptions and resolves waiting calls", async () => {
    const broadcaster = new ConversationInventoryBroadcaster();
    const pendingSignal = broadcaster.subscribe();
    const waitingSignal = broadcaster.subscribe();
    await waitingSignal.next();
    const waiting = waitingSignal.next();

    broadcaster.dispose();
    broadcaster.dispose();

    expect(broadcaster.subscriberCount()).toBe(0);
    expect((await pendingSignal.next()).done).toBe(true);
    expect((await waiting).done).toBe(true);
    broadcaster.invalidate();
    expect((await waitingSignal.next()).done).toBe(true);
  });

  test("subscriptions created after disposal are closed", async () => {
    const broadcaster = new ConversationInventoryBroadcaster();
    broadcaster.dispose();

    const subscription = broadcaster.subscribe();

    expect(broadcaster.subscriberCount()).toBe(0);
    expect((await subscription.next()).done).toBe(true);
  });
});
