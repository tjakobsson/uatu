import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";

import type { ConversationItem, ConversationSnapshot } from "../../src/chat/types";
import { chooseChatModel, openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type InventoryStats = {
  inventoryListCalls: number;
  inventoryListCompleted: number;
  inventoryListPending: boolean;
  inventoryInvalidations: number;
  inventorySubscribers: number;
  inventoryTransportInterrupted: boolean;
  pendingInventorySubscriptions: number;
};

async function control<T = unknown>(request: APIRequestContext, body: Record<string, unknown>): Promise<T> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<T>;
}

async function stats(request: APIRequestContext): Promise<InventoryStats> {
  return control<InventoryStats>(request, { action: "stats" });
}

async function token(request: APIRequestContext): Promise<string> {
  const response = await request.get("/__e2e/terminal-token");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { token: string }).token;
}

async function bootChat(page: Page, credential: string): Promise<void> {
  await page.goto(`/?t=${encodeURIComponent(credential)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
}

async function bootSecondClient(browser: Browser, credential: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await bootChat(page, credential);
  return { context, page };
}

async function waitForInventoryIdle(request: APIRequestContext, subscribers = 1): Promise<InventoryStats> {
  await expect.poll(async () => (await stats(request)).inventorySubscribers).toBe(subscribers);
  await expect.poll(async () => {
    const current = await stats(request);
    return current.inventoryListPending || current.inventoryListCalls !== current.inventoryListCompleted;
  }).toBe(false);
  return stats(request);
}

async function expectUniqueConversationOptions(page: Page): Promise<void> {
  const values = await page.locator("#chat-conversation-select option").evaluateAll(options =>
    options.map(option => (option as HTMLOptionElement).value).filter(Boolean),
  );
  expect(new Set(values).size).toBe(values.length);
}

function transcript(count: number): ConversationItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message:inventory-${index}`,
    type: "user_message" as const,
    createdAt: index + 1,
    text: `Inventory preservation line ${index + 1}: keep this transcript anchored while another client changes the chooser.`,
  }));
}

async function stageAttachment(page: Page): Promise<void> {
  const uploaded = page.waitForResponse(response => response.url().includes("/attachments") && response.request().method() === "POST");
  await page.locator("#chat-attach-input").setInputFiles({ name: "inventory.png", mimeType: "image/png", buffer: PNG });
  expect((await uploaded).status()).toBe(201);
  await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(1);
}

async function installInventoryFrameCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as typeof window & { __e2eInventoryFrames?: number };
    state.__e2eInventoryFrames = 0;
    const addEventListener = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function(type, listener, options) {
      if (type !== "inventory" || !listener) return addEventListener.call(this, type, listener, options);
      const wrapped: EventListener = event => {
        state.__e2eInventoryFrames = (state.__e2eInventoryFrames ?? 0) + 1;
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      };
      return addEventListener.call(this, type, wrapped, options);
    } as typeof EventSource.prototype.addEventListener;
  });
}

async function inventoryFrames(page: Page): Promise<number> {
  return page.evaluate(() => (window as typeof window & { __e2eInventoryFrames?: number }).__e2eInventoryFrames ?? 0);
}

