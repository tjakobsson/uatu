import { afterEach, describe, expect, test } from "bun:test";
import { resetAppBasePathForTests } from "../shared/app-url";
import type { LiveSubscription, LiveSubscriptionKey } from "../shared/live-protocol";
import type { LiveChannel, LiveTopicConsumer } from "../shell/live-channel";
import { ChatApiClient, ChatConnectionInterruptedError } from "./client";

const originalDocument = Reflect.get(globalThis, "document");

afterEach(() => {
  Reflect.set(globalThis, "document", originalDocument);
  resetAppBasePathForTests();
});

describe("chat API client", () => {
  test("read deadlines release even fetchers and bodies that ignore cancellation", async () => {
    let signal: AbortSignal | null | undefined;
    const hanging = new ChatApiClient(async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    }, undefined, { ordinaryMs: 10 });
    await expect(hanging.snapshot("opencode:test")).rejects.toThrow("timed out");
    expect(signal?.aborted).toBe(true);
    const body = new ChatApiClient(async () => new Response(new ReadableStream({ start() {} })), undefined, { ordinaryMs: 10 });
    await expect(body.conversations()).rejects.toThrow("timed out");
  });

  test("cold reads honor the server allowance while superseded reads abort", async () => {
    const client = new ChatApiClient(async url => {
      if (String(url).endsWith("status")) return Response.json({ agents: [{ agent: { id: "opencode", name: "OpenCode" }, availability: { state: "idle" } }] }, { headers: { "x-uatu-chat-startup-read-ms": "100" } });
      await new Promise(resolve => setTimeout(resolve, 20));
      return Response.json(snapshot());
    }, undefined, { ordinaryMs: 10 });
    await client.status();
    expect((await client.snapshot("opencode:test")).items).toEqual([]);
    const abort = new AbortController();
    const pending = client.snapshot("opencode:test", undefined, abort.signal);
    abort.abort(new Error("Superseded read"));
    await expect(pending).rejects.toThrow("Superseded read");
  });
  test("routes status, models, inventory, snapshots, and mutations through appUrl", async () => {
    Reflect.set(globalThis, "document", { querySelector: () => ({ getAttribute: () => "/s/work/" }) });
    resetAppBasePathForTests();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("status")) return Response.json({ agents: [{ agent: { id: "opencode", name: "OpenCode" }, availability: { state: "ready", version: "test" } }] });
      if (String(url).includes("models")) return Response.json({ models: [{ selection: { providerId: "anthropic", modelId: "claude" }, provider: "Anthropic", name: "Claude" }] });
      if (String(url).includes("commands")) return Response.json({ commands: [{ name: "review", description: "Review", argumentHint: "[focus]", kind: "command" }] });
      if (String(url).endsWith("conversations")) return init?.method === "POST"
        ? Response.json(snapshot(), { status: 201 })
        : Response.json({ conversations: [snapshot().conversation] });
       if (String(url).includes("prompts")) return Response.json({ messageId: "m1", delivery: "queue", configuration: { model: { providerId: "anthropic", modelId: "claude" } } }, { status: 202 });
       if (init?.method === "PATCH") return Response.json({ conversation: { ...snapshot().conversation, title: "Renamed" } });
      return Response.json(snapshot());
    }) as typeof fetch;
    const client = new ChatApiClient(fetcher);
    expect((await client.status())[0]!.agent.id).toBe("opencode");
    expect(await client.models("opencode")).toEqual([expect.objectContaining({ name: "Claude" })]);
    expect(await client.commands("opencode")).toEqual([expect.objectContaining({ name: "review" })]);
    expect(requests[1]!.url).toContain("agent=opencode");
    await client.conversations();
    await client.snapshot("c/1");
    await client.prompt("c/1", "r1", "hello", { providerId: "anthropic", modelId: "claude" });
    await client.renameConversation("c/1", "r2", "Renamed");
    expect(requests.every(request => request.url.startsWith("/s/work/api/chat/"))).toBe(true);
    expect(requests[4]!.url).toContain("c%2F1");
    expect(JSON.parse(requests[5]!.init!.body as string)).toEqual({
      requestId: "r1",
      text: "hello",
      model: { providerId: "anthropic", modelId: "claude" },
    });
    expect(requests[6]!.init?.method).toBe("PATCH");
  });

  test("posts reversible-history receipts through the base path and validates their results", async () => {
    Reflect.set(globalThis, "document", { querySelector: () => ({ getAttribute: () => "/s/work/" }) });
    resetAppBasePathForTests();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      {
        outcome: "changed",
        state: { staged: true, canUndo: false, canRedo: true, revertedMessages: [{ id: "message:first", text: "Try again" }] },
        restoredDraft: { text: "Try again" },
      },
      {
        outcome: "nothing-to-redo",
        state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
      },
      {
        outcome: "changed",
        state: { staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: "message:selected", text: "Selected" }] },
        restoredDraft: { text: "Selected" },
      },
      {
        outcome: "changed",
        state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
      },
    ];
    const client = new ChatApiClient(async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json(responses.shift());
    });

    expect(await client.undo("c/1", "undo-1")).toEqual(expect.objectContaining({ outcome: "changed" }));
    expect(await client.redo("c/1", "redo-1")).toEqual(expect.objectContaining({ outcome: "nothing-to-redo" }));
    expect(await client.revert("c/1", "message:selected", "revert-1")).toEqual(expect.objectContaining({ outcome: "changed" }));
    expect(await client.restore("c/1", "message:selected", "restore-1")).toEqual(expect.objectContaining({ outcome: "changed" }));
    expect(requests.map(entry => entry.url)).toEqual([
      "/s/work/api/chat/conversations/c%2F1/undo",
      "/s/work/api/chat/conversations/c%2F1/redo",
      "/s/work/api/chat/conversations/c%2F1/revert",
      "/s/work/api/chat/conversations/c%2F1/restore",
    ]);
    expect(requests.map(entry => JSON.parse(entry.init!.body as string))).toEqual([
      { requestId: "undo-1" },
      { requestId: "redo-1" },
      { requestId: "revert-1", messageId: "message:selected" },
      { requestId: "restore-1", messageId: "message:selected" },
    ]);
  });

  test("rejects malformed reversible-history results", async () => {
    const client = new ChatApiClient(async () => Response.json({
      outcome: "changed",
      state: { staged: false, canUndo: true, canRedo: true, revertedMessages: [] },
    }));

    await expect(client.undo("c1", "undo-1")).rejects.toThrow("cannot redo without a staged boundary");
  });

  test("a conversation stream is a subscription on the shared channel from the given cursor", () => {
    const channel = new FakeChannel();
    const client = new ChatApiClient(fetch, () => channel);
    const events: [number, string][] = [];
    const stream = client.stream("c1", "cursor-1", {
      event: (event, cursor) => events.push([event.sequence, cursor]),
      resync: () => {},
      error: () => {},
    });
    expect(channel.entries.map(entry => [entry.key, entry.cursor])).toEqual([[{ topic: "conversation", key: "c1" }, "cursor-1"]]);
    channel.deliver("c1", { generation: "g", sequence: 2, conversationId: "c1", type: "conversation.status", status: "running" }, "cursor-2");
    expect(events).toEqual([[2, "cursor-2"]]);
    stream.close();
    expect(channel.entries[0]!.closed).toBe(true);
    // Nothing after close reaches the handlers.
    channel.deliver("c1", { generation: "g", sequence: 3, conversationId: "c1", type: "conversation.status", status: "idle" }, "cursor-3");
    expect(events).toHaveLength(1);
  });

  test("a malformed event closes the subscription and asks for a resync", () => {
    const channel = new FakeChannel();
    const client = new ChatApiClient(fetch, () => channel);
    const errors: string[] = [];
    let resyncs = 0;
    client.stream("c1", "cursor-1", {
      event: () => {},
      resync: () => { resyncs += 1; },
      error: error => errors.push(error.message),
    });

    channel.deliver("c1", { nonsense: true }, "cursor-2");

    expect(errors).toHaveLength(1);
    expect(resyncs).toBe(1);
    expect(channel.entries[0]!.closed).toBe(true);
  });

  test("a topic resync detaches the subscription and hands the owner the child's reason", () => {
    const channel = new FakeChannel();
    const client = new ChatApiClient(fetch, () => channel);
    const reasons: unknown[] = [];
    client.stream("c1", "cursor-1", {
      event: () => {},
      resync: reason => reasons.push(reason?.reason ?? null),
      error: () => {},
    });
    channel.entries[0]!.consumer.resync?.({ generation: "g", sequence: 0, conversationId: "c1", type: "resync", reason: "retention-gap" }, 1);
    expect(reasons).toEqual(["retention-gap"]);
    expect(channel.entries[0]!.closed).toBe(true);

    // A resync with no usable payload still resyncs.
    client.stream("c2", "cursor-1", { event: () => {}, resync: reason => reasons.push(reason ?? null), error: () => {} });
    channel.entries[1]!.consumer.resync?.(undefined, 1);
    expect(reasons).toEqual(["retention-gap", null]);
  });

  test("the first drop is silent, a persisting outage announces, and the topic's ready clears it", () => {
    const channel = new FakeChannel();
    const client = new ChatApiClient(fetch, () => channel);
    const errors: string[] = [];
    const recoveries: number[] = [];
    client.stream("c1", "cursor-1", {
      event: () => {},
      resync: () => {},
      error: error => errors.push(error.message),
      recovered: () => recoveries.push(1),
    });
    const consumer = channel.entries[0]!.consumer;

    consumer.dropped?.(1);
    expect(errors).toEqual([]);
    consumer.dropped?.(2);
    expect(errors).toEqual(["Chat connection interrupted; reconnecting"]);
    // The replacement stream attaches the topic while the conversation stays
    // idle — no chat event arrives, and the open alone has to be enough.
    consumer.ready?.(2);
    expect(recoveries).toHaveLength(1);

    // The hub losing the child is an interruption too, typed the same way.
    consumer.unavailable?.(2);
    expect(errors).toEqual(["Chat connection interrupted; reconnecting", "Chat connection interrupted; reconnecting"]);
    expect(errors.every(message => message.length > 0)).toBe(true);
  });

  test("interruptions are typed so the surface can own them", () => {
    const channel = new FakeChannel();
    const client = new ChatApiClient(fetch, () => channel);
    const errors: unknown[] = [];
    client.stream("c1", "cursor-1", { event: () => {}, resync: () => {}, error: error => errors.push(error) });
    channel.entries[0]!.consumer.dropped?.(2);
    expect(errors[0]).toBeInstanceOf(ChatConnectionInterruptedError);
  });

  test("the inventory topic invalidates on data, re-reads and re-attaches on resync, and reports transport like a conversation", () => {
    const channel = new FakeChannel();
    const client = new ChatApiClient(fetch, () => channel);
    const invalidations: unknown[] = [];
    const errors: string[] = [];
    const recoveries: number[] = [];
    const stream = client.inventoryStream({
      invalidation: event => invalidations.push(event),
      error: error => errors.push(error.message),
      recovered: () => recoveries.push(1),
    });
    expect(channel.entries.map(entry => entry.key)).toEqual([{ topic: "inventory" }]);
    const entry = channel.entries[0]!;

    entry.consumer.data?.({ type: "conversation.inventory" }, "i1", 1);
    expect(invalidations).toEqual([{ type: "conversation.inventory" }]);

    // Malformed frames are reported, never applied.
    entry.consumer.data?.({ type: "conversation.created" }, "i2", 1);
    entry.consumer.data?.("not an object", "i3", 1);
    expect(invalidations).toHaveLength(1);
    expect(errors).toHaveLength(2);

    // A resync is one more reason to re-read; the topic re-attaches from now.
    entry.consumer.resync?.(undefined, 1);
    expect(invalidations).toHaveLength(2);
    expect(entry.resubscribed).toEqual([undefined]);

    entry.consumer.dropped?.(1);
    expect(errors).toHaveLength(2);
    entry.consumer.dropped?.(2);
    expect(errors.at(-1)).toBe("Chat inventory connection interrupted; reconnecting");
    entry.consumer.ready?.(2);
    expect(recoveries).toHaveLength(1);
    entry.consumer.unavailable?.(2);
    expect(errors.at(-1)).toBe("Chat inventory connection interrupted; reconnecting");

    stream.close();
    expect(entry.closed).toBe(true);
    entry.consumer.data?.({ type: "conversation.inventory" }, "i4", 2);
    entry.consumer.ready?.(2);
    expect(invalidations).toHaveLength(2);
    expect(recoveries).toHaveLength(1);
  });

  test("no stream opens a connection of its own", () => {
    const channel = new FakeChannel();
    const client = new ChatApiClient(fetch, () => channel);
    client.inventoryStream({ invalidation: () => {}, error: () => {} });
    client.stream("c1", "cursor", { event: () => {}, resync: () => {}, error: () => {} });
    client.stream("child", "cursor", { event: () => {}, resync: () => {}, error: () => {} });
    expect(channel.connects).toBe(0);
    expect(channel.entries).toHaveLength(3);
  });
});

