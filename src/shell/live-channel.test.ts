import { describe, expect, test } from "bun:test";

import {
  documentContextKey,
  LIVE_MAX_CURSOR_BYTES,
  LIVE_MAX_KEY_BYTES,
  LIVE_MAX_SUBSCRIPTIONS,
  type LiveEnvelope,
  type LiveSubscription,
} from "../shared/live-protocol";
import {
  createLiveChannel,
  reconnectDelay,
  RECONNECT_MAX_DELAY_MS,
  type LiveChannelSource,
  type LiveChannelStatus,
  type LiveChannelTimers,
  type LiveTopicConsumer,
} from "./live-channel";

type FakeSource = LiveChannelSource & {
  url: string;
  closed: boolean;
  fail(): void;
  hello(streamId?: string): void;
  live(envelope: LiveEnvelope): void;
  raw(type: string, data: string): void;
};

type RecordedPost = { url: string; body: { add?: LiveSubscription[]; remove?: { topic: string; key?: string }[] } };

// Drains microtasks and one macrotask turn so queued control flushes and
// fetch continuations have settled.
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

function envelope(
  topic: LiveEnvelope["topic"],
  event: LiveEnvelope["event"],
  options: { key?: string; cursor?: string; ws?: string } = {},
): LiveEnvelope {
  return {
    ws: options.ws ?? "one",
    topic,
    ...(options.key !== undefined ? { key: options.key } : {}),
    cursor: options.cursor ?? "",
    event,
  };
}

function createHarness(options: { ws?: string | null; activity?: boolean } = {}) {
  const sources: FakeSource[] = [];
  const statuses: LiveChannelStatus[] = [];
  const posts: RecordedPost[] = [];
  const postStatuses: number[] = [];
  const holds: (() => Promise<void>)[] = [];
  const scheduled: { delay: number; run: () => void; id: number }[] = [];
  let nextTimerId = 1;

  const timers: LiveChannelTimers = {
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      scheduled.push({ delay, run: callback, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer) {
      const index = scheduled.findIndex(entry => entry.id === (timer as unknown as number));
      if (index >= 0) scheduled.splice(index, 1);
    },
  };

  const channel = createLiveChannel({
    ws: options.ws === undefined ? "one" : options.ws,
    activity: options.activity ?? false,
    timers,
    fetcher: async (url, init) => {
      posts.push({ url, body: JSON.parse(String(init?.body)) });
      await holds.shift()?.();
      const status = postStatuses.shift() ?? 200;
      // 0 stands for a network failure: the request never gets an answer.
      if (status === 0) throw new TypeError("network error");
      return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: "nope" }), { status });
    },
    openSource: url => {
      const listeners = new Map<string, ((event: Event) => void)[]>();
      const emit = (type: string, data?: string) => {
        for (const listener of listeners.get(type) ?? []) listener({ type, data } as unknown as Event);
      };
      const source: FakeSource = {
        url,
        closed: false,
        addEventListener(type, listener) {
          const bucket = listeners.get(type) ?? [];
          bucket.push(listener);
          listeners.set(type, bucket);
        },
        close() {
          source.closed = true;
        },
        fail() {
          emit("error");
        },
        hello(streamId = "stream-1") {
          emit("hello", JSON.stringify({ streamId }));
        },
        live(value) {
          emit("live", JSON.stringify(value));
        },
        raw(type, data) {
          emit(type, data);
        },
      };
      sources.push(source);
      return source;
    },
  });
  channel.onStatus(status => statuses.push(status));

  return {
    channel,
    sources,
    statuses,
    posts,
    postStatuses,
    scheduled,
    latest: () => sources.at(-1)!,
    // Holds the next control request open until the returned release runs.
    holdNextPost() {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      holds.push(() => gate);
      return release;
    },
    // Fires exactly the pending timer, mirroring a real timer firing once.
    runPendingTimer() {
      const entry = scheduled.shift();
      if (!entry) throw new Error("no timer scheduled");
      entry.run();
      return entry.delay;
    },
    query(source: FakeSource) {
      return new URL(source.url, "http://hub.invalid").searchParams;
    },
    subs(source: FakeSource): LiveSubscription[] {
      const raw = this.query(source).get("subs");
      return raw ? (JSON.parse(raw) as LiveSubscription[]) : [];
    },
  };
}

