import { afterAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import type { LiveEnvelope } from "../shared/live-protocol";
import type { LiveChannel } from "../shell/live-channel";
import { ChatConnectionInterruptedError, ChatTransportError, type ChatApiClient } from "./client";
import type { ConversationSnapshot } from "./types";

const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
const savedGlobals = new Map<string, unknown>();
const CHILD_PROCESS_FLAG = "UATU_CHAT_LIFECYCLE_TEST_CHILD";

if (process.env[CHILD_PROCESS_FLAG] !== "1") {
  describe("chat lifecycle recovery", () => {
    test("runs the browser integration in an isolated process", async () => {
      const child = Bun.spawn({
        cmd: [process.execPath, "test", import.meta.path],
        env: { ...process.env, [CHILD_PROCESS_FLAG]: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    });
  });
} else {
describe("chat lifecycle recovery", () => {
  test("a resumed page reconciles inventory over the one channel without replacing its subscriptions or losing the draft", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");

    const conversationSelect = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    let selectedConversation = "";
    Object.defineProperty(conversationSelect, "value", {
      configurable: true,
      get: () => selectedConversation,
      set: value => { selectedConversation = String(value); },
    });

    const conversationCalls: number[] = [];
    const snapshotCalls: string[] = [];
    const streams: { conversationId: string; cursor: string; closed: boolean }[] = [];
    const inventoryStreams: { closed: boolean }[] = [];
    const connects: { resumed?: boolean }[] = [];
    const connectsAtInventoryFetch: number[] = [];

    const api = {
      status: async () => ([{
        agent: { id: "test", name: "Test" },
        availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: [] } },
      }]),
      conversations: async () => {
        conversationCalls.push(Date.now());
        // What the recovery had already done when it issued this fetch.
        connectsAtInventoryFetch.push(connects.length);
        return [conversation("one")];
      },
      commands: async () => [],
      snapshot: async (id: string) => { snapshotCalls.push(id); return snapshot(id); },
      stream: (conversationId: string, cursor: string) => {
        const entry = { conversationId, cursor, closed: false };
        streams.push(entry);
        return { close() { entry.closed = true; } };
      },
      inventoryStream: () => {
        const entry = { closed: false };
        inventoryStreams.push(entry);
        return { close() { entry.closed = true; } };
      },
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
    } as unknown as ChatApiClient;

    // The page's one channel, as the shell holds it. Chat never opens or
    // closes it; a wake-up reconnects it and runs chat's reconciliation.
    const { installLiveChannelForTests, watchPageLifecycle, disposeLiveChannel } = await import("../shell/live");
    installLiveChannelForTests({
      connect(options?: { resumed?: boolean }) { connects.push(options ?? {}); },
      dispose() {},
    } as unknown as LiveChannel);
    watchPageLifecycle();

    const { initChat } = await import(`./ui.ts?lifecycle-ui-test=${Date.now()}`);
    initChat(api);

    const input = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
    const form = document.querySelector<HTMLFormElement>("#chat-composer")!;
    await waitUntil(
      () => conversationSelect.value === "one" && !form.hidden && streams.length === 1,
      () => document.querySelector("#chat-state")?.textContent ?? "no chat state",
    );

    input.value = "a draft the user is still writing";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const renderedBefore = document.querySelector("#chat-items")?.innerHTML ?? "";
    const inventoryCallsBefore = conversationCalls.length;
    const snapshotCallsBefore = snapshotCalls.length;

    // The page freezes for the back/forward cache and comes back — the burst
    // a phone produces on resume. The teardown must not fire: this surface
    // is the one being restored.
    window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: true }));
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));

    await waitUntil(() => conversationCalls.length > inventoryCallsBefore);

    // One reconnect of the one channel for the whole burst, and it was
    // superseded BEFORE the reconciliation fetch went out: the replacement
    // never depends on the fetch succeeding, and the stream being replaced
    // cannot deliver anything more.
    expect(connects).toEqual([{ resumed: true }]);
    expect(connectsAtInventoryFetch.at(-1)).toBe(1);

    // Inventory reconciled from the server; the subscriptions were NOT
    // replaced — the channel resumes the inventory and conversation topics
    // from the cursors it holds, so there is nothing for chat to reopen.
    expect(inventoryStreams).toHaveLength(1);
    expect(inventoryStreams[0]!.closed).toBe(false);
    expect(streams).toHaveLength(1);
    expect(streams[0]!.closed).toBe(false);
    expect(streams[0]!.cursor).toBe("cursor-one");

    // Presentation state is untouched by transport recovery: the draft stands,
    // the timeline was neither refetched nor re-rendered. (Re-rendering is what
    // would move the reader's scroll position; this harness has no layout, so
    // the scroll itself is asserted in the browser suite.)
    expect(input.value).toBe("a draft the user is still writing");
    expect(snapshotCalls.length).toBe(snapshotCallsBefore);
    expect(document.querySelector("#chat-items")?.innerHTML ?? "").toBe(renderedBefore);

    // A genuinely later signal recovers the same way, once the first has
    // settled (an overlapping signal is dropped by design — see
    // createLifecycleRecovery).
    await Bun.sleep(20);
    window.dispatchEvent(new Event("online"));
    await waitUntil(() => connects.length === 2);
    expect(streams).toHaveLength(1);

    window.dispatchEvent(new Event("pagehide"));
    disposeLiveChannel();
    installLiveChannelForTests(null);
  });

  test("a page with chat, a conversation, and a resync holds exactly one live source, and a wake-up replaces it once", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");

    const conversationSelect = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    let selectedConversation = "";
    Object.defineProperty(conversationSelect, "value", {
      configurable: true,
      get: () => selectedConversation,
      set: value => { selectedConversation = String(value); },
    });

    // Every EventSource the page constructs, whoever asks for it.
    const sources: FakeLiveSource[] = [];
    Reflect.set(globalThis, "EventSource", class {
      constructor(url: string) {
        const source = new FakeLiveSource(url);
        sources.push(source);
        return source;
      }
    });
    const posts: { url: string; body: unknown }[] = [];
    let snapshots = 0;
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/hub/live/")) {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: true });
      }
      if (url.endsWith("/api/chat/status")) {
        return Response.json({ agents: [{
          agent: { id: "test", name: "Test" },
          availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: [] } },
        }] });
      }
      if (url.endsWith("/api/chat/conversations")) return Response.json({ conversations: [conversation("one")] });
      if (url.includes("/api/chat/conversations/one")) {
        snapshots += 1;
        return Response.json({ ...snapshot("one"), cursor: `cursor-one-${snapshots}` });
      }
      return Response.json({ error: `unexpected ${url}` }, { status: 404 });
    };

    const { installLiveChannelForTests, liveChannel, watchPageLifecycle, disposeLiveChannel } = await import("../shell/live");
    const { createLiveChannel } = await import("../shell/live-channel");
    const { ChatApiClient } = await import("./client");
    installLiveChannelForTests(null);
    const channel = createLiveChannel({
      ws: null,
      activity: false,
      openSource: url => new (globalThis as unknown as { EventSource: new (url: string) => FakeLiveSource }).EventSource(url),
      fetcher,
    });
    installLiveChannelForTests(channel);
    watchPageLifecycle();
    // As boot does: the shell opens the one stream before chat comes up.
    liveChannel().connect();
    expect(sources).toHaveLength(1);

    const { initChat } = await import(`./ui.ts?one-source-ui-test=${Date.now()}`);
    initChat(new ChatApiClient(fetcher, liveChannel));

    const form = document.querySelector<HTMLFormElement>("#chat-composer")!;
    await waitUntil(
      () => conversationSelect.value === "one" && !form.hidden && channel.subscriptions().some(sub => sub.topic === "conversation"),
      () => document.querySelector("#chat-state")?.textContent ?? "no chat state",
    );
    expect(channel.subscriptions()).toEqual([
      { topic: "inventory" },
      { topic: "conversation", key: "one", cursor: "cursor-one-1" },
    ]);

    // The stream says hello: the subscriptions made meanwhile are sent as
    // control changes on the open stream, not as connections.
    sources[0]!.hello("s1");
    await waitUntil(() => posts.length === 1);
    expect(posts[0]!.url).toBe("/api/hub/live/s1/subscriptions");
    expect(sources).toHaveLength(1);

    // The hub cannot replay the conversation's cursor: chat re-snapshots and
    // subscribes again from the snapshot's cursor — still no new connection.
    sources[0]!.live({ ws: "e2e", topic: "conversation", key: "one", cursor: "cursor-one-1", event: { kind: "resync" } });
    await waitUntil(() => channel.subscriptions().some(sub => sub.topic === "conversation" && sub.cursor === "cursor-one-2"));
    await waitUntil(() => posts.length >= 2);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.closed).toBe(false);

    // A wake-up burst replaces the one source exactly once, presenting every
    // retained cursor.
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    await Bun.sleep(5);
    expect(sources).toHaveLength(2);
    expect(sources[0]!.closed).toBe(true);
    expect(sources[1]!.closed).toBe(false);
    const query = new URL(sources[1]!.url, "http://hub.invalid").searchParams;
    expect(query.get("reconnect")).toBe("1");
    expect(JSON.parse(query.get("subs")!)).toEqual([
      { topic: "inventory" },
      { topic: "conversation", key: "one", cursor: "cursor-one-2" },
    ]);

    window.dispatchEvent(new Event("pagehide"));
    disposeLiveChannel();
    installLiveChannelForTests(null);
  });

  test("a successful stream open clears only the reconnect message, leaving unrelated errors standing", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");

    const conversationSelect = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    let selectedConversation = "";
    Object.defineProperty(conversationSelect, "value", {
      configurable: true,
      get: () => selectedConversation,
      set: value => { selectedConversation = String(value); },
    });

    type Handlers = { error: (error: ChatTransportError) => void; recovered?: () => void };
    const streamHandlers: Handlers[] = [];
    const inventoryHandlers: Handlers[] = [];

    const api = {
      status: async () => ([{
        agent: { id: "test", name: "Test" },
        availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: [] } },
      }]),
      conversations: async () => [conversation("one")],
      commands: async () => [],
      snapshot: async (id: string) => snapshot(id),
      stream: (_conversationId: string, _cursor: string, handlers: Handlers) => {
        streamHandlers.push(handlers);
        return { close() {} };
      },
      inventoryStream: (handlers: Handlers) => {
        inventoryHandlers.push(handlers);
        return { close() {} };
      },
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
    } as unknown as ChatApiClient;

    const { initChat } = await import(`./ui.ts?interruption-ui-test=${Date.now()}`);
    initChat(api);

    const form = document.querySelector<HTMLFormElement>("#chat-composer")!;
    const status = document.querySelector<HTMLElement>("#chat-state")!;
    await waitUntil(() => conversationSelect.value === "one" && !form.hidden && streamHandlers.length === 1);

    const handlers = streamHandlers[0]!;

    handlers.error(new ChatConnectionInterruptedError("Chat connection interrupted; reconnecting"));
    expect(status.textContent).toContain("Chat connection interrupted; reconnecting");

    // The replacement opens while the conversation stays idle — no Chat event
    // arrives, and the message must still go.
    handlers.recovered?.();
    expect(status.textContent).not.toContain("Chat connection interrupted; reconnecting");

    // An actionable error is not the reconnect message and survives a later
    // successful open.
    handlers.error(new ChatTransportError("The provider rejected the request"));
    expect(status.textContent).toContain("The provider rejected the request");
    handlers.recovered?.();
    expect(status.textContent).toContain("The provider rejected the request");

    // And an actionable error raised *after* an interruption is not swept away
    // by the reconnect that follows.
    handlers.error(new ChatConnectionInterruptedError("Chat connection interrupted; reconnecting"));
    handlers.error(new ChatTransportError("The active turn failed"));
    handlers.recovered?.();
    expect(status.textContent).toContain("The active turn failed");

    // Both streams down at once: the conversation stream coming back must not
    // retract the inventory stream's warning while it is still down.
    const inventory = inventoryHandlers[0]!;
    inventory.error(new ChatConnectionInterruptedError("Chat inventory connection interrupted; reconnecting"));
    handlers.error(new ChatConnectionInterruptedError("Chat connection interrupted; reconnecting"));
    handlers.recovered?.();
    expect(status.textContent).not.toContain("Chat connection interrupted; reconnecting");
    expect(status.textContent).toContain("Chat inventory connection interrupted; reconnecting");

    // The inventory stream's own recovery is what takes its message down.
    inventory.recovered?.();
    expect(status.textContent).toBe("");

    window.dispatchEvent(new Event("pagehide"));
  });
});