// The channel as the client sees it: subscriptions with their consumers,
// driven by hand.
class FakeChannel implements LiveChannel {
  suspend(): void {}
  readonly entries: Array<{
    key: LiveSubscriptionKey;
    cursor: string | undefined;
    consumer: LiveTopicConsumer;
    closed: boolean;
    resubscribed: Array<string | undefined>;
  }> = [];
  connects = 0;
  connect() { this.connects += 1; }
  subscribe(key: LiveSubscriptionKey, consumer: LiveTopicConsumer, options: { cursor?: string } = {}) {
    const entry = { key, cursor: options.cursor, consumer, closed: false, resubscribed: [] as Array<string | undefined> };
    this.entries.push(entry);
    return {
      resubscribe(cursor?: string) { entry.resubscribed.push(cursor); },
      close() { entry.closed = true; },
    };
  }
  deliver(conversationId: string, value: unknown, cursor: string) {
    for (const entry of this.entries) {
      if (entry.key.topic === "conversation" && entry.key.key === conversationId && !entry.closed) entry.consumer.data?.(value, cursor, 1);
    }
  }
  onActivity() { return () => {}; }
  onStreamOpened() { return () => {}; }
  onStatus() { return () => {}; }
  confirm() {}
  invalidate() {}
  isCurrent() { return true; }
  currentGeneration() { return 1; }
  isRecovering() { return false; }
  subscriptions(): LiveSubscription[] {
    return this.entries.filter(entry => !entry.closed).map(entry => ({ ...entry.key, ...(entry.cursor ? { cursor: entry.cursor } : {}) }));
  }
  dispose() {}
}

function snapshot() {
  return {
    conversation: { id: "c/1", title: "Chat", createdAt: 1, updatedAt: 1, status: "idle", agent: { id: "opencode", name: "OpenCode" } },
    configuration: {},
    generation: "g",
    cursor: "cursor",
    items: [],
  };
}