function recorder() {
  const calls: string[] = [];
  const consumer: LiveTopicConsumer = {
    data: (data, cursor, generation) => calls.push(`data ${JSON.stringify(data)} @${cursor} g${generation}`),
    ready: generation => calls.push(`ready g${generation}`),
    resync: (data, generation) => calls.push(`resync ${JSON.stringify(data)} g${generation}`),
    unavailable: generation => calls.push(`unavailable g${generation}`),
    dropped: drops => calls.push(`dropped ${drops}`),
  };
  return { calls, consumer };
}

describe("createLiveChannel — the one stream", () => {
  test("opens the hub's live route with the workspace, activity flag, and the initial subscription set", () => {
    const h = createHarness({ ws: "docs", activity: true });
    h.channel.subscribe({ topic: "document", key: "compareTarget=base&scope=folder" }, {});
    h.channel.subscribe({ topic: "conversation", key: "opencode:c1" }, {}, { cursor: "c1-cursor" });
    h.channel.connect();

    const source = h.latest();
    expect(new URL(source.url, "http://hub.invalid").pathname).toBe("/api/hub/live");
    expect(h.query(source).get("ws")).toBe("docs");
    expect(h.query(source).get("activity")).toBe("1");
    expect(h.query(source).get("reconnect")).toBeNull();
    expect(h.subs(source)).toEqual([
      { topic: "document", key: "compareTarget=base&scope=folder" },
      { topic: "conversation", key: "opencode:c1", cursor: "c1-cursor" },
    ]);
  });

  test("a page served at the root omits the workspace and asks for no activity", () => {
    const h = createHarness({ ws: null, activity: false });
    h.channel.connect();
    expect(h.latest().url).toBe("/api/hub/live");
  });

  test("a reconnect presents every retained cursor and marks itself a reconnect", () => {
    const h = createHarness();
    const document = recorder();
    const conversation = recorder();
    h.channel.subscribe({ topic: "document", key: "scope=folder" }, document.consumer);
    h.channel.subscribe({ topic: "conversation", key: "c1" }, conversation.consumer, { cursor: "c1-0" });
    h.channel.connect();
    h.latest().hello();
    h.latest().live(envelope("document", { kind: "data", data: { roots: [] } }, { key: "scope=folder", cursor: "d7" }));
    h.latest().live(envelope("conversation", { kind: "data", data: { sequence: 1 } }, { key: "c1", cursor: "c1-9" }));
    // Signals carry the topic's cursor but never move it.
    h.latest().live(envelope("conversation", { kind: "ready" }, { key: "c1", cursor: "c1-999" }));
    h.latest().live(envelope("document", { kind: "unavailable" }, { key: "scope=folder", cursor: "d999" }));

    h.latest().fail();
    expect(h.runPendingTimer()).toBe(1_000);

    const replacement = h.latest();
    expect(h.sources).toHaveLength(2);
    expect(h.sources[0]!.closed).toBe(true);
    expect(h.query(replacement).get("reconnect")).toBe("1");
    expect(h.subs(replacement)).toEqual([
      { topic: "document", key: "scope=folder", cursor: "d7" },
      { topic: "conversation", key: "c1", cursor: "c1-9" },
    ]);
    expect(document.calls).toEqual(['data {"roots":[]} @d7 g1', "unavailable g1", "dropped 1"]);
    expect(conversation.calls).toEqual(['data {"sequence":1} @c1-9 g1', "ready g1", "dropped 1"]);
  });

  test("one topic's resync is isolated from the others", () => {
    const h = createHarness();
    const document = recorder();
    const conversation = recorder();
    h.channel.subscribe({ topic: "document", key: "scope=folder" }, document.consumer);
    h.channel.subscribe({ topic: "conversation", key: "c1" }, conversation.consumer, { cursor: "stale" });
    h.channel.connect();
    h.latest().hello();

    h.latest().live(envelope("conversation", { kind: "resync", data: { type: "resync", reason: "retention-gap" } }, { key: "c1", cursor: "stale" }));
    h.latest().live(envelope("document", { kind: "data", data: { generatedAt: 5 } }, { key: "scope=folder", cursor: "d1" }));
    h.latest().live(envelope("document", { kind: "ready" }, { key: "scope=folder", cursor: "d1" }));

    expect(conversation.calls).toEqual(['resync {"type":"resync","reason":"retention-gap"} g1']);
    expect(document.calls).toEqual(['data {"generatedAt":5} @d1 g1', "ready g1"]);
    // The conversation's cursor is still the one presented; the document's advanced.
    expect(h.channel.subscriptions()).toEqual([
      { topic: "document", key: "scope=folder", cursor: "d1" },
      { topic: "conversation", key: "c1", cursor: "stale" },
    ]);
  });

  test("everything from a superseded generation is ignored", () => {
    const h = createHarness();
    const document = recorder();
    h.channel.subscribe({ topic: "document", key: "k" }, document.consumer);
    h.channel.connect();
    const stale = h.latest();
    const staleGeneration = h.channel.currentGeneration();

    h.channel.connect();
    expect(stale.closed).toBe(true);
    expect(h.channel.isCurrent(staleGeneration)).toBe(false);
    expect(h.channel.isCurrent(h.channel.currentGeneration())).toBe(true);
    // Superseding a generation leaves nothing confirmed, and the channel says
    // so rather than coasting on the previous generation's success.
    expect(h.statuses).toEqual(["reconnecting"]);

    stale.hello("old-stream");
    stale.live(envelope("document", { kind: "data", data: { late: true } }, { key: "k", cursor: "d-late" }));
    stale.fail();
    expect(document.calls).toEqual([]);
    expect(h.scheduled).toHaveLength(0);
    expect(h.channel.subscriptions()).toEqual([{ topic: "document", key: "k" }]);

    // Nor may a late confirmation from it report a stale success.
    h.channel.confirm(staleGeneration);
    expect(h.statuses).toEqual(["reconnecting"]);
  });

  test("envelopes for keys the page does not hold are dropped, including right after a close", () => {
    const h = createHarness();
    const held = recorder();
    const handle = h.channel.subscribe({ topic: "conversation", key: "c1" }, held.consumer);
    h.channel.connect();
    h.latest().hello();

    h.latest().live(envelope("conversation", { kind: "data", data: 1 }, { key: "c2", cursor: "x" }));
    h.latest().live(envelope("inventory", { kind: "data", data: 1 }, { cursor: "x" }));
    h.latest().live(envelope("conversation", { kind: "data", data: 1 }, { key: "c1", cursor: "x", ws: "another" }));
    expect(held.calls).toEqual([]);

    handle.close();
    // The hub has not even been told yet; locally the removal is immediate.
    h.latest().live(envelope("conversation", { kind: "data", data: 2 }, { key: "c1", cursor: "y" }));
    expect(held.calls).toEqual([]);
  });

  test("keepalive-shaped and malformed frames change nothing", () => {
    const h = createHarness();
    const document = recorder();
    h.channel.subscribe({ topic: "document", key: "k" }, document.consumer);
    h.channel.connect();
    h.latest().raw("live", "not json");
    h.latest().raw("live", JSON.stringify({ ws: "one", topic: "document", key: "k", cursor: "c", event: { kind: "nonsense" } }));
    h.latest().raw("hello", "{}");
    expect(document.calls).toEqual([]);
    expect(h.channel.subscriptions()).toEqual([{ topic: "document", key: "k" }]);
  });
});

