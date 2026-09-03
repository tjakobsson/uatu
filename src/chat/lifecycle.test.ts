import { afterAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

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
  test("a resumed page reconciles inventory and refreshes both streams without losing the draft or timeline", async () => {
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

    const api = {
      status: async () => ([{
        agent: { id: "test", name: "Test" },
        availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: [] } },
      }]),
      conversations: async () => {
        conversationCalls.push(Date.now());
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

    // The page freezes for the back/forward cache and comes back. The
    // teardown must not fire — this surface is the one being restored.
    window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: true }));
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));

    await waitUntil(() => conversationCalls.length > inventoryCallsBefore && streams.length === 2);

    // Inventory reconciled from the server, and both streams were replaced.
    expect(inventoryStreams).toHaveLength(2);
    expect(inventoryStreams[0]!.closed).toBe(true);
    expect(inventoryStreams[1]!.closed).toBe(false);
    expect(streams[0]!.closed).toBe(true);
    expect(streams[1]!.conversationId).toBe("one");
    // Resumed from the cursor the projection already held, so nothing already
    // received has to be refetched or reprojected.
    expect(streams[1]!.cursor).toBe("cursor-one");

    // Presentation state is untouched by transport recovery: the draft stands,
    // the timeline was neither refetched nor re-rendered. (Re-rendering is what
    // would move the reader's scroll position; this harness has no layout, so
    // the scroll itself is asserted in the browser suite.)
    expect(input.value).toBe("a draft the user is still writing");
    expect(snapshotCalls.length).toBe(snapshotCallsBefore);
    expect(document.querySelector("#chat-items")?.innerHTML ?? "").toBe(renderedBefore);

    // A regained network connection recovers the same way.
    const streamsAfterResume = streams.length;
    window.dispatchEvent(new Event("online"));
    await waitUntil(() => streams.length === streamsAfterResume + 1);
    expect(streams.at(-1)!.cursor).toBe("cursor-one");

    window.dispatchEvent(new Event("pagehide"));
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
