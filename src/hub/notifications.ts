import { createHash, randomUUID } from "node:crypto";
import { CHILD_NOTIFICATIONS_PATH, type NotificationFrame } from "../chat/notification-feed";
import { NOTIFICATION_LIFETIME_MS, type AgentNotification } from "../chat/notifications";
import type { LiveUpstreamSource } from "./live-broker";
import { SseFrameParser } from "./live-sse";
import { NOTIFICATION_CATEGORIES, NotificationStore, type NotificationData, type NotificationDevice, type NotificationPreferences } from "./notification-store";
import { createPushSender, parsePushSubscription, validPushContact, type PushSender } from "./push-sender";

export class NotificationRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
type Principal = { user: string; sessionId: string };
type Observer = { abort: AbortController; done: Promise<void>; connected: Promise<void> };
const JOURNAL_CAPACITY = 10_000;
const SEND_CONCURRENCY = 8;
const DEVICE_LIMIT = 32;
const SETTLE_TIMEOUT_MS = 3000;

export class HubNotifications {
  private readonly sender: PushSender | null;
  private readonly observers = new Map<string, Observer>();
  private readonly enrolling = new Map<string, number>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | undefined;
  private draining: Promise<void> | null = null;
  private drainAgain = false;
  private closed = false;

  constructor(private readonly options: {
    store: NotificationStore;
    contact?: string;
    source: LiveUpstreamSource;
    authorized: (principal: Principal, workspaceId: string) => boolean;
    workspaceName: (id: string) => string;
    sender?: PushSender;
    now?: () => number;
    settleTimeoutMs?: number;
  }) {
    this.now = options.now ?? Date.now;
    this.sender = options.sender ?? (options.contact && validPushContact(options.contact)
      ? createPushSender({ keys: options.store.snapshot().keys, contact: options.contact }) : null);
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.unsubscribe = this.options.source.onSessionChange?.(() => this.refresh());
    this.timer = setInterval(() => this.refresh(), 1000);
    this.timer.unref();
    this.refresh();
  }

  state(principal: Principal, id?: string) {
    const data = this.options.store.snapshot();
    const device = data.devices.find(device => device.id === id && device.user === principal.user);
    return {
      configured: this.sender !== null, publicKey: this.sender ? data.keys.publicKey : null,
      device: device ? { id: device.id, workspaceIds: device.workspaceIds, needsAnswer: device.needsAnswer, completed: device.completed,
        active: device.sessionId === principal.sessionId && this.active(device),
      } : null,
    };
  }

  async enroll(principal: Principal, raw: unknown) {
    if (!this.sender) throw new NotificationRequestError(503, "configure notifications.contact in the hub configuration first");
    const body = object(raw);
    const subscription = parsePushSubscription(body.subscription);
    if (!subscription) throw new NotificationRequestError(400, "invalid browser push subscription");
    const preferences = this.preferences(principal, body);
    if (body.id !== undefined && (typeof body.id !== "string" || body.id.length > 128)) throw new NotificationRequestError(400, "invalid device id");
    // Know each running workspace's feed position before the cutoff is stamped, so no event after the cutoff can precede the cursor.
    // A feed that does not answer in time gets a refusal, not a cutoff the hub cannot honor; the device's previous record stays.
    const stalled = await this.settle(preferences.workspaceIds.filter(ws => this.options.source.isRunning(ws)));
    if (stalled.length) throw new NotificationRequestError(503, `notification feed for ${stalled.map(ws => this.options.workspaceName(ws)).join(", ")} did not answer; try again`);
    const id = await this.options.store.mutate(data => {
      const existing = data.devices.find(device => device.id === body.id || device.subscription.endpoint === subscription.endpoint);
      if (existing && existing.user !== principal.user) throw new NotificationRequestError(409, "subscription belongs to another account; renew it on this device");
      if (data.devices.some(device => device.subscription.endpoint === subscription.endpoint && device.id !== existing?.id)) throw new NotificationRequestError(409, "subscription is already enrolled");
      if (!existing && data.devices.filter(device => device.user === principal.user).length >= DEVICE_LIMIT) {
        // Retired browsers leave records nobody can remove once their login lapses; those give way before the limit refuses a live device.
        for (const device of data.devices.filter(device => device.user === principal.user && !this.active(device))) this.forget(data, device.id);
        if (data.devices.filter(device => device.user === principal.user).length >= DEVICE_LIMIT) throw new NotificationRequestError(409, "device limit reached");
      }
      const sameAuthorization = existing?.sessionId === principal.sessionId;
      // A category keeps its cutoff only while it stays enabled under the same login; anything newly enabled starts now.
      const device: NotificationDevice = {
        ...principal, ...preferences, id: existing?.id ?? randomUUID(), subscription,
        createdAt: existing?.createdAt ?? this.now(),
        since: Object.fromEntries(preferences.workspaceIds.map(ws => [ws, Object.fromEntries(NOTIFICATION_CATEGORIES.filter(category => preferences[category])
          .map(category => [category, sameAuthorization && existing?.[category] ? existing.since[ws]?.[category] ?? this.now() : this.now()]))])),
      };
      data.devices = data.devices.filter(candidate => candidate.id !== device.id);
      data.devices.push(device);
      for (const delivery of data.deliveries) {
        if (delivery.deviceId === device.id && delivery.status === "pending" && (!sameAuthorization || !this.eligible(device, delivery.workspaceId, delivery.notification!))) {
          delivery.status = "discarded"; delete delivery.notification;
        }
      }
      return device.id;
    });
    this.refresh();
    return this.state(principal, id);
  }

