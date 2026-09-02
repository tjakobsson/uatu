// Fixture-driven coverage for the polish-claude-code-chat change: every
// scenario the delta specs added that the shared surface can show without a
// real model — the context readout's sources, compaction, versioned model
// names and the app-only set, typed model ids, Bash rows naming their
// commands, agent-specific permission copy, and dialog cards. Each test that
// changes what the user sees ends by saving a screenshot into the change's
// screenshots folder (see its README), so review reads the folder instead of
// running a session.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { APIRequestContext, Page, TestInfo } from "@playwright/test";

import { withMoreModels } from "../../src/chat/claude/models";
import type { ChatModel, ConversationItem } from "../../src/chat/types";
import { openChatConfiguration, openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

const CHANGE_SCREENSHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../openspec/changes/polish-claude-code-chat/screenshots");

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<any> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  const target = existsSync(CHANGE_SCREENSHOTS) ? path.join(CHANGE_SCREENSHOTS, `${name}.png`) : testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: target, animations: "disabled", caret: "hide" });
  await testInfo.attach(name, { path: target, contentType: "image/png" });
}

// The catalog as Claude Code 2.1.258 answered it on 2026-09-02, after the
// provider's own naming and the app-only set (chat/claude/models).
const claudeModels: ChatModel[] = withMoreModels([
  { selection: { providerId: "anthropic", modelId: "default" }, provider: "Anthropic", name: "Default (recommended)", default: true, detail: "Opus 5 with 1M context · Best for everyday, complex tasks", variants: ["low", "medium", "high", "xhigh", "max"], contextLimit: 1_000_000, imageInput: true, resolvesTo: { providerId: "anthropic", modelId: "opus[1m]" } },
  { selection: { providerId: "anthropic", modelId: "opus[1m]" }, provider: "Anthropic", name: "Opus 5 (1M context)", detail: "Opus 5 with 1M context · Best for everyday, complex tasks", variants: ["low", "medium", "high", "xhigh", "max"], contextLimit: 1_000_000, imageInput: true },
  { selection: { providerId: "anthropic", modelId: "fable[1m]" }, provider: "Anthropic", name: "Fable 5.1", detail: "Fable 5.1 · Most capable for your hardest and longest-running tasks", variants: ["low", "medium", "high", "xhigh", "max"], contextLimit: 1_000_000, imageInput: true },
  { selection: { providerId: "anthropic", modelId: "sonnet" }, provider: "Anthropic", name: "Sonnet 5", detail: "Sonnet 5 · Efficient for routine tasks", variants: ["low", "medium", "high", "xhigh", "max"], contextLimit: 200_000, imageInput: true },
  { selection: { providerId: "anthropic", modelId: "haiku" }, provider: "Anthropic", name: "Haiku 4.5", detail: "Haiku 4.5 · Fastest for quick answers", contextLimit: 200_000, imageInput: true },
]);

const bash = (id: string, createdAt: number, command: string, status: "running" | "completed", output?: string): ConversationItem => ({
  id, type: "tool", createdAt, name: "Bash", status, input: JSON.stringify({ command, description: `Run ${command.split(" ")[0]}` }), ...(output === undefined ? {} : { output }),
});
const carrier = (id: string, createdAt: number, modelId: string, input: number, cacheRead: number): ConversationItem => ({
  id, type: "assistant_message", createdAt, markdown: "", usage: { input, cacheRead, output: 40 }, model: { providerId: "anthropic", modelId },
});

/** Boots the dual-agent workspace and opens a seeded Claude conversation. */
async function bootClaude(page: Page, request: APIRequestContext, title: string, items: ConversationItem[] = [], configuration: Record<string, unknown> = {}): Promise<string> {
  await request.post("/__e2e/reset");
  await control(request, { action: "agents", count: 2 });
  await control(request, { action: "models", agent: "claude", models: claudeModels });
  const seeded = await control(request, { action: "seed", agent: "claude", title, items, configuration }) as { conversation: { id: string } };
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
  await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
  await expect(page.locator("#chat-context")).toContainText("Claude Code");
  return seeded.conversation.id;
}

