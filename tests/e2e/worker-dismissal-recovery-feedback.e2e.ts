import { chromium, webkit } from "@playwright/test";
import type { BackgroundTaskItem, ConversationSnapshot } from "../../src/chat/types";
import { childChatControl, expect, openSessionTab, signIn, test } from "./hub-fixtures";
import { openChatPanel, openChatWorkers } from "./chat-helpers";

test.use({ hubWorkspaces: ["alpha"], hubWorkerDismissals: true });

for (const engine of ["chromium", "webkit"] as const) test(`${engine}: failed dismissal survives healthy private reads and unrelated finished batch`, async ({ hub }) => {
  test.setTimeout(120_000);
  const browser = await ({ chromium, webkit })[engine].launch();
  try {
    const workspace = hub.workspaces[0]!;
    const task = (id: string, finished = true): BackgroundTaskItem => ({ type: "background_task", id: `worker:${id}`, taskId: id, taskType: "agent",
      description: `Synthetic feedback ${id}`, status: finished ? "completed" : "running", createdAt: 1,
      activity: { kind: finished ? "ended" : "unavailable", executionId: `v1:feedback-${id}`, generation: 1 }, control: { available: false } });
    const failed = task("failed", false), first = task("first"), second = task("second"), remote = task("remote");
    const snapshot = await childChatControl(workspace, { action: "seed", title: "Failed dismissal feedback", items: [failed, first, second, remote] }) as ConversationSnapshot;
    const conversationId = snapshot.conversation.id;
    const personalUrl = new URL("api/personal-worker-dismissals", workspace.sessionUrl);
    personalUrl.searchParams.set("conversationId", conversationId);
    const context = await browser.newContext(engine === "webkit" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
    const login = await context.newPage(); await signIn(login, hub); await login.close();
    const page = await context.newPage();
    const matches = (url: string) => { const parsed = new URL(url); return parsed.origin === personalUrl.origin && parsed.pathname === personalUrl.pathname; };
    const healthyRead = () => page.waitForEvent("requestfinished", { predicate: async request => matches(request.url()) && request.method() === "GET"
      && new URL(request.url()).searchParams.get("conversationId") === conversationId && (await request.response())?.status() === 200, timeout: 10_000 });
    const initialRead = healthyRead();
    await page.goto(workspace.sessionUrl);
    if (await page.locator("#touch-tab-chat").isVisible()) await page.locator("#touch-tab-chat").click();
    else await openChatPanel(page);
    await expect(page.locator("#chat-conversation-select")).toHaveValue(conversationId);
    await initialRead; await openChatWorkers(page);
    const row = (id: string) => page.locator(`#chat-compact-workers-items [data-worker-id="${id}"]`);
    const notice = page.locator(".chat-worker-dismissal-notice");
    await page.locator("#chat-input").fill("Keep draft after failed dismissal");
    // Inject one transport failure only; all subsequent reads and saves use
    // the real authenticated Hub/private store and conditional revisions.
    let injected = false;
    await page.route(url => matches(url.href), async route => {
      if (!injected && route.request().method() === "POST") {
        expect(route.request().postDataJSON()).toMatchObject({ conversationId, executionId: failed.activity!.executionId, operation: "dismiss" });
        injected = true; await route.fulfill({ status: 503, body: "Synthetic storage fault" });
      } else await route.continue();
    });
    await row(failed.id).getByRole("button", { name: "Dismiss worker from summary:", exact: false }).click();
    await expect(notice).toContainText("Could not save"); await expect(row(failed.id)).toBeVisible();
    const current = await context.request.get(personalUrl.href); expect(current.status()).toBe(200);
    const entries = (await current.json()).entries as Array<{ executionId: string; revision: number }>;
    const acknowledged = healthyRead();
    const remoteSave = await context.request.post(`${personalUrl.origin}${personalUrl.pathname}`, { data: { version: 1, conversationId, executionId: remote.activity!.executionId,
      expectedRevision: entries.find(entry => entry.executionId === remote.activity!.executionId)?.revision ?? 0, operation: "dismiss" } });
    expect(remoteSave.status()).toBe(200);
    await acknowledged;
    await expect(row(remote.id)).toHaveCount(0); await expect(notice).toContainText("Could not save");
    await page.getByRole("button", { name: "Dismiss finished", exact: true }).click();
    // Retained failure on a different source must not stop this healthy batch.
    await expect(row(first.id)).toHaveCount(0); await expect(row(second.id)).toHaveCount(0);
    await expect(notice).toContainText("Could not save"); await expect(row(failed.id)).toBeVisible();
    const retry = page.waitForResponse(response => matches(response.url()) && response.request().method() === "POST", { timeout: 10_000 });
    await row(failed.id).getByRole("button", { name: "Dismiss worker from summary:", exact: false }).click();
    expect((await retry).status()).toBe(200);
    await expect(row(failed.id)).toHaveCount(0); await expect(notice).toBeHidden();
    await expect(page.locator("#chat-input")).toHaveValue("Keep draft after failed dismissal");
  } finally { await browser.close(); }
});

for (const engine of ["chromium", "webkit"] as const) for (const qualification of ["working", "ended"] as const) test(`${engine}: dismissal attempt does not retain recovered identity guidance (${qualification})`, async ({ hub }) => {
  test.setTimeout(120_000);
  const browser = await ({ chromium, webkit })[engine].launch();
  try {
    const workspace = hub.workspaces[0]!;
    // Synthetic trusted child observations exercise real Hub retirement and the
    // mounted UI. These references are not a claim of captured native proof.
    const partial: BackgroundTaskItem = { type: "background_task", id: "worker:partial", taskId: "partial", taskType: "agent", description: "Synthetic active launch",
      childConversationId: "opencode:partial-child", status: "running", createdAt: 1,
      activity: { kind: "working", launchRef: "synthetic:feedback-launch", generation: 1 }, control: { available: false } };
    const finished: BackgroundTaskItem = { type: "background_task", id: "worker:finished", taskId: "finished", taskType: "agent", description: "Synthetic finished launch",
      childConversationId: "opencode:finished-child", status: "completed", createdAt: 1,
      activity: { kind: "ended", executionId: "v1:synthetic-finished", generation: 1 }, control: { available: false } };
    const snapshot = await childChatControl(workspace, { action: "seed", title: "Recovery feedback ownership", items: [partial, finished] }) as ConversationSnapshot;
    const conversationId = snapshot.conversation.id;
    const context = await browser.newContext(engine === "webkit" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
    const login = await context.newPage(); await signIn(login, hub); await login.close();
    const page = await openSessionTab(context, workspace);
    if (await page.locator("#touch-tab-chat").isVisible()) await page.locator("#touch-tab-chat").click();
    else await openChatPanel(page);
    await expect(page.locator("#chat-conversation-select")).toHaveValue(conversationId);
    await openChatWorkers(page);
    const notice = page.locator(".chat-worker-dismissal-notice");
    await expect(notice).toContainText("complete execution identity");
    await page.locator("#chat-input").fill("Keep this draft through recovery");
    const finishedRow = page.locator('#chat-compact-workers-items [data-worker-id="worker:finished"]');
    await page.getByRole("button", { name: "Dismiss finished", exact: true }).click();
    // The client refuses the action while identity is unresolved. Its current
    // health guidance must not become an immutable batch-operation outcome.
    await expect(finishedRow).toBeVisible();
    await expect(notice).toContainText("complete execution identity");
    const personalUrl = new URL("api/personal-worker-dismissals", workspace.sessionUrl);
    const acknowledged = page.waitForEvent("requestfinished", { predicate: async request => {
      const url = new URL(request.url());
      return request.method() === "GET" && url.origin === personalUrl.origin && url.pathname === personalUrl.pathname
        && url.searchParams.get("conversationId") === conversationId && (await request.response())?.status() === 200;
    }, timeout: 10_000 });
    const executionId = "v1:synthetic-active-qualified";
    await childChatControl(workspace, { action: "item", conversationId, item: { ...partial,
      status: qualification === "ended" ? "completed" : "running",
      activity: { ...partial.activity!, kind: qualification, executionId, executionAliases: [executionId] } } });
    const response = await (await acknowledged).response();
    expect(response).not.toBeNull();
    const personal = await response!.json() as { entries: Array<{ executionId: string; dismissed: boolean }> };
    expect(personal.entries.find(entry => entry.executionId === executionId)?.dismissed).toBe(false);
    await expect(notice).toBeHidden();
    await expect(page.locator('#chat-compact-workers-items [data-worker-id="worker:partial"]')).toHaveAttribute("data-state", qualification === "ended" ? "completed" : "working");
    await expect(finishedRow).toBeVisible();
    await expect(page.locator("#chat-input")).toHaveValue("Keep this draft through recovery");
  } finally { await browser.close(); }
});