  async remove(principal: Principal, id: string): Promise<void> {
    await this.options.store.mutate(data => {
      const device = data.devices.find(device => device.id === id);
      if (device && device.user !== principal.user) throw new NotificationRequestError(404, "notification device not found");
      this.forget(data, id);
    });
    this.refresh();
  }

  private forget(data: NotificationData, id: string): void {
    data.devices = data.devices.filter(device => device.id !== id);
    for (const delivery of data.deliveries) if (delivery.deviceId === id && delivery.status === "pending") {
      delivery.status = "discarded"; delete delivery.notification;
    }
  }

  private active(device: NotificationDevice): boolean {
    return device.workspaceIds.some(ws => this.options.authorized(device, ws));
  }

  async receive(workspaceId: string, frame: NotificationFrame): Promise<void> {
    await this.ingest(workspaceId, frame);
    void this.drain();
  }

  private ingest(workspaceId: string, frame: NotificationFrame): Promise<void> {
    return this.options.store.mutate(data => {
      this.prune(data);
      if (frame.type === "event" && frame.event.type === "resolved") {
        for (const delivery of data.deliveries) if (delivery.workspaceId === workspaceId && delivery.notification?.id === frame.event.id) {
          delivery.status = "discarded"; delete delivery.notification;
        }
      } else if (frame.type === "snapshot") {
        const pending = new Set(frame.pending.map(notification => notification.id));
        for (const delivery of data.deliveries) if (delivery.workspaceId === workspaceId && delivery.notification?.kind !== "turn-completed"
          && delivery.notification && !pending.has(delivery.notification.id)) { delivery.status = "discarded"; delete delivery.notification; }
        // Both handoffs list every still-pending request; each device's cutoff separates history from post-enrollment entries.
        for (const notification of frame.pending) this.enqueue(data, workspaceId, notification);
      } else if (frame.type === "event" && frame.event.type === "notification") {
        this.enqueue(data, workspaceId, frame.event.notification);
      }
      data.cursors[workspaceId] = frame.cursor;
    });
  }

  private enqueue(data: NotificationData, workspaceId: string, notification: AgentNotification): void {
    if (!validNotification(notification) || this.now() - notification.createdAt >= NOTIFICATION_LIFETIME_MS) return;
    for (const device of data.devices) {
      if (!this.eligible(device, workspaceId, notification)) continue;
      const key = JSON.stringify([workspaceId, device.id, notification.id]);
      if (data.deliveries.some(delivery => delivery.key === key)) continue;
      if (data.deliveries.length >= JOURNAL_CAPACITY) {
        // Evict the oldest settled record before dropping the new delivery; failing the frame would pin the feed on it.
        const oldest = data.deliveries.findIndex(delivery => delivery.status !== "pending");
        if (oldest === -1) continue;
        data.deliveries.splice(oldest, 1);
      }
      data.deliveries.push({ key, deviceId: device.id, workspaceId, notification, status: "pending", createdAt: notification.createdAt, attempts: 0, nextAttemptAt: this.now() });
    }
  }

  private eligible(device: NotificationDevice, workspaceId: string, notification: AgentNotification): boolean {
    const category = notification.kind === "turn-completed" ? "completed" : "needsAnswer";
    return device[category] && device.workspaceIds.includes(workspaceId) && this.options.authorized(device, workspaceId)
      && notification.createdAt >= (device.since[workspaceId]?.[category] ?? Infinity);
  }

