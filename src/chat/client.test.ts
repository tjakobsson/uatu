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
    const client = new ChatApiClient(fetch, url => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source as unknown as EventSource;
    });
    const errors: string[] = [];
    const stream = client.stream("c1", "cursor-1", { event: () => {}, resync: () => {}, error: error => errors.push(error.message) });

    sources[0]!.onerror?.(new Event("error"));
    expect(errors).toEqual([]);

    sources[0]!.onerror?.(new Event("error"));
    expect(errors).toEqual(["Chat connection interrupted; reconnecting"]);
    stream.close();
  });
});

class FakeEventSource {
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener as (event: MessageEvent<string>) => void); }
  close() { this.closed = true; }
  emit(type: string, value: unknown, lastEventId: string) {
    this.listeners.get(type)?.({ data: JSON.stringify(value), lastEventId } as MessageEvent<string>);
  }
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