afterAll(() => {
  for (const [key, value] of savedGlobals) Reflect.set(globalThis, key, value);
});
}

function conversation(id: string) {
  return { id, title: id, createdAt: 1, updatedAt: 1, status: "idle" as const, agent: { id: "test", name: "Test" } };
}

// One brokered stream, driven by hand: hello and envelopes as the hub would
// write them.
class FakeLiveSource {
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: Event) => void) {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }
  close() { this.closed = true; }
  hello(streamId: string) { this.emit("hello", JSON.stringify({ streamId })); }
  live(envelope: LiveEnvelope) { this.emit("live", JSON.stringify(envelope)); }
  private emit(type: string, data: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, data } as unknown as Event);
  }
}

function snapshot(id: string): ConversationSnapshot {
  return { conversation: conversation(id), configuration: {}, generation: "g", cursor: `cursor-${id}`, items: [] };
}

async function waitUntil(predicate: () => boolean, describe = () => "Chat UI state"): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${describe()}`);
}

function installDomGlobals(document: Document, window: Window): void {
  const browserGlobal = window as unknown as Record<string, unknown>;
  const values: Record<string, unknown> = {
    document,
    window,
    history: window.history ?? { back() {}, forward() {}, pushState() {}, replaceState() {} },
    navigator: window.navigator ?? {},
    Event: browserGlobal.Event,
    CustomEvent: browserGlobal.CustomEvent,
    Element: browserGlobal.Element,
    HTMLElement: browserGlobal.HTMLElement,
    HTMLButtonElement: browserGlobal.HTMLButtonElement,
    HTMLDialogElement: browserGlobal.HTMLDialogElement,
    HTMLInputElement: browserGlobal.HTMLInputElement,
    HTMLTemplateElement: browserGlobal.HTMLTemplateElement,
    HTMLTextAreaElement: browserGlobal.HTMLTextAreaElement,
    Node: browserGlobal.Node,
    NodeFilter: browserGlobal.NodeFilter ?? { SHOW_TEXT: 4 },
    MutationObserver: browserGlobal.MutationObserver,
    customElements: browserGlobal.customElements,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    CSS: { escape: (value: string) => value.replaceAll('"', '\\"') },
  };
  for (const [key, value] of Object.entries(values)) {
    if (!savedGlobals.has(key)) savedGlobals.set(key, Reflect.get(globalThis, key));
    Reflect.set(globalThis, key, value);
  }
  const elementPrototype = (browserGlobal.HTMLElement as { prototype: object }).prototype;
  Object.defineProperty(elementPrototype, "scrollIntoView", { configurable: true, value() {} });
  Object.defineProperty(elementPrototype, "scrollTo", { configurable: true, value() {} });
}
