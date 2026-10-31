import { chromium, webkit, type BrowserContext, type Page } from "@playwright/test";
import type { BackgroundTaskItem, ConversationSnapshot } from "../../src/chat/types";
import { childChatControl, expect, installEventSourceLedger, openEventSources, openSessionTab, signIn, test } from "./hub-fixtures";
import { openChatPanel, openChatWorkers } from "./chat-helpers";
import { captureScreenshot, saveEvidence } from "./evidence";
import type { NativeWorkerRequestReply, OpenCodeV2Fake } from "./opencode-v2-fake";

test.use({ hubWorkspaces: ["alpha"], hubWorkerDismissals: true });

async function watchPersonalFrames(context: BrowserContext): Promise<void> {
  await installEventSourceLedger(context);
  await context.addInitScript(() => {
    const Native = window.EventSource;
    const frames: unknown[] = [];
    const Wrapped = function (url: string | URL, init?: EventSourceInit) {
      const source = new Native(url, init);
      source.addEventListener("live", event => {
        const frame = JSON.parse((event as MessageEvent).data);
        if (frame.topic === "personal" && frames.length < 100) frames.push(frame.event);
      });
      return source;
    } as unknown as typeof EventSource;
    Wrapped.prototype = Native.prototype;
    for (const name of ["CONNECTING", "OPEN", "CLOSED"] as const) Object.defineProperty(Wrapped, name, { value: Native[name] });
    window.EventSource = Wrapped;
    (window as unknown as { personalFrames: unknown[] }).personalFrames = frames;
  });
}

const frames = (page: Page) => page.evaluate(() => (window as unknown as { personalFrames: Array<{ kind: string; data?: unknown }> }).personalFrames);
const row = (page: Page, id: string) => page.locator(`#chat-compact-workers-items [data-worker-id="${id}"]`);

async function chat(page: Page, conversationId: string): Promise<void> {
  if (await page.locator("#touch-tab-chat").isVisible()) await page.locator("#touch-tab-chat").click();
  else await openChatPanel(page);
  await expect(page.locator("#chat-conversation-select")).toHaveValue(conversationId);
}

