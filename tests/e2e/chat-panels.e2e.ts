import path from "node:path";
import { fileURLToPath } from "node:url";

import type { APIRequestContext, Page } from "@playwright/test";

import type { ConversationConfiguration, ConversationItem } from "../../src/chat/types";
import { captureScreenshot, chooseChatModel, openChatConfiguration, openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

// Where the zen-chat-activity change keeps its evidence: the working line's
// closed and open forms, a failed dot, and the phone width.
const ZEN_SCREENSHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../openspec/changes/zen-chat-activity/screenshots");

async function bootChat(page: Page, request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset");
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
}

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<unknown> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function seedAndOpen(
  page: Page,
  request: APIRequestContext,
  title: string,
  items: ConversationItem[],
  configuration?: ConversationConfiguration,
): Promise<string> {
  const seeded = await control(request, { action: "seed", title, items, ...(configuration ? { configuration } : {}) }) as { conversation: { id: string } };
  await page.reload();
  await openChatPanel(page);
  await expect(page.locator("#chat-conversation-select")).toHaveValue(seeded.conversation.id);
  return seeded.conversation.id;
}

function readTool(id: string, file: string): ConversationItem {
  return { id: `tool:${id}`, type: "tool", createdAt: 5, name: "read", status: "completed", input: JSON.stringify({ filePath: file }) };
}

function bash(id: string, createdAt: number, command: string, status: "running" | "completed", output?: string): ConversationItem {
  return { id, type: "tool", createdAt, name: "Bash", status, input: JSON.stringify({ command, description: `Run ${command.split(" ")[0]}` }), ...(output === undefined ? {} : { output }) };
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
    await expect(group).toHaveAttribute("data-outcome", "clean");
    await expect(group.locator(".chat-group-count")).toHaveText("3 steps");
    await expect(group.locator("> summary .chat-activity-subject")).toHaveText("Read a.ts · Read b.ts · Read c.ts");
    await expect(group.locator('[data-chat-item-id="tool:a"]')).toHaveCount(1);
    await expect(group.locator('[data-chat-item-id="tool:a"]')).toBeHidden();
    await group.locator("summary").first().click();
    await expect(group.locator('[data-chat-item-id="tool:a"]')).toBeVisible();
  });

  test("the working line carries a turn from nothing-back-yet through its steps to done, and stays open if opened", async ({ page, request }, testInfo) => {
    // The change's desktop evidence is captured at 1400x1000 so the before
    // and after shots line up.
    await page.setViewportSize({ width: 1400, height: 1000 });
    // A real prompt time: the working line's clock counts from it, and the
    // steps land after it — the timeline orders by createdAt.
    const started = Date.now() - 20_000;
    const at = (seconds: number) => started + seconds * 1_000;
    const id = await seedAndOpen(page, request, "Working line", [
      { id: "message:u1", type: "user_message", createdAt: started, text: "Run hello.sh, list the folder, then read the notes" },
    ]);
    await control(request, { action: "status", conversationId: id, status: "running" });
    // Nothing back yet: the line is already there, live, with its clock.
    const line = page.locator(".chat-activity-group");
    await expect(line).toHaveCount(1);
    await expect(line).toHaveClass(/is-awaiting/);
    await expect(line).toHaveAttribute("data-outcome", "live");
    await expect(line.locator(".chat-group-count")).toHaveText(/^Working · \d+s$/);
    const awaitingBox = await line.boundingBox();

    // The first step joins the same line: one line, same place, now a group
    // naming the step in flight.
    await control(request, { action: "item", conversationId: id, item: { id: "reasoning:1", type: "reasoning", createdAt: at(1), text: "Plan the three steps.", status: "running" } });
    await expect(line).toHaveCount(1);
    await expect(line).not.toHaveClass(/is-awaiting/);
    await expect(line.locator("> summary .chat-activity-subject")).toHaveText("Thinking");
    await expect(line.locator("> summary .chat-group-count")).toHaveText(/^Working · \d+s$/);
    expect(Math.abs((await line.boundingBox())!.y - awaitingBox!.y)).toBeLessThan(2);

    await control(request, { action: "item", conversationId: id, item: { id: "reasoning:1", type: "reasoning", createdAt: at(1), text: "Plan the three steps.", status: "completed", durationMs: 3000 } });
    await control(request, { action: "item", conversationId: id, item: bash("tool:1", at(4), "./hello.sh", "completed", "Hello from hello.sh") });
    await control(request, { action: "item", conversationId: id, item: bash("tool:2", at(5), "ls -la", "completed", "total 3\ndocs\nhello.sh\nREADME.md") });
    await control(request, { action: "item", conversationId: id, item: { id: "tool:3", type: "tool", createdAt: at(6), name: "Read", status: "completed", input: JSON.stringify({ file_path: "docs/notes.md" }), output: "# Notes" } });
    await control(request, { action: "item", conversationId: id, item: bash("tool:4", at(7), "sleep 20 && echo done", "running", "still going") });
    await expect(line).toHaveCount(1);
    await expect(line.locator("> summary .chat-activity-subject")).toHaveText("Bash sleep 20 && echo done");
    await expect(page.locator('[data-chat-item-id="tool:1"]')).toBeHidden();
    await captureScreenshot(page, testInfo, ZEN_SCREENSHOTS, "after-working-line-closed-desktop");

    // Opened: the member rows with their state, and the running member with
    // output already open so its tail shows.
    await line.locator("> summary").click();
    await expect(page.locator('[data-chat-item-id="tool:1"]')).toBeVisible();
    await expect(page.locator('[data-chat-item-id="tool:4"]')).toHaveAttribute("open", "");
    await expect(page.locator('[data-chat-item-id="tool:4"] .chat-tool-stream')).toContainText("still going");
    await captureScreenshot(page, testInfo, ZEN_SCREENSHOTS, "after-working-line-open-desktop");

    // Finishing settles the same line into the group summary, still open.
    await control(request, { action: "item", conversationId: id, item: bash("tool:4", at(7), "sleep 20 && echo done", "completed", "done") });
    await control(request, { action: "item", conversationId: id, item: { id: "message:a1", type: "assistant_message", createdAt: at(19), markdown: "All three ran.", completedAt: at(19) } });
    await control(request, { action: "status", conversationId: id, status: "completed" });
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute("data-outcome", "clean");
    await expect(line.locator("> summary .chat-group-count")).toHaveText("5 steps");
    await expect(line.locator("> summary .chat-activity-subject")).toHaveText("Bash ./hello.sh · Bash ls -la · Read docs/notes.md · Thought · Bash");
    await expect(line).toHaveAttribute("open", "");
    await expect(page.locator('[data-chat-item-id="tool:1"]')).toBeVisible();
  });

  test("a failed step reddens the dot, live and once finished, without the line being opened", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    const started = Date.now() - 40_000;
    const id = await seedAndOpen(page, request, "Failed step", [
      { id: "message:u1", type: "user_message", createdAt: started, text: "Read the notes and run the build" },
    ]);
    await control(request, { action: "status", conversationId: id, status: "running" });
    await control(request, { action: "item", conversationId: id, item: { ...readTool("a", "a.ts"), createdAt: started + 1_000 } });
    const line = page.locator(".chat-activity-group");
    await expect(line).toHaveAttribute("data-outcome", "live");
    const dot = line.locator(".chat-group-dot");
    const accent = await dot.evaluate(node => getComputedStyle(node).backgroundColor);

    await control(request, { action: "item", conversationId: id, item: { id: "tool:build", type: "tool", createdAt: started + 2_000, name: "Bash", status: "failed", input: JSON.stringify({ command: "bun run build" }), error: "exit 1" } });
    await control(request, { action: "item", conversationId: id, item: { ...readTool("c", "c.ts"), createdAt: started + 3_000 } });
    await expect(line).toHaveAttribute("data-outcome", "failed");
    await expect(line.locator("> summary .chat-group-count")).toHaveText(/^Working/);
    const danger = await dot.evaluate(node => getComputedStyle(node).backgroundColor);
    expect(danger).not.toBe(accent);

    await control(request, { action: "item", conversationId: id, item: { id: "message:a1", type: "assistant_message", createdAt: started + 9_000, markdown: "The build failed; see the step.", completedAt: started + 9_000 } });
    await control(request, { action: "status", conversationId: id, status: "completed" });
    await expect(line).toHaveAttribute("data-outcome", "failed");
    await expect(line.locator("> summary .chat-group-count")).toHaveText("3 steps");
    await expect(line).not.toHaveAttribute("open", "");
    expect(await dot.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(danger);
    await captureScreenshot(page, testInfo, ZEN_SCREENSHOTS, "after-finished-group-failed-dot-desktop");
  });

  test("reduced motion stills the working line's pulse", async ({ page, request }) => {
    const id = await seedAndOpen(page, request, "Reduced motion", [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "go" },
    ]);
    await control(request, { action: "status", conversationId: id, status: "running" });
    const dot = page.locator(".chat-activity-group .chat-group-dot");
    await expect(dot).toBeVisible();
    expect(await dot.evaluate(node => getComputedStyle(node).animationName)).toBe("chat-live-pulse");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await dot.evaluate(node => getComputedStyle(node).animationName)).toBe("none");
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

  test("a subagent longer than a page can be read back to its start", async ({ page, request }) => {
    // The transcript is fetched a page at a time like any conversation. With
    // no way to ask for the rest, a long subagent simply began mid-story and
    // said nothing about the messages above.
    const child = await control(request, {
      action: "seed", title: "Long child", child: true,
      items: [{ id: "part:child-new", type: "assistant_message", createdAt: 9, markdown: "the newest finding" }],
      older: [{ id: "part:child-old", type: "assistant_message", createdAt: 1, markdown: "the earliest finding" }],
    }) as { conversation: { id: string } };
    await seedAndOpen(page, request, "Fan-out", [
      { id: "tool:agent1", type: "tool", createdAt: 2, name: "task", status: "completed", input: JSON.stringify({ description: "Read it all", subagent_type: "explore", prompt: "go" }), childConversationId: child.conversation.id },
    ]);
    await page.locator("#chat-subagents summary").click();
    await page.getByRole("button", { name: "explore · Read it all" }).click();

    const older = page.locator("#chat-drilldown-older");
    await expect(page.locator("#chat-drilldown-items")).toContainText("the newest finding");
    await expect(older).toBeVisible();
    await older.click();
    await expect(page.locator("#chat-drilldown-items")).toContainText("the earliest finding");
    // One page back is the whole transcript here, so the offer retires.
    await expect(older).toBeHidden();
  });

  test("a subagent's working line keeps ticking while its parent is idle", async ({ page, request }) => {
    // The child is mid-turn on its own; the parent that launched it has
    // settled. The drill-down's working line is stamped from the child's
    // status, and its clock must advance from the child's status too — the
    // parent's idle composer says nothing about the subagent's turn.
    const started = Date.now() - 5_000;
    const child = await control(request, { action: "seed", title: "Busy child", child: true, items: [
      { id: "message:cu", type: "user_message", createdAt: started, text: "go" },
      bash("tool:child1", started + 1_000, "sleep 30", "running"),
    ] }) as { conversation: { id: string } };
    await control(request, { action: "status", conversationId: child.conversation.id, status: "running" });
    await seedAndOpen(page, request, "Idle parent", [
      { id: "tool:agent1", type: "tool", createdAt: 2, name: "task", status: "completed", input: JSON.stringify({ description: "Long task", subagent_type: "explore", prompt: "go" }), childConversationId: child.conversation.id },
    ]);
    await expect(page.locator("#chat-items .chat-activity-group[data-working-since]")).toHaveCount(0);

    await page.locator("#chat-subagents summary").click();
    await page.getByRole("button", { name: "explore · Long task" }).click();
    const line = page.locator("#chat-drilldown-items .chat-activity-group[data-working-since]");
    await expect(line).toHaveCount(1);
    const label = line.locator("> summary .chat-group-count");
    await expect(label).toHaveText(/^Working · \d+s$/);
    const seconds = async () => Number((await label.textContent())!.match(/(\d+)s$/)![1]);
    const first = await seconds();
    await expect.poll(seconds, { timeout: 5_000 }).toBeGreaterThan(first);
  });

  test("a stale pagination failure cannot overwrite a replacement drill-down", async ({ page, request }) => {
    const childB = await control(request, {
      action: "seed", title: "Child B", child: true,
      items: [{ id: "part:b", type: "assistant_message", createdAt: 2, markdown: "child B findings" }],
      older: [{ id: "part:b-old", type: "assistant_message", createdAt: 1, markdown: "older child B finding" }],
    }) as { conversation: { id: string } };
    const childA = await control(request, {
      action: "seed", title: "Child A", child: true,
      items: [{
        id: "tool:nested", type: "tool", createdAt: 2, name: "task", status: "completed", childConversationId: childB.conversation.id,
        input: JSON.stringify({ description: "Open B", subagent_type: "explore", prompt: "go" }),
      }],
      older: [{ id: "part:a-old", type: "assistant_message", createdAt: 1, markdown: "old A finding" }],
    }) as { conversation: { id: string } };
    await seedAndOpen(page, request, "Parent", [{
      id: "tool:open-a", type: "tool", createdAt: 2, name: "task", status: "completed", childConversationId: childA.conversation.id,
      input: JSON.stringify({ description: "Open A", subagent_type: "explore", prompt: "go" }),
    }]);
    await page.locator("#chat-subagents summary").click();
    await page.getByRole("button", { name: "explore · Open A" }).click();
    await expect(page.locator("#chat-drilldown-title")).toHaveText("explore · Open A");

    await control(request, { action: "failOlderHistory" });
    await page.locator("#chat-drilldown-older").click();
    const nested = page.locator('[data-chat-item-id="tool:nested"]');
    await nested.locator(":scope > summary").click();
    await nested.getByRole("button", { name: "Open transcript" }).click();
    await expect(page.locator("#chat-drilldown-title")).toHaveText("explore · Open B");
    await expect(page.locator("#chat-drilldown-items")).toContainText("child B findings");
    await page.waitForTimeout(350);
    await expect(page.locator("#chat-drilldown-state")).not.toContainText("older transcript unavailable");
    await expect(page.locator("#chat-drilldown-older")).toBeEnabled();
    await page.locator("#chat-drilldown-older").click();
    await expect(page.locator("#chat-drilldown-items")).toContainText("older child B finding");
  });

  test("subagents pin as a track, dismiss finished, and open their transcript", async ({ page, request }) => {
    const child = await control(request, { action: "seed", title: "Child transcript", child: true, items: [
      { id: "part:child", type: "assistant_message", createdAt: 1, markdown: "child findings" },
    ] }) as { conversation: { id: string } };
    const parent = await seedAndOpen(page, request, "Fan-out", [
      { id: "part:parent", type: "assistant_message", createdAt: 1, markdown: "parent findings" },
      { id: "tool:agent1", type: "tool", createdAt: 2, name: "task", status: "completed", input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }), childConversationId: child.conversation.id },
      { id: "tool:agent2", type: "tool", createdAt: 3, name: "task", status: "running", input: JSON.stringify({ description: "Audit styles", subagent_type: "general", prompt: "go" }) },
    ]);

    const track = page.locator("#chat-subagents");
    await expect(track).toBeVisible();
    await expect(track.locator("summary")).toContainText("1 of 2 subagents working · Audit styles");
    await expect(page.locator('[data-chat-item-id="part:parent"] [data-chat-copy="answer"]')).toHaveCount(0);

    await track.locator("summary").click();
    await expect(track.locator("li")).toHaveCount(2);
    await track.getByRole("button", { name: "explore · Review renderer" }).click();

    // A drill-down over the parent, not a conversation switch: the child's
    // transcript renders in its own layer and the picker never moves.
    const drilldown = page.locator("#chat-drilldown");
    await expect(drilldown).toBeVisible();
    await expect(page.locator("#chat-drilldown-items")).toContainText("child findings");
    await expect(page.locator("#chat-drilldown-title")).toHaveText("explore · Review renderer");
    await expect(page.locator('#chat-drilldown-items [data-chat-item-id="part:child"] [data-chat-copy="answer"]')).toHaveCount(0);
    await expect(page.locator("#chat-conversation-select")).toHaveValue(parent);
    // The picker lists conversations you can start and resume; a subagent's
    // transcript is neither, so it is absent from it entirely.
    await expect(page.locator(`#chat-conversation-select option[value="${child.conversation.id}"]`)).toHaveCount(0);
    await expect(page.locator("#chat-conversation-select option")).toHaveCount(1);

    // Returning is first-class and does not re-select anything: the parent is
    // still there, still selected, with its own transcript back in view.
    await page.locator("#chat-drilldown-back").click();
    await expect(drilldown).toBeHidden();
    await expect(page.locator("#chat-items")).toContainText("Review renderer");
    await expect(page.locator("#chat-conversation-select")).toHaveValue(parent);

    // Browser Back dismisses the layer here too. One entry per layer in both
    // chromes is what keeps this free of mode-dependent state — and it does
    // not navigate the document behind it, because the entry it pops is the
    // drill-down's own.
    const documentUrl = page.url();
    await page.getByRole("button", { name: "explore · Review renderer" }).click();
    await expect(drilldown).toBeVisible();
    await page.goBack();
    await expect(drilldown).toBeHidden();
    expect(page.url()).toBe(documentUrl);
    await expect(page.locator("#chat-conversation-select")).toHaveValue(parent);
    // The popped drill-down entry remains in the Forward stack, but is retired:
    // forwarding to it returns to the live parent entry instead of parking on
    // an inert same-URL marker.
    await page.goForward();
    await expect.poll(() => page.evaluate(() => (history.state as { chatDrilldown?: string } | null)?.chatDrilldown)).toBeUndefined();
    await expect(drilldown).toBeHidden();

    // A direct close can retire the drill-down below a later document entry.
    // Back skips toward the older live entry; Forward must then skip the same
    // marker in the opposite direction and reach that later entry.
    await page.getByRole("button", { name: "explore · Review renderer" }).click();
    await expect(drilldown).toBeVisible();
    await page.evaluate(() => history.pushState({ laterDocument: true }, "", `${location.pathname}${location.search}#later`));
    await page.locator("#chat-drilldown-back").click();
    await expect(drilldown).toBeHidden();
    await page.goBack();
    await expect.poll(() => page.evaluate(() => (history.state as { chatDrilldown?: string } | null)?.chatDrilldown)).toBeUndefined();
    await page.goForward();
    await expect.poll(() => page.evaluate(() => (history.state as { laterDocument?: boolean } | null)?.laterDocument)).toBe(true);
  });

  test("an incomplete question in a drill-down announces inside that layer", async ({ page, request }) => {
    const child = await control(request, { action: "seed", title: "Question child", child: true, items: [{
      id: "question:q1", type: "question", createdAt: 1, requestId: "q1", status: "pending",
      questions: [
        { header: "Scope", prompt: "Which scope?", options: [{ label: "UI", description: "Interface" }], multiple: false, allowFreeForm: false },
        { header: "Notes", prompt: "Any notes?", options: [], multiple: false, allowFreeForm: true },
      ],
    }] }) as { conversation: { id: string } };
    await seedAndOpen(page, request, "Question parent", [{
      id: "tool:agent-question", type: "tool", createdAt: 2, name: "task", status: "running", childConversationId: child.conversation.id,
      input: JSON.stringify({ description: "Ask reader", subagent_type: "explore", prompt: "go" }),
    }]);
    await page.locator("#chat-subagents summary").click();
    await page.getByRole("button", { name: "explore · Ask reader" }).click();
    const drilldown = page.locator("#chat-drilldown");
    await expect(drilldown).toBeVisible();

    const form = drilldown.locator("form[data-question-form]");
    await form.locator('[data-question-tab="1"]').click();
    await form.evaluate(element => (element as HTMLFormElement).requestSubmit());
    await expect(page.locator("#chat-drilldown-state")).toContainText("Still to answer: Scope, Notes");
    await expect(page.locator("#chat-state")).not.toContainText("Still to answer");
  });

  test("repeated drill-down close activation queues only one history traversal", async ({ page, request }) => {
    const child = await control(request, { action: "seed", title: "Close child", child: true, items: [
      { id: "part:child", type: "assistant_message", createdAt: 1, markdown: "child findings" },
    ] }) as { conversation: { id: string } };
    await seedAndOpen(page, request, "Close parent", [{
      id: "tool:agent-close", type: "tool", createdAt: 2, name: "task", status: "completed", childConversationId: child.conversation.id,
      input: JSON.stringify({ description: "Close safely", subagent_type: "explore", prompt: "go" }),
    }]);
    await page.evaluate(() => history.pushState({ sentinel: true }, "", `${location.pathname}${location.search}#sentinel`));
    await page.locator("#chat-subagents summary").click();
    await page.getByRole("button", { name: "explore · Close safely" }).click();
    const drilldown = page.locator("#chat-drilldown");
    await expect(drilldown).toBeVisible();

    await page.locator("#chat-drilldown-back").evaluate(button => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(drilldown).toBeHidden();
    expect(await page.evaluate(() => (history.state as { sentinel?: boolean } | null)?.sentinel)).toBe(true);
  });

  test("a request the parent is waiting on stays answerable behind an open subagent", async ({ page, request }) => {
    const child = await control(request, { action: "seed", title: "Child transcript", child: true, items: [
      { id: "part:child", type: "assistant_message", createdAt: 1, markdown: "child findings" },
    ] }) as { conversation: { id: string } };
    await seedAndOpen(page, request, "Answerable", [
      { id: "tool:agent1", type: "tool", createdAt: 2, name: "task", status: "completed", input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }), childConversationId: child.conversation.id },
      { id: "permission:p1", type: "permission", createdAt: 3, requestId: "p1", status: "pending", action: "bash", resources: ["rm -rf build"] },
    ]);

    // Left of the summary: the outstanding-request pill is pinned over its
    // right end, and that pill is the subject of this test.
    await page.locator("#chat-subagents summary").click({ position: { x: 8, y: 8 } });
    await page.getByRole("button", { name: "explore · Review renderer" }).click();
    await expect(page.locator("#chat-drilldown")).toBeVisible();

    // The parent's pinned request pill is not covered by the child, and taking
    // it returns to the parent with the card in view and answerable.
    const jump = page.locator("#chat-requests-jump");
    await expect(jump).toBeVisible();
    await jump.click();
    await expect(page.locator("#chat-drilldown")).toBeHidden();
    const card = page.locator('[data-chat-item-id="permission:p1"]');
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Allow once" }).click();
    await expect(jump).toBeHidden();
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
    await expect(track.locator("summary")).toContainText("1 of 1 subagent working · Still going");

    // Dismissal is a user statement — reloading the conversation must not
    // resurrect the dismissed strip.
    await page.reload();
    await openChatPanel(page);
    await expect(track).toBeVisible();
    await track.locator("summary").click();
    await expect(track.locator("li")).toHaveCount(1);
    await expect(track.locator("summary")).toContainText("1 of 1 subagent working · Still going");
  });

  // A conversation gave no sign of how full its context window was until it
  // overflowed. The battery percentage reads without opening anything;
  // opening it adds the exact token figures.
  test("the context indicator reads the fill on open and expands to the breakdown", async ({ page, request }) => {
    // The shape normalization produces: a message's spend rides its own
    // `usage:<id>` carrier with empty markdown, never a text part — a message
    // can emit several parts, and a per-part figure is one spend claimed
    // twice. The carrier must feed the readout while rendering no bubble.
    await seedAndOpen(page, request, "Context", [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "summarize the repo" },
      { id: "part:a1", type: "assistant_message", createdAt: 2, markdown: "An earlier answer." },
      { id: "usage:m1", type: "assistant_message", createdAt: 2, markdown: "", usage: { input: 4_000, output: 100 } },
      { id: "part:a2", type: "assistant_message", createdAt: 3, markdown: "The latest answer." },
      { id: "usage:m2", type: "assistant_message", createdAt: 3, markdown: "", usage: { input: 30_000, output: 1_200, reasoning: 400, cacheRead: 20_000, cacheWrite: 2_000 } },
    ], { model: { providerId: "anthropic", modelId: "claude-sonnet" } });

    // Populated from history, before any new turn — and from the newest
    // message's carrier, not the first one.
    const indicator = page.locator("#chat-context-usage");
    await expect(indicator).toBeVisible();
    // Two answers on screen, not four: a carrier is data, not a bubble.
    await expect(page.locator("#chat-items .chat-assistant-message")).toHaveCount(2);
    // 30k + 20k cache read + 2k cache write = 52k of the fixture model's 200k.
    // Output is excluded: it is what came back, not what occupies the window.
    await expect(page.locator("#chat-context-usage-label")).toHaveText("26%");
    const meter = page.locator("#chat-context-usage-meter");
    await expect(meter).toHaveCSS("border-radius", "50%");
    const fillPresentation = await meter.locator(".chat-context-meter-fill").evaluate(element => ({
      amount: (element as HTMLElement).style.getPropertyValue("--context-fill"),
      start: (element as HTMLElement).style.getPropertyValue("--context-start"),
      background: getComputedStyle(element).backgroundImage,
    }));
    expect(fillPresentation.amount).toBe("26%");
    expect(fillPresentation.start).toBe("223.2deg");
    expect(fillPresentation.background).toContain("conic-gradient");

    await indicator.locator("summary").click();
    const breakdown = page.locator("#chat-context-usage-breakdown");
    await expect(breakdown).toBeVisible();
    await expect(breakdown.locator("dt")).toHaveText(["In context", "Limit", "Input", "Cache read", "Cache write", "Reasoning", "Output"]);
    await expect(breakdown.locator("dd")).toHaveText(["52,000", "200,000", "30,000", "20,000", "2,000", "400", "1,200"]);
  });

  test("a conversation with no reported usage claims nothing", async ({ page, request }) => {
    await seedAndOpen(page, request, "No usage", [
      { id: "part:a1", type: "assistant_message", createdAt: 2, markdown: "An answer, unmeasured." },
    ]);
    // Hidden, not zeroed: an empty meter would be a claim about the
    // conversation rather than an absence of data about it.
    await expect(page.locator("#chat-context-usage")).toBeHidden();
  });

  test("switching conversations clears the previous context meter before loading", async ({ page, request }) => {
    const target = await control(request, { action: "seed", title: "Unavailable target", items: [] }) as { conversation: { id: string } };
    await seedAndOpen(page, request, "Measured source", [
      { id: "usage:m1", type: "assistant_message", createdAt: 2, markdown: "", usage: { input: 50_000 }, model: { providerId: "anthropic", modelId: "claude-sonnet" } },
    ]);
    await expect(page.locator("#chat-context-usage")).toBeVisible();
    await control(request, { action: "failHistory" });

    await page.locator("#chat-conversation-select").selectOption(target.conversation.id);
    await expect(page.locator("#chat-context-usage")).toBeHidden();
    await expect(page.locator("#chat-state")).toContainText("chat operation failed");
  });

  test("a new message's initial zero report does not reset known context usage", async ({ page, request }) => {
    const conversationId = await seedAndOpen(page, request, "Stable context", [
      { id: "usage:m1", type: "assistant_message", createdAt: 2, markdown: "", usage: { input: 30_000, cacheRead: 20_000 }, model: { providerId: "anthropic", modelId: "claude-sonnet" } },
    ]);
    const label = page.locator("#chat-context-usage-label");
    await expect(label).toHaveText("25%");

    // Selecting a future model does not reinterpret model A's existing usage
    // against model B's smaller window.
    await chooseChatModel(page, "GPT-5");
    await page.locator("#chat-configuration-done").click();
    await expect(label).toHaveText("25%");

    // OpenCode announces the next assistant message with zeroed counters, then
    // restates that carrier once real input accounting is available.
    await control(request, { action: "item", conversationId, item: {
      id: "usage:m2", type: "assistant_message", createdAt: 3, markdown: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, model: { providerId: "openai", modelId: "gpt-5" },
    } });
    await expect(label).toHaveText("25%");

    await control(request, { action: "item", conversationId, item: {
      id: "usage:m2", type: "assistant_message", createdAt: 3, markdown: "", usage: { input: 60_000, output: 500, cacheRead: 10_000, cacheWrite: 0 }, model: { providerId: "openai", modelId: "gpt-5" },
    } });
    await expect(label).toHaveText("70%");
  });

  test("an agent that does not declare context reporting leaves no readout behind", async ({ page, request }) => {
    await control(request, { action: "declareOnly", capabilities: ["models", "subagents"] });
    await seedAndOpen(page, request, "Undeclared", [
      { id: "part:a1", type: "assistant_message", createdAt: 2, markdown: "An answer.", usage: { input: 30_000 } },
      { id: "tool:agent1", type: "tool", createdAt: 3, name: "task", status: "completed", model: "claude-sonnet-4-5", usage: { input: 900, output: 100 }, input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }) },
    ]);
    // Absent, not empty — and what the agent does declare is unaffected.
    await expect(page.locator("#chat-context-usage")).toHaveCount(0);
    await openChatConfiguration(page);
    await expect(page.locator("#chat-configuration-models-section")).toBeVisible();
    await page.locator("#chat-configuration-done").click();
    const track = page.locator("#chat-subagents");
    await track.locator("summary").click();
    await expect(track.locator("li")).toContainText("explore · Review renderer");
    // The model still names itself; only the token figure is gated.
    await expect(track.locator(".chat-subagent-attribution")).toHaveText("claude-sonnet-4-5");
    // Restored before leaving: this worker's service is shared with whatever
    // runs next against it, and a narrowed agent is this test's setup only.
    await control(request, { action: "declareOnly", capabilities: ["modes", "models", "commands", "questions", "permissions", "subagents", "variants", "context"] });
  });

  test("an agent without subagents exposes no transcript controls from persisted tasks", async ({ page, request }) => {
    await control(request, { action: "declareOnly", capabilities: ["models"] });
    await seedAndOpen(page, request, "No subagents", [{
      id: "tool:legacy-agent", type: "tool", createdAt: 2, name: "task", status: "completed", childConversationId: "legacy-child",
      input: JSON.stringify({ description: "Old task", subagent_type: "explore", prompt: "go" }),
    }]);
    await expect(page.locator("#chat-subagents")).toBeHidden();
    const row = page.locator('[data-chat-item-id="tool:legacy-agent"]');
    await row.locator(":scope > summary").click();
    await expect(row.locator("[data-open-conversation]")).toHaveCount(0);
    await control(request, { action: "declareOnly", capabilities: ["modes", "models", "commands", "questions", "permissions", "subagents", "variants", "context"] });
  });

  test("a subagent row names the model it ran and the tokens it consumed", async ({ page, request }) => {
    await seedAndOpen(page, request, "Attribution", [
      { id: "tool:agent1", type: "tool", createdAt: 2, name: "task", status: "completed", model: "claude-sonnet-4-5", usage: { input: 12_000, output: 800, cacheRead: 4_000 }, input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }) },
      { id: "tool:agent2", type: "tool", createdAt: 3, name: "task", status: "running", input: JSON.stringify({ description: "Audit styles", subagent_type: "general", prompt: "go" }) },
    ]);

    const track = page.locator("#chat-subagents");
    await track.locator("summary").click();
    const rows = track.locator("li");
    await expect(rows).toHaveCount(2);
    // Spend, so output counts here — unlike the context fill, which asks what
    // occupies the window right now.
    await expect(rows.nth(0)).toContainText("claude-sonnet-4-5 · 17k tokens");
    // The unattributed one stays a readable row and asserts no figure.
    await expect(rows.nth(1)).toContainText("general · Audit styles");
    await expect(rows.nth(1).locator(".chat-subagent-attribution")).toHaveCount(0);
  });

  test("a long subagent report expands without splitting its Markdown", async ({ page, request }) => {
    const report = ["Report", "```ts", ...Array.from({ length: 30 }, (_, index) => `const line${index + 1} = true;`), "```"].join("\n");
    await seedAndOpen(page, request, "Long report", [{
      id: "tool:agent-long", type: "tool", createdAt: 2, name: "task", status: "completed", output: report,
      input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }),
    }]);

    const row = page.locator('[data-chat-item-id="tool:agent-long"]');
    await row.locator(":scope > summary").click();
    const content = row.locator(".chat-subagent-result-content");
    const collapsedHeight = await content.evaluate(element => element.getBoundingClientRect().height);
    await expect(row.locator(".chat-subagent-result pre code")).toHaveCount(1);
    await expect(row.locator(".chat-subagent-result pre code")).toContainText("const line30 = true;");

    await row.locator(".chat-output-more summary").click();
    const expandedHeight = await content.evaluate(element => element.getBoundingClientRect().height);
    expect(expandedHeight).toBeGreaterThan(collapsedHeight);
    await expect(row.locator(".chat-report-collapse")).toBeVisible();
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

