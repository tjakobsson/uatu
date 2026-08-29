import { afterAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import type { ChatApiClient } from "./client";
import type { ChatCommand, ConversationSnapshot, ReversibleHistoryResult } from "./types";

const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
const savedGlobals = new Map<string, unknown>();
const CHILD_PROCESS_FLAG = "UATU_CHAT_UI_TEST_CHILD";

if (process.env[CHILD_PROCESS_FLAG] !== "1") {
  describe("chat reversible-history composer", () => {
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
describe("chat reversible-history composer", () => {
  test("dispatches local history operations and keeps composer state private and recoverable", async () => {
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

    const undoResults: Array<Promise<ReversibleHistoryResult>> = [];
    const redoResults: Array<Promise<ReversibleHistoryResult>> = [];
    const commandResults: Array<() => Promise<ChatCommand[]>> = [async () => { throw new Error("inventory unavailable"); }];
    const snapshotResults: Array<() => Promise<ConversationSnapshot>> = [];
    const prompts: Array<{ conversationId: string; text: string; attachments?: unknown[] }> = [];
    const snapshotDrafts: string[] = [];
    const undoRequestIds: string[] = [];
    const streamFailures: Error[] = [];
    const uploadResults: Array<Promise<{ id: string; mimeType: string; sizeBytes: number }>> = [];
    const streams: Array<{
      conversationId: string;
      closed: boolean;
      resync(): void;
    }> = [];
    const localCommands: ChatCommand[] = [
      { name: "undo", description: "Undo", argumentHint: "", kind: "local-operation" },
      { name: "redo", description: "Redo", argumentHint: "", kind: "local-operation" },
    ];
    const api = {
      status: async () => ({
        state: "ready",
        version: "test",
        agent: { id: "test", name: "Test", capabilities: ["reversible-history", "attachments"] },
      }),
      conversations: async () => [conversation("one"), conversation("two")],
      commands: async () => await (commandResults.shift() ?? (async () => localCommands))(),
      snapshot: async (id: string) => {
        snapshotDrafts.push(document.querySelector<HTMLTextAreaElement>("#chat-input")?.value ?? "");
        return await (snapshotResults.shift() ?? (async () => snapshot(id)))();
      },
      stream: (conversationId: string, _cursor: string, handlers: Parameters<ChatApiClient["stream"]>[2]) => {
        const failure = streamFailures.shift();
        if (failure) throw failure;
        const entry = {
          conversationId,
          closed: false,
          resync() {
            entry.closed = true;
            handlers.resync();
          },
        };
        streams.push(entry);
        return { close() { entry.closed = true; } };
      },
      inventoryStream: () => ({ close() {} }),
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
      uploadAttachment: async () => await uploadResults.shift()!,
      undo: async (_conversationId: string, requestId: string) => {
        undoRequestIds.push(requestId);
        return await undoResults.shift()!;
      },
      redo: async () => await redoResults.shift()!,
      prompt: async (conversationId: string, _requestId: string, text: string, _model: unknown, _mode: unknown, _variant: unknown, attachments?: unknown[]) => {
        prompts.push({ conversationId, text, attachments });
        return { messageId: `message-${prompts.length}`, held: false, configuration: {} };
      },
    } as unknown as ChatApiClient;

    const revoked: string[] = [];
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = url => { revoked.push(url); originalRevoke(url); };
    try {
      const { initChat } = await import(`./ui.ts?reversible-history-ui-test=${Date.now()}`);
      initChat(api);
      const input = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
      const form = document.querySelector<HTMLFormElement>("#chat-composer")!;
      const select = conversationSelect;
      const attachInput = document.querySelector<HTMLInputElement>("#chat-attach-input")!;
      const live = document.querySelector<HTMLElement>("#chat-composer-status-live")!;
      await waitUntil(
        () => select.value === "one" && !form.hidden,
        () => document.querySelector("#chat-state")?.textContent ?? "no chat state",
      );

      uploadResults.push(Promise.resolve({ id: "existing", mimeType: "image/png", sizeBytes: 3 }));
      chooseFiles(attachInput, [new File(["old"], "existing.png", { type: "image/png" })]);
      await waitUntil(() => document.querySelector("#chat-attachments")?.textContent?.includes("existing.png") === true);

      type(input, "private passive draft");
      const passiveStream = streams.at(-1)!;
      const passiveSnapshotCalls = snapshotDrafts.length;
      snapshotResults.push(async () => { throw new Error("transient passive snapshot failure"); });
      passiveStream.resync();
      passiveStream.resync();
      await waitUntil(() => streams.at(-1) !== passiveStream && streams.at(-1)?.closed === false);
      expect(snapshotDrafts).toHaveLength(passiveSnapshotCalls + 2);
      expect(input.value).toBe("private passive draft");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");

      const streamRetrySource = streams.at(-1)!;
      const callsBeforePassiveStreamFailure = snapshotDrafts.length;
      streamFailures.push(new Error("transient passive stream failure"));
      streamRetrySource.resync();
      await waitUntil(() => streams.at(-1) !== streamRetrySource && streams.at(-1)?.closed === false);
      expect(snapshotDrafts).toHaveLength(callsBeforePassiveStreamFailure + 2);
      const callsAfterPassiveStreamRecovery = snapshotDrafts.length;
      await Bun.sleep(250);
      expect(snapshotDrafts).toHaveLength(callsAfterPassiveStreamRecovery);
      expect(input.value).toBe("private passive draft");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");

      const pendingPassiveSnapshot = deferred<ConversationSnapshot>();
      snapshotResults.push(async () => await pendingPassiveSnapshot.promise);
      const recoveredPassiveStream = streams.at(-1)!;
      const callsBeforeSelectionChange = snapshotDrafts.length;
      recoveredPassiveStream.resync();
      await waitUntil(() => snapshotDrafts.length === callsBeforeSelectionChange + 1);
      select.value = "two";
      select.dispatchEvent(new Event("change"));
      await waitUntil(() => streams.at(-1)?.conversationId === "two");
      const callsAfterSelectionChange = snapshotDrafts.length;
      pendingPassiveSnapshot.resolve(snapshot("one"));
      await Bun.sleep(150);
      expect(snapshotDrafts).toHaveLength(callsAfterSelectionChange);
      expect(streams.at(-1)?.conversationId).toBe("two");
      select.value = "one";
      select.dispatchEvent(new Event("change"));
      await waitUntil(() => streams.at(-1)?.conversationId === "one" && input.value === "private passive draft");

      commandResults.push(async () => { throw new Error("inventory still unavailable"); });
      submit(form, input, "/undo");
      await waitUntil(() => live.textContent?.includes("Chat commands could not be loaded") === true);
      expect(document.querySelector("#chat-composer-error")?.textContent).toContain("Submit /undo again to retry");
      expect(input.value).toBe("/undo");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");
      expect(prompts).toHaveLength(0);
      expect(undoRequestIds).toHaveLength(0);

      commandResults.push(async () => localCommands);
      const failedUndo = deferred<ReversibleHistoryResult>();
      undoResults.push(failedUndo.promise);
      submit(form, input, "/undo");
      await waitUntil(() => live.textContent === "Undoing...");
      streams.at(-1)!.resync();
      failedUndo.reject(new Error("provider unavailable"));
      await waitUntil(() => live.textContent?.includes("Undo failed") === true);
      expect(streams.at(-1)?.closed).toBe(false);
      expect(input.value).toBe("/undo");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");
      expect(prompts).toHaveLength(0);

      const noOpUndo = deferred<ReversibleHistoryResult>();
      undoResults.push(noOpUndo.promise);
      submit(form, input, "/undo");
      await waitUntil(() => live.textContent === "Undoing...");
      streams.at(-1)!.resync();
      noOpUndo.resolve({ outcome: "nothing-to-undo", state: { staged: false, canUndo: false, canRedo: false } });
      await waitUntil(() => live.textContent === "Nothing more to undo");
      expect(streams.at(-1)?.closed).toBe(false);
      expect(input.value).toBe("/undo");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");

      redoResults.push(Promise.resolve({ outcome: "nothing-to-redo", state: { staged: false, canUndo: true, canRedo: false } }));
      submit(form, input, "/redo");
      await waitUntil(() => live.textContent === "Nothing to redo");
      expect(input.value).toBe("/redo");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");

      const reloadFailure = deferred<ReversibleHistoryResult>();
      undoResults.push(reloadFailure.promise);
      snapshotResults.push(async () => { throw new Error("snapshot unavailable"); });
      submit(form, input, "/undo");
      await waitUntil(() => live.textContent === "Undoing...");
      streams.at(-1)!.resync();
      reloadFailure.resolve(changed("latest draft", [
        { id: "available", name: "available.png", mimeType: "image/png" },
        { name: "missing.png", mimeType: "image/png" },
      ]));
      await waitUntil(() => live.textContent?.includes("Submit /undo again to reconnect") === true);
      const undoCallsBeforeReloadRetry = undoRequestIds.length;
      expect(input.value).toBe("/undo");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");

      submit(form, input, "/undo");
      await waitUntil(() => input.value === "latest draft");
      expect(undoRequestIds).toHaveLength(undoCallsBeforeReloadRetry);
      expect(streams.at(-1)?.closed).toBe(false);
      expect(snapshotDrafts.at(-1)).toBe("/undo");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("available.png");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("missing.png");

      const slowUpload = deferred<{ id: string; mimeType: string; sizeBytes: number }>();
      uploadResults.push(slowUpload.promise);
      chooseFiles(attachInput, [new File(["slow"], "slow.png", { type: "image/png" })]);
      undoResults.push(Promise.resolve(changed("latest draft", [
        { id: "available", name: "available.png", mimeType: "image/png" },
        { name: "missing.png", mimeType: "image/png" },
      ])));
      streamFailures.push(new Error("stream unavailable"));
      submit(form, input, "/undo");
      await waitUntil(() => live.textContent?.includes("Submit /undo again to reconnect") === true);
      const undoCallsBeforeStreamRetry = undoRequestIds.length;
      expect(input.value).toBe("/undo");
      submit(form, input, "/undo");
      await waitUntil(() => input.value === "latest draft");
      expect(undoRequestIds).toHaveLength(undoCallsBeforeStreamRetry);
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("available.png");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("missing.png");
      expect(document.querySelector<HTMLImageElement>("#chat-attachments img")?.src).toContain("/api/chat/attachments/available");
      expect(live.textContent).toContain("unavailable and will not be sent");
      expect(revoked.some(url => url.startsWith("blob:"))).toBe(true);
      slowUpload.resolve({ id: "stale", mimeType: "image/png", sizeBytes: 4 });
      await Bun.sleep(0);
      expect(document.querySelector("#chat-attachments")?.textContent).not.toContain("slow.png");

      select.value = "two";
      select.dispatchEvent(new Event("change"));
      await waitUntil(() => select.value === "two" && streams.at(-1)?.conversationId === "two");
      type(input, "private second draft");
      select.value = "one";
      select.dispatchEvent(new Event("change"));
      await waitUntil(() => select.value === "one" && streams.at(-1)?.conversationId === "one" && input.value === "latest draft");

      const pendingUndo = deferred<ReversibleHistoryResult>();
      undoResults.push(pendingUndo.promise);
      submit(form, input, "/undo");
      select.value = "two";
      select.dispatchEvent(new Event("change"));
      await waitUntil(
        () => streams.at(-1)?.conversationId === "two" && input.value === "private second draft",
        () => `input=${JSON.stringify(input.value)} select=${select.value} live=${JSON.stringify(live.textContent)}`,
      );
      pendingUndo.resolve(changed("earlier draft", [{ id: "earlier", name: "earlier.png", mimeType: "image/png" }]));
      await Bun.sleep(0);
      expect(select.value).toBe("two");
      expect(input.value).toBe("private second draft");

      select.value = "one";
      select.dispatchEvent(new Event("change"));
      await waitUntil(() => streams.at(-1)?.conversationId === "one" && input.value === "earlier draft");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("earlier.png");

      redoResults.push(Promise.resolve(changed("redo draft", [{ id: "redo", name: "redo.png", mimeType: "image/png" }])));
      submit(form, input, "/redo");
      await waitUntil(() => input.value === "redo draft");
      type(input, "redo draft, edited");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitUntil(() => prompts.length === 1);
      expect(prompts).toEqual([{
        conversationId: "one",
        text: "redo draft, edited",
        attachments: [{ id: "redo", name: "redo.png", mimeType: "image/png" }],
      }]);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
      URL.revokeObjectURL = originalRevoke;
    }
  });
});

afterAll(() => {
  for (const [key, value] of savedGlobals) Reflect.set(globalThis, key, value);
});
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

function conversation(id: string) {
  return { id, title: id, createdAt: 1, updatedAt: 1, status: "idle" as const };
}

function snapshot(id: string): ConversationSnapshot {
  return { conversation: conversation(id), configuration: {}, generation: "g", cursor: `cursor-${id}`, items: [] };
}

function changed(text: string, attachments: Array<{ id?: string; name: string; mimeType: string }>): ReversibleHistoryResult {
  return {
    outcome: "changed",
    state: { staged: true, canUndo: true, canRedo: true },
    restoredDraft: { text, attachments },
  };
}

function chooseFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function type(input: HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function submit(form: HTMLFormElement, input: HTMLTextAreaElement, value: string): void {
  type(input, value);
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, describe = () => "Chat UI state"): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${describe()}`);
}