describe("createLiveChannel — subscription control", () => {
  test("changes on an open stream go through the control route bound by the hello id", async () => {
    const h = createHarness();
    h.channel.connect();
    h.latest().hello("stream-abc");
    const handle = h.channel.subscribe({ topic: "conversation", key: "c1" }, {}, { cursor: "c1-3" });
    await settle();
    expect(h.posts).toEqual([{ url: "/api/hub/live/stream-abc/subscriptions", body: { add: [{ topic: "conversation", key: "c1", cursor: "c1-3" }] } }]);

    handle.close();
    await settle();
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]!.body).toEqual({ remove: [{ topic: "conversation", key: "c1" }] });
    // No reconnect was involved.
    expect(h.sources).toHaveLength(1);
  });

  test("a remove and an add of one key collapse into the add, and a subscribe-then-close into nothing", async () => {
    const h = createHarness();
    const first = h.channel.subscribe({ topic: "conversation", key: "c1" }, {}, { cursor: "old" });
    h.channel.connect();
    h.latest().hello();
    await settle();
    expect(h.posts).toEqual([]);

    // The resync path: the snapshot's cursor replaces the old attachment.
    first.close();
    h.channel.subscribe({ topic: "conversation", key: "c1" }, {}, { cursor: "snapshot" });
    await settle();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.body).toEqual({ add: [{ topic: "conversation", key: "c1", cursor: "snapshot" }] });

    // A subagent opened and closed within one tick never reaches the hub.
    h.channel.subscribe({ topic: "conversation", key: "child" }, {}).close();
    await settle();
    expect(h.posts).toHaveLength(1);
  });

  test("a handle closes only its own subscription, never a replacement for the same key", async () => {
    const h = createHarness();
    const stale = recorder();
    const fresh = recorder();
    const first = h.channel.subscribe({ topic: "conversation", key: "c1" }, stale.consumer, { cursor: "a" });
    h.channel.connect();
    h.latest().hello();
    const second = h.channel.subscribe({ topic: "conversation", key: "c1" }, fresh.consumer, { cursor: "b" });
    // The chat surface installs the replacement and then closes the previous
    // handle — that order must leave the replacement standing.
    first.close();
    await settle();

    h.latest().live(envelope("conversation", { kind: "data", data: 1 }, { key: "c1", cursor: "c" }));
    expect(stale.calls).toEqual([]);
    expect(fresh.calls).toEqual(["data 1 @c g1"]);
    expect(h.channel.subscriptions()).toEqual([{ topic: "conversation", key: "c1", cursor: "c" }]);

    second.resubscribe("d");
    await settle();
    expect(h.posts.at(-1)!.body).toEqual({ add: [{ topic: "conversation", key: "c1", cursor: "d" }] });
  });

  test("changes made before hello ride the next connect's subscription set", async () => {
    const h = createHarness();
    h.channel.connect();
    h.channel.subscribe({ topic: "inventory" }, {});
    await settle();
    expect(h.posts).toEqual([]);

    // Hello arrives: the change is sent now.
    h.latest().hello();
    await settle();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.body).toEqual({ add: [{ topic: "inventory" }] });

    // A change while a reconnect is pending rides the reconnect instead.
    h.latest().fail();
    h.channel.subscribe({ topic: "conversation", key: "c9" }, {});
    await settle();
    expect(h.posts).toHaveLength(1);
    h.runPendingTimer();
    expect(h.subs(h.latest())).toEqual([{ topic: "inventory" }, { topic: "conversation", key: "c9" }]);
  });

  test("control requests are serialized: a change made mid-flight waits for the reply", async () => {
    const h = createHarness();
    h.channel.connect();
    h.latest().hello("s1");
    const release = h.holdNextPost();
    h.channel.subscribe({ topic: "conversation", key: "a" }, {});
    await settle();
    expect(h.posts).toHaveLength(1);
    // Second change while the first request is in flight: nothing is sent
    // until the first answers.
    h.channel.subscribe({ topic: "conversation", key: "b" }, {});
    await settle();
    expect(h.posts).toHaveLength(1);
    release();
    await settle();
    expect(h.posts.map(post => post.body)).toEqual([
      { add: [{ topic: "conversation", key: "a" }] },
      { add: [{ topic: "conversation", key: "b" }] },
    ]);
  });

  test("a control reply for a superseded stream is ignored", async () => {
    const h = createHarness();
    h.channel.connect();
    h.latest().hello("s1");
    const release = h.holdNextPost();
    h.channel.subscribe({ topic: "conversation", key: "a" }, {});
    await settle();
    expect(h.posts).toHaveLength(1);
    // The stream drops and reconnects while the request is in flight; the
    // reconnect presents the set, so the request's outcome no longer matters.
    h.latest().fail();
    h.runPendingTimer();
    h.latest().hello("s2");
    release();
    await settle();
    expect(h.posts).toHaveLength(1);
    expect(h.subs(h.latest())).toEqual([{ topic: "conversation", key: "a" }]);
  });

  // 404 unknown/ended stream, 403 stream owned by another hub session, 400
  // a change this stream cannot take: none of them improves by sending the
  // same request again, so the stream is lost to the change.
  test.each([400, 403, 404])("a %d from the control route loses the stream: reconnect presents the whole set", async status => {
    const h = createHarness();
    h.channel.subscribe({ topic: "document", key: "k" }, {});
    h.channel.connect();
    h.latest().hello("ended");
    h.postStatuses.push(status);
    h.channel.subscribe({ topic: "conversation", key: "c1" }, {}, { cursor: "c1-1" });
    await settle();
    expect(h.posts).toHaveLength(1);
    expect(h.statuses.at(-1)).toBe("reconnecting");
    expect(h.sources[0]!.closed).toBe(true);
    // The one pending timer is the reconnect; the refused POST is not retried.
    expect(h.scheduled).toHaveLength(1);
    h.runPendingTimer();
    await settle();
    expect(h.posts).toHaveLength(1);
    expect(h.subs(h.latest())).toEqual([
      { topic: "document", key: "k" },
      { topic: "conversation", key: "c1", cursor: "c1-1" },
    ]);
    expect(h.query(h.latest()).get("reconnect")).toBe("1");
  });

  test("a failed control request is retried after a short delay", async () => {
    const h = createHarness();
    h.channel.connect();
    h.latest().hello();
    h.postStatuses.push(500);
    h.channel.subscribe({ topic: "inventory" }, {});
    await settle();
    expect(h.posts).toHaveLength(1);
    expect(h.scheduled.map(entry => entry.delay)).toEqual([1_000]);
    h.runPendingTimer();
    await settle();
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]!.body).toEqual({ add: [{ topic: "inventory" }] });
  });

  test("5xx and network failures retry the change with backoff, then escalate to a reconnect", async () => {
    const h = createHarness();
    const conversation = recorder();
    h.channel.subscribe({ topic: "document", key: "k" }, {});
    h.channel.connect();
    h.latest().hello();
    h.postStatuses.push(500, 0, 503);
    h.channel.subscribe({ topic: "conversation", key: "c1" }, conversation.consumer, { cursor: "c1-1" });
    await settle();
    expect(h.scheduled.map(entry => entry.delay)).toEqual([1_000]);
    h.runPendingTimer();
    await settle();
    expect(h.scheduled.map(entry => entry.delay)).toEqual([2_000]);
    h.runPendingTimer();
    await settle();

    // Third failure in a row: stop retrying against this stream. A fresh one
    // presents the whole set, so nothing is re-queued.
    const change: RecordedPost["body"] = { add: [{ topic: "conversation", key: "c1", cursor: "c1-1" }] };
    expect(h.posts.map(post => post.body)).toEqual([change, change, change]);
    expect(h.sources[0]!.closed).toBe(true);
    expect(h.statuses.at(-1)).toBe("reconnecting");
    expect(h.scheduled).toHaveLength(1);
    expect(conversation.calls).toEqual(["dropped 1"]);
    h.runPendingTimer();
    await settle();
    expect(h.posts).toHaveLength(3);
    expect(h.subs(h.latest())).toEqual([
      { topic: "document", key: "k" },
      { topic: "conversation", key: "c1", cursor: "c1-1" },
    ]);
  });

  test("a successful change resets the control retry accounting", async () => {
    const h = createHarness();
    h.channel.connect();
    h.latest().hello();
    h.postStatuses.push(500, 200, 500, 500);
    h.channel.subscribe({ topic: "conversation", key: "a" }, {});
    await settle();
    h.runPendingTimer();
    await settle();
    expect(h.posts).toHaveLength(2);

    h.channel.subscribe({ topic: "conversation", key: "b" }, {});
    await settle();
    // Back to the first step of the schedule, not the third.
    expect(h.scheduled.map(entry => entry.delay)).toEqual([1_000]);
    h.runPendingTimer();
    await settle();
    expect(h.scheduled.map(entry => entry.delay)).toEqual([2_000]);
    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]!.closed).toBe(false);
  });

  test("a subscription the protocol refuses is dropped locally and told unavailable, never sent", async () => {
    const h = createHarness();
    const oversizedKey = recorder();
    const oversizedCursor = recorder();
    h.channel.subscribe({ topic: "inventory" }, {});
    h.channel.connect();
    h.latest().hello();

    h.channel.subscribe({ topic: "conversation", key: "k".repeat(LIVE_MAX_KEY_BYTES + 1) }, oversizedKey.consumer);
    h.channel.subscribe({ topic: "conversation", key: "c1" }, oversizedCursor.consumer, { cursor: "c".repeat(LIVE_MAX_CURSOR_BYTES + 1) });
    // Never during subscribe itself: the caller has not even got its handle yet.
    expect(oversizedKey.calls).toEqual([]);
    await settle();

    // The hub would answer 400, and a reconnect presenting it would be
    // refused the same way on every attempt. Nothing is sent, nothing reconnects.
    expect(h.posts).toEqual([]);
    expect(h.sources).toHaveLength(1);
    expect(h.scheduled).toEqual([]);
    expect(oversizedKey.calls).toEqual(["unavailable g1"]);
    expect(oversizedCursor.calls).toEqual(["unavailable g1"]);
    expect(h.channel.subscriptions()).toEqual([{ topic: "inventory" }]);

    h.latest().fail();
    h.runPendingTimer();
    expect(h.subs(h.latest())).toEqual([{ topic: "inventory" }]);
    expect(oversizedKey.calls).toEqual(["unavailable g1"]);
  });

  test("a closed handle hears nothing about its refusal", async () => {
    const h = createHarness();
    const refused = recorder();
    h.channel.connect();
    h.channel.subscribe({ topic: "conversation", key: "k".repeat(LIVE_MAX_KEY_BYTES + 1) }, refused.consumer).close();
    await settle();
    expect(refused.calls).toEqual([]);
  });

  test("a resubscribe to a cursor the protocol refuses drops the subscription and releases it at the hub", async () => {
    const h = createHarness();
    const conversation = recorder();
    const handle = h.channel.subscribe({ topic: "conversation", key: "c1" }, conversation.consumer);
    h.channel.connect();
    h.latest().hello();
    handle.resubscribe("c".repeat(LIVE_MAX_CURSOR_BYTES + 1));
    await settle();
    expect(h.posts.map(post => post.body)).toEqual([{ remove: [{ topic: "conversation", key: "c1" }] }]);
    expect(conversation.calls).toEqual(["unavailable g1"]);
    expect(h.channel.subscriptions()).toEqual([]);
    expect(h.sources).toHaveLength(1);
  });

  test("a cursor the protocol refuses is never presented on reconnect", async () => {
    const h = createHarness();
    const conversation = recorder();
    h.channel.subscribe({ topic: "inventory" }, {});
    h.channel.subscribe({ topic: "conversation", key: "c1" }, conversation.consumer);
    h.channel.connect();
    h.latest().hello();
    const cursor = "c".repeat(LIVE_MAX_CURSOR_BYTES + 1);
    h.latest().live(envelope("conversation", { kind: "data", data: 1 }, { key: "c1", cursor }));
    h.latest().fail();
    h.runPendingTimer();
    expect(h.subs(h.latest())).toEqual([{ topic: "inventory" }]);
    await settle();
    expect(conversation.calls).toEqual([`data 1 @${cursor} g1`, "dropped 1", "unavailable g2"]);
  });

  test("a subscription past the per-stream bound is refused locally; replacing a held key is not", async () => {
    const h = createHarness();
    for (let index = 0; index < LIVE_MAX_SUBSCRIPTIONS; index += 1) {
      h.channel.subscribe({ topic: "conversation", key: `c${index}` }, {});
    }
    h.channel.connect();
    h.latest().hello();
    const extra = recorder();
    h.channel.subscribe({ topic: "conversation", key: "one-too-many" }, extra.consumer);
    h.channel.subscribe({ topic: "conversation", key: "c0" }, {}, { cursor: "replaced" });
    await settle();
    expect(extra.calls).toEqual(["unavailable g1"]);
    expect(h.posts.map(post => post.body)).toEqual([{ add: [{ topic: "conversation", key: "c0", cursor: "replaced" }] }]);
    expect(h.channel.subscriptions()).toHaveLength(LIVE_MAX_SUBSCRIPTIONS);
  });

  test("a subscription set too long for one URL presents the rest over the control route after hello", async () => {
    // A pinned file whose name is all spaces: each is "+" in the key and
    // "%2B" in the query, the worst expansion a key at the protocol's
    // 4096-byte bound can have (about 12.6 KB of URL on its own).
    const pinned = (name: string) => documentContextKey(new URLSearchParams({ compareTarget: "last-commit", scope: "file", documentId: name }));
    const key = pinned(`/${" ".repeat(4_096 - pinned("/").length)}`);
    expect(new TextEncoder().encode(key).byteLength).toBe(4_096);

    const h = createHarness({ ws: "docs", activity: true });
    h.channel.subscribe({ topic: "inventory" }, {}, { cursor: "i1" });
    h.channel.subscribe({ topic: "document", key }, {}, { cursor: "d7" });
    h.channel.subscribe({ topic: "conversation", key: "opencode:c1" }, {}, { cursor: "c1-9" });
    h.channel.connect();

    // Under the ~8 KB request-line limit common to proxies (nginx, Apache);
    // Bun.serve itself answers 431 at about 16 KB.
    expect(h.latest().url.length).toBeLessThanOrEqual(8_192);
    expect(h.subs(h.latest())).toEqual([
      { topic: "inventory", cursor: "i1" },
      { topic: "conversation", key: "opencode:c1", cursor: "c1-9" },
    ]);
    await settle();
    expect(h.posts).toEqual([]);

    h.latest().hello("s1");
    await settle();
    expect(h.posts).toEqual([{ url: "/api/hub/live/s1/subscriptions", body: { add: [{ topic: "document", key, cursor: "d7" }] } }]);
  });
});

