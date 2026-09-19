import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
async function fixture(options: { settleTimeoutMs?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "uatu-notifications-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "notifications.json");
  const store = new NotificationStore(file); await store.load();
  let now = 1000;
  let authorized = true;
  const sessions = new Set(["session-one"]);
  let result: PushSendResult = { kind: "accepted" };
  const results = new Map<string, PushSendResult>();
  const sends: Array<{ endpoint: string; payload: string; ttl: number }> = [];
  const gates = new Map<string, Promise<void>>();
  const sender: PushSender = async (device, payload, ttl) => {
    sends.push({ endpoint: device.endpoint, payload, ttl }); await gates.get(device.endpoint); return results.get(device.endpoint) ?? result;
  };
  const feed = new NotificationFeed(() => now);
  const running = new Set<string>();
  const registered = new Set(["workspace", "other"]);
  let opens = 0;
  let batch: NotificationFrame[] | null = null;
  let onOpen = () => {};
  // A hung feed answers only when released, or rejects when the hub gives up on it.
  let stalled: Array<{ resolve: () => void; signal?: AbortSignal }> | null = null;
  let failOpens = 0;
  const hub = new HubNotifications({ store, sender, now: () => now, settleTimeoutMs: options.settleTimeoutMs ?? 50, workspaceName: ws => ws === "workspace" ? "Project" : "Other",
    authorized: (user, ws) => authorized && user.user === "one" && sessions.has(user.sessionId) && (ws === undefined || registered.has(ws)),
    source: {
      isRunning: ws => running.has(ws), workspaceIds: () => [...registered],
      open: async request => {
        opens += 1; onOpen();
        if (failOpens > 0) { failOpens -= 1; return new Response(null, { status: 503 }); }
        if (stalled) await new Promise<void>((resolve, reject) => {
          stalled!.push({ resolve, signal: request.signal });
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        if (batch) { const chunk = batch.map(frame => `event: notification\ndata: ${JSON.stringify(frame)}\n\n`).join(""); batch = null; return new Response(chunk); }
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
  return { store, hub, file, sends, feed, opens: () => opens, run: (ws = "workspace") => { running.add(ws); }, tick: (ms: number) => { now += ms; }, now: () => now,
    register: (ws: string) => { registered.add(ws); }, unregister: (ws: string) => { registered.delete(ws); running.delete(ws); },
    failNextOpen: () => { failOpens += 1; }, stall: () => { stalled = []; }, release: () => { const waiting = stalled ?? []; stalled = null; for (const entry of waiting) entry.resolve(); },
    revoke: () => { authorized = false; }, result: (value: PushSendResult) => { result = value; },
    batch: (frames: NotificationFrame[]) => { batch = frames; }, onOpen: (hook: () => void) => { onOpen = hook; }, sessions, resultFor: (id: string, value: PushSendResult) => { results.set(`https://web.push.apple.com/${id}`, value); },
    hold: (id: string) => { let release!: () => void; gates.set(`https://web.push.apple.com/${id}`, new Promise<void>(resolve => { release = resolve; })); return release; },
    enroll: (id = "phone", preferences = {}, as = principal) => hub.enroll(as, { subscription: subscription(id), workspaceIds: ["workspace"], needsAnswer: true, completed: true, ...preferences }),
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

test("snapshots skip requests that predate enrollment and recover those pending since then", async () => {
  const f = await fixture(); await f.enroll();
  const pending = (id: string, createdAt: number) => {
    const event = (occurrence(id, createdAt) as Extract<NotificationFrame, { type: "event" }>).event;
    if (event.type !== "notification") throw new Error("expected notification");
    return event.notification;
  };
  const history = pending("history", f.now() - 1);
  await f.hub.receive("workspace", { type: "snapshot", reason: "initial", cursor: "e:1", pending: [history, pending("first", f.now())] });
  await f.hub.drain(); expect(f.sends).toHaveLength(1);
  f.tick(10);
  await f.hub.receive("workspace", { type: "snapshot", reason: "gap", cursor: "e:2", pending: [history, pending("first", f.now() - 10), pending("second", f.now())] });
  await f.hub.drain(); expect(f.sends).toHaveLength(2);
  expect(f.store.snapshot().deliveries.map(delivery => JSON.parse(delivery.key)[2])).toEqual(["first", "second"]);
});

test("enabling one category keeps the other category's cutoff and its queued retry", async () => {
  const f = await fixture();
  const device = (await f.enroll("phone", { completed: false })).device!;
  f.result({ kind: "retry", retryAfterMs: 1000 });
  await f.hub.receive("workspace", occurrence("question", f.now())); await f.hub.drain();
  expect(f.sends).toHaveLength(1);
  f.tick(500);
  await f.enroll("phone", { id: device.id, completed: true });
  await f.hub.receive("workspace", occurrence("earlier-turn", f.now() - 1, "turn-completed")); await f.hub.drain();
  await f.hub.receive("workspace", occurrence("later-turn", f.now(), "turn-completed")); await f.hub.drain();
  const kinds = () => f.sends.map(send => JSON.parse(send.payload).kind);
  expect(kinds()).toEqual(["question-pending", "turn-completed"]);
  f.result({ kind: "accepted" }); f.tick(2500); await f.hub.drain();
  expect(kinds()).toEqual(["question-pending", "turn-completed", "question-pending", "turn-completed"]);
  expect(f.store.snapshot().deliveries.map(delivery => [JSON.parse(delivery.key)[2], delivery.status])).toEqual([["question", "accepted"], ["later-turn", "accepted"]]);
});

test("a full journal evicts settled records and still advances past frames it cannot record", async () => {
  const f = await fixture(); await f.enroll();
  const row = (index: number, status: "accepted" | "pending") => ({
    key: JSON.stringify(["workspace", "old", `fill-${index}`]), deviceId: "old", workspaceId: "workspace", status, createdAt: f.now(), attempts: 0, nextAttemptAt: f.now() + 60_000,
    ...(status === "pending" ? { notification: { id: `fill-${index}`, sourceId: `fill-${index}`, conversationId: "opencode:conversation", kind: "question-pending" as const, createdAt: f.now() } } : {}),
  });
  await f.store.mutate(data => { data.deliveries = Array.from({ length: 10_000 }, (_, index) => row(index, "accepted")); });
  await f.hub.receive("workspace", occurrence("fits", f.now())); await f.hub.drain();
  expect(f.sends).toHaveLength(1);
  expect(f.store.snapshot().deliveries).toHaveLength(10_000);
  expect(f.store.snapshot().deliveries.some(delivery => delivery.key.includes("fill-0"))).toBe(false);
  await f.store.mutate(data => { data.deliveries = Array.from({ length: 10_000 }, (_, index) => row(index, "pending")); });
  await f.hub.receive("workspace", occurrence("dropped", f.now())); await f.hub.drain();
  expect(f.sends).toHaveLength(1);
  expect(f.store.snapshot().deliveries).toHaveLength(10_000);
  expect(f.store.snapshot().cursors.workspace).toBe("epoch:dropped");
});

test("a hung endpoint does not hold other devices' sends", async () => {
  const f = await fixture();
  const slow = (await f.enroll("slow")).device!.id;
  const fast = (await f.enroll("fast")).device!.id;
  const release = f.hold("slow");
  await f.hub.receive("workspace", occurrence("q", f.now()));
  const status = (id: string) => f.store.snapshot().deliveries.find(delivery => delivery.deviceId === id)?.status;
  for (let i = 0; i < 200 && status(fast) !== "accepted"; i++) await Bun.sleep(2);
  expect(status(fast)).toBe("accepted");
  expect(status(slow)).toBe("pending");
  release(); await f.hub.drain();
  expect(status(slow)).toBe("accepted");
  expect(f.sends).toHaveLength(2);
});

test("a gone answer from a replaced endpoint does not retire the re-enrolled device", async () => {
  const f = await fixture();
  const id = (await f.enroll("old")).device!.id;
  const release = f.hold("old");
  await f.hub.receive("workspace", occurrence("q", f.now()));
  for (let i = 0; i < 200 && f.sends.length < 1; i++) await Bun.sleep(2);
  await f.enroll("new", { id });
  f.resultFor("old", { kind: "gone" });
  release(); await f.hub.drain();
  expect(f.store.snapshot().devices.map(device => device.subscription.endpoint)).toEqual(["https://web.push.apple.com/new"]);
  expect(f.sends.map(send => send.endpoint)).toEqual(["https://web.push.apple.com/old", "https://web.push.apple.com/new"]);
  expect(f.store.snapshot().deliveries).toMatchObject([{ status: "accepted" }]);
  f.resultFor("new", { kind: "gone" });
  await f.hub.receive("workspace", occurrence("q2", f.now())); await f.hub.drain();
  expect(f.store.snapshot().devices).toEqual([]);
});

test("retired enrollments whose login lapsed give way before the device limit refuses a live one", async () => {
  const f = await fixture();
  f.sessions.add("session-old");
  const old = { user: "one", sessionId: "session-old" };
  for (let i = 0; i < 32; i++) await f.enroll(`retired-${i}`, {}, old);
  await expect(f.enroll("live")).rejects.toMatchObject({ status: 409 });
  f.sessions.delete("session-old");
  const live = await f.enroll("live");
  expect(live.device?.active).toBe(true);
  expect(f.store.snapshot().devices.map(device => device.subscription.endpoint)).toEqual(["https://web.push.apple.com/live"]);
});

test("a request resolved within the same feed chunk is never sent", async () => {
  const f = await fixture(); await f.enroll();
  f.batch([occurrence("q", f.now()), { type: "event", cursor: "epoch:r", event: { type: "resolved", id: "q", conversationId: "opencode:conversation" } }]);
  f.run(); f.hub.refresh();
  for (let i = 0; i < 200 && f.store.snapshot().cursors.workspace !== "epoch:r"; i++) await Bun.sleep(2);
  await f.hub.drain();
  expect(f.sends).toHaveLength(0);
  expect(f.store.snapshot().deliveries).toMatchObject([{ status: "discarded" }]);
});

test("enrolling on a running workspace stamps the cutoff after the feed position is known", async () => {
  const f = await fixture(); f.run();
  const turn = (id: string) => (occurrence(id, f.now(), "turn-completed") as Extract<NotificationFrame, { type: "event" }>).event;
  f.onOpen(() => { f.feed.publish(turn("before-cursor")); f.tick(100); });
  await f.enroll();
  expect(f.opens()).toBe(1);
  expect(f.store.snapshot().devices[0]?.since.workspace).toEqual({ needsAnswer: f.now(), completed: f.now() });
  f.feed.publish(turn("after-cursor"));
  for (let i = 0; i < 200 && f.sends.length < 1; i++) await Bun.sleep(2);
  // The send is observed before its outcome is journaled; join the pass that records it.
  await f.hub.drain();
  expect(f.store.snapshot().deliveries.map(delivery => [JSON.parse(delivery.key)[2], delivery.status])).toEqual([["after-cursor", "accepted"]]);
});

test("a running workspace whose feed does not answer refuses enrollment without writing a device", async () => {
  const f = await fixture(); f.run(); f.stall();
  await expect(f.enroll()).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Project") });
  expect(f.store.snapshot().devices).toEqual([]);
  expect(f.hub.state(principal).device).toBeNull();
  // Once the feed answers, a retry enrolls with a cutoff at the feed position: nothing published before it is delivered.
  const turn = (id: string) => (occurrence(id, f.now(), "turn-completed") as Extract<NotificationFrame, { type: "event" }>).event;
  f.feed.publish(turn("before-cursor")); f.tick(100);
  f.release();
  const enrolled = await f.enroll();
  expect(enrolled.device?.active).toBe(true);
  expect(f.store.snapshot().devices[0]?.since.workspace).toEqual({ needsAnswer: f.now(), completed: f.now() });
  f.feed.publish(turn("after-cursor"));
  for (let i = 0; i < 200 && f.sends.length < 1; i++) await Bun.sleep(2);
  // The send is observed before its outcome is journaled; join the pass that records it.
  await f.hub.drain();
  expect(f.store.snapshot().deliveries.map(delivery => [JSON.parse(delivery.key)[2], delivery.status])).toEqual([["after-cursor", "accepted"]]);
});

test("only the stalled running workspace is named and stopped workspaces never wait", async () => {
  const f = await fixture(); f.run("workspace"); f.stall();
  await expect(f.enroll("phone", { workspaceIds: ["workspace", "other"] })).rejects.toMatchObject({ status: 503, message: "notification feed for Project did not answer; try again" });
  expect(f.store.snapshot().devices).toEqual([]);
  const enrolled = await f.enroll("phone", { workspaceIds: ["other"] });
  expect(enrolled.device?.workspaceIds).toEqual(["other"]);
  expect(f.opens()).toBe(1);
});

test("an enrollment during the feed's reconnect backoff is refused, not settled on the lost stream", async () => {
  const f = await fixture(); f.run();
  // The first device connects to a stream that delivers one frame and ends; the observer is now in its backoff.
  f.batch([occurrence("seen", f.now())]);
  await f.enroll("phone");
  expect(f.opens()).toBe(1);
  f.stall();
  await expect(f.enroll("desktop")).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Project") });
  expect(f.store.snapshot().devices.map(device => device.subscription.endpoint)).toEqual(["https://web.push.apple.com/phone"]);
  f.release();
  // The observer reconnects when its backoff ends; a retry then joins that stream's position.
  for (let i = 0; i < 600 && f.opens() < 2; i++) await Bun.sleep(5);
  const enrolled = await f.enroll("desktop");
  expect(enrolled.device?.active).toBe(true);
  expect(f.opens()).toBe(2);
});

test("a settle that spans a failed first attempt is answered by the retry within the bound", async () => {
  const f = await fixture({ settleTimeoutMs: 3000 }); f.run(); f.failNextOpen();
  const enrolled = await f.enroll();
  expect(enrolled.device?.active).toBe(true);
  expect(f.opens()).toBe(2);
  expect(f.store.snapshot().cursors.workspace).toBeDefined();
});

test("a refused update leaves the existing device record untouched", async () => {
  const f = await fixture();
  await f.enroll("phone", { completed: false });
  const before = structuredClone(f.store.snapshot().devices);
  f.run(); f.stall(); f.tick(500);
  await expect(f.enroll("phone", { completed: true })).rejects.toMatchObject({ status: 503 });
  expect(f.store.snapshot().devices).toEqual(before);
  expect(f.hub.state(principal, before[0]!.id).device).toMatchObject({ completed: false, active: true });
});

test("pre-release enrollments with one cutoff per workspace load as both categories", async () => {
  const f = await fixture(); await f.enroll();
  const raw = JSON.parse(await readFile(f.file, "utf8"));
  raw.devices[0].since = { workspace: 1000 };
  await writeFile(f.file, JSON.stringify(raw));
  const restored = new NotificationStore(f.file); await restored.load();
  expect(restored.snapshot().devices[0]?.since).toEqual({ workspace: { needsAnswer: 1000, completed: 1000 } });
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

test("records written before the all-workspaces mode load as explicit selections", async () => {
  const f = await fixture(); await f.enroll();
  const raw = JSON.parse(await readFile(f.file, "utf8"));
  delete raw.devices[0].allWorkspaces;
  await writeFile(f.file, JSON.stringify(raw));
  const restored = new NotificationStore(f.file); await restored.load();
  expect(restored.snapshot().devices[0]?.allWorkspaces).toBe(false);
  await restored.mutate(() => {});
  expect(JSON.parse(await readFile(f.file, "utf8")).devices[0].allWorkspaces).toBe(false);
});

test("an all-workspaces device hears every workspace while a selective device hears only its own", async () => {
  const f = await fixture();
  const phone = await f.enroll("phone", { allWorkspaces: true, workspaceIds: [] });
  await f.enroll("desktop", { workspaceIds: ["workspace"] });
  expect(phone.device).toMatchObject({ allWorkspaces: true, workspaceIds: [], active: true });
  expect(f.store.snapshot().devices[0]?.since).toEqual({ workspace: { needsAnswer: 1000, completed: 1000 }, other: { needsAnswer: 1000, completed: 1000 } });
  await f.hub.receive("other", occurrence("q", f.now())); await f.hub.drain();
  expect(f.sends.map(send => send.endpoint)).toEqual(["https://web.push.apple.com/phone"]);
  await f.hub.receive("workspace", occurrence("q2", f.now())); await f.hub.drain();
  expect(f.sends.map(send => send.endpoint.split("/").pop()).sort()).toEqual(["desktop", "phone", "phone"]);
});

test("an all-workspaces device on an empty registry is still active and covers nothing yet", async () => {
  const f = await fixture(); f.unregister("workspace"); f.unregister("other");
  const enrolled = await f.enroll("phone", { allWorkspaces: true, workspaceIds: [] });
  expect(enrolled.device).toMatchObject({ allWorkspaces: true, active: true });
  expect(f.store.snapshot().devices[0]?.since).toEqual({});
  const selective = await f.enroll("desktop", { workspaceIds: [] });
  expect(selective.device?.active).toBe(false);
});

test("an all-workspaces enrollment settles every running workspace and names the ones that stall", async () => {
  const f = await fixture(); f.run("workspace"); f.run("other"); f.stall();
  await expect(f.enroll("phone", { allWorkspaces: true, workspaceIds: [] })).rejects.toMatchObject({ status: 503, message: "notification feed for Project, Other did not answer; try again" });
  expect(f.store.snapshot().devices).toEqual([]);
  const turn = (id: string) => (occurrence(id, f.now(), "turn-completed") as Extract<NotificationFrame, { type: "event" }>).event;
  f.feed.publish(turn("before-cursor")); f.tick(100);
  f.release();
  const enrolled = await f.enroll("phone", { allWorkspaces: true, workspaceIds: [] });
  expect(enrolled.device?.active).toBe(true);
  expect(f.opens()).toBe(2);
  expect(f.store.snapshot().devices[0]?.since).toEqual({ workspace: { needsAnswer: f.now(), completed: f.now() }, other: { needsAnswer: f.now(), completed: f.now() } });
});

test("a workspace that appears while an all-workspaces enrollment settles is settled too", async () => {
  const f = await fixture(); f.run("workspace");
  let appeared = false;
  f.onOpen(() => { if (!appeared) { appeared = true; f.register("late"); f.run("late"); } });
  const enrolled = await f.enroll("phone", { allWorkspaces: true, workspaceIds: [] });
  expect(enrolled.device?.active).toBe(true);
  expect(f.opens()).toBe(2);
  expect(Object.keys(f.store.snapshot().devices[0]!.since).sort()).toEqual(["late", "other", "workspace"]);
  expect(f.store.snapshot().devices[0]?.since.late).toEqual({ needsAnswer: f.now(), completed: f.now() });
});

test("turning all workspaces off returns the device to its stored selection", async () => {
  const f = await fixture();
  const on = await f.enroll("phone", { allWorkspaces: true, workspaceIds: ["workspace"] });
  expect(on.device).toMatchObject({ allWorkspaces: true, workspaceIds: ["workspace"] });
  const off = await f.enroll("phone", { id: on.device!.id, allWorkspaces: false, workspaceIds: ["workspace"] });
  expect(off.device).toMatchObject({ id: on.device!.id, allWorkspaces: false, workspaceIds: ["workspace"] });
  expect(Object.keys(f.store.snapshot().devices[0]!.since)).toEqual(["workspace"]);
  await f.hub.receive("other", occurrence("ignored", f.now())); await f.hub.drain();
  expect(f.sends).toHaveLength(0);
  await f.hub.receive("workspace", occurrence("heard", f.now())); await f.hub.drain();
  expect(f.sends).toHaveLength(1);
});

test("a workspace registered after an all-workspaces enrollment is stamped before it is observed", async () => {
  const f = await fixture();
  await f.enroll("phone", { allWorkspaces: true, workspaceIds: [] });
  f.register("late");
  // Pending before the hub saw the workspace: history for this device, even when a later snapshot lists it again.
  await f.hub.receive("late", occurrence("old", f.now())); await f.hub.drain();
  f.tick(1); f.hub.refresh();
  for (let i = 0; i < 200 && !f.store.snapshot().devices[0]?.since.late; i++) await Bun.sleep(2);
  expect(f.store.snapshot().devices[0]?.since.late).toEqual({ needsAnswer: f.now(), completed: f.now() });
  const old = { id: "old", sourceId: "old", conversationId: "opencode:conversation", kind: "question-pending" as const, createdAt: f.now() - 1 };
  await f.hub.receive("late", { type: "snapshot", reason: "gap", cursor: "epoch:snap", pending: [old] });
  await f.hub.receive("late", occurrence("new", f.now())); await f.hub.drain();
  expect(f.sends.map(send => JSON.parse(send.payload).kind)).toEqual(["question-pending"]);
  expect(f.store.snapshot().deliveries.map(delivery => JSON.parse(delivery.key)[2])).toEqual(["new"]);
  // Once it runs, the hub observes it with no client action.
  expect(f.opens()).toBe(0);
  f.run("late"); f.hub.refresh();
  for (let i = 0; i < 200 && !f.store.snapshot().cursors.late; i++) await Bun.sleep(2);
  expect(f.opens()).toBe(1);
});

test("unregistering a covered workspace discards its unsent deliveries and leaves the rest alone", async () => {
  const f = await fixture(); f.result({ kind: "retry" });
  await f.enroll("phone", { allWorkspaces: true, workspaceIds: [] });
  await f.hub.receive("other", occurrence("gone", f.now())); await f.hub.drain();
  expect(f.store.snapshot().deliveries.map(delivery => delivery.status)).toEqual(["pending"]);
  f.unregister("other"); f.hub.refresh();
  for (let i = 0; i < 200 && f.store.snapshot().devices[0]?.since.other; i++) await Bun.sleep(2);
  expect(f.store.snapshot().devices[0]?.since).toEqual({ workspace: { needsAnswer: 1000, completed: 1000 } });
  expect(f.store.snapshot().deliveries.map(delivery => delivery.status)).toEqual(["discarded"]);
  f.result({ kind: "accepted" }); f.tick(60_000);
  await f.hub.receive("workspace", occurrence("kept", f.now())); await f.hub.drain();
  expect(f.sends.filter(send => JSON.parse(send.payload).title === "Project")).toHaveLength(1);
  expect(f.store.snapshot().deliveries.map(delivery => [JSON.parse(delivery.key)[2], delivery.status])).toEqual([["gone", "discarded"], ["kept", "accepted"]]);
});