test.describe("live conversation inventory", () => {
  test.describe.configure({ mode: "serial" });

  test("remote creation preserves the selected presentation and is unseen only on the other client", async ({ browser, page, request }) => {
    await request.post("/__e2e/reset");
    const primary = await control<ConversationSnapshot>(request, {
      action: "seed",
      title: "Primary conversation",
      items: transcript(36),
      configuration: { model: { providerId: "anthropic", modelId: "claude-sonnet" }, mode: "plan" },
    });
    const credential = await token(request);
    await bootChat(page, credential);
    const second = await bootSecondClient(browser, credential);
    try {
      await waitForInventoryIdle(request, 2);
      const chooser = page.locator("#chat-conversation-select");
      await expect(chooser).toHaveValue(primary.conversation.id);

      await stageAttachment(page);
      await chooseChatModel(page, "GPT-5");
      await page.locator("#chat-configuration-done").click();
      await control(request, { action: "status", conversationId: primary.conversation.id, status: "running" });
      await expect(page.locator("#chat-send")).toHaveAttribute("aria-label", "Cancel response");

      const timeline = page.locator("#chat-timeline");
      await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100);
      await timeline.evaluate(element => {
        element.scrollTop = 120;
        element.dispatchEvent(new Event("scroll"));
      });
      const scrollTop = await timeline.evaluate(element => element.scrollTop);
      const input = page.locator("#chat-input");
      await input.fill("Draft and focus stay with the primary conversation");
      await input.focus();

      const secondChooser = second.page.locator("#chat-conversation-select");
      const previousSecondSelection = await secondChooser.inputValue();
      await second.page.getByRole("button", { name: "New conversation" }).click();
      await expect(secondChooser).not.toHaveValue(previousSecondSelection);
      const createdId = await secondChooser.inputValue();

      await expect(chooser.locator(`option[value="${createdId}"]`)).toHaveCount(1);
      await expect(chooser).toHaveValue(primary.conversation.id);
      await expect(input).toHaveValue("Draft and focus stay with the primary conversation");
      await expect(input).toBeFocused();
      expect(await timeline.evaluate(element => element.scrollTop)).toBeCloseTo(scrollTop, 0);
      await expect(page.locator("#chat-send")).toHaveAttribute("aria-label", "Cancel response");
      await expect(page.locator("#chat-attachments .chat-attachment")).toContainText("inventory.png");
      await expect(page.locator("#chat-configuration-trigger")).toContainText("GPT-5");
      await expect(page.locator("#chat-conversation-unseen-count")).toHaveAttribute("aria-label", "Acknowledge 1 new conversation");
      await expect(page.locator("#chat-conversation-inventory-live")).toHaveText("1 new conversation available.");
      await expect(second.page.locator("#chat-conversation-unseen-count")).toBeHidden();
      await expectUniqueConversationOptions(page);
      await expectUniqueConversationOptions(second.page);

      await page.locator("#chat-collapse").click();
      await expect(page.locator("#chat-expand")).toHaveAttribute("aria-label", "Open chat panel, 1 new conversation");
      await openChatPanel(page);
      const inventoryIndicator = page.getByRole("button", { name: "Acknowledge 1 new conversation" });
      await expect(inventoryIndicator).toBeVisible();
      await inventoryIndicator.click();
      await expect(inventoryIndicator).toBeHidden();
      await expect(chooser).toHaveValue(primary.conversation.id);
      await expect(input).toHaveValue("Draft and focus stay with the primary conversation");
    } finally {
      await second.context.close();
    }
  });

  test("remote rename, unselected deletion, and child creation reconcile without disturbing selection", async ({ browser, page, request }) => {
    await request.post("/__e2e/reset");
    const selected = await control<ConversationSnapshot>(request, { action: "seed", title: "Selected locally", items: [] });
    const remote = await control<ConversationSnapshot>(request, { action: "seed", title: "Remote target", items: [] });
    const credential = await token(request);
    await bootChat(page, credential);
    const second = await bootSecondClient(browser, credential);
    try {
      await page.locator("#chat-conversation-select").selectOption(selected.conversation.id);
      await second.page.locator("#chat-conversation-select").selectOption(remote.conversation.id);
      const draft = page.locator("#chat-input");
      await draft.fill("Unselected mutations keep this draft");
      await draft.focus();
      await waitForInventoryIdle(request, 2);

      await second.page.getByRole("button", { name: "Rename conversation" }).click();
      await second.page.locator("#chat-rename-title").fill("Renamed from client two");
      await second.page.getByRole("button", { name: "Rename", exact: true }).click();
      await expect(page.locator(`#chat-conversation-select option[value="${remote.conversation.id}"]`)).toHaveText("Renamed from client two");
      await expect(page.locator("#chat-conversation-select")).toHaveValue(selected.conversation.id);
      await expect(draft).toHaveValue("Unselected mutations keep this draft");
      await expect(draft).toBeFocused();

      await control(request, { action: "externalDelete", conversationId: remote.conversation.id });
      await expect(page.locator(`#chat-conversation-select option[value="${remote.conversation.id}"]`)).toHaveCount(0);
      await expect(page.locator("#chat-conversation-select")).toHaveValue(selected.conversation.id);
      await expect(draft).toHaveValue("Unselected mutations keep this draft");
      await expect(draft).toBeFocused();

      const beforeChild = await stats(request);
      const child = await control<ConversationSnapshot>(request, { action: "externalCreate", title: "Subagent child", child: true });
      expect((await stats(request)).inventoryInvalidations).toBe(beforeChild.inventoryInvalidations);
      await control(request, { action: "inventoryInvalidate" });
      await expect.poll(async () => (await stats(request)).inventoryListCompleted).toBeGreaterThan(beforeChild.inventoryListCompleted);
      await expect(page.locator(`#chat-conversation-select option[value="${child.conversation.id}"]`)).toHaveCount(0);
      await expect(page.locator("#chat-conversation-unseen-count")).toBeHidden();
      await expectUniqueConversationOptions(page);
    } finally {
      await second.context.close();
    }
  });

  test("selected external deletion preserves local state and leaves chooser and New usable", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const survivor = await control<ConversationSnapshot>(request, { action: "seed", title: "Surviving conversation", items: [] });
    const selected = await control<ConversationSnapshot>(request, { action: "seed", title: "Deleted remotely", items: transcript(24) });
    const credential = await token(request);
    await bootChat(page, credential);
    await expect(page.locator("#chat-conversation-select")).toHaveValue(selected.conversation.id);

    await stageAttachment(page);
    await chooseChatModel(page, "GPT-5");
    await page.locator("#chat-configuration-done").click();
    await page.locator("#chat-input").fill("Preserve this deleted conversation draft");
    const timeline = page.locator("#chat-timeline");
    await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(60);
    await timeline.evaluate(element => {
      element.scrollTop = 80;
      element.dispatchEvent(new Event("scroll"));
    });
    const scrollTop = await timeline.evaluate(element => element.scrollTop);

    await control(request, { action: "externalDelete", conversationId: selected.conversation.id });
    await expect(page.locator("#chat-conversation-unavailable")).toContainText("This conversation was deleted elsewhere.");
    await expect(page.locator("#chat-conversation-select")).toHaveValue("");
    await expect(page.locator("#chat-conversation-select")).toBeEnabled();
    await expect(page.getByRole("button", { name: "New conversation" })).toBeEnabled();
    await expect(page.locator("#chat-input")).toHaveValue("Preserve this deleted conversation draft");
    await expect(page.locator("#chat-attachments .chat-attachment")).toContainText("inventory.png");
    await expect(page.locator("#chat-configuration-trigger")).toContainText("GPT-5");
    await expect(page.locator("#chat-items")).toContainText("Inventory preservation line 24");
    expect(await timeline.evaluate(element => element.scrollTop)).toBeCloseTo(scrollTop, 0);

    await page.locator("#chat-conversation-select").selectOption(survivor.conversation.id);
    await expect(page.locator("#chat-conversation-unavailable")).toBeHidden();
    await expect(page.locator("#chat-conversation-select")).toHaveValue(survivor.conversation.id);
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue(survivor.conversation.id);
    await expect(page.locator("#chat-conversation-unseen-count")).toBeHidden();
    await expectUniqueConversationOptions(page);
  });

  test("a selected conversation that returns to top-level inventory reloads and resumes streaming", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const selected = await control<ConversationSnapshot>(request, {
      action: "seed",
      title: "Temporarily nested conversation",
      items: transcript(8),
    });
    const credential = await token(request);
    await bootChat(page, credential);
    await expect(page.locator("#chat-conversation-select")).toHaveValue(selected.conversation.id);

    await stageAttachment(page);
    await chooseChatModel(page, "GPT-5");
    await page.locator("#chat-configuration-done").click();
    await page.locator("#chat-input").fill("Keep this draft while the session is nested");

    await control(request, { action: "externalSetChild", conversationId: selected.conversation.id, child: true });
    await expect(page.locator("#chat-conversation-unavailable")).toBeVisible();
    await expect(page.locator("#chat-conversation-select")).toHaveValue("");

    await control(request, { action: "item", conversationId: selected.conversation.id, item: {
      id: "message:while-nested",
      type: "assistant_message",
      createdAt: 20,
      markdown: "Loaded from the restored snapshot",
    } });
    await control(request, { action: "externalSetChild", conversationId: selected.conversation.id, child: false });

    await expect(page.locator("#chat-conversation-unavailable")).toBeHidden();
    await expect(page.locator("#chat-conversation-select")).toHaveValue(selected.conversation.id);
    await expect(page.locator("#chat-composer")).not.toHaveAttribute("inert", "");
    await expect(page.locator("#chat-input")).toHaveValue("Keep this draft while the session is nested");
    await expect(page.locator("#chat-attachments .chat-attachment")).toContainText("inventory.png");
    await expect(page.locator("#chat-configuration-trigger")).toContainText("GPT-5");
    await expect(page.locator("#chat-items")).toContainText("Loaded from the restored snapshot");

    await control(request, { action: "item", conversationId: selected.conversation.id, item: {
      id: "message:after-restore",
      type: "assistant_message",
      createdAt: 21,
      markdown: "Delivered after the stream resumed",
    } });
    await expect(page.locator("#chat-items")).toContainText("Delivered after the stream resumed");
    await expectUniqueConversationOptions(page);
  });

  test("inventory transport and provider-pump recovery fetch authoritative state without duplicates", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await control(request, { action: "seed", title: "Recovery baseline", items: [] });
    const credential = await token(request);
    await bootChat(page, credential);
    await waitForInventoryIdle(request);

    await control(request, { action: "inventoryInterrupt" });
    await expect.poll(async () => (await stats(request)).inventorySubscribers).toBe(0);
    const interrupted = await control<ConversationSnapshot>(request, { action: "externalCreate", title: "Created while inventory transport was down" });
    await expect.poll(async () => (await stats(request)).pendingInventorySubscriptions).toBe(1);
    await control(request, { action: "inventoryResume" });
    await expect(page.locator(`#chat-conversation-select option[value="${interrupted.conversation.id}"]`)).toHaveCount(1);

    const beforeRestart = await waitForInventoryIdle(request);
    const restarted = await control<ConversationSnapshot>(request, { action: "externalCreate", title: "Found after provider pump restart", invalidate: false });
    expect((await stats(request)).inventoryListCalls).toBe(beforeRestart.inventoryListCalls);
    await control(request, { action: "providerPumpRestart" });
    await expect(page.locator(`#chat-conversation-select option[value="${restarted.conversation.id}"]`)).toHaveCount(1);
    await expectUniqueConversationOptions(page);
  });

  test("duplicate invalidations during a delayed list produce one trailing request", async ({ page, request }) => {
    await installInventoryFrameCounter(page);
    await request.post("/__e2e/reset");
    await control(request, { action: "seed", title: "Serialized baseline", items: [] });
    const credential = await token(request);
    await bootChat(page, credential);
    const baseline = await waitForInventoryIdle(request);
    let deliveredFrames = await inventoryFrames(page);

    await control(request, { action: "delayNextInventoryList" });
    await control(request, { action: "inventoryInvalidate" });
    await expect.poll(async () => (await stats(request)).inventoryListPending).toBe(true);
    expect((await stats(request)).inventoryListCalls).toBe(baseline.inventoryListCalls + 1);

    const created = await control<ConversationSnapshot>(request, { action: "externalCreate", title: "Created during the delayed list" });
    await expect.poll(() => inventoryFrames(page)).toBeGreaterThan(deliveredFrames);
    deliveredFrames = await inventoryFrames(page);
    for (let index = 0; index < 2; index += 1) {
      await control(request, { action: "inventoryInvalidate" });
      await expect.poll(() => inventoryFrames(page)).toBeGreaterThan(deliveredFrames);
      deliveredFrames = await inventoryFrames(page);
      expect((await stats(request)).inventoryListCalls).toBe(baseline.inventoryListCalls + 1);
    }

    await control(request, { action: "releaseInventoryList" });
    await expect(page.locator(`#chat-conversation-select option[value="${created.conversation.id}"]`)).toHaveCount(1);
    await expect.poll(async () => {
      const current = await stats(request);
      return [current.inventoryListCalls, current.inventoryListCompleted];
    }).toEqual([baseline.inventoryListCalls + 2, baseline.inventoryListCompleted + 2]);
    await expectUniqueConversationOptions(page);
  });

  test("page visibility restoration and Chat activation reconcile missed inventory", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await control(request, { action: "seed", title: "Resume baseline", items: [] });
    const credential = await token(request);
    await bootChat(page, credential);
    const baseline = await waitForInventoryIdle(request);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const resumed = await control<ConversationSnapshot>(request, { action: "externalCreate", title: "Created while page was hidden", invalidate: false });
    expect((await stats(request)).inventoryListCalls).toBe(baseline.inventoryListCalls);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator(`#chat-conversation-select option[value="${resumed.conversation.id}"]`)).toHaveCount(1);

    await page.locator("#chat-collapse").click();
    const beforeActivation = await waitForInventoryIdle(request);
    const activated = await control<ConversationSnapshot>(request, { action: "externalCreate", title: "Found when Chat reopened", invalidate: false });
    expect((await stats(request)).inventoryListCalls).toBe(beforeActivation.inventoryListCalls);
    await openChatPanel(page);
    await expect(page.locator(`#chat-conversation-select option[value="${activated.conversation.id}"]`)).toHaveCount(1);
    await expect(page.locator("#chat-conversation-unseen-count")).toHaveAttribute("aria-label", "Acknowledge 2 new conversations");
    await expectUniqueConversationOptions(page);
  });
});