  private preferences(principal: Principal, body: Record<string, unknown>): NotificationPreferences {
    if (!Array.isArray(body.workspaceIds) || body.workspaceIds.length > 256 || body.workspaceIds.some(id => typeof id !== "string" || !this.options.authorized(principal, id))
      || typeof body.needsAnswer !== "boolean" || typeof body.completed !== "boolean") throw new NotificationRequestError(400, "invalid notification preferences or workspace access");
    return { workspaceIds: [...new Set(body.workspaceIds as string[])], needsAnswer: body.needsAnswer, completed: body.completed };
  }

  refresh(): void {
    if (this.closed || !this.sender) return;
    const wanted = new Set([...this.enrolling.keys(), ...this.options.store.snapshot().devices.flatMap(device => device.workspaceIds.filter(ws =>
      (device.needsAnswer || device.completed) && this.options.authorized(device, ws)))].filter(ws => this.options.source.isRunning(ws)));
    for (const [id, observer] of this.observers) if (!wanted.has(id)) observer.abort.abort();
    for (const id of wanted) this.ensureObserver(id);
    void this.drain();
  }

  private ensureObserver(id: string): Observer {
    const existing = this.observers.get(id);
    if (existing) return existing;
    const abort = new AbortController();
    const observer: Observer = { abort, done: Promise.resolve(), connected: Promise.resolve() };
    this.observers.set(id, observer);
    observer.done = this.observe(id, abort.signal, observer).finally(() => { if (this.observers.get(id) === observer) this.observers.delete(id); });
    return observer;
  }

  /** Resolves to the workspaces whose feed had not answered when the bound elapsed. */
  private async settle(workspaceIds: string[]): Promise<string[]> {
    if (!workspaceIds.length || this.closed) return [];
    for (const ws of workspaceIds) this.enrolling.set(ws, (this.enrolling.get(ws) ?? 0) + 1);
    try {
      const pending = new Set(workspaceIds);
      const connected = Promise.all(workspaceIds.map(ws => this.ensureObserver(ws).connected.then(() => { pending.delete(ws); })));
      await Promise.race([connected, new Promise<void>(resolve => setTimeout(resolve, this.options.settleTimeoutMs ?? SETTLE_TIMEOUT_MS).unref())]);
      return [...pending];
    } finally {
      for (const ws of workspaceIds) {
        const remaining = (this.enrolling.get(ws) ?? 1) - 1;
        if (remaining > 0) this.enrolling.set(ws, remaining); else this.enrolling.delete(ws);
      }
    }
  }

