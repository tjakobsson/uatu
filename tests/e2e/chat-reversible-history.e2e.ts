import type { APIRequestContext, Browser, Page } from "@playwright/test";

import type { ChatCapability, ConversationItem, ConversationSnapshot } from "../../src/chat/types";
import { openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

const CAPABILITIES: ChatCapability[] = ["commands", "attachments", "reversible-history"];
const PNG = Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
));

async function control<T = unknown>(request: APIRequestContext, body: Record<string, unknown>): Promise<T> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<T>;
}

async function token(request: APIRequestContext): Promise<string> {
  return request.get("/__e2e/terminal-token").then(response => response.json()).then((body: { token: string }) => body.token);
}

async function openClient(page: Page, credential: string, conversationId: string): Promise<void> {
  await page.goto(`/?t=${encodeURIComponent(credential)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  if (await page.locator("html").getAttribute("data-ui-mode") === "touch") await page.locator("#touch-tab-chat").click();
  else await openChatPanel(page);
  await expect(page.locator("#chat-conversation-select")).toHaveValue(conversationId);
}

async function historyCommand(page: Page, operation: "undo" | "redo") {
  const response = page.waitForResponse(candidate => new URL(candidate.url()).pathname.endsWith(`/${operation}`));
  await page.locator("#chat-input").fill(`/${operation}`);
  if (await page.locator("#chat-send").getAttribute("aria-label") === "Cancel response") {
    await page.locator("#chat-composer").evaluate((form: HTMLFormElement) => form.requestSubmit());
  } else if (await page.locator("html").getAttribute("data-ui-mode") === "touch") {
    await page.locator("#chat-send").tap();
  } else {
    await page.locator("#chat-send").click();
  }
  return response;
}

async function send(page: Page, text: string) {
  const response = page.waitForResponse(candidate => new URL(candidate.url()).pathname.endsWith("/prompts"));
  await page.locator("#chat-input").fill(text);
  await page.locator("#chat-input").press("Enter");
  return response;
}

async function uploadFixtureAttachment(page: Page): Promise<{ id: string; mimeType: string }> {
  return page.evaluate(async bytes => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], "restored.png", { type: "image/png" }));
    const response = await fetch("/api/chat/conversations/fixture/attachments", { method: "POST", body: form });
    if (!response.ok) throw new Error(`attachment upload failed: ${response.status}`);
    return response.json() as Promise<{ id: string; mimeType: string }>;
  }, PNG);
}

async function postHistory(page: Page, conversationId: string, operation: "undo" | "redo", requestId: string) {
  return page.evaluate(async ({ conversationId, operation, requestId }) => {
    const response = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId }),
    });
    return { status: response.status, body: await response.json() };
  }, { conversationId, operation, requestId });
}

function historyItems(availableAttachment?: { id: string; mimeType: string }): ConversationItem[] {
  return [
    { id: "message:first", type: "user_message", createdAt: 1, text: "first instruction" },
    { id: "part:first", type: "assistant_message", createdAt: 2, markdown: "first answer" },
    { id: "message:second", type: "user_message", createdAt: 3, text: "second instruction" },
    { id: "part:second", type: "assistant_message", createdAt: 4, markdown: "second answer" },
    {
      id: "message:third",
      type: "user_message",
      createdAt: 5,
      text: "third instruction",
      attachments: [
        ...(availableAttachment ? [{ id: availableAttachment.id, name: "restored.png", mimeType: availableAttachment.mimeType }] : []),
        { name: "missing.png", mimeType: "image/png" },
      ],
    },
    { id: "part:third", type: "assistant_message", createdAt: 6, markdown: "third answer" },
  ];
}

test.describe("reversible Chat history", () => {
  test.describe.configure({ mode: "serial" });

  test("synchronizes hidden history and files while keeping the other client's draft private", async ({ browser, page, request, baseURL }) => {
    await request.post("/__e2e/reset", { data: { file: "reversible.md", extras: { "reversible.md": "# Third state\n" } } });
    await control(request, { action: "declareOnly", capabilities: CAPABILITIES });
    const credential = await token(request);
    await page.goto(`/?t=${encodeURIComponent(credential)}`);
    const attachment = await uploadFixtureAttachment(page);
    const seeded = await control<ConversationSnapshot>(request, { action: "seed", title: "Reversible history", items: historyItems(attachment) });
    const conversationId = seeded.conversation.id;
    await control(request, {
      action: "reversibleFiles",
      conversationId,
      reversibleFiles: [{
        relativePath: "reversible.md",
        baseline: "# Baseline state\n",
        versions: {
          "message:first": "# First state\n",
          "message:second": "# Second state\n",
          "message:third": "# Third state\n",
        },
      }],
    });

    await openClient(page, credential, conversationId);
    const secondContext = await browser.newContext({ baseURL });
    const other = await secondContext.newPage();
    await openClient(other, credential, conversationId);
    try {
      await page.locator("#chat-input").fill("caller draft");
      await other.locator("#chat-input").fill("other client's private draft");
      let promptRequests = 0;
      page.on("request", request => {
        if (new URL(request.url()).pathname.endsWith("/prompts")) promptRequests += 1;
      });

      expect((await historyCommand(page, "undo")).status()).toBe(200);
      await expect(page.locator("#chat-input")).toHaveValue("third instruction");
      await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(2);
      await expect(page.locator("#chat-attachments")).toContainText("restored.png");
      await expect(page.getByRole("button", { name: "Remove unavailable missing.png" })).toBeVisible();
      await expect(page.locator("#chat-composer-error")).toContainText("1 restored attachment is unavailable");
      await expect(page.locator("#chat-items")).not.toContainText("third instruction");
      await expect(other.locator("#chat-items")).not.toContainText("third instruction");
      await expect(other.locator("#chat-items")).toContainText("second answer");
      await expect(other.locator("#chat-input")).toHaveValue("other client's private draft");
      await expect(page.locator("#preview")).toContainText("Second state");

      expect((await historyCommand(page, "undo")).status()).toBe(200);
      await expect(page.locator("#chat-input")).toHaveValue("second instruction");
      await expect(page.locator("#chat-items")).not.toContainText("second instruction");
      await expect(other.locator("#chat-items")).not.toContainText("second instruction");
      await expect(other.locator("#chat-input")).toHaveValue("other client's private draft");
      await expect(page.locator("#preview")).toContainText("First state");

      expect((await historyCommand(page, "redo")).status()).toBe(200);
      await expect(page.locator("#chat-input")).toHaveValue("third instruction");
      await expect(page.locator("#chat-items")).toContainText("second answer");
      await expect(other.locator("#chat-items")).toContainText("second answer");
      await expect(other.locator("#chat-input")).toHaveValue("other client's private draft");

      expect((await historyCommand(page, "redo")).status()).toBe(200);
      await expect(page.locator("#chat-items")).toContainText("third answer");
      await expect(other.locator("#chat-items")).toContainText("third answer");
      await expect(page.locator("#preview")).toContainText("Third state");
      await expect(other.locator("#chat-input")).toHaveValue("other client's private draft");
      expect(promptRequests).toBe(0);
    } finally {
      await secondContext.close();
    }
  });

  test("pauses and removes queued messages, then commits a replacement before the older queue", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await control(request, { action: "declareOnly", capabilities: CAPABILITIES });
    const seeded = await control<ConversationSnapshot>(request, {
      action: "seed",
      title: "Replacement branch",
      items: [{ id: "message:base", type: "user_message", createdAt: 1, text: "base instruction" }],
    });
    const conversationId = seeded.conversation.id;
    await openClient(page, await token(request), conversationId);

    await send(page, "discarded active turn");
    await send(page, "older queued turn");
    await send(page, "remove this queued turn");
    await expect(page.locator("#chat-queue .is-held")).toHaveCount(2);

    expect((await historyCommand(page, "undo")).status()).toBe(200);
    await expect(page.locator("#chat-input")).toHaveValue("discarded active turn");
    await expect(page.locator("#chat-items")).not.toContainText("discarded active turn");
    await expect(page.locator("#chat-queue .is-held")).toHaveCount(2);

    await control(request, { action: "status", conversationId, status: "idle" });
    await expect(page.locator("#chat-queue .is-held")).toHaveCount(2);
    await expect(page.locator("#chat-items")).not.toContainText("older queued turn");

    const removal = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().includes("/queue/"));
    await page.locator("#chat-queue .is-held", { hasText: "remove this queued turn" }).locator("[data-queue-remove]").click();
    expect((await removal).status()).toBe(200);
    await expect(page.locator("#chat-queue .is-held")).toHaveCount(1);

    const replacement = await send(page, "replacement turn");
    expect(replacement.status()).toBe(202);
    expect(await replacement.json()).toMatchObject({ held: false });
    await expect(page.locator("#chat-items")).toContainText("replacement turn");
    await expect(page.locator("#chat-items")).not.toContainText("discarded active turn");
    await expect(page.locator("#chat-queue .is-held")).toContainText("older queued turn");

    await control(request, { action: "status", conversationId, status: "completed" });
    await expect(page.locator("#chat-queue .is-held")).toHaveCount(0);
    const userTurns = await page.locator("#chat-items .chat-user-message").allTextContents();
    expect(userTurns).toEqual(expect.arrayContaining([expect.stringContaining("replacement turn"), expect.stringContaining("older queued turn")]));
    expect(userTurns.findIndex(text => text.includes("replacement turn"))).toBeLessThan(userTurns.findIndex(text => text.includes("older queued turn")));

    expect((await historyCommand(page, "redo")).status()).toBe(200);
    await expect(page.locator("#chat-composer-status-live")).toHaveText("Nothing to redo");
    await expect(page.locator("#chat-items")).not.toContainText("discarded active turn");
  });

  test("resumes a paused queue when Redo clears the staged boundary", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await control(request, { action: "declareOnly", capabilities: CAPABILITIES });
    const seeded = await control<ConversationSnapshot>(request, {
      action: "seed",
      title: "Redo queue resume",
      items: [{ id: "message:base", type: "user_message", createdAt: 1, text: "base instruction" }],
    });
    const conversationId = seeded.conversation.id;
    await openClient(page, await token(request), conversationId);

    await send(page, "active turn");
    await send(page, "queued after active turn");
    expect((await historyCommand(page, "undo")).status()).toBe(200);
    await control(request, { action: "status", conversationId, status: "idle" });
    await expect(page.locator("#chat-queue .is-held")).toContainText("queued after active turn");
    await expect(page.locator("#chat-items")).not.toContainText("queued after active turn");

    expect((await historyCommand(page, "redo")).status()).toBe(200);
    await expect(page.locator("#chat-queue .is-held")).toHaveCount(0);
    await expect(page.locator("#chat-items")).toContainText("active turn");
    await expect(page.locator("#chat-items .chat-user-message").last()).toContainText("queued after active turn");
  });

  test.describe("touch commands", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("uses dedicated idempotent endpoints and recovers from one-shot failures and no-ops", async ({ page, request }) => {
      await request.post("/__e2e/reset");
      await control(request, { action: "declareOnly", capabilities: CAPABILITIES });
      const seeded = await control<ConversationSnapshot>(request, {
        action: "seed",
        title: "Touch history",
        items: historyItems(),
      });
      const conversationId = seeded.conversation.id;
      await openClient(page, await token(request), conversationId);
      let promptRequests = 0;
      page.on("request", request => {
        if (new URL(request.url()).pathname.endsWith("/prompts")) promptRequests += 1;
      });

      const first = await postHistory(page, conversationId, "undo", "fixed-undo");
      const retry = await postHistory(page, conversationId, "undo", "fixed-undo");
      expect(first).toEqual(retry);
      expect(first).toMatchObject({ status: 200, body: { outcome: "changed", restoredDraft: { text: "third instruction" } } });
      await expect(page.locator("#chat-items")).not.toContainText("third instruction");
      const stats = await control<{ reversibleAttempts: Array<{ requestId: string }> }>(request, { action: "stats" });
      expect(stats.reversibleAttempts.filter(attempt => attempt.requestId === "fixed-undo")).toHaveLength(1);

      expect((await postHistory(page, conversationId, "redo", "fixed-redo")).status).toBe(200);
      await expect(page.locator("#chat-items")).toContainText("third answer");
      await control(request, { action: "failUndo" });
      const failed = await historyCommand(page, "undo");
      expect(failed.status()).toBe(500);
      await expect(page.locator("#chat-composer-error")).toContainText("Undo failed");
      await expect(page.locator("#chat-composer-error")).toContainText("Command and attachments kept");
      await expect(page.locator("#chat-input")).toHaveValue("/undo");
      await expect(page.locator("#chat-items")).toContainText("third answer");

      expect((await historyCommand(page, "undo")).status()).toBe(200);
      await expect(page.locator("#chat-input")).toHaveValue("third instruction");
      await control(request, { action: "failRedo" });
      const failedRedo = await historyCommand(page, "redo");
      expect(failedRedo.status()).toBe(500);
      await expect(page.locator("#chat-composer-error")).toContainText("Redo failed");
      await expect(page.locator("#chat-input")).toHaveValue("/redo");
      await expect(page.locator("#chat-items")).not.toContainText("third instruction");
      expect((await historyCommand(page, "redo")).status()).toBe(200);
      await expect(page.locator("#chat-items")).toContainText("third answer");

      expect((await historyCommand(page, "undo")).status()).toBe(200);
      await expect(page.locator("#chat-input")).toHaveValue("third instruction");
      expect((await historyCommand(page, "undo")).status()).toBe(200);
      await expect(page.locator("#chat-input")).toHaveValue("second instruction");
      expect((await historyCommand(page, "undo")).status()).toBe(200);
      await expect(page.locator("#chat-input")).toHaveValue("first instruction");
      expect((await historyCommand(page, "undo")).status()).toBe(200);
      await expect(page.locator("#chat-composer-status-live")).toHaveText("Nothing more to undo");

      expect((await historyCommand(page, "redo")).status()).toBe(200);
      expect((await historyCommand(page, "redo")).status()).toBe(200);
      expect((await historyCommand(page, "redo")).status()).toBe(200);
      expect((await historyCommand(page, "redo")).status()).toBe(200);
      await expect(page.locator("#chat-items")).toContainText("third answer");
      expect((await historyCommand(page, "redo")).status()).toBe(200);
      await expect(page.locator("#chat-composer-status-live")).toHaveText("Nothing to redo");
      expect(promptRequests).toBe(0);
    });
  });
});
