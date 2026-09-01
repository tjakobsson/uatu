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

  test("a plan approval offers its intents and resolves to the chosen one", async ({ page, request }) => {
    await bootDualAgentChat(page, request);
    const seeded = await control(request, {
      action: "seed", agent: "claude", title: "Plan flow",
      items: [{ id: "message:u1", type: "user_message", createdAt: 1, text: "plan the fix" }],
    }) as { conversation: { id: string } };
    await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
    await expect(page.locator("#chat-items")).toContainText("plan the fix");

    await control(request, { action: "item", conversationId: seeded.conversation.id, item: {
      id: "permission:plan1", type: "permission", createdAt: 2, requestId: "plan1",
      action: "Review the plan", resources: [], status: "pending",
      plan: "## The plan\n\n1. Fix the **bug**",
      choices: [
        { id: "implement", label: "Approve and implement" },
        { id: "implement-and-restore", label: "Approve, then return to acceptEdits" },
      ],
    } });
    // The plan renders as markdown; the generic approve pair is absent.
    await expect(page.locator(".chat-request-plan strong")).toHaveText("bug");
    await expect(page.locator("[data-permission-outcome=approved-once]")).toHaveCount(0);

    await page.locator('[data-permission-choice="implement-and-restore"]').click();
    // The reply carried the chosen intent and the card receded to its label.
    await expect(page.locator(".chat-request-trace")).toHaveText("Approve, then return to acceptEdits");
  });

  test("task progress stays one block across updates and a reopen shows the final state", async ({ page, request }) => {
    await bootDualAgentChat(page, request);
    const seeded = await control(request, {
      action: "seed", agent: "claude", title: "Task flow",
      items: [{ id: "message:u1", type: "user_message", createdAt: 1, text: "do the work" }],
    }) as { conversation: { id: string } };
    const id = seeded.conversation.id;
    await page.locator("#chat-conversation-select").selectOption(id);
    await expect(page.locator("#chat-items")).toContainText("do the work");

    await control(request, { action: "item", conversationId: id, item: {
      id: "task-progress", type: "task_progress", createdAt: 2, entries: [
        { text: "Read the code", status: "in_progress", activeText: "Reading the code" },
        { text: "Fix it", status: "pending" },
      ],
    } });
    await expect(page.locator(".chat-task-progress-count")).toHaveText("0/2");
    await expect(page.locator(".chat-task-progress")).toContainText("Reading the code");

    await control(request, { action: "item", conversationId: id, item: {
      id: "task-progress", type: "task_progress", createdAt: 2, entries: [
        { text: "Read the code", status: "completed" },
        { text: "Fix it", status: "in_progress" },
      ],
    } });
    await expect(page.locator(".chat-task-progress")).toHaveCount(1);
    await expect(page.locator(".chat-task-progress-count")).toHaveText("1/2");

    // A reload rebuilds the surface from the authoritative snapshot.
    await page.reload();
    await openChatPanel(page);
    await expect(page.locator(".chat-task-progress")).toHaveCount(1);
    await expect(page.locator(".chat-task-progress-count")).toHaveText("1/2");
  });

  test("a claude conversation answers interactions and drills into its subagent", async ({ page, request }) => {
    await bootDualAgentChat(page, request);
    const child = await control(request, {
      action: "seed", agent: "claude", title: "Child", child: true,
      items: [{ id: "part:c1", type: "assistant_message", createdAt: 3, markdown: "child findings" }],
    }) as { conversation: { id: string } };
    const seeded = await control(request, {
      action: "seed", agent: "claude", title: "Interactions",
      items: [
        { id: "tool:agent1", type: "tool", createdAt: 2, name: "task", status: "completed", input: JSON.stringify({ description: "Inspect", subagent_type: "explore", prompt: "go" }), childConversationId: child.conversation.id },
      ],
    }) as { conversation: { id: string } };
    const id = seeded.conversation.id;
    await page.locator("#chat-conversation-select").selectOption(id);

    // Permission round trip on the claude-owned conversation.
    await control(request, { action: "item", conversationId: id, item: {
      id: "permission:p1", type: "permission", createdAt: 4, requestId: "p1",
      action: "Write marker.txt", resources: ["marker.txt"], status: "pending",
    } });
    await page.locator("[data-permission-outcome=approved-once]").click();
    await expect(page.locator(".chat-request-trace")).toHaveText("Allowed once");

    // Question rejection keeps the surface usable.
    await control(request, { action: "item", conversationId: id, item: {
      id: "question:q1", type: "question", createdAt: 5, requestId: "q1", status: "pending",
      questions: [{ prompt: "Proceed?", header: "Next", options: [{ label: "Yes", description: "" }], multiple: false, allowFreeForm: false }],
    } });
    await page.locator("[data-question-reject]").click();
    await expect(page.locator("#chat-items details.chat-request").last()).toContainText("Rejected");

    // The subagent opens as a drill-down and returns.
    await page.locator("#chat-subagents summary").click();
    await page.getByRole("button", { name: "explore · Inspect" }).click();
    await expect(page.locator("#chat-drilldown-items")).toContainText("child findings");
    await expect(page.locator("#chat-conversation-select")).toHaveValue(id);
    await page.locator("#chat-drilldown-back").click();
    await expect(page.locator("#chat-items")).toContainText("Inspect");
  });
});
