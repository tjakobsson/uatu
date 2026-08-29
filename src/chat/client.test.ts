import { afterEach, describe, expect, test } from "bun:test";
import { resetAppBasePathForTests } from "../shared/app-url";
import { ChatApiClient } from "./client";

const originalDocument = Reflect.get(globalThis, "document");

afterEach(() => {
  Reflect.set(globalThis, "document", originalDocument);
  resetAppBasePathForTests();
});

describe("chat API client", () => {
  test("routes status, models, inventory, snapshots, and mutations through appUrl", async () => {
    Reflect.set(globalThis, "document", { querySelector: () => ({ getAttribute: () => "/s/work/" }) });
    resetAppBasePathForTests();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("status")) return Response.json({ state: "ready", version: "test" });
      if (String(url).endsWith("models")) return Response.json({ models: [{ selection: { providerId: "anthropic", modelId: "claude" }, provider: "Anthropic", name: "Claude" }] });
      if (String(url).endsWith("commands")) return Response.json({ commands: [{ name: "review", description: "Review", argumentHint: "[focus]", kind: "command" }] });
      if (String(url).endsWith("conversations")) return init?.method === "POST"
        ? Response.json(snapshot(), { status: 201 })
        : Response.json({ conversations: [snapshot().conversation] });
       if (String(url).includes("prompts")) return Response.json({ messageId: "m1", delivery: "queue", configuration: { model: { providerId: "anthropic", modelId: "claude" } } }, { status: 202 });
       if (init?.method === "PATCH") return Response.json({ conversation: { ...snapshot().conversation, title: "Renamed" } });
      return Response.json(snapshot());
    }) as typeof fetch;
    const client = new ChatApiClient(fetcher);
    await client.status();
    expect(await client.models()).toEqual([expect.objectContaining({ name: "Claude" })]);
    expect(await client.commands()).toEqual([expect.objectContaining({ name: "review" })]);
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

  test("posts undo and redo receipts through the base path and validates their results", async () => {
    Reflect.set(globalThis, "document", { querySelector: () => ({ getAttribute: () => "/s/work/" }) });
    resetAppBasePathForTests();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      {
        outcome: "changed",
        state: { staged: true, canUndo: false, canRedo: true },
        restoredDraft: { text: "Try again" },
      },
      {
        outcome: "nothing-to-redo",
        state: { staged: false, canUndo: true, canRedo: false },
      },
    ];
    const client = new ChatApiClient(async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json(responses.shift());
    });

    expect(await client.undo("c/1", "undo-1")).toEqual(expect.objectContaining({ outcome: "changed" }));
    expect(await client.redo("c/1", "redo-1")).toEqual(expect.objectContaining({ outcome: "nothing-to-redo" }));
    expect(requests.map(entry => entry.url)).toEqual([
      "/s/work/api/chat/conversations/c%2F1/undo",
      "/s/work/api/chat/conversations/c%2F1/redo",
    ]);
    expect(requests.map(entry => JSON.parse(entry.init!.body as string))).toEqual([
      { requestId: "undo-1" },
      { requestId: "redo-1" },
    ]);
  });

  test("rejects malformed reversible-history results", async () => {
    const client = new ChatApiClient(async () => Response.json({
      outcome: "changed",
      state: { staged: false, canUndo: true, canRedo: true },
    }));

    await expect(client.undo("c1", "undo-1")).rejects.toThrow("cannot redo without a staged boundary");
  });

  test("reconnects from the latest event cursor and cleanup closes the stream", () => {
    const sources: FakeEventSource[] = [];
    const client = new ChatApiClient(fetch, url => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source as unknown as EventSource;
    });
    const events: number[] = [];
    const stream = client.stream("c1", "cursor-1", {
      event: event => events.push(event.sequence),
      resync: () => {},
      error: () => {},
    });
    expect(sources[0]!.url).toContain("cursor=cursor-1");
    sources[0]!.emit("chat", { generation: "g", sequence: 2, conversationId: "c1", type: "conversation.status", status: "running" }, "cursor-2");
    expect(events).toEqual([2]);
    stream.close();
    expect(sources[0]!.closed).toBe(true);
  });

  test("a malformed event closes the stream and asks for a resync", () => {
    const sources: FakeEventSource[] = [];
    const client = new ChatApiClient(fetch, url => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source as unknown as EventSource;
    });
    const errors: string[] = [];
    let resyncs = 0;
    client.stream("c1", "cursor-1", {
      event: () => {},
      resync: () => { resyncs += 1; },
      error: error => errors.push(error.message),
    });

    sources[0]!.emit("chat", { nonsense: true }, "cursor-2");

    expect(errors).toHaveLength(1);
    expect(resyncs).toBe(1);
    expect(sources[0]!.closed).toBe(true);
  });

  test("the first reconnect is silent and later failures announce", () => {
    const sources: FakeEventSource[] = [];
    const timers = new FakeTimers();
    const client = new ChatApiClient(fetch, url => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source as unknown as EventSource;
    }, timers);
    const errors: string[] = [];
    const stream = client.stream("c1", "cursor-1", { event: () => {}, resync: () => {}, error: error => errors.push(error.message) });

    sources[0]!.fail();
    expect(errors).toEqual([]);
    expect(timers.delays()).toEqual([1_000]);
    timers.runNext();

    sources[1]!.fail();
    expect(errors).toEqual(["Chat connection interrupted; reconnecting"]);
    stream.close();
  });

  test("inventory stream uses the app base path and accepts initial and reconnect frames", () => {
    Reflect.set(globalThis, "document", { querySelector: () => ({ getAttribute: () => "/s/work/" }) });
    resetAppBasePathForTests();
    const sources: FakeEventSource[] = [];
    const timers = new FakeTimers();
    const client = eventSourceClient(sources, timers);
    const invalidations: unknown[] = [];
    const stream = client.inventoryStream({
      invalidation: event => invalidations.push(event),
      error: () => {},
    });

    expect(sources[0]!.url).toBe("/s/work/api/chat/conversations/events");
    sources[0]!.emit("inventory", { type: "conversation.inventory" });
    sources[0]!.fail();
    timers.runNext();
    sources[1]!.emit("inventory", { type: "conversation.inventory" });

    expect(sources[1]!.url).toBe("/s/work/api/chat/conversations/events");
    expect(invalidations).toEqual([
      { type: "conversation.inventory" },
      { type: "conversation.inventory" },
    ]);
    stream.close();
  });

  test("inventory stream rejects malformed frames without invalidating", () => {
    const sources: FakeEventSource[] = [];
    const client = eventSourceClient(sources, new FakeTimers());
    const errors: string[] = [];
    let invalidations = 0;
    const stream = client.inventoryStream({
      invalidation: () => { invalidations += 1; },
      error: error => errors.push(error.message),
    });

    sources[0]!.emit("inventory", { type: "conversation.created" });
    sources[0]!.emit("inventory", { type: "conversation.inventory", id: "c1" });
    sources[0]!.emitRaw("inventory", "not json");

    expect(invalidations).toBe(0);
    expect(errors).toHaveLength(3);
    stream.close();
  });

  test("inventory stream retries with capped backoff and reports persistent failure", () => {
    const sources: FakeEventSource[] = [];
    const timers = new FakeTimers();
    const client = eventSourceClient(sources, timers);
    const errors: string[] = [];
    const stream = client.inventoryStream({ invalidation: () => {}, error: error => errors.push(error.message) });

    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000];
    for (const [index, delay] of expectedDelays.entries()) {
      sources[index]!.fail();
      expect(timers.delays()).toEqual([delay]);
      expect(errors).toHaveLength(Math.max(0, index));
      timers.runNext();
    }

    expect(sources).toHaveLength(expectedDelays.length + 1);
    expect(errors.every(error => error === "Chat inventory connection interrupted; reconnecting")).toBe(true);
    stream.close();
  });

  test("a valid inventory frame resets consecutive failures", () => {
    const sources: FakeEventSource[] = [];
    const timers = new FakeTimers();
    const client = eventSourceClient(sources, timers);
    const errors: string[] = [];
    const stream = client.inventoryStream({ invalidation: () => {}, error: error => errors.push(error.message) });

    sources[0]!.fail();
    timers.runNext();
    sources[1]!.emit("inventory", { type: "conversation.inventory" });
    sources[1]!.fail();

    expect(timers.delays()).toEqual([1_000]);
    expect(errors).toEqual([]);
    stream.close();
  });

  test("inventory stream cleanup closes active sources and cancels reconnect timers", () => {
    const sources: FakeEventSource[] = [];
    const timers = new FakeTimers();
    const client = eventSourceClient(sources, timers);
    const activeStream = client.inventoryStream({ invalidation: () => {}, error: () => {} });

    activeStream.close();
    expect(sources[0]!.closed).toBe(true);

    const reconnectingStream = client.inventoryStream({ invalidation: () => {}, error: () => {} });
    sources[1]!.fail();
    expect(timers.delays()).toEqual([1_000]);
    reconnectingStream.close();
    expect(timers.delays()).toEqual([]);
    timers.runNext();
    expect(sources).toHaveLength(2);
  });

  test("inventory stream does not schedule another reconnect when persistent-error handling closes it", () => {
    const sources: FakeEventSource[] = [];
    const timers = new FakeTimers();
    const client = eventSourceClient(sources, timers);
    let stream!: ReturnType<ChatApiClient["inventoryStream"]>;
    stream = client.inventoryStream({ invalidation: () => {}, error: () => stream.close() });

    sources[0]!.fail();
    timers.runNext();
    sources[1]!.fail();

    expect(timers.delays()).toEqual([]);
    expect(sources[1]!.closed).toBe(true);
  });
});

