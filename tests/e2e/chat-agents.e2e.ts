import type { APIRequestContext, Page } from "@playwright/test";

import { openChatPanel } from "./chat-helpers";
import { captureScreenshot } from "./evidence";
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
  // These tests seed conversations after boot. Wait for both inventory
  // subscriptions so seeding cannot fall between the initial list and SSE.
  for (const agent of ["opencode", "claude"]) {
    await expect.poll(async () => {
      const stats = await control(request, { action: "stats", agent }) as { inventorySubscribers: number };
      return stats.inventorySubscribers;
    }).toBeGreaterThan(0);
  }
}

test.describe("multi-agent chat", () => {
  test("enabling a second fixture agent replaces lingering inventory subscriptions", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
    await page.goto(`/?t=${encodeURIComponent(token.token)}`);
    await openChatPanel(page);
    // Establish the single-agent upstream before swapping the fixture router.
    // It can survive a page reload in the broker's linger window.
    await expect.poll(async () => {
      const stats = await control(request, { action: "stats" }) as { inventorySubscribers: number };
      return stats.inventorySubscribers;
    }).toBeGreaterThan(0);
    await control(request, { action: "agents", count: 2 });
    await page.reload();
    await openChatPanel(page);
    // The replacement upstream reaches the newly enabled agent. (A seed that
    // lands before the page's own inventory attach is still announced: every
    // first attach gets an opening tick, lingering upstream or not.)
    await expect.poll(async () => {
      const stats = await control(request, { action: "stats", agent: "claude" }) as { inventorySubscribers: number };
      return stats.inventorySubscribers;
    }).toBeGreaterThan(0);
    const seeded = await control(request, {
      action: "seed", agent: "claude", title: "Newly enabled agent", items: [],
    }) as { conversation: { id: string } };
    await expect(page.locator("#chat-conversation-select option", { hasText: "Newly enabled agent" })).toHaveCount(1);
    await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
    await expect(page.locator("#chat-context")).toContainText("Claude Code");
  });

  test("the chooser files both agents' conversations under the day of their last activity", async ({ page, request }, testInfo) => {
    await bootDualAgentChat(page, request);
    // Local wall-clock instants in the runner's zone, which the browser shares;
    // all in the past, so no clamping to "now" is involved.
    const now = new Date();
    const at = (daysAgo: number, hour: number, minute = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, minute).getTime();
    const olderDay = at(3, 12);
    await control(request, { action: "seed", agent: "opencode", title: "OpenCode earlier", items: [], updatedAt: olderDay });
    await control(request, { action: "seed", agent: "claude", title: "Claude yesterday", items: [], updatedAt: at(1, 18, 5) });
    await control(request, { action: "seed", agent: "opencode", title: "OpenCode yesterday", items: [], updatedAt: at(1, 9, 30) });
    await control(request, { action: "seed", agent: "claude", title: "Claude today", items: [], updatedAt: at(0, 0, 1) });
    const select = page.locator("#chat-conversation-select");
    await expect(select.locator("option", { hasText: "OpenCode earlier" })).toHaveCount(1);

    const expected = await page.evaluate(([older, yesterdayClaude, yesterdayOpen, today]) => {
      // 24-hour clock and ISO date whatever the locale; only the weekday is the locale's.
      const pad = (value: number) => String(value).padStart(2, "0");
      const clock = (value: number) => `${pad(new Date(value).getHours())}:${pad(new Date(value).getMinutes())}`;
      const day = new Date(older);
      return {
        older: `${day.toLocaleDateString([], { weekday: "short" })} ${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`,
        times: [clock(today), clock(yesterdayClaude), clock(yesterdayOpen), clock(older)],
      };
    }, [olderDay, at(1, 18, 5), at(1, 9, 30), at(0, 0, 1)]);
    const groups = await select.locator("optgroup").evaluateAll(nodes => nodes.map(node => [
      (node as HTMLOptGroupElement).label,
      Array.from(node.querySelectorAll("option")).map(option => option.textContent),
    ]));
    expect(groups).toEqual([
      ["Today", [`Claude today · Claude Code · ${expected.times[0]}`]],
      ["Yesterday", [`Claude yesterday · Claude Code · ${expected.times[1]}`, `OpenCode yesterday · OpenCode · ${expected.times[2]}`]],
      [expected.older, [`OpenCode earlier · OpenCode · ${expected.times[3]}`]],
    ]);

    // The native popup is drawn by the platform and cannot be captured, so
    // the evidence shows the same options as an in-page list box.
    await select.evaluate(element => {
      const list = element as HTMLSelectElement;
      list.size = list.options.length + list.querySelectorAll("optgroup").length;
      list.style.flex = "0 0 auto";
      list.style.width = "20rem";
      list.style.maxWidth = "none";
    });
    await captureScreenshot(page, testInfo, "conversation-picker-days");
  });

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

  test("a Claude Code permission card states Claude Code's own reach and never names OpenCode", async ({ page, request }, testInfo) => {
    await bootDualAgentChat(page, request);
    const seeded = await control(request, { action: "seed", agent: "claude", title: "Claude permission", items: [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "Fix the greeting" },
    ] }) as { conversation: { id: string } };
    await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
    await expect(page.locator("#chat-context")).toContainText("Claude Code");
    await control(request, { action: "item", conversationId: seeded.conversation.id, item: {
      id: "permission:perm-c1", type: "permission", createdAt: 10, requestId: "perm-c1", action: "Claude wants to edit hello.sh", resources: ["/workspace/hello.sh"], status: "pending",
      // What Claude Code's always reply installs, in its own rule syntax.
      alwaysPatterns: ["Allow: Edit(/workspace/hello.sh)"],
      diff: "@@ -1 +1 @@\n-echo hello\n+echo Hello, world",
    } });
    const card = page.locator('[data-chat-item-id="permission:perm-c1"]');
    await expect(card.getByRole("button", { name: "Allow always" })).toBeVisible();
    // The scope line is the owning agent's own sentence (spec: names only
    // that agent) — the OpenCode sentence must not leak onto a Claude card.
    await expect(card.locator(".chat-request-scope")).toContainText("rest of this turn");
    await expect(card).not.toContainText("OpenCode");
    await captureScreenshot(page, testInfo, "phase1-permission-card-claude");

    // The confirmation lists Claude Code's rule under Claude Code's own
    // lifetime sentence, and again never names OpenCode.
    await card.getByRole("button", { name: "Allow always" }).click();
    const claudeStage = card.locator("[data-permission-confirming]");
    await expect(claudeStage.locator(".chat-request-always code")).toHaveText(["Allow: Edit(/workspace/hello.sh)"]);
    await expect(claudeStage.locator(".chat-request-scope")).toContainText("rest of this turn");
    await expect(claudeStage).not.toContainText("OpenCode");
    await page.setViewportSize({ width: 1400, height: 1000 });
    await captureScreenshot(page, testInfo, "after-confirmation-claude-desktop");
    await claudeStage.getByRole("button", { name: "Cancel" }).click();
    await expect(claudeStage).toBeHidden();

    // The OpenCode-owned conversation keeps OpenCode's own sentence, and its
    // confirmation lists OpenCode's own pattern.
    const opencode = await control(request, { action: "seed", title: "OpenCode permission", items: [] }) as { conversation: { id: string } };
    await page.locator("#chat-conversation-select").selectOption(opencode.conversation.id);
    await control(request, { action: "item", conversationId: opencode.conversation.id, item: {
      id: "permission:perm-o1", type: "permission", createdAt: 10, requestId: "perm-o1", action: "bash", resources: ["bun test"], alwaysPatterns: ["bun test *"], status: "pending",
    } });
    const opencodeCard = page.locator('[data-chat-item-id="permission:perm-o1"]');
    await expect(opencodeCard.locator(".chat-request-scope")).toContainText("until OpenCode restarts");
    await opencodeCard.getByRole("button", { name: "Allow always" }).click();
    const opencodeStage = opencodeCard.locator("[data-permission-confirming]");
    await expect(opencodeStage.locator(".chat-request-always code")).toHaveText(["bun test *"]);
    await expect(opencodeStage.locator(".chat-request-scope")).toContainText("until OpenCode restarts");
    await expect(opencodeStage).not.toContainText("rest of this turn");
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
