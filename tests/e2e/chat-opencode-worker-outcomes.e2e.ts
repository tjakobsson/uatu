import type { APIRequestContext, Page } from "@playwright/test";
import type { ConversationItem } from "../../src/chat/types";
import { openChatWorkers } from "./chat-helpers";
import { test as base, expect } from "./fixtures";
import { withEngineBrowsers } from "./page-diagnostics";

const test = withEngineBrowsers(base);

async function control(request: APIRequestContext, body: Record<string, unknown>) {
  const response = await request.post("/__e2e/chat", { data: { action: "opencode", ...body } });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function boot(page: Page, request: APIRequestContext) {
  await request.post("/__e2e/reset");
  await control(request, { action: "agents", stack: "opencode-v2", backgroundPreview: true });
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await page.locator("#touch-tab-chat").tap();
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.locator("#chat-state")).toContainText("Started new conversation with OpenCode");
  return page.locator("#chat-conversation-select").inputValue();
}

for (const engine of ["chromium", "webkit"] as const)
for (const recovery of ["reload", "reconnect"] as const)
for (const [idleOutcome, status, label] of [["succeeded", "completed", "finished"], ["failed", "failed", "failed"], ["interrupted", "stopped", "stopped"]] as const)
test(`native ${idleOutcome} without a parent report recovers after ${recovery}: ${engine}`, async ({ launchBrowser, request, baseURL }) => {
  test.setTimeout(60_000);
  const browser = await launchBrowser(engine);
  const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const conversationId = await boot(page, request);
    const worker = await control(request, { op: "launchRequestWorker", conversationId });
    await openChatWorkers(page);
    const rows = page.locator("#chat-compact-workers-items .chat-worker-row");
    const row = rows.filter({ has: page.locator(`[data-inspect-task="${worker.taskId}"]`) });
    await expect(row).toHaveAttribute("data-state", "working");
    // Lose the notification channel while the worker ends. Recovery must read
    // the owned child's native idle outcome, not invent a parent result.
    await control(request, { op: "pauseEvents" });
    await expect(row).toHaveAttribute("data-state", "unknown");
    await control(request, { op: "settleWorkerWithoutReport", childId: worker.childId, idleOutcome, text: "Child-only outcome evidence" });
    await control(request, { op: "reconnectEvents" });
    if (recovery === "reload") {
      await page.reload();
      await page.locator("#touch-tab-chat").tap();
      await openChatWorkers(page);
    }
    await expect(rows).toHaveCount(1);
    await expect(row).toHaveAttribute("data-state", status);
    await expect(row.locator("[data-inspect-task]")).toHaveAttribute("aria-label", new RegExp(label));
    await expect(page.locator("#chat-compact-workers-label")).toHaveText("1 finished");
    await expect(page.locator('#chat-compact-workers-items .chat-worker-row:is([data-state="working"], [data-state="unknown"])')).toHaveCount(0);
    await expect(page.locator("#chat-items")).not.toContainText("Child-only outcome evidence");

    // Inspect the normal authenticated history route as well as the rendered
    // worker: terminal state must not manufacture a synthetic result/summary.
    const response = await page.request.get(`/api/chat/conversations/${encodeURIComponent(conversationId)}`);
    expect(response.ok()).toBe(true);
    const history = await response.json() as { items: ConversationItem[] };
    const tasks = history.items.filter(item => item.type === "background_task");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ taskId: worker.taskId, status, stateUncertain: false });
    expect(tasks[0]!.resultId).toBeUndefined();
    expect(tasks[0]!.summary).toBeUndefined();

    const state = await control(request, { op: "state" });
    const parent = state.sessions[conversationId.replace(/^opencode:/, "")];
    expect(parent.pending).toEqual([]);
    expect(parent.messages.filter((message: { type: string }) => message.type === "synthetic")).toEqual([]);
    expect(state.sessions[worker.childId].running).toBe(false);
    expect(state.unhandled).toEqual([]);
  } finally {
    await control(request, { op: "reconnectEvents" });
    await page.close();
    await browser.close();
  }
});
