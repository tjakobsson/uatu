import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import { ChatAdapter } from "../src/chat/adapter";
import { NotificationFeed } from "../src/chat/notification-feed";
import { qualifyNotificationEvent } from "../src/chat/notifications";
import type { ChatProvider } from "../src/chat/provider";
import { NotificationStore } from "../src/hub/notification-store";
import { HubNotifications } from "../src/hub/notifications";
import type { Presence } from "../src/hub/presence";

// Actual adapter -> child SSE bytes -> hub journal -> fake push transport.
// Both provider suites drive this without constructing any browser page.
export async function notificationPipeline(provider: ChatProvider, workspacePath: string) {
  const root = await mkdtemp(path.join(tmpdir(), "uatu-notification-pipeline-"));
  const store = new NotificationStore(path.join(root, "notifications.json"));
  await store.load();
  const feed = new NotificationFeed();
  const sent: Array<{ endpoint: string; payload: { kind: string; url: string; id: string } }> = [];
  let opens = 0;
  // The user's presence as the hub's live broker would report it; it outlives a hub restart like the pages do.
  let presence: Presence = "away";
  const presenceListeners = new Set<(user: string) => void>();
  const options: ConstructorParameters<typeof HubNotifications>[0] = { store,
    sender: async (subscription, payload) => { sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) }); return { kind: "accepted" }; },
    authorized: () => true, workspaceName: () => "Project",
    presence: {
      presence: () => presence,
      onPresenceChange: listener => { presenceListeners.add(listener); return () => { presenceListeners.delete(listener); }; },
    },
    source: {
      isRunning: () => true, workspaceIds: () => ["project"],
      open: async request => {
        opens++;
        const cursor = new URL(request.path, "http://child.invalid").searchParams.get("cursor");
        const subscription = feed.subscribe(cursor ?? undefined, request.signal);
        return new Response(new ReadableStream({
          async pull(controller) {
            const next = await subscription.next();
            if (next.done) { controller.close(); return; }
            controller.enqueue(new TextEncoder().encode(`event: notification\ndata: ${JSON.stringify(next.value)}\n\n`));
          }, cancel() { subscription.cancel(); },
        }));
      },
    },
  };
  let hub = new HubNotifications(options);
  for (const device of ["phone", "desktop"]) {
    const key = createECDH("prime256v1"); key.generateKeys();
    await hub.enroll({ user: "person", sessionId: "session" }, {
      subscription: { endpoint: `https://web.push.apple.com/${device}`, keys: { p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } },
      workspaceIds: ["project"], needsAnswer: true, completed: true,
    });
  }
  for (let i = 0; i < 500 && !store.snapshot().cursors.project; i++) await Bun.sleep(2);
  if (!store.snapshot().cursors.project) throw new Error("notification feed did not become ready");
  const adapter = new ChatAdapter({ provider, workspacePath, onNotification: event => feed.publish(qualifyNotificationEvent(provider.describe().id, event)) });
  void adapter.startEventPump().catch(() => {});
  return {
    sent, opens: () => opens,
    setPresence(value: Presence) { presence = value; for (const listener of [...presenceListeners]) listener("person"); },
    /** Waits until the journal has recorded `count` deliveries (sent or not). */
    async waitForDeliveries(count: number) {
      for (let i = 0; i < 500 && options.store.snapshot().deliveries.length < count; i++) await Bun.sleep(2);
      await hub.drain();
      if (options.store.snapshot().deliveries.length < count) throw new Error(`expected ${count} recorded deliveries`);
    },
    heldCount: () => options.store.snapshot().deliveries.filter(delivery => delivery.status === "pending" && delivery.heldAt !== undefined).length,
    async restartHub() {
      await hub.dispose();
      const restored = new NotificationStore(path.join(root, "notifications.json"));
      await restored.load();
      options.store = restored;
      hub = new HubNotifications(options);
      hub.start();
    },
    async waitForSends(count: number) {
      for (let i = 0; i < 500 && sent.length < count; i++) await Bun.sleep(2);
      await hub.drain();
      if (sent.length !== count) throw new Error(`expected ${count} push submissions, got ${sent.length}`);
    },
    async dispose() {
      await hub.dispose(); await adapter.dispose(); feed.dispose(); await rm(root, { recursive: true, force: true });
    },
  };
}