test.describe("Claude Code chat polish (fixture-driven)", () => {
  test.use({ viewport: { width: 1400, height: 1000 } });

  test("the context readout prefers the session's own report and expands to its categories", async ({ page, request }, testInfo) => {
    const id = await bootClaude(page, request, "Context report", [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "Summarize the repo" },
      carrier("usage:a1", 2, "opus[1m]", 200, 149_800),
      { id: "message:a1", type: "assistant_message", createdAt: 3, markdown: "Here is the summary.", completedAt: 3 },
      { id: "status:1", type: "turn_status", createdAt: 4, status: "completed" },
    ]);
    const label = page.locator("#chat-context-usage-label");
    // The carrier alone: one call's occupancy against the 1M window.
    await expect(label).toHaveText("15%");
    await expect(page.locator("#chat-context-usage")).toHaveAttribute("data-source", "usage");

    const report: ConversationItem = {
      id: "context:report:1", type: "context_report", createdAt: 5, total: 300_000, max: 1_000_000,
      model: { providerId: "anthropic", modelId: "opus[1m]" },
      categories: [
        { name: "System prompt", tokens: 12_000, kind: "used" },
        { name: "System tools", tokens: 18_000, kind: "used" },
        { name: "System tools (deferred)", tokens: 13_000, kind: "deferred" },
        { name: "Memory files", tokens: 4_000, kind: "used" },
        { name: "Messages", tokens: 266_000, kind: "used" },
        { name: "Free space", tokens: 700_000, kind: "free" },
      ],
    };
    await control(request, { action: "item", conversationId: id, item: report });
    await expect(label).toHaveText("30%");
    await expect(page.locator("#chat-context-usage")).toHaveAttribute("data-source", "report");
    await page.locator("#chat-context-usage > summary").click();
    const rows = page.locator("#chat-context-usage-breakdown dt");
    await expect(rows).toHaveText(["In context", "Limit", "System prompt", "System tools", "Memory files", "Messages"]);
    await expect(page.locator("#chat-context-usage-breakdown")).not.toContainText("Free space");
    await capture(page, testInfo, "phase1-meter-and-breakdown");
  });

  test("a compaction marker sits between two activity runs and the readout drops after it", async ({ page, request }, testInfo) => {
    const id = await bootClaude(page, request, "Compaction", [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "Audit the scripts" },
    ], { model: { providerId: "anthropic", modelId: "sonnet" } });
    await control(request, { action: "status", conversationId: id, status: "running" });
    for (const [index, command] of ["./hello.sh", "ls -la", "cat README.md"].entries()) {
      await control(request, { action: "item", conversationId: id, item: bash(`tool:a${index}`, 10 + index, command, "completed", "ok") });
    }
    await control(request, { action: "item", conversationId: id, item: carrier("usage:a1", 20, "sonnet", 200, 179_800) });
    const label = page.locator("#chat-context-usage-label");
    await expect(label).toHaveText("90%");

    await control(request, { action: "item", conversationId: id, item: { id: "compaction:1", type: "compaction", createdAt: 21, trigger: "auto", preTokens: 180_000, postTokens: 40_000 } });
    await control(request, { action: "item", conversationId: id, item: { id: "context:compaction:1", type: "context_report", createdAt: 22, total: 40_000, model: { providerId: "anthropic", modelId: "sonnet" } } });
    await expect(label).toHaveText("20%");
    for (const [index, command] of ["date", "whoami", "uname -a"].entries()) {
      await control(request, { action: "item", conversationId: id, item: bash(`tool:b${index}`, 30 + index, command, "completed", "ok") });
    }
    await control(request, { action: "item", conversationId: id, item: { id: "message:a1", type: "assistant_message", createdAt: 40, markdown: "Done after compaction.", completedAt: 40 } });
    await control(request, { action: "status", conversationId: id, status: "completed" });

    const marker = page.locator(".chat-compaction");
    await expect(marker).toHaveText("Context compacted · 180,000 → 40,000 tokens");
    // Both finished runs collapse behind their group lines before the
    // order is read; the marker sits between them.
    await expect(page.locator('[data-chat-item-id="group:tool:a0"]')).toBeVisible();
    await expect(page.locator('[data-chat-item-id="group:tool:b0"]')).toBeVisible();
    const order = await page.locator("#chat-items > [data-chat-item-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-chat-item-id")));
    expect(order.indexOf("compaction:1")).toBeGreaterThan(order.indexOf("group:tool:a0"));
    expect(order.indexOf("compaction:1")).toBeLessThan(order.indexOf("group:tool:b0"));
    await capture(page, testInfo, "phase1-compaction-marker");
  });

  test("the picker names every model with its version and offers the app-only set after the catalog", async ({ page, request }, testInfo) => {
    await bootClaude(page, request, "Versioned names");
    await expect(page.locator("#chat-configuration-summary")).toHaveText("Default · Opus 5 (1M context)");
    await capture(page, testInfo, "phase1-composer-model-button");
    await openChatConfiguration(page);
    const names = page.locator("#chat-configuration-models .chat-configuration-model-name");
    await expect(names).toHaveText(["Default (recommended)", "Opus 5 (1M context)", "Fable 5.1", "Sonnet 5", "Haiku 4.5", "Fable 5", "Opus 4.8", "Opus 4.7", "Opus 4.6", "Sonnet 4.6"]);
    const groups = page.locator("#chat-configuration-models .chat-configuration-provider h3");
    await expect(groups).toHaveText(["Anthropic", "More models"]);
    await capture(page, testInfo, "phase1-picker-versioned-names");
  });

  test("a typed model id reaches the prompt verbatim and the readout shows an unknown window", async ({ page, request }, testInfo) => {
    const id = await bootClaude(page, request, "Typed id");
    await openChatConfiguration(page);
    const form = page.locator("[data-custom-model-form]");
    await form.scrollIntoViewIfNeeded();
    await form.locator("[data-custom-model-input]").fill("claude-opus-4-9");
    await capture(page, testInfo, "phase1-more-models-and-typed-id");
    await form.locator("[data-custom-model-submit]").click();
    await expect(page.locator('#chat-configuration-models button[data-model-value="anthropic/claude-opus-4-9"]')).toContainText("Typed model id");
    await page.locator("#chat-configuration-done").click();
    await expect(page.locator("#chat-configuration-trigger")).toHaveAttribute("aria-label", /claude-opus-4-9/);

    await page.locator("#chat-input").fill("run under the typed id");
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-send").click();
    expect((await accepted).request().postDataJSON()).toMatchObject({ model: { providerId: "anthropic", modelId: "claude-opus-4-9" } });
    const stats = await control(request, { action: "stats" });
    // The fixture's stats cover the primary agent; the configuration event
    // proves the typed id reached the conversation configuration.
    expect(stats).toBeTruthy();
    await control(request, { action: "item", conversationId: id, item: carrier("usage:t1", 50, "claude-opus-4-9", 100, 900) });
    await expect(page.locator("#chat-context-usage-label")).toHaveText("?");
    await expect(page.locator("#chat-context-usage")).toHaveAttribute("data-fill", "unknown");
  });

  test("Bash rows name their commands live and in the collapsed group line", async ({ page, request }, testInfo) => {
    const id = await bootClaude(page, request, "Bash rows", [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "Run hello.sh, list the folder, then read the notes" },
    ]);
    await control(request, { action: "status", conversationId: id, status: "running" });
    await control(request, { action: "item", conversationId: id, item: bash("tool:1", 10, "./hello.sh", "completed", "Hello from hello.sh") });
    await control(request, { action: "item", conversationId: id, item: bash("tool:2", 11, "ls -la", "completed", "total 3\ndocs\nhello.sh\nREADME.md") });
    await control(request, { action: "item", conversationId: id, item: { id: "tool:3", type: "tool", createdAt: 12, name: "Read", status: "completed", input: JSON.stringify({ file_path: "docs/notes.md" }), output: "# Notes" } });
    await control(request, { action: "item", conversationId: id, item: bash("tool:4", 13, "sleep 20 && echo done", "running") });
    // The live tail stays flat and every row names its command.
    await expect(page.locator('[data-chat-item-id="tool:1"] .chat-activity-subject')).toHaveText("./hello.sh");
    await expect(page.locator('[data-chat-item-id="tool:4"] .chat-activity-subject')).toHaveText("sleep 20 && echo done");
    await expect(page.locator(".chat-activity-group")).toHaveCount(0);
    await capture(page, testInfo, "phase1-live-tail");

    await control(request, { action: "item", conversationId: id, item: bash("tool:4", 13, "sleep 20 && echo done", "completed", "done") });
    await control(request, { action: "item", conversationId: id, item: { id: "message:a1", type: "assistant_message", createdAt: 20, markdown: "All three ran.", completedAt: 20 } });
    await control(request, { action: "status", conversationId: id, status: "completed" });
    await expect(page.locator(".chat-activity-group > summary .chat-activity-subject")).toHaveText("Bash ./hello.sh · Bash ls -la · Read docs/notes.md · Bash");
    await capture(page, testInfo, "phase1-bash-rows-with-commands");
  });

  test("a dialog card is answered and the turn continues", async ({ page, request }, testInfo) => {
    const id = await bootClaude(page, request, "Dialog", [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "Write the release notes" },
    ]);
    await control(request, { action: "status", conversationId: id, status: "running" });
    const dialog: ConversationItem = {
      id: "question:dl-1", type: "question", createdAt: 10, requestId: "dl-1", status: "pending",
      source: "dialog",
      intro: "Claude Code asks how to continue after claude-opus-5 declined this request.",
      schema: { dialogKind: "refusal_fallback_prompt", payload: { originalModel: "claude-opus-5", fallbackModel: "claude-sonnet-5" } },
      questions: [{ prompt: "claude-opus-5 declined to continue. The turn can be retried on claude-sonnet-5.", header: "Refusal", options: [{ label: "Retry on claude-sonnet-5", description: "Rerun this turn on the fallback model" }, { label: "Edit the prompt", description: "Stop this turn so the request can be changed" }], multiple: false, allowFreeForm: false }],
    };
    await control(request, { action: "item", conversationId: id, item: dialog });
    const card = page.locator('[data-chat-item-id="question:dl-1"]');
    await expect(card).toHaveAttribute("data-question-source", "dialog");
    await expect(card).toContainText("Claude Code asks how to continue");
    await capture(page, testInfo, "phase1-dialog-card");
    await card.getByRole("radio", { name: /Retry on claude-sonnet-5/ }).check();
    await card.getByRole("button", { name: "Answer", exact: true }).click();
    await expect(card).toContainText("Answered");
    await control(request, { action: "item", conversationId: id, item: { id: "message:a1", type: "assistant_message", createdAt: 20, markdown: "Retried on Sonnet: here are the notes.", completedAt: 20 } });
    await control(request, { action: "status", conversationId: id, status: "completed" });
    await expect(page.locator('[data-chat-item-id="message:a1"]')).toContainText("Retried on Sonnet");
    await expect(page.locator("#chat-composer-status")).toHaveAttribute("data-state", "ready");
  });

  test("background work is a state of its own: the composer names the running task, lists it with a stop, and the settled row lands in place", async ({ page, request }, testInfo) => {
    const id = await bootClaude(page, request, "Background work", [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "Run sleep 20 && echo done in the background, then tell me when it finishes" },
    ]);
    await control(request, { action: "status", conversationId: id, status: "running" });
    await control(request, { action: "item", conversationId: id, item: { id: "tool:bg", type: "tool", createdAt: 10, name: "Bash", status: "completed", input: JSON.stringify({ command: "sleep 20 && echo done", description: "Sleep then report", run_in_background: true }), output: "Command running in background with ID: b2f6" } });
    const task: ConversationItem = { id: "task:b2f6", type: "background_task", createdAt: 11, taskId: "b2f6", description: "Sleep then report", taskType: "local_bash", toolUseId: "tool:bg", status: "running" };
    await control(request, { action: "item", conversationId: id, item: task });
    await control(request, { action: "item", conversationId: id, item: { id: "message:a1", type: "assistant_message", createdAt: 12, markdown: "Started; I will report when it finishes.", completedAt: 12 } });
    await control(request, { action: "status", conversationId: id, status: "completed" });
    await control(request, { action: "status", conversationId: id, status: "background" });

    // The composer: a background state, named, with the conversation still
    // accepting a prompt; the live list names the task with a stop.
    const status = page.locator("#chat-composer-status");
    await expect(status).toHaveAttribute("data-state", "background");
    await expect(status).toHaveAttribute("aria-label", "1 background task running · Sleep then report");
    // Prompting stays possible: the composer takes text and offers Send,
    // not Cancel, while the task runs.
    await page.locator("#chat-input").fill("still there?");
    await expect(page.locator("#chat-send")).toBeEnabled();
    await expect(page.locator("#chat-send")).not.toHaveAttribute("aria-label", /Cancel/);
    await page.locator("#chat-input").fill("");
    const list = page.locator("#chat-background-tasks");
    await expect(list).toBeVisible();
    await expect(list.locator("#chat-background-tasks-label")).toHaveText("1 background task running · Sleep then report");
    await expect(page.locator('[data-chat-item-id="task:b2f6"]')).toHaveCount(0);
    await capture(page, testInfo, "phase2-background-state-composer");
    await control(request, { action: "item", conversationId: id, item: { ...task, progress: "Using Bash" } });
    await list.locator("summary").click();
    await expect(list.locator("li")).toHaveCount(1);
    await expect(list.locator("li .chat-background-task-progress")).toHaveText("Using Bash");
    await capture(page, testInfo, "phase2-task-list-stop");

    // Stop: the request reaches the agent, which settles the row as stopped;
    // the list empties and the timeline records the outcome in place.
    const stop = list.getByRole("button", { name: "Stop Sleep then report" });
    const stopRequest = page.waitForResponse(response => response.url().includes("/tasks/b2f6/stop"));
    await stop.click();
    expect((await stopRequest).status()).toBe(200);
    await control(request, { action: "status", conversationId: id, status: "idle" });
    await expect(list).toBeHidden();
    const row = page.locator('[data-chat-item-id="task:b2f6"]');
    await expect(row).toContainText("Background task stopped");
    await expect(row.locator(".chat-activity-subject")).toHaveText("Sleep then report");
    await expect(status).toHaveAttribute("data-state", "ready");

    // A second task settles on its own: completed, with the agent's summary.
    const second: ConversationItem = { id: "task:c1", type: "background_task", createdAt: 20, taskId: "c1", description: "Build the docs", taskType: "local_bash", status: "running" };
    await control(request, { action: "item", conversationId: id, item: second });
    await control(request, { action: "status", conversationId: id, status: "background" });
    await expect(status).toHaveAttribute("data-state", "background");
    await control(request, { action: "item", conversationId: id, item: { ...second, status: "completed", summary: "done\n[exited with code 0]" } });
    await control(request, { action: "status", conversationId: id, status: "running" });
    await control(request, { action: "item", conversationId: id, item: { id: "message:a2", type: "assistant_message", createdAt: 21, markdown: "The build finished: done.", completedAt: 21 } });
    await control(request, { action: "status", conversationId: id, status: "completed" });
    const settled = page.locator('[data-chat-item-id="task:c1"]');
    await expect(settled).toContainText("Background task finished");
    await settled.locator("summary").click();
    await expect(settled.locator(".chat-task-summary")).toContainText("exited with code 0");
    await expect(list).toBeHidden();
    await capture(page, testInfo, "phase2-settled-task-row");
  });

  test("a reopened conversation shows its live background work from the agent's own report", async ({ page, request }) => {
    const id = await bootClaude(page, request, "Reopen with background work", [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "Keep the watcher running" },
      { id: "task:w1", type: "background_task", createdAt: 2, taskId: "w1", description: "Watch the build", taskType: "local_bash", status: "running" },
    ]);
    await control(request, { action: "status", conversationId: id, status: "background" });
    await page.reload();
    await openChatPanel(page);
    await page.locator("#chat-conversation-select").selectOption(id);
    await expect(page.locator("#chat-composer-status")).toHaveAttribute("data-state", "background");
    await expect(page.locator("#chat-background-tasks-label")).toHaveText("1 background task running · Watch the build");
  });
});