test.describe("the working line at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("collapses the live tail behind one line in touch mode", async ({ page, request }, testInfo) => {
    await request.post("/__e2e/reset");
    const started = Date.now() - 20_000;
    const at = (seconds: number) => started + seconds * 1_000;
    const seeded = await control(request, { action: "seed", title: "Working line", items: [
      { id: "message:u1", type: "user_message", createdAt: started, text: "Run hello.sh, list the folder, then read the notes" },
    ] }) as { conversation: { id: string } };
    const id = seeded.conversation.id;
    const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
    await page.goto(`/?t=${encodeURIComponent(token.token)}`);
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await page.locator("#touch-tab-chat").click();
    await expect(page.locator("#chat-conversation-select")).toHaveValue(id);

    await control(request, { action: "status", conversationId: id, status: "running" });
    await control(request, { action: "item", conversationId: id, item: { id: "reasoning:1", type: "reasoning", createdAt: at(1), text: "Plan the three steps.", status: "completed", durationMs: 3000 } });
    await control(request, { action: "item", conversationId: id, item: bash("tool:1", at(4), "./hello.sh", "completed", "Hello from hello.sh") });
    await control(request, { action: "item", conversationId: id, item: bash("tool:2", at(5), "ls -la", "completed", "total 3\ndocs\nhello.sh\nREADME.md") });
    await control(request, { action: "item", conversationId: id, item: { id: "tool:3", type: "tool", createdAt: at(6), name: "Read", status: "completed", input: JSON.stringify({ file_path: "docs/notes.md" }), output: "# Notes" } });
    await control(request, { action: "item", conversationId: id, item: bash("tool:4", at(7), "sleep 20 && echo done", "running") });
    const line = page.locator(".chat-activity-group");
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute("data-outcome", "live");
    await expect(line.locator("> summary .chat-activity-subject")).toHaveText("Bash sleep 20 && echo done");
    await expect(page.locator('[data-chat-item-id="tool:1"]')).toBeHidden();
    await captureScreenshot(page, testInfo, ZEN_SCREENSHOTS, "after-working-line-phone");
  });
});