class FakeEventSource {
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener as (event: MessageEvent<string>) => void); }
  close() { this.closed = true; }
  fail() { this.onerror?.(new Event("error")); }
  emit(type: string, value: unknown, lastEventId = "") {
    this.listeners.get(type)?.({ data: JSON.stringify(value), lastEventId } as MessageEvent<string>);
  }
  emitRaw(type: string, data: string) {
    this.listeners.get(type)?.({ data, lastEventId: "" } as MessageEvent<string>);
  }
}

class FakeTimers {
  private nextId = 1;
  private readonly tasks = new Map<ReturnType<typeof setTimeout>, { callback: () => void; delay: number }>();

  setTimeout = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++ as unknown as ReturnType<typeof setTimeout>;
    this.tasks.set(id, { callback, delay });
    return id;
  };

  clearTimeout = (id: ReturnType<typeof setTimeout>): void => {
    this.tasks.delete(id);
  };

  delays(): number[] {
    return [...this.tasks.values()].map(task => task.delay);
  }

  runNext(): void {
    const next = this.tasks.entries().next().value as [ReturnType<typeof setTimeout>, { callback: () => void }] | undefined;
    if (!next) return;
    this.tasks.delete(next[0]);
    next[1].callback();
  }
}

function eventSourceClient(sources: FakeEventSource[], timers: FakeTimers): ChatApiClient {
  return new ChatApiClient(fetch, url => {
    const source = new FakeEventSource(url);
    sources.push(source);
    return source as unknown as EventSource;
  }, timers);
}

function snapshot() {
  return {
    conversation: { id: "c/1", title: "Chat", createdAt: 1, updatedAt: 1, status: "idle" },
    configuration: {},
    generation: "g",
    cursor: "cursor",
    items: [],
  };
}
