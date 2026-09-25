import { afterAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import type { ChatApiClient } from "./client";
import type { RevealOptions } from "./coordinated-scroll";
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

describe("chat scheduled wakeups", () => {
  test("the composer lists pending wakeups and Release calls the control once, then the state clears", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const fireAt = new Date(2026, 8, 24, 20, 3).getTime();
    const oneShot = { id: "wakeup:w1", type: "scheduled_wakeup" as const, createdAt: 2, wakeupId: "w1", prompt: "check the build", recurring: false, schedule: "3 20 * * *", nextFireAt: fireAt, status: "pending" as const };
    const recurring = { id: "wakeup:c1", type: "scheduled_wakeup" as const, createdAt: 3, wakeupId: "c1", prompt: "poll the queue", recurring: true, schedule: "*/5 * * * *", nextFireAt: fireAt + 60_000, status: "pending" as const };
    const releases: Array<{ conversationId: string; requestId: string }> = [];
    const released = deferred<unknown>();
    let emit: ((event: unknown) => void) | undefined;
    const api = {
      status: async () => ([{
        agent: { id: "test", name: "Test" },
        availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["scheduled-wakeups"] } },
      }]),
      conversations: async () => [{ ...conversation("one"), status: "scheduled" }],
      commands: async () => [],
      snapshot: async (id: string) => ({ ...snapshot(id), conversation: { ...conversation(id), status: "scheduled" }, items: [{ id: "message:u", type: "user_message", createdAt: 1, text: "wake me later" }, oneShot, recurring] }),
      stream: (_id: string, _cursor: string, handlers: { event(event: unknown, cursor: string): void }) => {
        emit = event => handlers.event(event, "cursor-next");
        return { close() {} };
      },
      inventoryStream: () => ({ close() {} }),
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
      release: async (conversationId: string, requestId: string) => {
        releases.push({ conversationId, requestId });
        return released.promise;
      },
    } as unknown as ChatApiClient;

    try {
      const { initChat } = await import(`./ui.ts?scheduled-wakeups-ui-test=${Date.now()}`);
      initChat(api);
      const panel = () => document.querySelector<HTMLElement>("#chat-scheduled-wakeups")!;
      const button = () => document.querySelector<HTMLButtonElement>("#chat-wakeups-release")!;
      await waitUntil(() => !panel().hidden, () => document.querySelector("#chat-state")?.textContent ?? "no panel");
      const time = new Date(fireAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      expect(document.querySelector("#chat-scheduled-wakeups-label")?.textContent).toBe(`2 wakeups scheduled · next about ${time}`);
      const rows = [...document.querySelectorAll("#chat-scheduled-wakeups-items li")];
      expect(rows.map(row => row.querySelector(".chat-wakeup-prompt")?.textContent)).toEqual(["check the build", "poll the queue"]);
      expect(rows.map(row => row.querySelector(".chat-wakeup-recurring")?.textContent ?? null)).toEqual([null, "Repeats"]);
      expect(rows[0]!.querySelector(".chat-wakeup-when")?.textContent).toBe(`about ${time}`);
      expect(document.querySelector("#chat-wakeups-release-note")?.textContent).toBe("Releasing cancels every wakeup and ends the agent's session.");
      // Each wakeup has its own Cancel.
      expect(rows.map(row => row.querySelector("[data-cancel-wakeup]")?.getAttribute("data-cancel-wakeup"))).toEqual(["w1", "c1"]);
      expect(document.querySelector(".chat-composer-status")?.getAttribute("data-state")).toBe("scheduled");
      // Pending rows are in the timeline too.
      expect(document.querySelector('#chat-timeline [data-chat-item-id="wakeup:w1"]')?.className).toContain("is-pending");

      button().dispatchEvent(new Event("click", { bubbles: true }));
      await waitUntil(() => releases.length === 1);
      expect(releases[0]!.conversationId).toBe("one");
      // Inert until the agent answers: a second press sends nothing.
      expect(button().disabled).toBe(true);
      expect(button().textContent).toBe("Releasing…");
      button().dispatchEvent(new Event("click", { bubbles: true }));
      await Bun.sleep(5);
      expect(releases).toHaveLength(1);

      // The agent reports the wakeups cancelled and the conversation idle.
      let sequence = 1;
      const frame = (body: Record<string, unknown>) => emit!({ generation: "g", sequence: sequence++, conversationId: "one", ...body });
      frame({ type: "item.upsert", item: { ...oneShot, nextFireAt: undefined, status: "cancelled" } });
      frame({ type: "item.upsert", item: { ...recurring, nextFireAt: undefined, status: "cancelled" } });
      frame({ type: "conversation.status", status: "idle" });
      released.resolve({ released: true });
      await waitUntil(() => panel().hidden === true, () => `panel still shown: ${document.querySelector("#chat-scheduled-wakeups-label")?.textContent}`);
      expect(document.querySelector(".chat-composer-status")?.getAttribute("data-state")).toBe("ready");
      expect(document.querySelector('#chat-timeline [data-chat-item-id="wakeup:w1"] .chat-wakeup-label')?.textContent).toBe("Wakeup cancelled");
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

describe("chat paused crons", () => {
  test("a reopened conversation lists its paused cron with a Cancel and no release; Cancel calls the control once", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const paused = { id: "wakeup:c1", type: "scheduled_wakeup" as const, createdAt: 2, wakeupId: "c1", prompt: "poll the queue", recurring: true, schedule: "*/5 * * * *", status: "paused" as const, message: "Paused: the agent's session ended." };
    const cancels: Array<{ conversationId: string; wakeupId: string }> = [];
    const cancelled = deferred<unknown>();
    let emit: ((event: unknown) => void) | undefined;
    const api = {
      status: async () => ([{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["scheduled-wakeups"] } } }]),
      conversations: async () => [conversation("one")],
      commands: async () => [],
      snapshot: async (id: string) => ({ ...snapshot(id), items: [{ id: "message:u", type: "user_message", createdAt: 1, text: "poll every five minutes" }, paused] }),
      stream: (_id: string, _cursor: string, handlers: { event(event: unknown, cursor: string): void }) => {
        emit = event => handlers.event(event, "cursor-next");
        return { close() {} };
      },
      inventoryStream: () => ({ close() {} }),
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
      cancelWakeup: async (conversationId: string, wakeupId: string) => { cancels.push({ conversationId, wakeupId }); return cancelled.promise; },
    } as unknown as ChatApiClient;
    try {
      const { initChat } = await import(`./ui.ts?paused-crons-ui-test=${Date.now()}`);
      initChat(api);
      const panel = () => document.querySelector<HTMLElement>("#chat-scheduled-wakeups")!;
      await waitUntil(() => !panel().hidden, () => document.querySelector("#chat-state")?.textContent ?? "no panel");
      expect(document.querySelector("#chat-scheduled-wakeups-label")?.textContent).toBe("1 schedule paused · fires again when this conversation runs");
      expect(document.querySelector("#chat-scheduled-wakeups-items li")?.className).toBe("is-paused");
      expect(document.querySelector("#chat-scheduled-wakeups-items .chat-wakeup-when")?.textContent).toBe("Paused");
      // No session to release: only the per-row Cancel.
      expect(document.querySelector<HTMLElement>(".chat-wakeups-release")?.hidden).toBe(true);
      expect(document.querySelector(".chat-composer-status")?.getAttribute("data-state")).toBe("ready");
      const cancel = () => document.querySelector<HTMLButtonElement>('[data-cancel-wakeup="c1"]')!;
      cancel().dispatchEvent(new Event("click", { bubbles: true }));
      await waitUntil(() => cancels.length === 1);
      expect(cancels[0]).toEqual({ conversationId: "one", wakeupId: "c1" });
      expect(cancel().disabled).toBe(true);
      cancel().dispatchEvent(new Event("click", { bubbles: true }));
      await Bun.sleep(5);
      expect(cancels).toHaveLength(1);
      const { message: _message, ...row } = paused;
      emit!({ generation: "g", sequence: 1, conversationId: "one", type: "item.upsert", item: { ...row, status: "cancelled" } });
      cancelled.resolve({ cancelled: true });
      await waitUntil(() => panel().hidden === true, () => "panel still shown");
      expect(document.querySelector('#chat-timeline [data-chat-item-id="wakeup:c1"] .chat-wakeup-label')?.textContent).toBe("Recurring wakeup cancelled");
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
    // The sidebar (not booted here) hides the Usage pane by default.
    document.querySelector<HTMLElement>('[data-pane-id="usage"]')!.hidden = true;
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
      // A report of its own, older than the workspace's last-known one.
      older: [
        { id: "message:u", type: "user_message", createdAt: 0, text: "hi" },
        { id: "context:report:1", type: "context_report", createdAt: Date.now() - 30 * 60_000, total: 10, plan: { subscription: "pro", fiveHour: { utilization: 3 }, sevenDay: { utilization: 25 } } },
      ],
    };
    const api = {
      status: async () => ([{ agent: { id: "test", name: "Test" }, availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities } } }]),
      conversations: async () => [conversation("standing"), conversation("older")],
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
    return { document, window, select, reads, usageAsks: () => usageAsks };
  };

  test("a conversation's own older report yields to a newer workspace one, so a read answered through another session still lands here", async () => {
    const { document, window, select, reads } = await boot("older", ["context", "usage"]);
    try {
      const summary = document.querySelector<HTMLElement>("#chat-plan-usage-summary")!;
      select.value = "older";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      // The workspace's 12-minute-old report is newer than this conversation's own 30-minute-old one.
      await waitUntil(() => summary.textContent === "Session 9% · Week 25%", () => `summary ${summary.textContent}`);
      document.querySelector<HTMLButtonElement>("#chat-plan-read")!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await waitUntil(() => reads.length === 1, () => `reads ${reads.join(",")}`);
      // The read went through "elsewhere"; the conversation that asked still shows its answer.
      await waitUntil(() => summary.textContent === "Session 14% · Week 25%", () => `summary ${summary.textContent}`);
      expect(document.querySelector("#chat-plan-readout-age")?.textContent).toMatch(/· just now$/);
    } finally {
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

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
    document.querySelector<HTMLElement>('[data-pane-id="usage"]')!.hidden = true;
    const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    let selected = "";
    Object.defineProperty(select, "value", { configurable: true, get: () => selected, set: value => { selected = String(value); } });
    const asks: string[] = [];
    const readAgents: string[] = [];
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
      models: async () => [],
      modes: async () => [],
      commands: async () => [],
      usage: async (agentId: string) => {
        asks.push(agentId);
        if (agentId === "opencode") throw new ChatTransportError("this agent does not report plan usage", 409);
        if (failFirst) { failFirst = false; throw new ChatTransportError("Chat request failed (502)", 502); }
        return { plan: { subscription: "pro", fiveHour: { utilization: 9 }, sevenDay: { utilization: 25 } }, readAt: Date.now() };
      },
      readUsage: async (agentId: string) => { readAgents.push(agentId); return { report: null, reason: "no-live-session" }; },
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
      // The reads go to the agent that answered with a report.
      document.querySelector<HTMLButtonElement>('[data-pane-id="usage"] .pane-action[data-usage-read]')!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await waitUntil(() => readAgents.length === 1, () => `reads ${readAgents.join(",")}`);
      expect(readAgents).toEqual(["claude"]);
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

describe("chat question anchoring", () => {
  test("revealing a free-form answer hands its timeline's anchor to the question card", async () => {
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
    const pending = {
      id: "question:q1", type: "question" as const, createdAt: 2, requestId: "q1", status: "pending" as const,
      questions: [{
        prompt: "Which branch?", header: "Branch", multiple: false, allowFreeForm: true,
        options: [{ label: "main", description: "" }],
      }],
    };
    const api = {
      status: async () => ([{
        agent: { id: "test", name: "Test" },
        availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: ["questions"] } },
      }]),
      conversations: async () => [conversation("one")],
      commands: async () => [],
      snapshot: async (id: string) => ({ ...snapshot(id), items: [{ id: "message:u", type: "user_message", createdAt: 1, text: "which branch?" }, pending] }),
      stream: () => ({ close() {} }),
      inventoryStream: () => ({ close() {} }),
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
      question: async () => ({ outcome: "answered" }),
    } as unknown as ChatApiClient;

    // The seam under test is the hand-off itself: which owner is asked to
    // hold which item. linkedom has no layout, so the owner's own pinned/
    // unpinned decision cannot be exercised here — the e2e suite does that.
    const { CoordinatedScrollOwner } = await import("./coordinated-scroll");
    const handoffs: Array<{ scroller: string; preferredItemId: string | undefined }> = [];
    const beforeMutation = CoordinatedScrollOwner.prototype.beforeMutation;
    CoordinatedScrollOwner.prototype.beforeMutation = function (this: InstanceType<typeof CoordinatedScrollOwner>, preferredItemId?: string) {
      handoffs.push({ scroller: this.scroller.id, preferredItemId });
      beforeMutation.call(this, preferredItemId);
    };

    try {
      const { initChat } = await import(`./ui.ts?question-anchor-ui-test=${Date.now()}`);
      initChat(api);
      const card = () => document.querySelector<HTMLElement>('[data-chat-item-id="question:q1"]');
      await waitUntil(
        () => card()?.querySelector("[data-question-custom-toggle]") != null,
        () => document.querySelector("#chat-state")?.textContent ?? "no question card",
      );
      const toggle = card()!.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
      const editor = card()!.querySelector<HTMLElement>("[data-question-custom-editor]")!;
      expect(editor.hidden).toBe(true);

      // linkedom implements no `form` IDL attribute; the handler reads it.
      Object.defineProperty(toggle, "form", { configurable: true, value: card()!.querySelector("form[data-question-form]") });
      toggle.checked = true;
      handoffs.length = 0;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));

      expect(handoffs).toEqual([{ scroller: "chat-timeline", preferredItemId: "question:q1" }]);
      expect(editor.hidden).toBe(false);

      // No resolvable card: today's behavior, which is no hand-off at all.
      const stray = document.createElement("form");
      stray.setAttribute("data-question-form", "");
      stray.innerHTML = '<fieldset data-question-panel="0"><input type="radio" data-question-custom-toggle></fieldset>';
      document.querySelector<HTMLElement>("#chat-items")!.append(stray);
      const strayToggle = stray.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
      Object.defineProperty(strayToggle, "form", { configurable: true, value: stray });
      handoffs.length = 0;
      strayToggle.dispatchEvent(new Event("change", { bubbles: true }));
      expect(handoffs).toEqual([]);
    } finally {
      CoordinatedScrollOwner.prototype.beforeMutation = beforeMutation;
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

describe("chat answering state", () => {
  test("explicit selection cannot carry an outgoing answer hold into an incoming paused conversation", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    let active: Element | null = null;
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } });
    const { presentationLocalStorage } = await import("../shell/presentation-storage");
    const paused = { itemId: "message:b", offset: -20 };
    presentationLocalStorage()!.setItem("uatu:chat-presentation", JSON.stringify({ selectedId: "one", anchors: { two: paused } }));
    let opened = "";
    const api = questionApi(document);
    Object.assign(api, {
      conversations: async () => [conversation("one"), conversation("two")],
      snapshot: async (id: string) => ({ ...snapshot(id), items: id === "one" ? [pendingQuestion("q1", 1)] : [
        { id: "message:b", type: "user_message", createdAt: 1, text: "Incoming paused conversation" },
      ] }),
      stream: (id: string) => { opened = id; return { close() {} }; },
    });
    const { TimelineAnchorController } = await import("./anchor");
    const restore = TimelineAnchorController.prototype.restore;
    let parentAnchor: InstanceType<typeof TimelineAnchorController> | null = null;
    TimelineAnchorController.prototype.restore = function (value) { parentAnchor = this; restore.call(this, value); };
    const { CoordinatedScrollOwner } = await import("./coordinated-scroll");
    const hold = CoordinatedScrollOwner.prototype.hold;
    let holds = 0;
    CoordinatedScrollOwner.prototype.hold = function (element, options) { holds += 1; hold.call(this, element, options); };
    const requestFrame = globalThis.requestAnimationFrame;
    const cancelFrame = globalThis.cancelAnimationFrame;
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 100_000;
    try {
      const { initChat } = await import(`./ui.ts?answer-selection=${Date.now()}`);
      initChat(api);
      const card = await waitForQuestionCard(document);
      card.querySelector<HTMLElement>("[data-question-custom-toggle]")!.dispatchEvent(new window.Event("click", { bubbles: true }));
      const field = card.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
      expect(parentAnchor!.isPinned()).toBe(true);
      active = field;
      field.dispatchEvent(new window.Event("focusin", { bubbles: true }));
      await Bun.sleep(20);
      expect(holds).toBe(1);
      holds = 0;
      // A notification/selection can arrive without blurring A. Let B's fast
      // snapshot complete while A's clearing paint is still queued in rAF.
      globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
      globalThis.cancelAnimationFrame = id => { if (!frames.delete(id)) cancelFrame(id); };
      const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
      select.value = "two";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      await waitUntil(() => opened === "two");
      expect(field.isConnected).toBe(true);
      expect(parentAnchor!.currentAnchor()).toEqual(paused);
      expect(parentAnchor!.isPinned()).toBe(false);
      // Run the real render and post-paint focus cleanup, then its coordinated
      // scroll work. An outgoing hold must not repin B when A is removed.
      for (let pass = 0; pass < 10 && frames.size > 0; pass += 1) {
        const pending = [...frames];
        for (const [id, callback] of pending) if (frames.delete(id)) callback(performance.now() + pass * 16);
        await Promise.resolve();
      }
      expect(field.isConnected).toBe(false);
      expect(parentAnchor!.isPinned()).toBe(false);
      expect(parentAnchor!.currentAnchor()).toEqual(paused);
      expect(holds).toBe(0);
    } finally {
      globalThis.requestAnimationFrame = requestFrame;
      globalThis.cancelAnimationFrame = cancelFrame;
      TimelineAnchorController.prototype.restore = restore;
      CoordinatedScrollOwner.prototype.hold = hold;
      frames.clear();
      window.dispatchEvent(new Event("pagehide"));
      delete (window as unknown as { localStorage?: Storage }).localStorage;
    }
  });

  for (const change of ["remove", "refresh", "released-refresh"] as const) test(`focused answer reconciles after snapshot ${change} without focusout`, async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    let active: Element | null = null;
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
    let items: unknown[] = [{ id: "message:u", type: "user_message", createdAt: 1, text: "which branch?" }, pendingQuestion("q1", 2)];
    let handlers: { resync(): void } | null = null;
    const api = questionApi(document, { items: () => items, stream: value => { handlers = value; } });
    const { CoordinatedScrollOwner } = await import("./coordinated-scroll");
    const hold = CoordinatedScrollOwner.prototype.hold;
    const release = CoordinatedScrollOwner.prototype.release;
    const holds: Element[] = [];
    const releases: string[] = [];
    let answerOwner: InstanceType<typeof CoordinatedScrollOwner> | null = null;
    CoordinatedScrollOwner.prototype.hold = function (element, options) { answerOwner = this; holds.push(element); hold.call(this, element, options); };
    CoordinatedScrollOwner.prototype.release = function () { releases.push(this.scroller.id); release.call(this); };
    try {
      const { initChat } = await import(`./ui.ts?answer-snapshot=${change}-${Date.now()}`);
      initChat(api);
      const card = await waitForQuestionCard(document);
      card.querySelector<HTMLElement>("[data-question-custom-toggle]")!.dispatchEvent(new window.Event("click", { bubbles: true }));
      const field = card.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
      active = field;
      field.dispatchEvent(new window.Event("focusin", { bubbles: true }));
      expect(document.documentElement.hasAttribute("data-chat-answering")).toBe(true);
      if (change === "released-refresh") answerOwner!.pause();
      holds.length = 0;
      releases.length = 0;
      if (change === "remove") items = items.slice(0, 1);
      handlers!.resync();
      await Bun.sleep(80);
      if (change === "remove") {
        expect(field.isConnected).toBe(false);
        expect(document.documentElement.hasAttribute("data-chat-answering")).toBe(false);
        expect(document.documentElement.hasAttribute("data-chat-editing")).toBe(false);
        expect(releases).toContain("chat-timeline");
      } else {
        expect(field.isConnected).toBe(true);
        expect(holds.length).toBe(change === "refresh" ? 1 : 0);
        if (change === "refresh") expect(holds[0] === field).toBe(true);
      }
    } finally {
      CoordinatedScrollOwner.prototype.hold = hold;
      CoordinatedScrollOwner.prototype.release = release;
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a request's answer field puts the surface in the answering state; the composer does not", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    // linkedom tracks no focus at all, so the state the handler reads is
    // supplied here and the events that drive it are dispatched directly.
    let active: Element | null = null;
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
    const focus = (element: Element) => { active = element; element.dispatchEvent(new window.Event("focusin", { bubbles: true })); };
    const blur = async (element: Element) => {
      active = document.body;
      element.dispatchEvent(new window.Event("focusout", { bubbles: true }));
      await Bun.sleep(1);
    };
    const api = questionApi(document);
    try {
      const { initChat } = await import(`./ui.ts?answering-ui-test=${Date.now()}`);
      initChat(api);
      const card = await waitForQuestionCard(document);
      const toggle = card.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
      Object.defineProperty(toggle, "form", { configurable: true, value: card.querySelector("form[data-question-form]") });
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      const answerField = card.querySelector<HTMLInputElement>("[data-question-custom-input]")!;

      focus(answerField);
      expect(document.documentElement.hasAttribute("data-chat-answering")).toBe(true);
      expect(document.documentElement.hasAttribute("data-chat-editing")).toBe(true);

      await blur(answerField);
      expect(document.documentElement.hasAttribute("data-chat-answering")).toBe(false);
      expect(document.documentElement.hasAttribute("data-chat-editing")).toBe(false);

      // The composer is editing, but it is not answering a request: the
      // chrome that the answering state clears includes the composer itself.
      focus(document.querySelector<HTMLTextAreaElement>("#chat-input")!);
      expect(document.documentElement.hasAttribute("data-chat-editing")).toBe(true);
      expect(document.documentElement.hasAttribute("data-chat-answering")).toBe(false);
    } finally {
      document.documentElement.removeAttribute("data-chat-answering");
      document.documentElement.removeAttribute("data-chat-editing");
      document.documentElement.removeAttribute("data-chat-input-focused");
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("the answered field's timeline is held while it has focus and released when it loses it", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    let active: Element | null = null;
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
    const focus = (element: Element) => { active = element; element.dispatchEvent(new window.Event("focusin", { bubbles: true })); };
    const blur = async (element: Element) => {
      active = document.body;
      element.dispatchEvent(new window.Event("focusout", { bubbles: true }));
      await Bun.sleep(1);
    };
    // The seam is which owner is asked to hold what: the hold's own defence
    // of the position is the coordinated owner's unit case, and the platform
    // autoscroll it defends against is the browser suite's.
    const { CoordinatedScrollOwner } = await import("./coordinated-scroll");
    const holds: Array<{ scroller: string; element: Element; align: string | undefined }> = [];
    const placements: Array<RevealOptions | undefined> = [];
    const releases: string[] = [];
    const hold = CoordinatedScrollOwner.prototype.hold;
    const release = CoordinatedScrollOwner.prototype.release;
    CoordinatedScrollOwner.prototype.hold = function (this: InstanceType<typeof CoordinatedScrollOwner>, element: HTMLElement, options?: RevealOptions) {
      holds.push({ scroller: this.scroller.id, element, align: options?.align });
      placements.push(options);
      hold.call(this, element, options);
    };
    CoordinatedScrollOwner.prototype.release = function (this: InstanceType<typeof CoordinatedScrollOwner>) {
      releases.push(this.scroller.id);
      release.call(this);
    };
    try {
      const { initChat } = await import(`./ui.ts?answer-hold-ui-test=${Date.now()}`);
      initChat(questionApi(document));
      const card = await waitForQuestionCard(document);
      const toggle = card.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
      Object.defineProperty(toggle, "form", { configurable: true, value: card.querySelector("form[data-question-form]") });
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      const answerField = card.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
      holds.length = 0;
      releases.length = 0;

      focus(answerField);
      // On touch the field is held against the bottom of the band left above
      // the keyboard, and the row carrying Answer and Reject is held with it:
      // placing the field alone could leave its own buttons covered.
      expect(holds).toEqual([{ scroller: "chat-timeline", element: answerField, align: "end" }]);
      expect(placements[0]?.extent).toBe(card.querySelector<HTMLElement>("form[data-question-form] .chat-request-actions")!);
      expect(releases).toEqual([]);

      await blur(answerField);
      // Both owners: by now the field may not be in the timeline that held it,
      // and releasing an owner that holds nothing does nothing.
      expect(releases).toContain("chat-timeline");
      expect(holds).toHaveLength(1);

      // The composer is editing, not answering: nothing is held for it.
      focus(document.querySelector<HTMLTextAreaElement>("#chat-input")!);
      expect(holds).toHaveLength(1);
    } finally {
      CoordinatedScrollOwner.prototype.hold = hold;
      CoordinatedScrollOwner.prototype.release = release;
      document.documentElement.removeAttribute("data-chat-answering");
      document.documentElement.removeAttribute("data-chat-editing");
      document.documentElement.removeAttribute("data-chat-input-focused");
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  for (const lifecycle of ["transfer", "resume"] as const) test(`answer hold follows ${lifecycle} in parent and drill-down`, async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    let active: Element | null = null;
    let visibility = "visible";
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const focus = (element: Element) => { active = element; element.dispatchEvent(new window.Event("focusin", { bubbles: true })); };
    const { CoordinatedScrollOwner } = await import("./coordinated-scroll");
    const calls: Array<{ kind: string; scroller: string; element?: Element }> = [];
    const hold = CoordinatedScrollOwner.prototype.hold;
    const release = CoordinatedScrollOwner.prototype.release;
    CoordinatedScrollOwner.prototype.hold = function (element, options) {
      calls.push({ kind: "hold", scroller: this.scroller.id, element });
      hold.call(this, element, options);
    };
    CoordinatedScrollOwner.prototype.release = function () {
      calls.push({ kind: "release", scroller: this.scroller.id });
      release.call(this);
    };
    try {
      const { initChat } = await import(`./ui.ts?answer-lifecycle=${lifecycle}-${Date.now()}`);
      initChat(questionApi(document));
      await waitForQuestionCard(document);
      // Synthetic request controls isolate focus ownership from rendering and
      // provider request ordering; real independently-owned requests are E2E.
      for (const id of ["chat-timeline", "chat-drilldown-timeline"]) {
        const request = document.createElement("div");
        request.className = "chat-request";
        const first = document.createElement("input");
        const second = document.createElement("input");
        request.append(first, second);
        document.getElementById(id)!.append(request);
        focus(first);
        calls.length = 0;
        if (lifecycle === "transfer") {
          focus(second);
          expect(calls.filter(call => call.kind === "hold").map(call => ({ scroller: call.scroller, correctField: call.element === second }))).toEqual([{ scroller: id, correctField: true }]);
          expect(calls.findIndex(call => call.kind === "release")).toBeLessThan(calls.findIndex(call => call.kind === "hold"));
        } else {
          visibility = "hidden";
          document.dispatchEvent(new window.Event("visibilitychange"));
          visibility = "visible";
          document.dispatchEvent(new window.Event("visibilitychange"));
          expect(calls.filter(call => call.kind === "hold").map(call => ({ scroller: call.scroller, correctField: call.element === first }))).toEqual([{ scroller: id, correctField: true }]);
        }
        calls.length = 0;
        // Repeated focus sync/viewport corrections must not undo a gesture's
        // release by installing the same hold again.
        focus(active!);
        expect(calls.filter(call => call.kind === "hold")).toEqual([]);
      }
    } finally {
      CoordinatedScrollOwner.prototype.hold = hold;
      CoordinatedScrollOwner.prototype.release = release;
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("on desktop the answered field is held with the minimal move", async () => {
    // The end alignment exists because a keyboard covers the chrome and the
    // question has to be pressed against what is left. Nothing covers it on
    // desktop, so there is no band to press against and moving a card the
    // reader can already see would be a jump bought for nothing. What the
    // field is held *with* is unchanged: the extent is not device-dependent.
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    let active: Element | null = null;
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
    const focus = (element: Element) => { active = element; element.dispatchEvent(new window.Event("focusin", { bubbles: true })); };
    const { CoordinatedScrollOwner } = await import("./coordinated-scroll");
    const placements: Array<RevealOptions | undefined> = [];
    const hold = CoordinatedScrollOwner.prototype.hold;
    CoordinatedScrollOwner.prototype.hold = function (this: InstanceType<typeof CoordinatedScrollOwner>, element: HTMLElement, options?: RevealOptions) {
      placements.push(options);
      hold.call(this, element, options);
    };
    try {
      const { initChat } = await import(`./ui.ts?answer-hold-desktop-ui-test=${Date.now()}`);
      initChat(questionApi(document));
      const card = await waitForQuestionCard(document);
      const toggle = card.querySelector<HTMLInputElement>("[data-question-custom-toggle]")!;
      Object.defineProperty(toggle, "form", { configurable: true, value: card.querySelector("form[data-question-form]") });
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      const answerField = card.querySelector<HTMLInputElement>("[data-question-custom-input]")!;
      placements.length = 0;

      focus(answerField);
      expect(placements.map(placement => placement?.align)).toEqual(["nearest"]);
      expect(placements[0]?.extent).toBe(card.querySelector<HTMLElement>("form[data-question-form] .chat-request-actions")!);
    } finally {
      CoordinatedScrollOwner.prototype.hold = hold;
      document.documentElement.removeAttribute("data-chat-answering");
      document.documentElement.removeAttribute("data-chat-editing");
      document.documentElement.removeAttribute("data-chat-input-focused");
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("a press on a request's answer controls does not blur the field first, whatever the pointer", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    const permission = {
      id: "permission:p1", type: "permission" as const, createdAt: 3, requestId: "p1", status: "pending" as const,
      action: "Run git status", resources: ["git status"],
    };
    const prompt = { id: "message:u", type: "user_message" as const, createdAt: 1, text: "which branch?" };
    // Only a conversation's newest request is answerable, so the question and
    // the permission are shown in turn rather than together.
    let items: unknown[] = [prompt, pendingQuestion("q1", 2)];
    let handlers: { resync(): void } | null = null;
    const api = questionApi(document, {
      items: () => items,
      stream: (streamHandlers: { resync(): void }) => { handlers = streamHandlers; },
    });
    const press = (element: Element, pointerType: string) => {
      const event = Object.assign(new window.Event("mousedown", { bubbles: true, cancelable: true }), { pointerType });
      element.dispatchEvent(event as unknown as Event);
      return event.defaultPrevented;
    };
    try {
      const { initChat } = await import(`./ui.ts?answer-press-ui-test=${Date.now()}`);
      initChat(api);
      const card = await waitForQuestionCard(document);
      // The state the guard reads, derived by `syncEditingFocus` and pinned
      // by the answering-state case above; set here so this case is about
      // which presses the guard intercepts.
      const answering = (on: boolean) => document.documentElement.toggleAttribute("data-chat-answering", on);

      // Nothing is being answered, so no press can blur a field and reflow
      // the card: every pointer keeps ordinary behavior.
      expect(press(card.querySelector("[data-question-primary]")!, "touch")).toBe(false);
      expect(press(card.querySelector("[data-question-primary]")!, "mouse")).toBe(false);

      answering(true);
      // Cancelling touch pointerdown suppresses the compatibility click in
      // WebKit. Let the pointer sequence through; only its mousedown default
      // (the focus transfer) is prevented.
      const touchDown = Object.assign(new window.Event("pointerdown", { bubbles: true, cancelable: true }), { pointerType: "touch" });
      card.querySelector("[data-question-primary]")!.dispatchEvent(touchDown);
      expect(touchDown.defaultPrevented).toBe(false);
      // The controls that resolve a request: pressing them must not take
      // focus off an open answer field and reflow the card under the pointer.
      // The pointer type is not the question — a trackpad on an iPad's
      // keyboard case moves the card exactly as a finger does.
      expect(press(card.querySelector("[data-question-primary]")!, "touch")).toBe(true);
      expect(press(card.querySelector("[data-question-reject]")!, "touch")).toBe(true);
      expect(press(card.querySelector("[data-question-primary]")!, "mouse")).toBe(true);
      expect(press(card.querySelector("[data-question-reject]")!, "pen")).toBe(true);

      // Ordinary targets keep ordinary behavior even while answering.
      expect(press(card.querySelector("[data-question-custom-toggle]")!, "touch")).toBe(false);
      expect(press(card.querySelector("summary")!, "touch")).toBe(false);

      // Preventing the default on mousedown does not cancel the click the
      // card resolves on: rejecting the question still reaches the agent.
      const rejects: string[] = [];
      Object.assign(api, { question: async (_conversationId: string, itemId: string) => { rejects.push(itemId); return { outcome: "rejected" }; } });
      card.querySelector<HTMLButtonElement>("[data-question-reject]")!.dispatchEvent(new window.Event("click", { bubbles: true }) as unknown as Event);
      await waitUntil(() => rejects.length === 1, () => `rejects ${rejects.join(",")}`);

      items = [prompt, permission];
      handlers!.resync();
      await waitUntil(
        () => document.querySelector('[data-chat-item-id="permission:p1"] [data-permission-outcome]') != null,
        () => document.querySelector("#chat-items")?.textContent ?? "no permission card",
      );
      const permissionCard = document.querySelector<HTMLElement>('[data-chat-item-id="permission:p1"]')!;
      expect(press(permissionCard.querySelector('[data-permission-outcome="approved-session"]')!, "touch")).toBe(true);
      expect(press(permissionCard.querySelector('[data-permission-outcome="approved-session"]')!, "mouse")).toBe(true);
      expect(press(permissionCard.querySelector("summary")!, "touch")).toBe(false);
    } finally {
      document.documentElement.removeAttribute("data-chat-answering");
      document.documentElement.removeAttribute("data-chat-editing");
      document.documentElement.removeAttribute("data-chat-input-focused");
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

describe("chat outstanding-request pill", () => {
  test("yields while its request is on screen and re-targets when the request changes", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "desktop");
    document.documentElement.setAttribute("data-chat-panel", "open");
    stubConversationSelect(document);
    const { observers, restore: restoreObservers } = stubIntersectionObservers();
    const later = { ...pendingQuestion("q2", 3), questions: [{ prompt: "Which remote?", header: "Remote", multiple: false, allowFreeForm: true, options: [{ label: "origin", description: "" }] }] };
    let items: unknown[] = [{ id: "message:u", type: "user_message", createdAt: 1, text: "which branch?" }, pendingQuestion("q1", 2)];
    let handlers: { resync(): void } | null = null;
    const api = questionApi(document, {
      items: () => items,
      stream: (streamHandlers: { resync(): void }) => { handlers = streamHandlers; },
    });
    const pill = document.querySelector<HTMLButtonElement>("#chat-requests-jump")!;
    const latest = () => observers.at(-1)!;
    // linkedom measures nothing, so what the timeline shows of the card is
    // supplied: a 600px band, and a card of `cardHeight` with `visible` of it
    // on screen.
    const fire = (visible: number, cardHeight = 200) => latest().callback([seen(visible, cardHeight)]);
    try {
      const { initChat } = await import(`./ui.ts?requests-pill-ui-test=${Date.now()}`);
      initChat(api);
      await waitUntil(() => pill.textContent === "1 request needs your answer", () => `pill ${pill.textContent}`);
      // Rooted at the timeline, on the card the pill points at.
      expect(latest().options.root).toBe(document.querySelector("#chat-timeline"));
      expect(latest().observed).toEqual([document.querySelector('[data-chat-item-id="question:q1"]')!]);
      // Dense thresholds: the rule is re-evaluated as the card scrolls, not
      // only as it enters and leaves.
      expect(latest().options.threshold).toEqual(Array.from({ length: 21 }, (_, index) => index / 20));
      expect(pill.hidden).toBe(false);

      // Half the card showing is enough to yield to it.
      fire(200);
      expect(pill.hidden).toBe(true);
      fire(100);
      expect(pill.hidden).toBe(true);
      // A sliver is not: the field and the controls are still off screen, and
      // the pill is the way back to them.
      fire(40);
      expect(pill.hidden).toBe(false);
      fire(0);
      expect(pill.hidden).toBe(false);
      // A card taller than the band can never show half of itself, so half
      // the band showing is the other way to qualify.
      fire(300, 2_000);
      expect(pill.hidden).toBe(true);
      fire(200, 2_000);
      expect(pill.hidden).toBe(false);
      expect(pill.textContent).toBe("1 request needs your answer");

      items = [...items, later];
      handlers!.resync();
      await waitUntil(() => pill.textContent === "2 requests need your answer", () => `pill ${pill.textContent}`);
      // The newest request is the answerable one, so the observer moves to it
      // and every observer it replaced is released.
      expect(latest().observed).toEqual([document.querySelector('[data-chat-item-id="question:q2"]')!]);
      expect(observers.slice(0, -1).every(observer => observer.disconnected)).toBe(true);
      fire(200);
      expect(pill.hidden).toBe(true);
      // The count is the count of everything outstanding, unchanged by the gate.
      expect(pill.textContent).toBe("2 requests need your answer");

      // pagehide can retain this document on iOS: its existing surface and
      // observer must keep working rather than wait for a nonexistent remount.
      const retainedObserver = latest();
      window.dispatchEvent(new Event("pagehide"));
      expect(retainedObserver.disconnected).toBe(false);
      fire(0);
      expect(pill.hidden).toBe(false);

      // No outstanding request means there is no node left to observe, even
      // though the chat surface itself continues to live with the document.
      items = [];
      handlers!.resync();
      await waitUntil(() => pill.textContent === "", () => `pill ${pill.textContent}`);
      expect(retainedObserver.disconnected).toBe(true);
      expect(pill.hidden).toBe(true);
    } finally {
      restoreObservers();
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });

  test("returns while a subagent drill-down is pushed over the request it leads to", async () => {
    const { document, window } = parseHTML(html);
    installDomGlobals(document, window);
    document.documentElement.setAttribute("data-ui-mode", "touch");
    document.documentElement.setAttribute("data-active-tab", "chat");
    stubConversationSelect(document);
    const { observers, restore: restoreObservers } = stubIntersectionObservers();
    const items: unknown[] = [
      { id: "message:u", type: "user_message", createdAt: 1, text: "review the docs" },
      {
        id: "tool:agent1", type: "tool", createdAt: 2, name: "task", status: "completed",
        input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }),
        childConversationId: "child",
      },
      pendingQuestion("q1", 3),
    ];
    const api = questionApi(document, { items: () => items, capabilities: ["questions", "subagents"] });
    const pill = document.querySelector<HTMLButtonElement>("#chat-requests-jump")!;
    const drilldown = document.querySelector<HTMLElement>("#chat-drilldown")!;
    const click = (element: Element) => element.dispatchEvent(new window.Event("click", { bubbles: true }) as unknown as Event);
    try {
      const { initChat } = await import(`./ui.ts?requests-pill-drilldown-ui-test=${Date.now()}`);
      initChat(api);
      await waitUntil(() => pill.textContent === "1 request needs your answer", () => `pill ${pill.textContent}`);
      // The card is on screen in the parent transcript, so the pill yields.
      observers.at(-1)!.callback([seen(200)]);
      expect(pill.hidden).toBe(true);

      const openTranscript = () => document.querySelector<HTMLButtonElement>('#chat-subagents [data-open-conversation]');
      await waitUntil(() => openTranscript() != null, () => document.querySelector("#chat-items")?.textContent ?? "no subagent card");
      click(openTranscript()!);
      expect(drilldown.hidden).toBe(false);
      // The card still intersects the parent timeline under the pushed
      // screen, but it cannot be reached there: the pill is what carries a
      // request the parent is waiting on over the layer.
      expect(pill.hidden).toBe(false);

      click(document.querySelector<HTMLButtonElement>("#chat-drilldown-back")!);
      expect(drilldown.hidden).toBe(true);
      expect(pill.hidden).toBe(true);
    } finally {
      restoreObservers();
      await Bun.sleep(20);
      window.dispatchEvent(new Event("pagehide"));
    }
  });
});

afterAll(() => {
  for (const [key, value] of savedGlobals) Reflect.set(globalThis, key, value);
});

function stubConversationSelect(document: Document): void {
  const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
  let selected = "";
  Object.defineProperty(select, "value", { configurable: true, get: () => selected, set: value => { selected = String(value); } });
}

function pendingQuestion(requestId: string, createdAt: number) {
  return {
    id: `question:${requestId}`, type: "question" as const, createdAt, requestId, status: "pending" as const,
    questions: [{
      prompt: "Which branch?", header: "Branch", multiple: false, allowFreeForm: true,
      options: [{ label: "main", description: "" }],
    }],
  };
}

function questionApi(document: Document, options: { items?: () => unknown[]; stream?: (handlers: { resync(): void }) => void; capabilities?: string[] } = {}): ChatApiClient {
  const items = options.items ?? (() => [{ id: "message:u", type: "user_message", createdAt: 1, text: "which branch?" }, pendingQuestion("q1", 2)]);
  return {
    status: async () => ([{
      agent: { id: "test", name: "Test" },
      availability: { state: "ready", version: "test", agent: { id: "test", name: "Test", capabilities: options.capabilities ?? ["questions"] } },
    }]),
    conversations: async () => [conversation("one")],
    commands: async () => [],
    snapshot: async (id: string) => ({ ...snapshot(id), items: items() }),
    stream: (_conversationId: string, _cursor: string, handlers: { resync(): void }) => {
      options.stream?.(handlers);
      return { close() {} };
    },
    inventoryStream: () => ({ close() {} }),
    attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
    question: async () => ({ outcome: "answered" }),
  } as unknown as ChatApiClient;
}

/** What the page's IntersectionObserver reports, as the pill reads it. */
type ObservedVisibility = {
  isIntersecting: boolean;
  intersectionRatio: number;
  intersectionRect: { height: number };
  rootBounds: { height: number } | null;
};

type StubObserver = {
  observed: Element[];
  disconnected: boolean;
  callback: (entries: ObservedVisibility[]) => void;
  options: { root?: Element | null; threshold?: number | number[] };
};

/**
 * The page's IntersectionObserver, replaced by one the test drives: linkedom
 * has no layout, so what a card shows of itself is supplied rather than
 * measured. Every constructed observer is collected, which is also how the
 * tests check that replaced ones are released.
 */
function stubIntersectionObservers(): { observers: StubObserver[]; restore(): void } {
  const observers: StubObserver[] = [];
  const saved = Reflect.get(globalThis, "IntersectionObserver");
  class Stub {
    readonly observed: Element[] = [];
    disconnected = false;
    constructor(readonly callback: (entries: ObservedVisibility[]) => void, readonly options: { root?: Element | null; threshold?: number | number[] }) {
      observers.push(this as unknown as StubObserver);
    }
    observe(element: Element): void { this.observed.push(element); }
    unobserve(): void {}
    disconnect(): void { this.disconnected = true; }
  }
  Reflect.set(globalThis, "IntersectionObserver", Stub);
  return { observers, restore: () => { Reflect.set(globalThis, "IntersectionObserver", saved); } };
}

/** `visible` pixels of a `cardHeight` card, inside a 600px visible band. */
function seen(visible: number, cardHeight = 200, bandHeight = 600): ObservedVisibility {
  return {
    isIntersecting: visible > 0,
    intersectionRatio: visible / cardHeight,
    intersectionRect: { height: visible },
    rootBounds: { height: bandHeight },
  };
}

async function waitForQuestionCard(document: Document): Promise<HTMLElement> {
  await waitUntil(
    () => document.querySelector('[data-chat-item-id="question:q1"] [data-question-custom-toggle]') != null,
    () => document.querySelector("#chat-state")?.textContent ?? "no question card",
  );
  return document.querySelector<HTMLElement>('[data-chat-item-id="question:q1"]')!;
}
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
