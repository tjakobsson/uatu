import { expect, test } from "bun:test";
import { NotificationFeed } from "./notification-feed";
import type { AgentNotificationEvent } from "./notifications";

const pending = (id: string, createdAt = 1000): AgentNotificationEvent => ({ type: "notification", notification: { id, sourceId: id, conversationId: "opencode:one", kind: "question-pending", createdAt } });

test("snapshot and live handoff has one boundary with no lost occurrence", async () => {
  const feed = new NotificationFeed(() => 1000);
  feed.publish(pending("before"));
  const subscriber = feed.subscribe();
  feed.publish(pending("after"));
  expect((await subscriber.next()).value).toMatchObject({ type: "snapshot", reason: "initial", pending: [{ id: "before" }] });
  expect((await subscriber.next()).value).toMatchObject({ type: "event", event: { notification: { id: "after" } } });
  subscriber.cancel();
});

test("retained cursors replay occurrences and resolutions in order", async () => {
  const feed = new NotificationFeed(() => 1000);
  const first = feed.subscribe();
  const cursor = (await first.next()).value!.cursor;
  first.cancel();
  feed.publish(pending("q"));
  feed.publish({ type: "resolved", id: "q", conversationId: "opencode:one" });
  const second = feed.subscribe(cursor);
  expect((await second.next()).value).toMatchObject({ type: "event", event: { type: "notification" } });
  expect((await second.next()).value).toMatchObject({ type: "event", event: { type: "resolved" } });
  expect((await second.next()).value).toMatchObject({ type: "ready" });
  expect(feed.snapshot()).toEqual([]);
  second.cancel();
});

test("a gap returns only pending requests with their original timestamps", async () => {
  const feed = new NotificationFeed(() => 1500, 400);
  const subscriber = feed.subscribe();
  const cursor = (await subscriber.next()).value!.cursor;
  subscriber.cancel();
  feed.publish(pending("first"));
  feed.publish({ type: "notification", notification: { id: "turn", sourceId: "turn", conversationId: "opencode:one", kind: "turn-completed", createdAt: 1200 } });
  feed.publish(pending("last"));
  const restored = feed.subscribe(cursor);
  const snapshot = (await restored.next()).value!;
  expect(snapshot).toMatchObject({ type: "snapshot", reason: "gap", pending: [{ id: "first", createdAt: 1000 }, { id: "last", createdAt: 1000 }] });
  restored.cancel();
});

test("aborted, disposed, and slow subscriptions release their queues", async () => {
  const feed = new NotificationFeed(() => 1000);
  const abort = new AbortController();
  const subscriber = feed.subscribe(undefined, abort.signal);
  await subscriber.next();
  const waiting = subscriber.next();
  abort.abort();
  expect((await waiting).done).toBe(true);
  const slow = feed.subscribe();
  for (let i = 0; i < 1200; i++) feed.publish(pending(`${i}${"x".repeat(1000)}`));
  expect((await slow.next()).done).toBe(true);
  const last = feed.subscribe();
  feed.dispose();
  expect((await last.next()).done).toBe(true);
});

test("expired requests leave recovery snapshots", () => {
  let now = 1000;
  const feed = new NotificationFeed(() => now);
  feed.publish(pending("q"));
  now += 300_001;
  expect(feed.snapshot()).toEqual([]);
});