  private async observe(workspaceId: string, signal: AbortSignal, observer: Observer): Promise<void> {
    let failures = 0;
    let connect = () => {};
    // The feed position is known only while a stream is delivering frames. A resolved promise is replaced the moment
    // its stream ends — before the backoff, not at the next attempt — so an enrollment during the outage waits for the
    // reconnect instead of reading the previous connection as settled. A promise still pending is kept: an attempt that
    // failed before any frame changes nothing, and waiters already attached must see the retry that answers.
    let pending = false;
    const disconnect = () => {
      if (pending) return;
      pending = true;
      observer.connected = new Promise<void>(resolve => { connect = () => { pending = false; resolve(); }; });
    };
    disconnect();
    while (!signal.aborted) {
      try {
        const cursor = this.options.store.snapshot().cursors[workspaceId];
        const response = await this.options.source.open({ workspaceId, path: `${CHILD_NOTIFICATIONS_PATH}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, signal });
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("notification feed unavailable"); }
        const reader = response.body.getReader();
        const parser = new SseFrameParser();
        let buffered = 0;
        try {
          while (!signal.aborted) {
            const next = await reader.read();
            if (next.done) break;
            buffered += next.value.byteLength;
            if (buffered > 2 * 1024 * 1024) throw new Error("notification feed frame too large");
            const frames = parser.push(next.value);
            if (frames.length) buffered = 0;
            // A request and its resolution can share one chunk; record the whole batch before anything is sent.
            for (const frame of frames) {
              if ("comment" in frame || frame.event !== "notification") continue;
              const value = JSON.parse(frame.data) as NotificationFrame;
              if (!validFrame(value)) throw new Error("invalid notification feed frame");
              await this.ingest(workspaceId, value);
              failures = 0;
              connect();
            }
            if (frames.length) void this.drain();
          }
        } finally { await reader.cancel().catch(() => {}); }
      } catch { /* Retry from the last durably recorded cursor. Never log payloads. */ }
      disconnect();
      if (!signal.aborted) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, Math.min(1000 * 2 ** Math.min(failures++, 4), 15_000));
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }

  drain(): Promise<void> {
    if (this.draining) { this.drainAgain = true; return this.draining; }
    this.draining = (async () => {
      do {
        this.drainAgain = false;
        await this.deliver();
      } while (this.drainAgain && !this.closed);
    })().catch(() => {}).finally(() => {
      this.draining = null;
      if (this.drainAgain && !this.closed) return this.drain();
    });
    return this.draining;
  }

  private async deliver(): Promise<void> {
    if (!this.sender || this.closed) return;
    const queue = this.options.store.snapshot().deliveries.filter(delivery => delivery.status === "pending" && delivery.nextAttemptAt <= this.now()).map(delivery => delivery.key);
    // A hung endpoint holds only its own worker; a failed journal write ends this pass and the next drain resumes from durable state.
    let stopped = false;
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, async () => {
      for (let key = queue.shift(); key !== undefined && !stopped && !this.closed; key = queue.shift()) {
        await this.attempt(key).catch(() => { stopped = true; });
      }
    }));
  }

  private async attempt(key: string): Promise<void> {
    if (!this.sender) return;
    const latest = this.options.store.snapshot();
    const delivery = latest.deliveries.find(entry => entry.key === key);
    if (!delivery || delivery.status !== "pending" || !delivery.notification) return;
    const device = latest.devices.find(device => device.id === delivery.deviceId);
    const expires = delivery.createdAt + NOTIFICATION_LIFETIME_MS;
    if (!device || this.now() >= expires || !this.eligible(device, delivery.workspaceId, delivery.notification)) return this.finish(key, "discarded");
    if (delivery.nextAttemptAt > this.now()) return;
    const notification = delivery.notification;
    const payload = JSON.stringify({ version: 1, id: createHash("sha256").update(key).digest("hex"), kind: notification.kind,
      title: this.options.workspaceName(delivery.workspaceId).slice(0, 120),
      body: notification.kind === "turn-completed" ? "Agent turn finished" : "An agent needs your answer",
      url: `/s/${encodeURIComponent(delivery.workspaceId)}/?conversation=${encodeURIComponent(notification.conversationId)}`,
      createdAt: notification.createdAt,
    });
    const result = await this.sender(device.subscription, payload, Math.ceil((expires - this.now()) / 1000));
    if (result.kind === "accepted") await this.finish(key, "accepted");
    else if (result.kind === "gone") {
      // A re-enrollment may have replaced the subscription while this send was in flight; only the endpoint that answered is gone.
      await this.options.store.mutate(data => {
        if (data.devices.find(entry => entry.id === device.id)?.subscription.endpoint === device.subscription.endpoint) this.forget(data, device.id);
      });
      this.refresh();
    }
    else await this.options.store.mutate(data => {
      const entry = data.deliveries.find(entry => entry.key === key);
      if (!entry || entry.status !== "pending") return;
      entry.attempts += 1;
      const delay = result.kind === "configuration-error" ? 60_000 : Math.max(result.retryAfterMs ?? 0, Math.min(1000 * 2 ** Math.min(entry.attempts, 5), 30_000));
      entry.nextAttemptAt = this.now() + delay;
    });
  }

  private finish(key: string, status: "accepted" | "discarded"): Promise<void> {
    return this.options.store.mutate(data => {
      const delivery = data.deliveries.find(entry => entry.key === key);
      if (delivery?.status === "pending") { delivery.status = status; delete delivery.notification; }
    });
  }

  private prune(data: NotificationData): void {
    data.deliveries = data.deliveries.filter(delivery => this.now() - delivery.createdAt < 24 * 60 * 60_000);
    for (const delivery of data.deliveries) if (delivery.status === "pending" && this.now() - delivery.createdAt >= NOTIFICATION_LIFETIME_MS) {
      delivery.status = "discarded"; delete delivery.notification;
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    for (const observer of this.observers.values()) observer.abort.abort();
    await Promise.all([...this.observers.values()].map(observer => observer.done));
    await this.draining;
    await this.options.store.settled();
  }
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function validNotification(value: AgentNotification): boolean {
  return Boolean(value && typeof value.id === "string" && value.id.length < 4096 && typeof value.conversationId === "string" && value.conversationId.includes(":")
    && typeof value.sourceId === "string" && ["question-pending", "permission-pending", "turn-completed"].includes(value.kind) && Number.isFinite(value.createdAt));
}
function validFrame(value: NotificationFrame): boolean {
  if (!value || typeof value.cursor !== "string" || value.cursor.length > 1024) return false;
  if (value.type === "ready") return true;
  if (value.type === "snapshot") return (value.reason === "initial" || value.reason === "gap") && Array.isArray(value.pending) && value.pending.every(validNotification);
  return value.type === "event" && Boolean(value.event) && (value.event.type === "notification" ? validNotification(value.event.notification)
    : value.event.type === "resolved" && typeof value.event.id === "string" && typeof value.event.conversationId === "string");
}
