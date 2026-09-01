import type { APIRequestContext, Page } from "@playwright/test";

import { openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<unknown> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function bootDualAgentChat(page: Page, request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset");
  await control(request, { action: "agents", count: 2 });
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
}

test.describe("multi-agent chat", () => {
  test("creation offers the agents, the chooser attributes them, and the header follows the selection", async ({ page, request }) => {
    await bootDualAgentChat(page, request);

    // Creation asks which agent the conversation belongs to.
    await page.locator("#chat-new-conversation").click();
    const menu = page.locator("#chat-agent-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".chat-agent-menu__item")).toHaveCount(2);
    await menu.locator(".chat-agent-menu__item", { hasText: "Claude Code" }).click();
    await expect(menu).toBeHidden();
    await expect(page.locator("#chat-context")).toContainText("Claude Code");
    const claudeConversationId = await page.locator("#chat-conversation-select").inputValue();
    expect(claudeConversationId.startsWith("claude:")).toBe(true);

    // A second conversation under the other agent.
    await page.locator("#chat-new-conversation").click();
    await page.locator("#chat-agent-menu .chat-agent-menu__item", { hasText: "OpenCode" }).click();
    // The identity row takes its name from the agent's own declaration —
    // this harness agent declares itself "Fixture Agent".
    await expect(page.locator("#chat-context")).toContainText("Fixture Agent");
    const opencodeConversationId = await page.locator("#chat-conversation-select").inputValue();
    expect(opencodeConversationId.startsWith("opencode:")).toBe(true);

    // The chooser attributes each conversation to its agent.
    const optionLabels = await page.locator("#chat-conversation-select option:not([data-chat-inventory-placeholder])").allTextContents();
    expect(optionLabels.some(label => label.includes("· Claude Code"))).toBe(true);
    expect(optionLabels.some(label => label.includes("· OpenCode"))).toBe(true);

    // The identity row follows the selected conversation's owning agent.
    await page.locator("#chat-conversation-select").selectOption(claudeConversationId);
    await expect(page.locator("#chat-context")).toContainText("Claude Code");
    await expect(page.locator("#chat-input")).toHaveAttribute("placeholder", /Claude Code/);
    await page.locator("#chat-conversation-select").selectOption(opencodeConversationId);
    await expect(page.locator("#chat-context")).toContainText("Fixture Agent");
    await expect(page.locator("#chat-input")).toHaveAttribute("placeholder", /Fixture Agent/);
  });

  test("a single-agent workspace creates without offering a choice", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
    await page.goto(`/?t=${encodeURIComponent(token.token)}`);
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await openChatPanel(page);

    await page.locator("#chat-new-conversation").click();
    await expect(page.locator("#chat-agent-menu")).toHaveCount(0);
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    // Without a peer to distinguish from, the chooser stays unattributed.
    const optionLabels = await page.locator("#chat-conversation-select option:not([data-chat-inventory-placeholder])").allTextContents();
    expect(optionLabels.every(label => !label.includes("· OpenCode"))).toBe(true);
  });

  test("an unavailable agent is explained at creation and cannot own the new conversation", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await control(request, { action: "agents", count: 2 });
    await control(request, { action: "failStartup", agent: "claude" });
    const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
    await page.goto(`/?t=${encodeURIComponent(token.token)}`);
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    await openChatPanel(page);

    await page.locator("#chat-new-conversation").click();
    const unavailable = page.locator("#chat-agent-menu .chat-agent-menu__item.is-unavailable");
    await expect(unavailable).toHaveCount(1);
    await expect(unavailable).toContainText("Claude Code");
    // Choosing it does not create a conversation (aria-disabled: Playwright
    // needs force to deliver the click at all).
    await unavailable.click({ force: true });
    await expect(page.locator("#chat-agent-menu")).toBeVisible();
    // The available agent still works. (By data attribute: the unavailable
    // item's failure message also mentions the other agent's name.)
    await page.locator('#chat-agent-menu .chat-agent-menu__item[data-agent-id="opencode"]').click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
  });
});
