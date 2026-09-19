import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import { NotificationStore } from "./notification-store";
import { HubNotifications } from "./notifications";
import type { PushSender, PushSendResult } from "./push-sender";
import { NotificationFeed, type NotificationFrame } from "../chat/notification-feed";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const finish of cleanup.splice(0).reverse()) await finish(); });
const principal = { user: "one", sessionId: "session-one" };
function subscription(id: string) {
  const key = createECDH("prime256v1"); key.generateKeys();
  return { endpoint: `https://web.push.apple.com/${id}`, keys: { p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}
const occurrence = (id: string, createdAt: number, kind: "question-pending" | "turn-completed" = "question-pending"): NotificationFrame => ({
  type: "event", cursor: `epoch:${id}`, event: { type: "notification", notification: { id, sourceId: id, conversationId: "opencode:conversation", kind, createdAt } },
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "uatu-notifications-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "notifications.json");
  const store = new NotificationStore(file); await store.load();
  let now = 1000;
  let authorized = true;
  let result: PushSendResult = { kind: "accepted" };
  const sends: Array<{ endpoint: string; payload: string; ttl: number }> = [];
  const sender: PushSender = async (device, payload, ttl) => { sends.push({ endpoint: device.endpoint, payload, ttl }); return result; };
  const feed = new NotificationFeed(() => now);
  let running = false;
  let opens = 0;
  const hub = new HubNotifications({ store, sender, now: () => now, workspaceName: () => "Project",
    authorized: (user, ws) => authorized && user.user === "one" && user.sessionId === "session-one" && ws === "workspace",
    source: {
      isRunning: () => running, workspaceIds: () => ["workspace"],
      open: async request => {
        opens += 1;
        const sub = feed.subscribe(new URL(request.path, "http://child.invalid").searchParams.get("cursor") ?? undefined, request.signal);
        return new Response(new ReadableStream({
          async pull(controller) {
            const next = await sub.next();
            if (next.done) { controller.close(); return; }
            controller.enqueue(new TextEncoder().encode(`event: notification\ndata: ${JSON.stringify(next.value)}\n\n`));
          }, cancel() { sub.cancel(); },
        }));
      },
    },
  });
  cleanup.push(() => hub.dispose());
  return { store, hub, file, sends, feed, opens: () => opens, run: () => { running = true; }, tick: (ms: number) => { now += ms; }, now: () => now,
    revoke: () => { authorized = false; }, result: (value: PushSendResult) => { result = value; },
    enroll: (id = "phone", preferences = {}) => hub.enroll(principal, { subscription: subscription(id), workspaceIds: ["workspace"], needsAnswer: true, completed: true, ...preferences }),
  };
}

test("VAPID identity and enrollment survive restart with private permissions", async () => {
  const f = await fixture();
  const enrolled = await f.enroll();
  const restored = new NotificationStore(f.file); await restored.load();
  expect(restored.snapshot().keys).toEqual(f.store.snapshot().keys);
  expect(restored.snapshot().devices[0]?.id).toBe(enrolled.device!.id);
  expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(enrolled)).not.toContain(f.store.snapshot().keys.privateKey);
  expect(JSON.stringify(enrolled)).not.toContain("web.push.apple.com");
});

test("preferences and authorization filter each device, including changes before retries", async () => {
  const f = await fixture();
  const first = await f.enroll("phone");
  await f.enroll("desktop", { completed: false });
  await f.hub.receive("workspace", occurrence("turn", f.now(), "turn-completed")); await f.hub.drain();
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0]?.endpoint).toEndWith("/phone");
  const payload = JSON.parse(f.sends[0]!.payload);
  expect(payload.body).toBe("Agent turn finished");
  expect(payload.url).toBe("/s/workspace/?conversation=opencode%3Aconversation");
  f.result({ kind: "retry" });
  await f.hub.receive("workspace", occurrence("q", f.now())); await f.hub.drain();
  expect(f.sends).toHaveLength(3);
  await f.hub.remove(principal, first.device!.id);
  f.revoke(); f.tick(10_000); await f.hub.drain();
  expect(f.sends).toHaveLength(3);
  expect(f.store.snapshot().deliveries.every(delivery => delivery.status !== "pending")).toBe(true);
});

