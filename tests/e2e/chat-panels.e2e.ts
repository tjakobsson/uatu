import type { APIRequestContext, Page } from "@playwright/test";

import type { ConversationItem } from "../../src/chat/types";
import { openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

async function bootChat(page: Page, request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset");
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading OpenCode");
}

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<unknown> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function seedAndOpen(page: Page, request: APIRequestContext, title: string, items: ConversationItem[]): Promise<string> {
  const seeded = await control(request, { action: "seed", title, items }) as { conversation: { id: string } };
  await page.reload();
  await openChatPanel(page);
  await expect(page.locator("#chat-conversation-select")).toHaveValue(seeded.conversation.id);
  return seeded.conversation.id;
}

function readTool(id: string, file: string): ConversationItem {
  return { id: `tool:${id}`, type: "tool", createdAt: 5, name: "read", status: "completed", input: JSON.stringify({ filePath: file }) };
}

function todoWrite(id: string, states: string[]): ConversationItem {
  return {
    id: `tool:${id}`,
    type: "tool",
    createdAt: 6,
    name: "todowrite",
    status: "completed",
    input: JSON.stringify({ todos: ["Review structure", "Implement change", "Verify results"].map((content, index) => ({ content, status: states[index] })) }),
  };
}

test.describe("chat panels and navigation", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("a finished run of tool calls collapses behind one group line", async ({ page, request }) => {
    await seedAndOpen(page, request, "Grouping", [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "inspect things" },
      readTool("a", "a.ts"),
      readTool("b", "b.ts"),
      readTool("c", "c.ts"),
      { id: "part:answer", type: "assistant_message", createdAt: 9, markdown: "All read." },
    ]);

    const group = page.locator(".chat-activity-group");
    await expect(group).toHaveCount(1);
    await expect(group.locator(".chat-group-count")).toHaveText("3 steps");
    await expect(group.locator("> summary .chat-activity-subject")).toHaveText("Read ×3");
    await expect(group.locator('[data-chat-item-id="tool:a"]')).toHaveCount(1);
    await expect(group.locator('[data-chat-item-id="tool:a"]')).toBeHidden();
    await group.locator("summary").first().click();
    await expect(group.locator('[data-chat-item-id="tool:a"]')).toBeVisible();
  });

  test("the live task list pins progress above the composer", async ({ page, request }) => {
    const id = await seedAndOpen(page, request, "Tasks", [todoWrite("t1", ["pending", "pending", "pending"])]);

    const panel = page.locator("#chat-task-list");
    await expect(panel).toBeVisible();
    await expect(panel.locator("summary")).toContainText("0/3 tasks · Review structure");

    await control(request, { action: "item", conversationId: id, item: todoWrite("t2", ["completed", "in_progress", "pending"]) });
    await expect(panel.locator("summary")).toContainText("1/3 tasks · Implement change");

    await panel.locator("summary").click();
    await expect(panel.locator("#chat-task-list-items li")).toHaveCount(3);
    await expect(panel.locator("#chat-task-list-items li.is-done")).toHaveText("Review structure");
  });

  test("subagents pin as a track, dismiss finished, and open their transcript", async ({ page, request }) => {
    const child = await control(request, { action: "seed", title: "Child transcript", items: [
      { id: "part:child", type: "assistant_message", createdAt: 1, markdown: "child findings" },
    ] }) as { conversation: { id: string } };
    await seedAndOpen(page, request, "Fan-out", [
      { id: "tool:agent1", type: "tool", createdAt: 2, name: "task", status: "completed", input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }), childConversationId: child.conversation.id },
      { id: "tool:agent2", type: "tool", createdAt: 3, name: "task", status: "running", input: JSON.stringify({ description: "Audit styles", subagent_type: "general", prompt: "go" }) },
    ]);

    const track = page.locator("#chat-subagents");
    await expect(track).toBeVisible();
    await expect(track.locator("summary")).toContainText("1 of 2 agents working · Audit styles");

    await track.locator("summary").click();
    await expect(track.locator("li")).toHaveCount(2);
    await track.getByRole("button", { name: "explore · Review renderer" }).click();
    await expect(page.locator("#chat-items")).toContainText("child findings");
    // The e2e fake lists every conversation, so the child is selected via its
    // existing option; the real adapter hides children and inserts an
    // interim "↳" option instead. Either way the picker tracks the child.
    await expect(page.locator("#chat-conversation-select")).toHaveValue(child.conversation.id);
  });

  test("dismiss finished clears completed subagents but keeps running ones", async ({ page, request }) => {
    await seedAndOpen(page, request, "Dismissal", [
      { id: "tool:agent1", type: "tool", createdAt: 2, name: "task", status: "completed", input: JSON.stringify({ description: "Done work", prompt: "go" }) },
      { id: "tool:agent2", type: "tool", createdAt: 3, name: "task", status: "running", input: JSON.stringify({ description: "Still going", prompt: "go" }) },
    ]);

    const track = page.locator("#chat-subagents");
    await track.locator("summary").click();
    await expect(track.locator("li")).toHaveCount(2);
    await page.getByRole("button", { name: "Dismiss finished" }).click();
    await expect(track.locator("li")).toHaveCount(1);
    await expect(track.locator("summary")).toContainText("1 of 1 agent working · Still going");

    // Dismissal is a user statement — reloading the conversation must not
    // resurrect the dismissed strip.
    await page.reload();
    await openChatPanel(page);
    await expect(track).toBeVisible();
    await track.locator("summary").click();
    await expect(track.locator("li")).toHaveCount(1);
    await expect(track.locator("summary")).toContainText("1 of 1 agent working · Still going");
  });

  test("the prompt rail jumps to a prompt and flashes the landing", async ({ page, request }) => {
    await seedAndOpen(page, request, "Rail", [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "first question" },
      { id: "part:a1", type: "assistant_message", createdAt: 2, markdown: "answer one" },
      { id: "message:u2", type: "user_message", createdAt: 3, text: "second question" },
      { id: "part:a2", type: "assistant_message", createdAt: 4, markdown: "answer two" },
      { id: "message:u3", type: "user_message", createdAt: 5, text: "third question" },
    ]);

    const rail = page.locator("#chat-prompt-rail");
    await expect(rail).toBeVisible();
    await expect(rail.locator(".chat-prompt-dot")).toHaveCount(3);

    await rail.locator(".chat-prompt-dot").first().click();
    await expect(page.locator('[data-chat-item-id="message:u1"]')).toHaveClass(/is-jump-target/);

    // Jumping to the newest prompt marks ITS dot active even though the short
    // final exchange cannot scroll to the top of the timeline.
    await rail.locator(".chat-prompt-dot").last().click();
    await expect(page.locator('[data-chat-item-id="message:u3"]')).toHaveClass(/is-jump-target/);
    await expect(rail.locator(".chat-prompt-dot").last()).toHaveClass(/is-active/);
    await expect(rail.locator(".chat-prompt-dot.is-active")).toHaveCount(1);
  });

  test("a finished turn reports how long it worked", async ({ page, request }) => {
    await seedAndOpen(page, request, "Worked", [
      { id: "message:u1", type: "user_message", createdAt: 1_000, text: "do the thing" },
      { id: "status:done", type: "turn_status", createdAt: 8_000, status: "completed" },
    ]);

    await expect(page.locator('[data-chat-item-id="status:done"]')).toContainText("worked 7s");
  });

  test("reasoning reads Thinking while running and Thought with its time once done", async ({ page, request }) => {
    await seedAndOpen(page, request, "Thinking", [
      { id: "part:r1", type: "reasoning", createdAt: 1, text: "pondering", status: "running" },
      { id: "part:r2", type: "reasoning", createdAt: 2, text: "pondered", status: "completed", durationMs: 12_000 },
    ]);

    await expect(page.locator('[data-chat-item-id="part:r1"] summary')).toContainText("Thinking");
    await expect(page.locator('[data-chat-item-id="part:r2"] summary')).toContainText("Thought for 12s");
  });
});
