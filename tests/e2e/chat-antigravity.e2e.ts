import type { APIRequestContext, Page } from "@playwright/test";

import { openChatPanel } from "./chat-helpers";
import { captureScreenshot } from "./evidence";
import { expect, test } from "./fixtures";

// Antigravity as the third agent, over the harness's Antigravity-shaped fake
// (tests/e2e/server.ts): the picker order, its login notice, a conversation,
// and a steer taken into the running turn.

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<unknown> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function boot(page: Page, request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset");
  await control(request, { action: "agents", count: 3 });
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
}

async function newAntigravityConversation(page: Page): Promise<string> {
  await page.locator("#chat-new-conversation").click();
  await page.locator("#chat-agent-menu .chat-agent-menu__item", { hasText: "Antigravity" }).click();
  await expect(page.locator("#chat-context")).toContainText("Antigravity");
  const id = await page.locator("#chat-conversation-select").inputValue();
  expect(id.startsWith("antigravity:")).toBe(true);
  return id;
}

async function submit(page: Page, text: string): Promise<void> {
  await page.locator("#chat-input").fill(text);
  const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
  await page.locator("#chat-send").click();
  expect((await accepted).ok()).toBe(true);
}

test("the picker offers OpenCode, Claude Code and Antigravity in that order, and an Antigravity turn takes a steer once", async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await boot(page, request);
  await page.locator("#chat-new-conversation").click();
  const items = page.locator("#chat-agent-menu .chat-agent-menu__item");
  await expect(items).toHaveCount(3);
  const labels = await items.allTextContents();
  expect(["OpenCode", "Claude Code", "Antigravity"].map(name => labels.findIndex(label => label.includes(name)))).toEqual([0, 1, 2]);
  await page.keyboard.press("Escape");

  const conversationId = await newAntigravityConversation(page);
  await submit(page, "Summarize the README");
  await expect(page.locator("#chat-stop")).toBeEnabled();

  // Busy Send steers at once: one timeline row, no pending Steer entry.
  await expect(page.locator("#chat-send")).toHaveAttribute("aria-label", "Send as steer; hold 2.5 seconds to queue");
  await submit(page, "Keep it to one line");
  const steer = page.locator("#chat-items [data-chat-item-id^='message:']").filter({ hasText: "Keep it to one line" });
  // Sent at once, confirmed when the turn carrying it ends.
  await expect(page.locator("#chat-items .is-pending").filter({ hasText: "Keep it to one line" })).toContainText("waiting for the agent to confirm");
  await expect(page.locator(".chat-queued-message")).toHaveCount(0);

  await control(request, { action: "item", agent: "antigravity", conversationId, item: { id: "message:reply", type: "assistant_message", createdAt: Date.now(), markdown: "A fixture workspace for UatuCode's tests." } });
  await control(request, { action: "status", agent: "antigravity", conversationId, status: "completed" });
  await expect(page.locator("#chat-items")).toContainText("A fixture workspace for UatuCode's tests.");
  await expect(page.locator("#chat-stop")).toBeDisabled();
  await expect(steer).toHaveCount(1);
  await expect(page.locator("#chat-items .is-pending")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "antigravity-conversation-desktop");
});

test("without a login, Antigravity's notice says to run agy, with no Agent accounts link", async ({ page, request }, testInfo) => {
  await boot(page, request);
  await control(request, { action: "login", agent: "antigravity", login: "missing" });
  await newAntigravityConversation(page);
  const notice = page.locator("#chat-login-notice");
  await expect(notice).toContainText("Antigravity is not logged in.");
  await expect(notice).toContainText("Run agy where UatuCode runs.");
  await expect(notice.locator("a")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "antigravity-login-notice-desktop");
});

test("creating an Antigravity conversation without a login says to run agy and shows the login notice", async ({ page, request }) => {
  await boot(page, request);
  await control(request, { action: "login", agent: "antigravity", login: "missing", silent: true });
  await control(request, { action: "refuseCreationForLogin", agent: "antigravity" });
  const created = page.waitForResponse(response => response.url().endsWith("/api/chat/conversations") && response.request().method() === "POST");
  await page.locator("#chat-new-conversation").click();
  await page.locator("#chat-agent-menu .chat-agent-menu__item", { hasText: "Antigravity" }).click();
  const response = await created;
  expect(response.status()).toBe(409);
  expect(await response.json()).toEqual(expect.objectContaining({ code: "agent-login-required" }));
  await expect(page.locator("#chat-state")).toContainText("Antigravity is not logged in. Run agy where UatuCode runs and sign in.");
  // The picker stays usable: another agent's conversation can still be created.
  await page.locator("#chat-new-conversation").click();
  await page.locator("#chat-agent-menu .chat-agent-menu__item", { hasText: "OpenCode" }).click();
  await expect(page.locator("#chat-conversation-select")).toHaveValue(/^opencode:/);
});
