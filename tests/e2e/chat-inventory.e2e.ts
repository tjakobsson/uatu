import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";

import type { ConversationItem, ConversationSnapshot } from "../../src/chat/types";
import { chooseChatModel, openChatPanel } from "./chat-helpers";
import { captureScreenshot } from "./evidence";
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

// Counts `inventory` topic frames as the page's one live stream delivers
// them: the channel listens for `live` envelopes, so the wrapper reads each
// envelope's topic rather than an event type of its own.
async function installInventoryFrameCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as typeof window & { __e2eInventoryFrames?: number };
    state.__e2eInventoryFrames = 0;
    const addEventListener = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function(type, listener, options) {
      if (type !== "live" || !listener) return addEventListener.call(this, type, listener, options);
      const wrapped: EventListener = event => {
        try {
          const envelope = JSON.parse((event as MessageEvent<string>).data) as { topic?: string; event?: { kind?: string } };
          if (envelope.topic === "inventory" && envelope.event?.kind === "data") {
            state.__e2eInventoryFrames = (state.__e2eInventoryFrames ?? 0) + 1;
          }
        } catch { /* not an envelope; the channel drops it too */ }
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

// Persist through the real UI, then start a fresh page with an explicitly
// controlled inventory. No global presentation keys or provider timing assumptions.
async function bootRememberedStartup(previousPage: Page, request: APIRequestContext, mode: "desktop" | "touch", agents = 1) {
  await request.post("/__e2e/reset");
  if (agents > 1) await control(request, { action: "agents", count: agents });
  const saved = await control<ConversationSnapshot>(request, {
    action: "seed", title: "Remembered conversation", items: [
      { id: "message:remembered", type: "assistant_message", createdAt: 1, markdown: "Remembered history loaded." },
    ],
  });
  const credential = await token(request);
  const activate = async (page: Page) => {
    if (mode === "touch") await page.locator("#touch-tab-chat").click();
    else await openChatPanel(page);
  };
  await previousPage.goto(`/?t=${encodeURIComponent(credential)}`);
  await activate(previousPage);
  await expect(previousPage.locator("#chat-items")).toContainText("Remembered history loaded.");
  const draft = "Keep the remembered draft";
  await previousPage.locator("#chat-input").fill(draft);
  await expect.poll(() => previousPage.evaluate(({ id, draft }) =>
    Object.keys(localStorage).some(key => {
      if (!key.includes("chat-presentation")) return false;
      const value = JSON.parse(localStorage.getItem(key)!);
      return value.selectedId === id && value.drafts?.[id] === draft;
    }), { id: saved.conversation.id, draft })).toBe(true);
  const page = await previousPage.context().newPage();
  await previousPage.close();
  let inventory: ConversationSnapshot["conversation"][] = [];
  const openingReads: string[] = [];
  const mutations: string[] = [];
  page.on("request", req => {
    const path = new URL(req.url()).pathname;
    if (req.method() === "GET" && /^\/api\/chat\/conversations\/[^/]+$/.test(path)) openingReads.push(path);
    if (req.method() === "POST" && path.startsWith("/api/chat/conversations")) mutations.push(path);
  });
  await page.route("**/api/chat/conversations", route => route.request().method() === "GET"
    ? route.fulfill({ json: { conversations: inventory } }) : route.continue());
  await page.goto(`/?t=${encodeURIComponent(credential)}`);
  await activate(page);
  await expect(page.locator("#chat-state")).toContainText("No conversations yet");
  await waitForInventoryIdle(request);
  const publish = async (conversations: typeof inventory) => {
    inventory = conversations;
    const response = page.waitForResponse(res => res.request().method() === "GET"
      && new URL(res.url()).pathname === "/api/chat/conversations");
    await control(request, { action: "inventoryInvalidate" });
    await (await response).finished();
    // Flush the response's UI update before checking that no opening was issued.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  return { page, saved, draft, publish, openingReads, mutations };
}

test.describe("live conversation inventory", () => {
  test.describe.configure({ mode: "serial" });

  for (const mode of ["desktop", "touch"] as const) {
    test.describe(`${mode} cold startup`, () => {
      test.use(mode === "touch"
        ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
        : { viewport: { width: 1440, height: 1000 }, hasTouch: false, isMobile: false });

      test("failed restoration stays actionable until explicit read retry", async ({ page: previousPage, request }) => {
        const { page, saved, draft, publish, openingReads, mutations } = await bootRememberedStartup(previousPage, request, mode);
        let fail = true;
        await page.route(`**/api/chat/conversations/${encodeURIComponent(saved.conversation.id)}?*`, route => fail
          ? route.fulfill({ status: 503, json: { error: "Remembered history temporarily unavailable" } }) : route.continue());
        await publish([saved.conversation]);
        const retry = page.getByRole("button", { name: "Retry read" });
        await expect(page.locator(".chat-read-error").filter({ visible: true })).toContainText("Remembered history temporarily unavailable");
        await expect(retry).toBeEnabled();
        for (let i = 0; i < 2; i++) await publish([saved.conversation]);
        expect(openingReads).toHaveLength(1);
        await expect(retry).toBeVisible();
        fail = false;
        await retry.click();
        await expect(page.locator("#chat-items")).toContainText("Remembered history loaded.");
        await expect(page.locator("#chat-input")).toHaveValue(draft);
        await expect(page.locator("#chat-send")).toBeEnabled();
        await expect(retry).toBeHidden();
        expect(openingReads).toHaveLength(2);
        expect(mutations).toEqual([]);
      });

      test("manual selection keeps its draft when the remembered conversation arrives", async ({ page: previousPage, request }) => {
        const { page, saved, publish, openingReads, mutations } = await bootRememberedStartup(previousPage, request, mode);
        const other = await control<ConversationSnapshot>(request, { action: "seed", title: "Chosen manually", items: [
          { id: "message:manual", type: "assistant_message", createdAt: 1, markdown: "Manually chosen history." },
        ] });
        await publish([other.conversation]);
        await page.locator("#chat-conversation-select").selectOption(other.conversation.id);
        await expect(page.locator("#chat-items")).toContainText("Manually chosen history.");
        await page.locator("#chat-input").fill("My manual selection draft");
        await publish([saved.conversation, other.conversation]);
        await expect(page.locator("#chat-conversation-select")).toHaveValue(other.conversation.id);
        await expect(page.locator("#chat-input")).toHaveValue("My manual selection draft");
        await expect(page.locator("#chat-items")).not.toContainText("Remembered history loaded.");
        expect(openingReads).toEqual([`/api/chat/conversations/${encodeURIComponent(other.conversation.id)}`]);
        expect(mutations).toEqual([]);
      });

      test("confirmed creation prevents restoration both in flight and after failure", async ({ page: previousPage, request }) => {
        const { page, saved, publish, openingReads } = await bootRememberedStartup(previousPage, request, mode);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        await page.route("**/api/chat/conversations", async route => {
          if (route.request().method() !== "POST") return route.fallback();
          await gate;
          await route.fulfill({ status: 503, json: { error: "Creation temporarily unavailable" } });
        });
        try {
          const creating = page.waitForRequest(req => req.method() === "POST" && new URL(req.url()).pathname === "/api/chat/conversations");
          await page.getByRole("button", { name: "New conversation" }).click();
          await creating;
          await publish([]);
          await publish([saved.conversation]);
          expect(openingReads).toEqual([]);
          await expect(page.locator("#chat-items")).not.toContainText("Remembered history loaded.");
          release();
          await expect(page.locator("#chat-state")).toContainText("Creation temporarily unavailable");
          await publish([]);
          await publish([saved.conversation]);
          expect(openingReads).toEqual([]);
          await expect(page.locator("#chat-state")).toContainText("Creation temporarily unavailable");
          await expect(page.getByRole("button", { name: "New conversation", exact: true })).toBeEnabled();
          await expect(page.locator("#chat-conversation-select")).toBeEnabled();
          await page.locator("#chat-conversation-select").selectOption(saved.conversation.id);
          await expect(page.locator("#chat-items")).toContainText("Remembered history loaded.");
        } finally { release(); }
      });

      test("dismissing agent choice preserves remembered restoration", async ({ page: previousPage, request }) => {
        const { page, saved, draft, publish, openingReads, mutations } = await bootRememberedStartup(previousPage, request, mode, 2);
        await page.getByRole("button", { name: "New conversation" }).click();
        const menu = page.locator("#chat-agent-menu");
        await expect(menu).toBeVisible();
        await expect(menu.locator(".chat-agent-menu__item")).toHaveCount(2);
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await publish([saved.conversation]);
        await expect(page.locator("#chat-items")).toContainText("Remembered history loaded.");
        await expect(page.locator("#chat-input")).toHaveValue(draft);
        await expect(page.locator("#chat-send")).toBeEnabled();
        expect(openingReads).toHaveLength(1);
        expect(mutations).toEqual([]);
      });

      test("restores the exact remembered conversation after empty inventory without taking focus", async ({ page: previousPage, context, request }, testInfo) => {
        await request.post("/__e2e/reset");
        const saved = await control<ConversationSnapshot>(request, {
          action: "seed", title: "Remembered startup conversation",
          items: [{ id: "message:saved-startup", type: "assistant_message", createdAt: 1,
            markdown: "Saved history: the synthetic startup checklist is ready." }],
        });
        // Newest inventory entry is deliberately NOT the remembered one.
        const fallback = await control<ConversationSnapshot>(request, {
          action: "seed", title: "Unrelated newer conversation", items: [],
        });
        const credential = await token(request);
        await previousPage.goto(`/?t=${encodeURIComponent(credential)}`);
        if (mode === "touch") await previousPage.locator("#touch-tab-chat").click();
        else await openChatPanel(previousPage);
        await expect(previousPage.locator("#chat-conversation-select")).toHaveValue(fallback.conversation.id);
        await previousPage.locator("#chat-conversation-select").selectOption(saved.conversation.id);
        await expect(previousPage.locator("#chat-items")).toContainText("Saved history:");
        const draft = "Please review the saved startup checklist.";
        await previousPage.locator("#chat-input").fill(draft);
        // Let the real UI persist its workspace-scoped presentation; do not
        // inject a global storage key or clear storage between page lifetimes.
        await expect.poll(() => previousPage.evaluate(({ id, draft }) =>
          Object.keys(localStorage).some(key => {
            if (!key.includes("chat-presentation")) return false;
            const value = JSON.parse(localStorage.getItem(key)!);
            return value.selectedId === id && value.drafts?.[id] === draft;
          }), { id: saved.conversation.id, draft })).toBe(true);
        if (mode === "touch") {
          await previousPage.locator("#chat-input").blur();
          await previousPage.locator("#touch-tab-files").click();
        } else await previousPage.locator("#chat-collapse").click();
        await previousPage.close();

        const page = await context.newPage();
        let populated = false;
        let emptyReads = 0;
        let documentNavigations = 0;
        let openingReads = 0;
        const mutations: string[] = [];
        page.on("request", request => {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentNavigations += 1;
          if (request.method() === "GET" && new URL(request.url()).pathname === `/api/chat/conversations/${encodeURIComponent(saved.conversation.id)}`) openingReads += 1;
          if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/chat/conversations")) mutations.push(request.url());
        });
        await page.route("**/api/chat/conversations", async route => {
          if (route.request().method() !== "GET" || populated) return route.continue();
          emptyReads += 1;
          await route.fulfill({ json: { conversations: [] } });
        });
        await page.goto(`/?t=${encodeURIComponent(credential)}`);
        await expect(page.locator("html")).toHaveAttribute("data-ui-mode", mode);
        // Chat initializes lazily on activation; hide it again while the
        // controlled startup inventory is still empty.
        if (mode === "touch") await page.locator("#touch-tab-chat").click();
        else await openChatPanel(page);
        await expect.poll(() => emptyReads).toBeGreaterThan(0);
        await expect(page.locator("#chat-state")).toContainText("No conversations yet");
        await expect(page.locator("#chat-items")).not.toContainText("Saved history:");
        await waitForInventoryIdle(request);
        if (mode === "touch") await page.locator("#touch-tab-files").click();
        else await page.locator("#chat-collapse").click();
        const otherControl = page.locator(mode === "touch" ? "#touch-tab-files" : "#chat-expand");
        await otherControl.focus();
        await expect(otherControl).toBeFocused();

        // From this point through background subscription proof there are no UI actions,
        // reloads, chooser changes, or new-conversation requests.
        const restoredSnapshot = page.waitForResponse(response => response.request().method() === "GET"
          && new URL(response.url()).pathname === `/api/chat/conversations/${encodeURIComponent(saved.conversation.id)}`);
        const restoredSubscription = page.waitForResponse(response => {
          const request = response.request();
          if (request.method() !== "POST" || !new URL(request.url()).pathname.endsWith("/subscriptions")) return false;
          const body = request.postDataJSON() as { add?: { topic: string; key?: string }[] };
          return body.add?.some(entry => entry.topic === "conversation" && entry.key === saved.conversation.id) ?? false;
        });
        populated = true;
        await control(request, { action: "inventoryInvalidate" });
        const snapshotResponse = await restoredSnapshot;
        expect(snapshotResponse.ok()).toBe(true);
        const snapshot = await snapshotResponse.json() as ConversationSnapshot;
        expect(snapshot.conversation.id).toBe(saved.conversation.id);
        expect(snapshot.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: "message:saved-startup" })]));
        expect((await restoredSubscription).ok()).toBe(true);
        expect(openingReads).toBe(1);
        await expect(page.locator("#chat-conversation-select")).toHaveValue(saved.conversation.id);
        await expect(page.locator("#chat-conversation-select")).not.toHaveValue(fallback.conversation.id);
        await expect(page.locator("#chat-input")).toHaveValue(draft);
        await expect(otherControl).toBeFocused();
        await expect(page.locator("#chat-timeline")).toBeHidden();
        if (mode === "touch") await expect(page.locator("#touch-tab-files")).toHaveAttribute("aria-selected", "true");
        else await expect(page.locator("html")).toHaveAttribute("data-chat-panel", "collapsed");

        expect(documentNavigations).toBe(1);
        expect(mutations).toEqual([]);

        // Hidden surfaces intentionally defer timeline/control rendering.
        // Reveal the already-read and subscribed conversation, not a selection.
        if (mode === "touch") await page.locator("#touch-tab-chat").click();
        else await openChatPanel(page);
        await expect(page.locator("#chat-items")).toContainText("Saved history: the synthetic startup checklist is ready.");
        await expect(page.locator("#chat-composer")).not.toHaveAttribute("inert", "");
        await expect(page.locator("#chat-input")).toHaveValue(draft);
        await expect(page.locator("#chat-send")).toBeEnabled();

        // Published only AFTER history rendered: this cannot have come from
        // the opening snapshot, and proves live delivery after restoration.
        await control(request, { action: "item", conversationId: saved.conversation.id, item: {
          id: "message:startup-live", type: "assistant_message", createdAt: 2,
          markdown: "Live update: restoration is subscribed and ready.",
        } });
        await expect(page.locator("#chat-items")).toContainText("Live update: restoration is subscribed and ready.");
        expect(documentNavigations).toBe(1);
        expect(mutations).toEqual([]);
        expect(openingReads).toBe(1);
        await expect(page.locator("#chat-conversation-select")).toHaveValue(saved.conversation.id);
        await expect(page.locator("#chat-input")).toHaveValue(draft);
        await expect(page.locator("#chat-send")).toBeEnabled();
        await captureScreenshot(page, testInfo, `conversation-startup-restored-${mode}`);
      });
    });
  }

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
      // One agent-level subscription regardless of client count: the
      // router's inventory hub multiplexes every connected client over it.
      await waitForInventoryIdle(request, 1);
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
      // One agent-level subscription regardless of client count: the
      // router's inventory hub multiplexes every connected client over it.
      await waitForInventoryIdle(request, 1);

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
