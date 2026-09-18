import { afterAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import type { ChatApiClient } from "./client";
import { resetUsagePaneForTests } from "./usage-pane";
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
    const revertResults: Array<Promise<ReversibleHistoryResult>> = [];
    const restoreResults: Array<Promise<ReversibleHistoryResult>> = [];
    const commandResults: Array<() => Promise<ChatCommand[]>> = [async () => { throw new Error("inventory unavailable"); }];
    const snapshotResults: Array<() => Promise<ConversationSnapshot>> = [];
    const prompts: Array<{ conversationId: string; text: string; attachments?: unknown[] }> = [];
    const snapshotDrafts: string[] = [];
    const undoRequestIds: string[] = [];
    const targetedCalls: Array<{ operation: "revert" | "restore"; conversationId: string; messageId: string; requestId: string }> = [];
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
      status: async () => ([{
        agent: { id: "test", name: "Test" },
        availability: {
          state: "ready",
          version: "test",
          agent: { id: "test", name: "Test", capabilities: ["reversible-history", "attachments"] },
        },
      }]),
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
      revert: async (conversationId: string, messageId: string, requestId: string) => {
        targetedCalls.push({ operation: "revert", conversationId, messageId, requestId });
        return await revertResults.shift()!;
      },
      restore: async (conversationId: string, messageId: string, requestId: string) => {
        targetedCalls.push({ operation: "restore", conversationId, messageId, requestId });
        return await restoreResults.shift()!;
      },
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

      const visibleTurns = historySnapshot("one", false);
      snapshotResults.push(async () => visibleTurns);
      streams.at(-1)!.resync();
      await waitUntil(() => document.querySelectorAll("[data-history-revert]").length === 2);
      const revertedState = {
        staged: true,
        canUndo: true,
        canRedo: true,
        revertedMessages: [{ id: "message:second", text: "second prompt" }],
      };
      const reverted = deferred<ReversibleHistoryResult>();
      revertResults.push(reverted.promise);
      snapshotResults.push(async () => historySnapshot("one", true));
      document.querySelector<HTMLButtonElement>('[data-history-revert="message:second"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-history-revert="message:first"]')!.click();
      expect(targetedCalls).toHaveLength(1);
      reverted.resolve({
        outcome: "changed",
        state: revertedState,
        restoredDraft: { text: "second prompt" },
      });
      await waitUntil(() => input.value === "second prompt" && document.querySelector("[data-history-restore]") !== null);
      expect(targetedCalls[0]).toEqual(expect.objectContaining({
        operation: "revert",
        conversationId: "one",
        messageId: "message:second",
      }));
      expect(document.querySelector("#chat-reverted")?.hasAttribute("hidden")).toBe(false);
      expect(document.querySelector("#chat-reverted-items")?.textContent).toContain("second prompt");

      const restored = deferred<ReversibleHistoryResult>();
      restoreResults.push(restored.promise);
      snapshotResults.push(async () => visibleTurns);
      document.querySelector<HTMLButtonElement>('[data-history-restore="message:second"]')!.click();
      await waitUntil(() => live.textContent === "Restoring...");
      restored.resolve({
        outcome: "changed",
        state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
      });
      await waitUntil(() => input.value === "" && document.querySelector("#chat-reverted")?.hasAttribute("hidden") === true);
      expect(targetedCalls[1]).toEqual(expect.objectContaining({
        operation: "restore",
        conversationId: "one",
        messageId: "message:second",
      }));

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
      noOpUndo.resolve({ outcome: "nothing-to-undo", state: { staged: false, canUndo: false, canRedo: false, revertedMessages: [] } });
      await waitUntil(() => live.textContent === "Nothing more to undo");
      expect(streams.at(-1)?.closed).toBe(false);
      expect(input.value).toBe("/undo");
      expect(document.querySelector("#chat-attachments")?.textContent).toContain("existing.png");

      redoResults.push(Promise.resolve({ outcome: "nothing-to-redo", state: { staged: false, canUndo: true, canRedo: false, revertedMessages: [] } }));
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
      expect(eventSourceConstructions).toBe(0);
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

describe("chat permission confirmation", () => {
  test("Allow always asks first; only Confirm replies, Cancel and Escape reply nothing", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    let selectedConversation = "";
    Object.defineProperty(select, "value", {
      configurable: true,
      get: () => selectedConversation,
      set: value => { selectedConversation = String(value); },
    });
    const permissionCalls: Array<{ conversationId: string; requestId: string; outcome: string }> = [];
    const pending = {
      id: "permission:p1", type: "permission" as const, createdAt: 2, requestId: "p1",
      action: "bash", resources: ["git status --short"], alwaysPatterns: ["git status *"], status: "pending" as const,
    };
    const api = {
      status: async () => ([{
        agent: { id: "test", name: "Test" },
        availability: {
          state: "ready",
          version: "test",
          agent: { id: "test", name: "Test", capabilities: ["permissions"], permissionScopeNote: "“Allow always” lasts until the test ends." },
        },
      }]),
      conversations: async () => [conversation("one")],
      commands: async () => [],
      snapshot: async (id: string) => ({ ...snapshot(id), items: [{ id: "message:u", type: "user_message", createdAt: 1, text: "status?" }, pending] }),
      stream: () => ({ close() {} }),
      inventoryStream: () => ({ close() {} }),
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
      permission: async (conversationId: string, requestId: string, _clientRequestId: string, outcome: string) => {
        permissionCalls.push({ conversationId, requestId, outcome });
        return { outcome };
      },
    } as unknown as ChatApiClient;

    try {
      const { initChat } = await import(`./ui.ts?permission-confirmation-ui-test=${Date.now()}`);
      initChat(api);
      const card = () => document.querySelector<HTMLElement>('[data-chat-item-id="permission:p1"]');
      const always = () => card()?.querySelector<HTMLButtonElement>('[data-permission-outcome="approved-session"]') ?? null;
      const stageOf = () => card()?.querySelector<HTMLElement>("[data-permission-confirming]") ?? null;
      const click = (element: Element | null) => { element!.dispatchEvent(new Event("click", { bubbles: true })); };
      await waitUntil(() => always() !== null, () => document.querySelector("#chat-state")?.textContent ?? "no card");

      // Allow always opens the stage and sends nothing.
      click(always());
      await waitUntil(() => stageOf() !== null);
      expect(permissionCalls).toEqual([]);
      expect(always()).toBeNull();
      expect([...stageOf()!.querySelectorAll(".chat-request-always code")].map(code => code.textContent)).toEqual(["git status *"]);
      expect(stageOf()!.textContent).toContain("until the test ends");

      // Cancel returns to the pending choices, still without a reply.
      click(stageOf()!.querySelector("[data-permission-cancel]"));
      await waitUntil(() => stageOf() === null && always() !== null);
      expect(permissionCalls).toEqual([]);

      // Escape inside the stage is Cancel.
      click(always());
      await waitUntil(() => stageOf() !== null);
      stageOf()!.querySelector("[data-permission-cancel]")!.dispatchEvent(Object.assign(new Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" }));
      await waitUntil(() => stageOf() === null && always() !== null);
      expect(permissionCalls).toEqual([]);

      // Confirm sends the persistent reply, exactly once.
      click(always());
      await waitUntil(() => stageOf() !== null);
      click(stageOf()!.querySelector("[data-permission-confirm]"));
      await waitUntil(() => permissionCalls.length === 1);
      await Bun.sleep(5);
      expect(permissionCalls).toEqual([{ conversationId: "one", requestId: "p1", outcome: "approved-session" }]);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

describe("chat cost receipt", () => {
  test("itemizes three ways, remembers the choice across conversations and a reload, and leaves an agent's own totals alone", async () => {
    // One storage across two boots: the second boot is the reload.
    const stored = new Map<string, string>();
    const storage = {
      get length() { return stored.size; },
      clear() { stored.clear(); },
      getItem: (key: string) => stored.get(key) ?? null,
      key: (index: number) => [...stored.keys()][index] ?? null,
      removeItem: (key: string) => { stored.delete(key); },
      setItem: (key: string, value: string) => { stored.set(key, String(value)); },
    };
    const Q = { providerId: "berget", modelId: "qwen" };
    const carrier = (id: string, costUsd: number, agent: string) => ({ id: `usage:${id}`, type: "assistant_message" as const, createdAt: 1, markdown: "", usage: { input: 1_000, output: 10, costUsd }, model: Q, agent });
    const task = (id: string, description: string, kind: string, conversationId: string, costUsd: number, descendants?: unknown[]) => ({
      id, type: "tool" as const, createdAt: 2, name: "task", status: "completed" as const, input: JSON.stringify({ description, subagent_type: kind }),
      childConversationId: conversationId, model: "qwen", usage: { input: 500, output: 5, costUsd }, ...(descendants ? { descendants } : {}),
    });
    const itemsOf: Record<string, unknown[]> = {
      one: [
        { id: "message:u", type: "user_message", createdAt: 0, text: "review the docs" },
        carrier("b", 0.5, "build"),
        task("tool:a", "Summarise README", "general", "ses_a", 0.2),
        task("tool:c", "Audit docs", "general", "ses_c", 0.1, [{ id: "tool:g", parentId: "tool:c", description: "Find files", subagent: "explore", conversationId: "ses_g", model: "qwen", usage: { input: 100, output: 1, costUsd: 0.05 } }]),
        task("tool:a2", "Shorten summary", "general", "ses_a", 0.15),
      ],
      two: [{ id: "message:u", type: "user_message", createdAt: 0, text: "hi" }, carrier("p", 2, "plan")],
      // An agent that tallies the session itself: totals on its report, per model, no receipt.
      tallied: [
        { id: "message:u", type: "user_message", createdAt: 0, text: "hi" },
        { id: "report", type: "context_report", createdAt: 3, total: 10, session: { costUsd: 9, apiDurationMs: 0, durationMs: 0, linesAdded: 0, linesRemoved: 0, models: [
          { id: "opus", input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, costUsd: 9 }, { id: "haiku", input: 10, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
        ] } },
      ],
    };
    const boot = async (tag: string) => {
      const { document, window } = parseHTML(html);
      installDomGlobals(document, window);
      Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
      document.documentElement.setAttribute("data-ui-mode", "desktop");
      document.documentElement.setAttribute("data-chat-panel", "open");
      const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
      let selected = "";
      Object.defineProperty(select, "value", { configurable: true, get: () => selected, set: value => { selected = String(value); } });
      const api = {
        status: async () => ([{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["context", "subagents"] } } }]),
        conversations: async () => [conversation("one"), conversation("two"), conversation("tallied")],
        commands: async () => [],
        snapshot: async (id: string) => ({ ...snapshot(id), items: itemsOf[id] ?? [] }),
        stream: () => ({ close() {} }),
        inventoryStream: () => ({ close() {} }),
        attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
      } as unknown as ChatApiClient;
      const { initChat } = await import(`./ui.ts?receipt-ui-test-${tag}=${Date.now()}`);
      initChat(api);
      const open = async (id: string, cost: string) => {
        if (selected !== id) { select.value = id; select.dispatchEvent(new Event("change", { bubbles: true })); }
        await waitUntil(() => document.querySelector("#chat-plan-session-cost")?.textContent === cost, () => `cost ${document.querySelector("#chat-plan-session-cost")?.textContent} for ${id}`);
      };
      const views = document.querySelector<HTMLElement>("#chat-plan-session-views")!;
      return {
        document, window, open, views,
        heading: () => document.querySelector("#chat-plan-session-heading")!.textContent,
        rows: () => [...document.querySelectorAll("#chat-plan-session-models tr")].map(row => [row.querySelector("td")!.firstChild!.textContent === null ? "" : row.querySelector("td")!.textContent, row.querySelector("td:last-child")!.textContent]),
        total: () => document.querySelector<HTMLElement>("#chat-plan-session-total")!,
        checked: () => [...views.querySelectorAll<HTMLElement>("[data-receipt-view]")].filter(button => button.getAttribute("aria-checked") === "true").map(button => button.dataset.receiptView),
        choose: (view: string) => views.querySelector(`[data-receipt-view="${view}"]`)!.dispatchEvent(new Event("click", { bubbles: true })),
      };
    };

    const first = await boot("first");
    try {
      await first.open("one", "$1.00");
      // By agent, to begin with: the named main agent, a line per task each
      // with its own cost, the nested subagent under its launcher.
      expect(first.heading()).toBe("Agent");
      expect(first.views.hidden).toBe(false);
      expect(first.checked()).toEqual(["agents"]);
      expect(first.rows()).toEqual([
        ["buildqwen · main agent", "$0.50"],
        ["general · Summarise READMEqwen", "$0.20"],
        ["general · Audit docsqwen", "$0.10"],
        ["explore · Find filesqwen", "$0.05"],
        ["general · Shorten summaryqwen · same agent as “Summarise README”", "$0.15"],
      ]);
      expect(first.total().hidden).toBe(false);
      expect(first.total().textContent).toContain("Total");
      expect(first.total().querySelector("td:last-child")!.textContent).toBe("$1.00");

      // By type: two generals (one given two tasks) and one explore.
      first.choose("types");
      expect(first.heading()).toBe("Type");
      expect(first.checked()).toEqual(["types"]);
      expect(first.rows()).toEqual([["buildqwen · main agent", "$0.50"], ["2 × generalqwen · 3 tasks", "$0.45"], ["1 × exploreqwen", "$0.05"]]);
      // The arrow keys move the choice, as a radiogroup's do.
      first.views.dispatchEvent(Object.assign(new Event("keydown", { bubbles: true, cancelable: true }), { key: "ArrowRight" }));
      expect(first.heading()).toBe("Model");
      expect(first.rows()).toEqual([["qwenbuild · 2 × general · explore", "$1.00"]]);
      expect(first.total().querySelector("td:last-child")!.textContent).toBe("$1.00");

      // The choice is the reader's, not the conversation's.
      await first.open("two", "$2.00");
      expect(first.heading()).toBe("Model");
      expect(first.checked()).toEqual(["models"]);

      // An agent that tallies the session itself reports per model only:
      // nothing to switch between, no total line, its rows as reported.
      await first.open("tallied", "$9.00");
      expect(first.views.hidden).toBe(true);
      expect(first.total().hidden).toBe(true);
      expect(first.heading()).toBe("Model");
      expect(first.rows()).toEqual([["opus", "$9.00"], ["haiku", "$0.00"]]);
      // Back on an itemizable conversation the control returns, still on the reader's choice.
      await first.open("one", "$1.00");
      expect(first.views.hidden).toBe(false);
      expect(first.checked()).toEqual(["models"]);
      first.choose("types");
      expect(first.checked()).toEqual(["types"]);
    } finally {
      await Bun.sleep(20);
      first.window.dispatchEvent(new Event("pagehide"));
    }

    // Reload: a fresh page over the same storage opens on the remembered choice.
    const second = await boot("second");
    try {
      await second.open("one", "$1.00");
      expect(second.checked()).toEqual(["types"]);
      expect(second.heading()).toBe("Type");
    } finally {
      await Bun.sleep(20);
      second.window.dispatchEvent(new Event("pagehide"));
    }
  });
});

describe("plan usage on demand", () => {
  const boot = async (tag: string, capabilities: string[]) => {
    // One usage-pane module serves every boot in this process: its held
    // report and read handler must not leak from one test into the next.
    resetUsagePaneForTests();
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    let selected = "";
    Object.defineProperty(select, "value", { configurable: true, get: () => selected, set: value => { selected = String(value); } });
    const reads: string[] = [];
    let usageAsks = 0;
    const stored = { plan: { subscription: "pro", fiveHour: { utilization: 9 }, sevenDay: { utilization: 25 } }, readAt: Date.now() - 12 * 60_000, conversationId: "elsewhere" };
    const itemsOf: Record<string, unknown[]> = {
      standing: [
        { id: "message:u", type: "user_message", createdAt: 0, text: "hi" },
        { id: "notice:limit", type: "notice", createdAt: 1, level: "warning", message: "Approaching the 5-hour limit", code: "rate-limit-warning" },
      ],
    };
    const api = {
      status: async () => ([{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities } } }]),
      conversations: async () => [conversation("standing")],
      commands: async () => [],
      usage: async () => { usageAsks += 1; return stored; },
      readUsage: async (_agentId: string, _requestId: string, mode: string) => { reads.push(mode); return { report: { plan: { ...stored.plan, fiveHour: { utilization: 14 } }, readAt: Date.now() } }; },
      snapshot: async (id: string) => ({ ...snapshot(id), items: itemsOf[id] ?? [] }),
      stream: () => ({ close() {} }),
      inventoryStream: () => ({ close() {} }),
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
    } as unknown as ChatApiClient;
    const { initChat } = await import(`./ui.ts?usage-ui-test-${tag}=${Date.now()}`);
    initChat(api);
    select.value = "standing";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { document, window, reads, usageAsks: () => usageAsks };
  };

  test("a conversation with only a standing shows it beside the workspace's last-known plan, refreshes it when opened, and reads on demand", async () => {
    const { document, window, reads } = await boot("with", ["context", "usage"]);
    try {
      const summary = document.querySelector<HTMLElement>("#chat-plan-usage-summary")!;
      await waitUntil(() => summary.textContent === "Session 9% · Week 25%", () => `summary ${summary.textContent}`);
      const details = document.querySelector<HTMLElement>("#chat-plan-usage")!;
      expect(details.dataset.level).toBe("warning");
      expect(details.dataset.stale).toBe("true");
      expect(document.querySelector<HTMLElement>("#chat-plan-readout-standing")!.hidden).toBe(false);
      expect(document.querySelector("#chat-plan-readout-standing")?.textContent).toContain("Approaching the 5-hour limit");
      expect(document.querySelector<HTMLElement>("#chat-plan-readout-head")!.hidden).toBe(false);
      expect(document.querySelector("#chat-plan-readout-name")?.textContent).toBe("Pro plan");
      expect(document.querySelector("#chat-plan-readout-age")?.textContent).toMatch(/· 12 min ago$/);
      expect([...document.querySelectorAll("#chat-plan-readout-rows .plan-row-label")].map(node => node.textContent)).toEqual(["Session", "Week"]);
      const read = document.querySelector<HTMLButtonElement>("#chat-plan-read")!;
      expect(read.hidden).toBe(false);
      // Opening the stale readout refreshes through a live session, unasked.
      details.setAttribute("open", "");
      Object.defineProperty(details, "open", { configurable: true, value: true });
      details.dispatchEvent(new window.Event("toggle"));
      await waitUntil(() => reads.length === 1, () => `reads ${reads.join(",")}`);
      expect(reads).toEqual(["live-only"]);
      await waitUntil(() => summary.textContent === "Session 14% · Week 25%", () => `summary ${summary.textContent}`);
      expect(details.dataset.stale).toBeUndefined();
      // The button reads now, starting a session if it must.
      read.dispatchEvent(new window.Event("click", { bubbles: true }));
      await waitUntil(() => reads.length === 2, () => `reads ${reads.join(",")}`);
      expect(reads[1]).toBe("start");
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("an agent idle at load is asked once the inventory has started it; a failed ask is retried and a 409 is final", async () => {
    resetUsagePaneForTests();
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    let selected = "";
    Object.defineProperty(select, "value", { configurable: true, get: () => selected, set: value => { selected = String(value); } });
    const asks: string[] = [];
    let failFirst = true;
    let statusCalls = 0;
    const { ChatTransportError } = await import("./client");
    const claude = { id: "claude", name: "Claude Code" };
    const api = {
      // Idle at first: nothing declared yet, as on a fresh workspace process.
      // The poll for a selected not-ready agent then finds it ready.
      status: async () => {
        statusCalls += 1;
        return [
          { agent: claude, availability: statusCalls === 1 ? { state: "idle" } : { state: "ready", version: "test", agent: { ...claude, capabilities: ["context", "usage"] } } },
          { agent: { id: "opencode", name: "OpenCode" }, availability: { state: "idle" } },
        ];
      },
      conversations: async () => [{ id: "claude:c", title: "c", createdAt: 1, updatedAt: 1, status: "idle", agent: claude }],
      commands: async () => [],
      usage: async (agentId: string) => {
        asks.push(agentId);
        if (agentId === "opencode") throw new ChatTransportError("this agent does not report plan usage", 409);
        if (failFirst) { failFirst = false; throw new ChatTransportError("Chat request failed (502)", 502); }
        return { plan: { subscription: "pro", fiveHour: { utilization: 9 }, sevenDay: { utilization: 25 } }, readAt: Date.now() };
      },
      readUsage: async () => ({ report: null, reason: "no-live-session" }),
      snapshot: async (id: string) => ({ ...snapshot(id), conversation: { id, title: "c", createdAt: 1, updatedAt: 1, status: "idle", agent: claude } }),
      stream: () => ({ close() {} }),
      inventoryStream: () => ({ close() {} }),
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
    } as unknown as ChatApiClient;
    const { initChat } = await import(`./ui.ts?usage-ui-test-idle=${Date.now()}`);
    initChat(api);
    try {
      // Both idle agents are asked after the inventory read; OpenCode's 409 is final, Claude's 502 is not.
      await waitUntil(() => asks.length === 2, () => `asks ${asks.join(",")}`);
      expect([...asks].sort()).toEqual(["claude", "opencode"]);
      expect(document.querySelector("#usage-pane .pane-empty")?.textContent).toBe("No usage read yet.");
      // Selecting a conversation under the not-yet-ready agent polls its
      // status; once it reports ready and declaring usage, Claude is asked
      // again — OpenCode, having said 409, is not.
      select.value = "claude:c";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Bun.sleep(1_700);
      await waitUntil(() => asks.length === 3, () => `asks ${asks.join(",")}`);
      expect(asks.filter(id => id === "opencode")).toHaveLength(1);
      await waitUntil(() => document.querySelector("#usage-pane .usage-pane-head")?.textContent?.startsWith("Pro plan") === true, () => `pane ${document.querySelector("#usage-pane")?.textContent}`);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("an agent that does not report plan usage gets no read control and is never asked", async () => {
    const { document, window, reads, usageAsks } = await boot("without", ["context"]);
    try {
      const summary = document.querySelector<HTMLElement>("#chat-plan-usage-summary")!;
      await waitUntil(() => summary.textContent === "Near rate limit", () => `summary ${summary.textContent}`);
      expect(document.querySelector<HTMLElement>("#chat-plan-readout-head")!.hidden).toBe(true);
      expect(document.querySelector<HTMLButtonElement>("#chat-plan-read")!.hidden).toBe(true);
      expect(usageAsks()).toBe(0);
      expect(reads).toEqual([]);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

afterAll(() => {
  for (const [key, value] of savedGlobals) Reflect.set(globalThis, key, value);
});
}

// The chat surface owns no connection: every EventSource the page holds is
// the shell's one live channel. Any construction from chat code is a
// regression, whatever the fake api above does.
let eventSourceConstructions = 0;

function installDomGlobals(document: Document, window: Window): void {
  const browserGlobal = window as unknown as Record<string, unknown>;
  const values: Record<string, unknown> = {
    document,
    window,
    EventSource: class { constructor() { eventSourceConstructions += 1; } addEventListener() {} close() {} },
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
  return { id, title: id, createdAt: 1, updatedAt: 1, status: "idle" as const, agent: { id: "test", name: "Test" } };
}

function snapshot(id: string): ConversationSnapshot {
  return { conversation: conversation(id), configuration: {}, generation: "g", cursor: `cursor-${id}`, items: [] };
}

function historySnapshot(id: string, reverted: boolean): ConversationSnapshot {
  const first = { id: "message:first", type: "user_message" as const, createdAt: 1, text: "first prompt" };
  const response = { id: "message:response", type: "assistant_message" as const, createdAt: 2, markdown: "response" };
  const second = { id: "message:second", type: "user_message" as const, createdAt: 3, text: "second prompt" };
  return {
    conversation: conversation(id),
    configuration: {},
    generation: "g",
    cursor: `cursor-${id}`,
    items: reverted ? [first, response] : [first, response, second],
    reversibleHistory: reverted
      ? { staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: second.id, text: second.text }] }
      : { staged: false, canUndo: true, canRedo: false, revertedMessages: [] },
  };
}

function changed(text: string, attachments: Array<{ id?: string; name: string; mimeType: string }>): ReversibleHistoryResult {
  return {
    outcome: "changed",
    state: { staged: true, canUndo: true, canRedo: true, revertedMessages: [{ id: "message:restored", text }] },
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