test("source replay and persisted accepted delivery do not send twice", async () => {
  const f = await fixture(); await f.enroll();
  const frame = occurrence("q", f.now());
  await f.hub.receive("workspace", frame); await f.hub.drain();
  await f.hub.receive("workspace", frame); await f.hub.drain();
  expect(f.sends).toHaveLength(1);
  const restored = new NotificationStore(f.file); await restored.load();
  expect(restored.snapshot().deliveries).toMatchObject([{ status: "accepted" }]);
  expect(restored.snapshot().cursors.workspace).toBe(frame.cursor);
});

test("retry preserves identity and expiry, while gone endpoints stop delivery", async () => {
  const f = await fixture(); await f.enroll();
  f.result({ kind: "retry", retryAfterMs: 5000 });
  await f.hub.receive("workspace", occurrence("q", f.now())); await f.hub.drain();
  f.tick(4000); await f.hub.drain(); expect(f.sends).toHaveLength(1);
  f.tick(1000); f.result({ kind: "accepted" }); await f.hub.drain();
  expect(f.sends).toHaveLength(2);
  expect(JSON.parse(f.sends[0]!.payload).id).toBe(JSON.parse(f.sends[1]!.payload).id);
  expect(f.sends[1]!.ttl).toBeLessThan(f.sends[0]!.ttl);
  f.result({ kind: "gone" });
  await f.hub.receive("workspace", occurrence("gone", f.now())); await f.hub.drain();
  expect(f.store.snapshot().devices).toEqual([]);
});

test("known resolutions and expired events cancel unsent deliveries", async () => {
  const f = await fixture(); await f.enroll(); f.result({ kind: "retry" });
  await f.hub.receive("workspace", occurrence("resolved", f.now())); await f.hub.drain();
  await f.hub.receive("workspace", { type: "event", cursor: "epoch:resolved", event: { type: "resolved", id: "resolved", conversationId: "opencode:conversation" } });
  f.tick(300_001); await f.hub.drain();
  expect(f.sends).toHaveLength(1);
  await f.hub.receive("workspace", occurrence("expired", 1000)); await f.hub.drain();
  expect(f.sends).toHaveLength(1);
});

test("new enrollment skips historical snapshots; gaps recover only still-pending requests", async () => {
  const f = await fixture(); await f.enroll();
  const notification = (occurrence("pending", f.now()) as Extract<NotificationFrame, { type: "event" }>).event;
  if (notification.type !== "notification") throw new Error("expected notification");
  await f.hub.receive("workspace", { type: "snapshot", reason: "initial", cursor: "e:1", pending: [notification.notification] });
  await f.hub.drain(); expect(f.sends).toHaveLength(0);
  await f.hub.receive("workspace", { type: "snapshot", reason: "gap", cursor: "e:2", pending: [notification.notification] });
  await f.hub.drain(); expect(f.sends).toHaveLength(1);
});

test("two enrolled devices share a feed with no browser page and do not start a stopped workspace", async () => {
  const f = await fixture();
  await f.enroll("phone"); await f.enroll("desktop");
  expect(f.opens()).toBe(0);
  f.run(); f.hub.refresh();
  for (let i = 0; i < 100 && !f.store.snapshot().cursors.workspace; i++) await Bun.sleep(2);
  expect(f.opens()).toBe(1);
  const event = occurrence("live", f.now());
  if (event.type === "event") f.feed.publish(event.event);
  for (let i = 0; i < 100 && f.sends.length < 2; i++) await Bun.sleep(2);
  expect(f.sends).toHaveLength(2);
  f.hub.refresh(); expect(f.opens()).toBe(1);
});

test("other users cannot modify, remove, or adopt a device subscription", async () => {
  const f = await fixture();
  const input = { subscription: subscription("phone"), workspaceIds: ["workspace"], needsAnswer: true, completed: true };
  const state = await f.hub.enroll(principal, input);
  const other = { user: "other", sessionId: "other" };
  expect(f.hub.state(other, state.device!.id).device).toBeNull();
  await expect(f.hub.remove(other, state.device!.id)).rejects.toMatchObject({ status: 404 });
  await expect(f.hub.enroll(other, { ...input, workspaceIds: [] })).rejects.toMatchObject({ status: 409 });
  expect(f.store.snapshot().devices).toHaveLength(1);
});