for (const engine of ["chromium", "webkit"] as const) test(`${engine}: real authenticated private dismissal convergence, activity retirement, reconnect and Hub listener/store restart`, async ({ hub, hubProcess }, info) => {
  test.setTimeout(120_000);
  const browser = await ({ chromium, webkit })[engine].launch();
  const contexts: BrowserContext[] = [];
  const personalReads = new Map<Page, number>();
  try {
    const workspace = hub.workspaces[0]!;
    const worker: BackgroundTaskItem = { type: "background_task", id: "worker:unavailable", taskId: "worker-one", taskType: "agent", description: "Synthetic unavailable execution", childConversationId: "opencode:reused-child", status: "running", createdAt: 1,
      activity: { kind: "unavailable", executionId: "v1:launch-a", executionAliases: ["v1:launch-a", "v1:launch-b"], generation: 1, observedAt: 1 }, control: { available: false, reason: "Synthetic fixture has no native control proof" } };
    const ended: BackgroundTaskItem = { ...worker, id: "worker:ended", taskId: "worker-ended", description: "Synthetic ended execution", activity: { kind: "ended", executionId: "v1:ended", generation: 1, observedAt: 2, endedAt: 3 } };
    const snapshot = await childChatControl(workspace, { action: "seed", title: "Private worker dismissal acceptance", items: [worker, ended] }) as ConversationSnapshot;
    const conversationId = snapshot.conversation.id;
    const personalUrl = `${workspace.sessionUrl}api/personal-worker-dismissals?conversationId=${encodeURIComponent(conversationId)}`;
    const pages: Page[] = [];
    for (const user of [hub.user, hub.user, hub.otherUser!]) {
      expect(user).toBeTruthy();
      const context = await browser.newContext(engine === "webkit" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
      contexts.push(context);
      await watchPersonalFrames(context);
      const login = await context.newPage();
      await signIn(login, { ...hub, user }); await login.close();
      const page = await openSessionTab(context, workspace);
      personalReads.set(page, 0);
      page.on("response", response => {
        if (new URL(response.url()).pathname.endsWith("/api/personal-worker-dismissals") && response.request().method() === "GET" && response.status() === 200) {
          void response.finished().then(() => personalReads.set(page, (personalReads.get(page) ?? 0) + 1), () => {});
        }
      });
      await chat(page, conversationId); await openChatWorkers(page);
      await expect(row(page, worker.id)).toBeVisible(); await expect(row(page, ended.id)).toBeVisible();
      await expect.poll(async () => (await frames(page)).filter(frame => frame.kind === "data").length).toBeGreaterThan(0);
      await expect.poll(() => openEventSources(page)).toHaveLength(1);
      expect(new URL((await openEventSources(page))[0]!, hub.origin).pathname).toBe("/api/hub/live");
      pages.push(page);
    }
    const [a1, a2, b] = pages as [Page, Page, Page];
    const states = async (context: BrowserContext) => {
      const response = await context.request.get(personalUrl);
      expect(response.status()).toBe(200); expect(response.headers()["cache-control"]).toContain("no-store");
      return response.json() as Promise<{ entries: Array<{ executionId: string; dismissed: boolean }> }>;
    };
    const lifecycleMutations: string[] = [];
    for (const page of pages) page.on("request", request => {
      if (request.method() === "POST" && /\/(questions|permissions|background|cancel|stop)(\/|$)/.test(new URL(request.url()).pathname)) lifecycleMutations.push(new URL(request.url()).pathname);
    });
    await a2.locator("#chat-input").fill("Independent device draft");
    const initialA2Url = a2.url();
    const initialBFrames = (await frames(b)).filter(frame => frame.kind === "data").length;
    const initialA2Frames = (await frames(a2)).filter(frame => frame.kind === "data").length;
    await expect(a1.locator('meta[name="uatu-hub"]')).toHaveAttribute("content", "true");
    const dismissedResponse = a1.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/personal-worker-dismissals") && response.request().method() === "POST", { timeout: 10_000 });
    await row(a1, worker.id).getByRole("button", { name: "Dismiss worker from summary:", exact: false }).click();
    const saved = await dismissedResponse;
    expect(saved.status(), JSON.stringify(await saved.json())).toBe(200);
    const firstDismissedId = saved.request().postDataJSON().executionId as string;
    await expect(row(a1, worker.id)).toHaveCount(0); await expect(row(a2, worker.id)).toHaveCount(0);
    await expect(row(b, worker.id)).toBeVisible();
    await expect.poll(async () => (await frames(a2)).filter(frame => frame.kind === "data").length).toBeGreaterThan(initialA2Frames);
    expect((await frames(b)).filter(frame => frame.kind === "data")).toHaveLength(initialBFrames);
    expect((await states(contexts[0]!)).entries.find(entry => entry.executionId === firstDismissedId)?.dismissed).toBe(true);
    expect((await states(contexts[2]!)).entries.every(entry => !entry.dismissed)).toBe(true);
    await expect(a2.locator("#chat-input")).toHaveValue("Independent device draft");
    expect(a2.url()).toBe(initialA2Url);

    const endedResponse = a1.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/personal-worker-dismissals") && response.request().method() === "POST");
    await row(a1, ended.id).getByRole("button", { name: "Dismiss worker from summary:", exact: false }).click();
    const endedSaved = await endedResponse;
    expect(endedSaved.status()).toBe(200);
    const endedDismissedId = endedSaved.request().postDataJSON().executionId as string;
    await expect(a2.locator("#chat-compact-workers")).toBeHidden();
    await expect(b.locator("#chat-compact-workers-label")).toHaveText("2 unresolved");
    await captureScreenshot(a2, info, `${engine}-account-a-all-dismissed`);
    await captureScreenshot(b, info, `${engine}-account-b-private-rows`);
    await a2.reload(); await chat(a2, conversationId);
    await expect(a2.locator("#chat-compact-workers")).toBeHidden();

    // These are explicit synthetic child DTO observations, not claims of native
    // OpenCode proof. The real Hub observer/API/SSE/browser consume them unchanged.
    const recovered: BackgroundTaskItem = { ...worker, activity: { ...worker.activity!, kind: "working", executionId: "v1:launch-b", executionAliases: ["v1:launch-b", "v1:launch-a"] } };
    await childChatControl(workspace, { action: "item", conversationId, item: recovered });
    for (const page of pages) { await openChatWorkers(page); await expect(row(page, worker.id)).toHaveAttribute("data-state", "working"); }
    await expect.poll(async () => (await states(contexts[0]!)).entries.filter(entry => entry.executionId.startsWith("v1:launch-")).every(entry => !entry.dismissed)).toBe(true);
    const unavailableAgain: BackgroundTaskItem = { ...recovered, activity: { ...recovered.activity!, kind: "unavailable" } };
    await childChatControl(workspace, { action: "item", conversationId, item: unavailableAgain });
    for (const page of pages) await expect(row(page, worker.id)).toHaveAttribute("data-state", "unknown");
    const fresh: BackgroundTaskItem = { ...worker, id: "worker:fresh", taskId: "worker-fresh", description: "New execution in the same child", activity: { kind: "unavailable", executionId: "v1:new-execution", generation: 1 } };
    await childChatControl(workspace, { action: "item", conversationId, item: fresh });
    for (const page of pages) await expect(row(page, fresh.id)).toBeVisible();
    await captureScreenshot(a2, info, `${engine}-retired-mark-new-execution-visible`);

    const freshDismissalResponse = a1.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/personal-worker-dismissals") && response.request().method() === "POST", { timeout: 10_000 });
    const readsBeforeFreshDismissal = personalReads.get(a1)!;
    await row(a1, worker.id).getByRole("button", { name: "Dismiss worker from summary:", exact: false }).click();
    let freshSaved = await freshDismissalResponse;
    if (freshSaved.status() === 409) {
      // A signature changed since this device's last personal read. The real
      // client refreshes on conflict, but never resends a dismissal itself.
      await expect(row(a1, worker.id)).toBeVisible();
      await expect.poll(() => personalReads.get(a1)!).toBeGreaterThan(readsBeforeFreshDismissal);
      await a1.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      await expect(a1.locator(".chat-worker-dismissal-notice")).toBeHidden();
      const explicitRetry = a1.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/personal-worker-dismissals") && response.request().method() === "POST", { timeout: 10_000 });
      await row(a1, worker.id).getByRole("button", { name: "Dismiss worker from summary:", exact: false }).click();
      freshSaved = await explicitRetry;
    }
    expect(freshSaved.status(), JSON.stringify(await freshSaved.json())).toBe(200);
    await expect(row(a2, worker.id)).toHaveCount(0); await expect(row(a2, fresh.id)).toBeVisible();
    await contexts[1]!.setOffline(true);
    const newExecutionResponse = a1.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/personal-worker-dismissals") && response.request().method() === "POST", { timeout: 10_000 });
    await row(a1, fresh.id).getByRole("button", { name: "Dismiss worker from summary:", exact: false }).click();
    const newSaved = await newExecutionResponse;
    expect(newSaved.status()).toBe(200);
    const newDismissedId = newSaved.request().postDataJSON().executionId as string;
    expect(newDismissedId).not.toBe(firstDismissedId);
    await expect(row(a1, fresh.id)).toHaveCount(0);
    await expect(row(a2, fresh.id)).toBeVisible(); // The offline device really missed this invalidation.
    await contexts[1]!.setOffline(false);
    await a2.reload(); await chat(a2, conversationId);
    await expect(a2.locator("#chat-compact-workers")).toBeHidden();

    await hubProcess.restartWorkerDismissals();
    // This really recreates startHubServer and a fresh disk-loaded private
    // store. It intentionally retains the harness OS process and child data.
    await a2.reload(); await chat(a2, conversationId);
    await expect(a2.locator("#chat-compact-workers")).toBeHidden();
    expect((await states(contexts[1]!)).entries.filter(entry => entry.dismissed).map(entry => entry.executionId).sort()).toEqual([endedDismissedId, firstDismissedId, newDismissedId].sort());
    await b.reload(); await chat(b, conversationId); await openChatWorkers(b);
    for (const item of [worker, ended, fresh]) await expect(row(b, item.id)).toBeVisible();
    expect((await states(contexts[2]!)).entries.every(entry => !entry.dismissed)).toBe(true);
    for (const page of [a2, b]) {
      await expect.poll(() => openEventSources(page)).toHaveLength(1);
      expect(new URL((await openEventSources(page))[0]!, hub.origin).pathname).toBe("/api/hub/live");
      for (const frame of await frames(page)) if (frame.kind === "data") expect(frame).toEqual({ kind: "data", data: { category: "worker-dismissals" } });
    }
    expect(lifecycleMutations).toEqual([]);
    await saveEvidence(info, `${engine}-authenticated-dismissal-acceptance.json`, JSON.stringify({ engine, independentContexts: 3, authenticatedAccounts: 2,
      sameAccountSseConvergence: true, otherAccountUnchanged: true, provenAliasReordering: true, activityRetirement: true, freshExecutionIsolated: true,
      missedInvalidationRecovered: true, hubListenerAndStoreRecreatedFromDisk: true, osProcessRestarted: false, provider: "synthetic child DTO fixture", lifecycleMutations,
      singleStreamPaths: await Promise.all([a2, b].map(async page => new URL((await openEventSources(page))[0]!, hub.origin).pathname)) }, null, 2));
  } finally { await browser.close(); }
});

for (const engine of ["chromium", "webkit"] as const) test(`${engine}: native child permission and question resurface dismissed work and answer once through the canonical parent card`, async ({ hub }, info) => {
  test.setTimeout(120_000);
  const browser = await ({ chromium, webkit })[engine].launch();
  try {
    const workspace = hub.workspaces[0]!;
    await childChatControl(workspace, { action: "agents", stack: "opencode-v2", backgroundPreview: true });
    const pages: Page[] = [];
    for (let device = 0; device < 2; device++) {
      const context = await browser.newContext(engine === "webkit" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
      await watchPersonalFrames(context);
      const login = await context.newPage(); await signIn(login, hub); await login.close();
      const page = await openSessionTab(context, workspace);
      if (await page.locator("#touch-tab-chat").isVisible()) await page.locator("#touch-tab-chat").click(); else await openChatPanel(page);
      pages.push(page);
    }
    const [a1, a2] = pages as [Page, Page];
    await a1.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect(a1.locator("#chat-conversation-select")).not.toHaveValue("");
    const conversationId = await a1.locator("#chat-conversation-select").inputValue();
    await a1.locator("#chat-input").fill("Run the native request fixture"); await a1.locator("#chat-send").click();
    await expect(a1.locator("#chat-stop")).toBeEnabled();
    const worker = await childChatControl(workspace, { action: "opencode", op: "launchRequestWorker", conversationId }) as { taskId: string; childId: string; callId: string };
    await childChatControl(workspace, { action: "opencode", op: "finish", conversationId });
    await a2.reload(); await chat(a2, conversationId);
    const nativeRow = (page: Page) => page.locator(`#chat-compact-workers-items [data-background-task="${worker.taskId}"]`);
    for (const page of pages) { await openChatWorkers(page); await expect(nativeRow(page)).toHaveAttribute("data-state", "working"); }
    const state = async () => await childChatControl(workspace, { action: "opencode", op: "state" }) as ReturnType<OpenCodeV2Fake["state"]>;
    const canonical: Array<{ kind: string; requestId: string; canonicalId: string; childId: string }> = [];
    for (const kind of ["permission", "question"] as const) {
      // An incomplete active inventory does not end the execution. Reload the
      // real provider snapshot, dismiss its unavailable presentation, then let
      // a positively linked native request recover that same retained task.
      await childChatControl(workspace, { action: "opencode", op: "workerObservation", childId: worker.childId, observed: false });
      const refreshed = a1.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/personal-worker-dismissals") && response.request().method() === "GET" && response.status() === 200);
      await a1.reload(); await chat(a1, conversationId); await refreshed;
      await openChatWorkers(a1);
      await expect(nativeRow(a1)).toContainText("Status unavailable");
      const saved = a1.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/personal-worker-dismissals") && response.request().method() === "POST");
      await nativeRow(a1).getByRole("button", { name: "Dismiss worker from summary:", exact: false }).click();
      const dismissal = await saved;
      expect(dismissal.status(), JSON.stringify(await dismissal.json())).toBe(200);
      const dismissedId = dismissal.request().postDataJSON().executionId as string;
      for (const page of pages) await expect(nativeRow(page)).toHaveCount(0);

      const pending = await childChatControl(workspace, { action: "opencode", op: "workerRequest", childId: worker.childId, requestKind: kind }) as { requestId: string; childId: string; messageId: string; toolId: string };
      for (const page of pages) { await openChatWorkers(page); await expect(nativeRow(page)).toContainText("Needs your answer"); }
      const snapshotResponse = await a1.context().request.get(`${workspace.sessionUrl}api/chat/conversations/${encodeURIComponent(conversationId)}`);
      expect(snapshotResponse.status()).toBe(200);
      const snapshot = await snapshotResponse.json() as ConversationSnapshot;
      const request = snapshot.items.find(item => (item.type === "permission" || item.type === "question") && item.type === kind && item.requestId === pending.requestId);
      expect(request).toMatchObject({ type: kind, requestId: pending.requestId, status: "pending", conversationId: `opencode:${worker.childId}` });
      const canonicalId = request!.id;
      const card = a1.locator(`#chat-items [data-chat-item-id="${canonicalId}"]`);
      for (const page of pages) await expect(page.locator(`#chat-items [data-chat-item-id="${canonicalId}"]`)).toHaveCount(1);
      await nativeRow(a1).locator(".chat-worker-inspect").click();
      await expect.poll(() => a1.evaluate(() => document.activeElement?.closest<HTMLElement>("[data-chat-item-id]")?.dataset.chatItemId)).toBe(canonicalId);
      // Streaming may replace a card's DOM node while reconciling its native
      // fields. Its canonical id, count and focused answering surface must not
      // change or grow a second request/reply path.
      await expect(card).toHaveCount(1);
      expect((await state()).requestReplies.filter(reply => reply.requestId === pending.requestId)).toHaveLength(0);
      if (kind === "permission") await card.getByRole("button", { name: "Allow once", exact: true }).click();
      else {
        await card.getByRole("radio", { name: /Yes/ }).check();
        await card.getByRole("button", { name: "Answer", exact: true }).click();
      }
      await expect.poll(async () => (await state()).requestReplies.filter(reply => reply.requestId === pending.requestId).length).toBe(1);
      for (const page of pages) {
        await expect(nativeRow(page)).toContainText("Working");
        await expect(nativeRow(page)).not.toContainText("Needs your answer");
        await expect(page.locator(`#chat-items [data-chat-item-id="${canonicalId}"]`)).toHaveCount(1);
        if (kind === "permission") await expect(page.locator(`#chat-items [data-chat-item-id="${canonicalId}"] [data-permission-outcome]`)).toHaveCount(0);
        else await expect(page.locator(`#chat-items [data-chat-item-id="${canonicalId}"]`).getByRole("button", { name: "Answer", exact: true })).toHaveCount(0);
      }
      const expected: NativeWorkerRequestReply = { kind, childId: worker.childId, requestId: pending.requestId, body: kind === "permission" ? { decision: "once" } : { answer: { q0: "Yes" } } };
      expect((await state()).requestReplies.filter(reply => reply.requestId === pending.requestId)).toEqual([expected]);
      const rpc = `POST /api/session/${worker.childId}/${kind === "permission" ? "permission" : "form"}/${pending.requestId}/reply`;
      expect((await state()).calls.filter(call => call.split("?")[0] === rpc)).toHaveLength(1);
      const personal = await a1.context().request.get(`${workspace.sessionUrl}api/personal-worker-dismissals?conversationId=${encodeURIComponent(conversationId)}`).then(response => response.json()) as { entries: Array<{ executionId: string; dismissed: boolean }> };
      expect(personal.entries.find(entry => entry.executionId === dismissedId)?.dismissed).toBe(false);
      canonical.push({ kind, requestId: pending.requestId, canonicalId, childId: worker.childId });
      await captureScreenshot(a1, info, `${engine}-native-${kind}-answered-canonical`);
    }
    const final = await state();
    expect(final.requestReplies).toHaveLength(2);
    expect(final.unhandled).toEqual([]);
    const childProofs = final.requestEvidence.filter(event => event.sessionID === worker.childId && event.durable);
    expect(childProofs.map(event => event.durable!.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(childProofs.filter(event => event.type === "session.tool.input.started" || event.type === "session.tool.called")).toHaveLength(4);
    expect(childProofs.every(event => event.durable!.aggregateID === worker.childId && event.durable!.version === 1)).toBe(true);
    const ephemeral = final.requestEvidence.filter(event => event.type === "permission.asked" || event.type === "form.created");
    expect(ephemeral).toHaveLength(2); expect(ephemeral.every(event => event.durable === undefined)).toBe(true);
    for (const page of pages) await expect.poll(() => openEventSources(page)).toHaveLength(1);
    await saveEvidence(info, `${engine}-native-canonical-answer-acceptance.json`, JSON.stringify({ engine, canonical, replies: final.requestReplies, childProofs, ephemeral,
      nativeReplyRpcs: final.calls.filter(call => /\/api\/session\/[^/]+\/(permission|form)\/[^/]+\/reply/.test(call)),
      nativeReplyRpcCount: 2, singleReplyPerRequest: true, canonicalCardReused: true, resurfacedPriorDismissal: true, producerContract: "OpenCode 2.1.2 synthetic native tool/request envelopes; real provider, adapter, Hub and browser" }, null, 2));
  } finally { await browser.close(); }
});