describe("createLiveChannel — recovery and status", () => {
  test("repeated failures keep reconnecting on a capped exponential schedule", () => {
    const h = createHarness();
    h.channel.connect();

    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      h.latest().fail();
      delays.push(h.runPendingTimer());
    }

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    expect(RECONNECT_MAX_DELAY_MS).toBe(15_000);
    // Eight sources: the original plus one per reconnect. The cycle never
    // gives up waiting for the browser to leave CONNECTING.
    expect(h.sources).toHaveLength(8);
    expect(h.statuses.every(status => status === "reconnecting")).toBe(true);
  });

  test("an error burst from one source schedules a single reconnect and one drop", () => {
    const h = createHarness();
    const consumer = recorder();
    h.channel.subscribe({ topic: "inventory" }, consumer.consumer);
    h.channel.connect();
    h.latest().fail();
    h.latest().fail();
    h.latest().fail();
    expect(h.scheduled).toHaveLength(1);
    expect(consumer.calls).toEqual(["dropped 1"]);
    h.runPendingTimer();
    expect(h.sources).toHaveLength(2);
  });

  test("drops count since the last hello, so a persisting outage is distinguishable from a first drop", () => {
    const h = createHarness();
    const consumer = recorder();
    h.channel.subscribe({ topic: "conversation", key: "c1" }, consumer.consumer);
    h.channel.connect();
    h.latest().hello();
    h.latest().fail();
    h.runPendingTimer();
    // The replacement never says hello and dies too.
    h.latest().fail();
    h.runPendingTimer();
    h.latest().hello();
    h.latest().fail();
    expect(consumer.calls).toEqual(["dropped 1", "dropped 2", "dropped 1"]);
  });

  test("confirming the current generation reports live and resets failure accounting", () => {
    const h = createHarness();
    h.channel.connect();

    h.latest().fail();
    expect(h.runPendingTimer()).toBe(1_000);
    h.latest().fail();
    expect(h.runPendingTimer()).toBe(2_000);

    h.channel.confirm(h.channel.currentGeneration());
    expect(h.statuses.at(-1)).toBe("live");
    expect(h.channel.isRecovering()).toBe(false);

    // The next interruption starts a fresh sequence rather than inheriting the
    // old failure count.
    h.latest().fail();
    expect(h.runPendingTimer()).toBe(1_000);
  });

  test("an open stream alone is not treated as connected; the first connect leaves Connecting alone", () => {
    const h = createHarness();
    h.channel.connect();
    h.latest().hello();
    expect(h.statuses).toEqual([]);
  });

  test("a deliberate replacement of a confirmed channel stops claiming Connected until reconfirmed", () => {
    const h = createHarness();
    h.channel.connect();
    h.channel.confirm(h.channel.currentGeneration());
    expect(h.statuses.at(-1)).toBe("live");

    h.channel.connect({ resumed: true });
    expect(h.statuses.at(-1)).toBe("reconnecting");
    expect(h.channel.isRecovering()).toBe(true);
    expect(h.query(h.latest()).get("reconnect")).toBe("1");

    h.channel.confirm(h.channel.currentGeneration());
    expect(h.statuses.at(-1)).toBe("live");
  });

  test("invalidating the current generation returns to reconnecting without touching the transport", () => {
    const h = createHarness();
    h.channel.connect();
    h.channel.confirm(h.channel.currentGeneration());
    h.channel.invalidate(h.channel.currentGeneration());
    expect(h.statuses).toEqual(["live", "reconnecting"]);
    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]!.closed).toBe(false);
    // Idempotent while already recovering; a stale generation is ignored.
    h.channel.invalidate(h.channel.currentGeneration());
    h.channel.invalidate(h.channel.currentGeneration() - 1);
    expect(h.statuses).toEqual(["live", "reconnecting"]);
    h.channel.confirm(h.channel.currentGeneration());
    expect(h.statuses.at(-1)).toBe("live");
  });

  test("activity envelopes reach listeners for any workspace, sanitized to the fixed shape", () => {
    const h = createHarness({ activity: true });
    const seen: [string, unknown][] = [];
    const off = h.channel.onActivity((ws, activity) => seen.push([ws, activity]));
    h.channel.connect();
    h.latest().live(envelope("activity", { kind: "data", data: { running: true, working: true, awaiting: false, title: "leak" } }, { ws: "two" }));
    h.latest().live(envelope("activity", { kind: "data", data: { running: false, working: true, awaiting: true } }, { ws: "three" }));
    h.latest().live(envelope("activity", { kind: "ready" }, { ws: "two" }));
    expect(seen).toEqual([
      ["two", { running: true, working: true, awaiting: false }],
      ["three", { running: false, working: false, awaiting: false }],
    ]);
    off();
    h.latest().live(envelope("activity", { kind: "data", data: { running: true, working: false, awaiting: false } }, { ws: "two" }));
    expect(seen).toHaveLength(2);
  });

  test("activity that arrived before a listener registered is replayed to it at once, latest per workspace", () => {
    const h = createHarness({ activity: true });
    h.channel.connect();
    // The hub's per-workspace snapshot arrives once, when the stream opens —
    // possibly before the switcher has finished its own probe.
    h.latest().live(envelope("activity", { kind: "data", data: { running: true, working: true, awaiting: false } }, { ws: "two" }));
    h.latest().live(envelope("activity", { kind: "data", data: { running: true, working: true, awaiting: true } }, { ws: "two" }));
    h.latest().live(envelope("activity", { kind: "data", data: { running: false } }, { ws: "three" }));

    const seen: [string, unknown][] = [];
    h.channel.onActivity((ws, activity) => seen.push([ws, activity]));
    // Synchronously, during registration.
    expect(seen).toEqual([
      ["two", { running: true, working: true, awaiting: true }],
      ["three", { running: false, working: false, awaiting: false }],
    ]);

    // After that, live as before and without a repeat of the replay.
    h.latest().live(envelope("activity", { kind: "data", data: { running: true, working: false, awaiting: false } }, { ws: "two" }));
    expect(seen).toEqual([
      ["two", { running: true, working: true, awaiting: true }],
      ["three", { running: false, working: false, awaiting: false }],
      ["two", { running: true, working: false, awaiting: false }],
    ]);
  });

  test("disposal stops the retry cycle, closes the source, and silences late errors", () => {
    const h = createHarness();
    h.channel.subscribe({ topic: "inventory" }, {});
    h.channel.connect();
    const source = h.latest();
    source.fail();
    expect(h.scheduled).toHaveLength(1);

    h.channel.dispose();
    expect(h.scheduled).toHaveLength(0);
    expect(h.channel.subscriptions()).toEqual([]);

    // Nothing reopens after disposal, from any entry point.
    h.channel.connect();
    expect(h.sources).toHaveLength(1);
    source.fail();
    expect(h.scheduled).toHaveLength(0);
    h.channel.confirm(h.channel.currentGeneration());
    expect(h.statuses).toEqual(["reconnecting"]);
    expect(h.channel.isCurrent(h.channel.currentGeneration())).toBe(false);
  });
});

describe("reconnectDelay", () => {
  test("doubles from one second and saturates at the cap", () => {
    expect([1, 2, 3, 4, 5, 10].map(reconnectDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
  });
});
