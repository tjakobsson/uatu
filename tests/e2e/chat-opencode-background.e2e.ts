import type { APIRequestContext, Page } from "@playwright/test";
import { openChatPanel } from "./chat-helpers";
import { test as base, expect } from "./fixtures";
import { withEngineBrowsers } from "./page-diagnostics";
import { captureScreenshot } from "./evidence";
const test = withEngineBrowsers(base);

async function control(request: APIRequestContext, body: Record<string, unknown>) {
  const response = await request.post("/__e2e/chat", { data: { action: "opencode", ...body } });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function revealTouchWorkers(page: Page) {
  if (await page.locator("html").getAttribute("data-ui-mode") !== "touch") return;
  const workers = page.locator("#chat-compact-workers");
  if (!await workers.getAttribute("open").then(value => value !== null)) await workers.locator(":scope > summary").tap();
}

async function revealTouchContinue(page: Page) {
  await page.locator("#chat-continue-workers").scrollIntoViewIfNeeded();
}

async function boot(page: Page, request: APIRequestContext, preview = true) {
  await request.post("/__e2e/reset");
  await control(request, { action: "agents", stack: "opencode-v2", backgroundPreview: preview });
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  if (await page.locator("html").getAttribute("data-ui-mode") === "touch") await page.locator("#touch-tab-chat").tap();
  else await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.locator("#chat-state")).toContainText("Started new conversation with OpenCode");
  const conversationId = await page.locator("#chat-conversation-select").inputValue();
  await page.locator("#chat-input").fill("Start fixture work");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-stop")).toBeEnabled();
  return conversationId;
}

async function settleDuringShellConfirmation(page: Page, request: APIRequestContext) {
  const conversationId = await boot(page, request);
  const shell = await control(request, { op: "launchShell", conversationId });
  await revealTouchWorkers(page);
  await page.locator(`[data-background-task="${shell.taskId}"] [data-inspect-task]`).click();
  await expect(page.locator("#chat-drilldown-output-text")).toContainText("safe shell output");
  await page.locator("#chat-drilldown-task [data-stop-task]").click();
  const confirmation = page.getByRole("dialog", { name: "Stop shell worker?" });
  await expect(confirmation).toBeVisible();
  await control(request, { op: "shellPhase", shellId: shell.shellId, shellPhase: "capture" });
  const result = page.locator("#chat-drilldown-task [data-task-result]");
  await expect(result).toBeAttached();
  await expect(page.locator("#chat-drilldown-task [data-stop-task]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(page.locator("#chat-drilldown")).toBeVisible();
  await expect(result).toBeFocused();
  expect((await control(request, { op: "state" })).calls.filter((call: string) => call.startsWith("DELETE /api/shell/"))).toHaveLength(0);
}

test("settlement during shell confirmation restores the surviving inspection action", async ({ page, request }, testInfo) => {
  await settleDuringShellConfirmation(page, request);
  await captureScreenshot(page, testInfo, "review-shell-confirmation-focus-desktop");
});

test("Continue feedback clears after parent and workers settle", async ({ page, request }) => {
  const conversationId = await boot(page, request);
  const worker = await control(request, { op: "launchWorker", conversationId, background: false });
  await page.getByRole("button", { name: "Continue while workers run", exact: true }).click();
  await expect(page.locator("#chat-background-feedback")).toContainText("Request accepted");
  await control(request, { op: "finish", conversationId });
  await control(request, { op: "settleWorker", childId: worker.childId });
  await expect(page.locator("#chat-background-tasks-items [data-inspect-task]")).toHaveCount(0);
  await expect(page.locator("#chat-background-action")).toBeHidden();
  await expect(page.locator("#chat-background-feedback")).toBeEmpty();
  await control(request, { op: "wakeParent", conversationId });
  await expect(page.locator("#chat-background-feedback")).toBeEmpty();
});

for (const theme of ["light", "dark"] as const) test(`background audit desktop ${theme}`, async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ colorScheme: theme });
  const conversationId = await boot(page, request);
  const stopBeforeWorkers = (await page.locator("#chat-stop").boundingBox())!;
  const worker = await control(request, { op: "launchWorker", conversationId, background: false });
  const sibling = await control(request, { op: "launchWorker", conversationId });
  const proceed = page.getByRole("button", { name: "Continue while workers run", exact: true });
  await expect(proceed).toBeVisible();
  const stopWithWorkers = (await page.locator("#chat-stop").boundingBox())!;
  expect(stopWithWorkers.width).toBe(stopBeforeWorkers.width);
  expect(stopWithWorkers.x).toBe(stopBeforeWorkers.x);
  await expect(proceed).toHaveClass(/chat-secondary-button/);
  await expect(page.locator(".chat-background-help")).not.toHaveAttribute("open");
  await captureScreenshot(page, testInfo, `audit-background-desktop-${theme}-blocking`);
  await proceed.click();
  await expect(page.locator("#chat-background-tasks-items [data-inspect-task]")).toHaveCount(2);
  await expect(proceed).toBeHidden();
  await captureScreenshot(page, testInfo, `audit-background-desktop-${theme}-detached`);
  await control(request, { op: "finish", conversationId });
  await control(request, { op: "settleWorker", childId: worker.childId });
  await control(request, { op: "settleWorker", childId: sibling.childId });
  await expect(page.locator("#chat-background-action")).toBeHidden();
  for (const group of await page.locator("#chat-items details.chat-activity-group:not([open]) > summary").all()) await group.click();
  await captureScreenshot(page, testInfo, `audit-background-desktop-${theme}-settled`);
});

test("Continue is parent-wide, keeps the draft, and inspection survives worker failure", async ({ page, request }) => {
  const conversationId = await boot(page, request);
  const worker = await control(request, { op: "launchWorker", conversationId, background: false });
  await page.locator("#chat-input").fill("Keep this draft");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=", "base64");
  const upload = page.waitForResponse(response => response.url().includes("/attachments") && response.request().method() === "POST");
  await page.locator("#chat-attach-input").setInputFiles({ name: "preserved.png", mimeType: "image/png", buffer: png });
  expect((await upload).status()).toBe(201);
  const attachments = await page.locator("#chat-attachments").textContent();
  const configuration = await page.locator("#chat-configuration-summary").textContent();
  const delivery = await page.locator("#chat-send-help").textContent();
  const proceed = page.getByRole("button", { name: "Continue while workers run", exact: true });
  await expect(proceed).toBeVisible();
  await expect(page.locator("#chat-background-action")).toContainText("including shell commands");
  await proceed.click();
  await expect(page.locator("#chat-background-tasks-items [data-inspect-task]")).toHaveCount(1);
  await expect(page.locator("#chat-input")).toHaveValue("Keep this draft");
  await expect(page.locator("#chat-attachments")).toHaveText(attachments!);
  await expect(page.locator("#chat-configuration-summary")).toHaveText(configuration!);
  expect(await page.locator("#chat-send-help").textContent()).toBe(delivery);
  const state = await control(request, { op: "state" });
  expect(state.calls.filter((call: string) => call.startsWith("POST ") && call.includes("/background"))).toHaveLength(1);
  await page.locator("#chat-background-tasks-items [data-inspect-task]").click();
  await expect(page.locator("#chat-drilldown-items")).toContainText("Check fixture");
  await control(request, { op: "settleWorker", childId: worker.childId, workerState: "error", text: "Fixture failed safely" });
  await expect(page.locator("#chat-drilldown-task")).toContainText("failed");
  await expect(page.locator("#chat-drilldown-items")).toContainText("Fixture failed safely");
  await page.keyboard.press("Escape");
  await expect(page.locator("#chat-input")).toHaveValue("Keep this draft");
  for (const group of await page.locator("#chat-items details.chat-activity-group:not([open]) > summary").all()) await group.click();
  await page.locator(`[data-chat-item-id="task:${worker.taskId}"] > summary`).click();
  await expect(page.locator(".chat-task-summary", { hasText: "Fixture failed safely" })).toHaveCount(1);
  await page.reload();
  await openChatPanel(page);
  await expect(page.locator("#chat-background-tasks-items [data-inspect-task]")).toHaveCount(0);
  const report = page.locator(`[data-chat-item-id="task:${worker.taskId}"]`);
  await expect(report).toContainText("failed");
});

for (const [workerState, outcome] of [["completed", "finished"], ["error", "failed"], ["cancelled", "stopped"]] as const) {
  test(`native worker ${workerState} settles independently; Stop acknowledgement is not settlement`, async ({ page, request }) => {
    const conversationId = await boot(page, request);
    const worker = await control(request, { op: "launchWorker", conversationId });
    const sibling = await control(request, { op: "launchWorker", conversationId });
    await control(request, { op: "finish", conversationId, text: "Parent finished" });
    await expect(page.locator("#chat-stop")).toBeDisabled();
    const row = page.locator(`[data-background-task="${worker.taskId}"]`);
    await expect(row).toBeVisible();
    if (workerState === "cancelled") {
      const acknowledged = page.waitForResponse(response => response.url().includes("/tasks/") && response.url().endsWith("/stop"));
      await row.locator("[data-stop-task]").click();
      await expect(row.locator("[data-stop-task]")).toHaveText("Stopping…");
      await expect(row.locator("[data-stop-task]")).toBeDisabled();
      // Stopping is immediate UI feedback, not proof the provider dispatched.
      // Count native requests only after admission acknowledges, before the
      // test emits settlement. Keep the exact target and sibling assertions.
      expect((await acknowledged).ok()).toBe(true);
      const state = await control(request, { op: "state" });
      expect(state.calls.filter((call: string) => call.startsWith("POST ") && call.includes("/interrupt"))).toEqual([`POST /api/session/${worker.childId}/interrupt?resume=false`]);
      expect(state.sessions[sibling.childId].running).toBe(true);
    }
    await control(request, { op: "settleWorker", childId: worker.childId, workerState, text: `Report ${outcome}` });
    await expect(row).toHaveCount(0);
    await expect(page.locator("#chat-background-tasks-items [data-inspect-task]")).toHaveCount(1);
    await expect(page.locator(`[data-chat-item-id="task:${worker.taskId}"]`)).toContainText(outcome);
    expect((await control(request, { op: "state" })).sessions[sibling.childId].running).toBe(true);
  });
}

test("a sibling settling or launching preserves the focused surviving worker control", async ({ page, request }) => {
  const conversationId = await boot(page, request);
  const a = await control(request, { op: "launchWorker", conversationId });
  const b = await control(request, { op: "launchWorker", conversationId });
  const row = page.locator(`[data-background-task="${a.taskId}"]`);
  const inspect = row.locator("[data-inspect-task]");
  const stop = row.locator("[data-stop-task]");
  await inspect.focus();
  await control(request, { op: "settleWorker", childId: b.childId, text: "Sibling finished" });
  await expect(page.locator(`[data-background-task="${b.taskId}"]`)).toHaveCount(0);
  await expect(inspect).toBeFocused();
  await stop.focus();
  const c = await control(request, { op: "launchWorker", conversationId });
  await expect(page.locator(`[data-background-task="${c.taskId}"]`)).toBeVisible();
  await expect(stop).toBeFocused();
  await control(request, { op: "settleWorker", childId: c.childId });
  await expect(page.locator(`[data-background-task="${c.taskId}"]`)).toHaveCount(0);
  await expect(stop).toBeFocused();
  expect((await control(request, { op: "state" })).calls.some((call: string) => call.startsWith("POST ") && call.includes("/interrupt"))).toBe(false);
});

test("completion wins a delayed worker Stop response; an idle parent can prompt while its sibling runs", async ({ page, request }) => {
  const conversationId = await boot(page, request);
  const worker = await control(request, { op: "launchWorker", conversationId });
  const sibling = await control(request, { op: "launchWorker", conversationId });
  await control(request, { op: "finish", conversationId });
  let release!: () => void;
  let admitted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stopAdmitted = new Promise<void>(resolve => { admitted = resolve; });
  await page.route("**/api/chat/conversations/*/tasks/*/stop", async route => {
    const response = await route.fetch();
    // Delay only the browser acknowledgement, not server admission. The UI's
    // optimistic Stopping label alone does not prove the interrupt dispatched.
    admitted();
    await gate; await route.fulfill({ response });
  });
  const row = page.locator(`[data-background-task="${worker.taskId}"]`);
  await row.locator("[data-stop-task]").click();
  await expect(row.locator("[data-stop-task]")).toHaveText("Stopping…");
  await stopAdmitted;
  expect((await control(request, { op: "state" })).calls.filter((call: string) => call.startsWith("POST ") && call.includes("/interrupt"))).toEqual([`POST /api/session/${worker.childId}/interrupt?resume=false`]);
  await control(request, { op: "settleWorker", childId: worker.childId, text: "Completion won the race" });
  await expect(page.locator(`[data-chat-item-id="task:${worker.taskId}"]`)).toContainText("finished");
  const stopped = page.waitForResponse(response => response.url().endsWith("/stop"));
  release(); expect((await stopped).ok()).toBe(true);
  await expect(page.locator(`[data-chat-item-id="task:${worker.taskId}"]`)).toContainText("finished");
  await page.locator("#chat-input").fill("Continue parent independently");
  const prompted = page.waitForResponse(response => response.url().endsWith("/prompts"));
  await page.locator("#chat-send").click(); expect((await prompted).ok()).toBe(true);
  await expect(page.locator(`[data-background-task="${sibling.taskId}"]`)).toBeVisible();
  const state = await control(request, { op: "state" });
  expect(state.sessions[sibling.childId].running).toBe(true);
  expect(state.calls.filter((call: string) => call.startsWith("POST ") && call.includes("/background"))).toHaveLength(0);
  expect(state.calls.filter((call: string) => call.startsWith("POST ") && call.includes("/prompt"))).toHaveLength(2);
});

for (const boundary of ["browser", "upstream"] as const) {
  test(`${boundary} response loss retains the receipt and reconnect never replays Continue`, async ({ page, request }) => {
    const conversationId = await boot(page, request);
    await control(request, { op: "launchWorker", conversationId, background: false });
    if (boundary === "upstream") await control(request, { op: "loseBackgroundResponse" });
    let requestId = "";
    await page.route("**/api/chat/conversations/*/background", async route => {
      requestId = route.request().postDataJSON().requestId;
      const response = await route.fetch();
      if (boundary === "browser") await route.abort("connectionreset");
      else await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Continue while workers run", exact: true }).click();
    await expect(page.locator("#chat-background-feedback")).toContainText("Outcome unknown");
    await control(request, { op: "launchWorker", conversationId, background: false });
    const retry = await page.request.post(`/api/chat/conversations/${encodeURIComponent(conversationId)}/background`, { headers: { origin: new URL(page.url()).origin }, data: { requestId } });
    expect(retry.status()).toBe(boundary === "browser" ? 200 : 409);
    await page.unroute("**/api/chat/conversations/*/background");
    await control(request, { op: "disconnect" });
    await page.reload(); await openChatPanel(page);
    await expect(page.locator("#chat-background-tasks-items [data-inspect-task]")).toHaveCount(1);
    const state = await control(request, { op: "state" });
    expect(state.calls.filter((call: string) => call.startsWith("POST ") && call.includes("/background"))).toHaveLength(1);
  });
}

test("Stop parent cancels blocking children, preserves detached work and paused input; native wake preserves the draft", async ({ page, request }) => {
  const conversationId = await boot(page, request);
  const nativeId = conversationId.replace(/^opencode:/, "");
  const foreground = await control(request, { op: "launchWorker", conversationId, background: false });
  const detached = await control(request, { op: "launchWorker", conversationId });
  await page.locator("#chat-input").fill("Pending steer");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-input")).toHaveValue("");
  await page.locator("#chat-input").fill("Held queue");
  // The previous steer clears its draft before its admission finishes.
  // Wait for the submission guard to release, not merely for an empty input.
  await expect(page.locator("#chat-send")).toBeEnabled();
  await page.locator("#chat-input").press("Alt+Enter");
  await expect(page.locator("#chat-input")).toHaveValue("");
  await page.locator("#chat-input").fill("Draft must survive");
  const cancelled = page.waitForResponse(response => response.url().endsWith("/cancel") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Stop parent", exact: true }).click();
  expect((await cancelled).ok()).toBe(true);
  await expect(page.locator("#chat-stop")).toBeDisabled();
  const stopped = await control(request, { op: "state" });
  expect(stopped.sessions[foreground.childId].running).toBe(false);
  expect(stopped.sessions[detached.childId].running).toBe(true);
  expect(stopped.sessions[nativeId].pending.some((entry: { payload: { text: string } }) => entry.payload.text === "Pending steer")).toBe(true);
  expect(stopped.calls.filter((call: string) => call.startsWith("POST ") && call.includes("/interrupt"))).toEqual([`POST /api/session/${nativeId}/interrupt?resume=false`]);
  expect(stopped.calls.some((call: string) => call.startsWith("POST ") && call.includes("/background"))).toBe(false);
  await control(request, { op: "settleWorker", childId: detached.childId, text: "Detached report" });
  await control(request, { op: "wakeParent", conversationId });
  await expect(page.locator("#chat-stop")).toBeEnabled();
  await expect(page.locator("#chat-input")).toHaveValue("Draft must survive");
  await expect(page.locator("#chat-queue")).toContainText("Held queue");
  const resumed = await control(request, { op: "state" });
  expect(resumed.calls.filter((call: string) => call.startsWith("POST ") && call.includes("/interrupt"))).toHaveLength(1);
  expect(resumed.calls.filter((call: string) => call.startsWith("POST ") && call.includes("/prompt"))).toHaveLength(2);
});

test("an accepted no-op invents no tasks; unadvertised capability offers no Continue", async ({ page, request }) => {
  const conversationId = await boot(page, request);
  await expect(page.getByRole("button", { name: "Continue while workers run", exact: true })).toBeHidden();
  const worker = await control(request, { op: "launchWorker", conversationId, background: false });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const dispatched = new Promise<void>(resolve => { entered = resolve; });
  await page.route("**/api/chat/conversations/*/background", async route => { entered(); await gate; await route.continue(); }, { times: 1 });
  const accepted = page.waitForResponse(response => response.url().endsWith("/background") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Continue while workers run", exact: true }).click();
  await dispatched;
  await control(request, { op: "settleWorker", childId: worker.childId });
  release();
  // The request is deliberately held before dispatch. Await its real no-op
  // acknowledgement before inspecting accepted feedback, not elapsed time.
  const response = await accepted;
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ accepted: true });
  await expect(page.locator("#chat-background-feedback")).toContainText("Request accepted");
  await expect(page.locator("#chat-background-tasks-items [data-inspect-task]")).toHaveCount(0);
  expect((await control(request, { op: "state" })).calls.filter((call: string) => call.startsWith("POST ") && call.includes("/background"))).toHaveLength(1);
  await boot(page, request, false);
  await expect(page.getByRole("button", { name: "Continue while workers run", exact: true })).toHaveCount(0);
});

for (const phase of ["running", "exit", "captureBeforeRemove"] as const) {
  test(`shell removal with ${phase} preserves available output and reports the capture outcome truthfully`, async ({ page, request }) => {
    const conversationId = await boot(page, request);
    await control(request, { op: "launchWorker", conversationId, background: false });
    await control(request, { op: "launchWorker", conversationId, background: false });
    const shell = await control(request, { op: "launchShell", conversationId, background: false });
    await page.getByRole("button", { name: "Continue while workers run", exact: true }).click();
    await expect(page.locator("#chat-background-tasks-items [data-inspect-task]")).toHaveCount(3);
    await page.locator(`[data-background-task="${shell.taskId}"] [data-inspect-task]`).click();
    await expect(page.locator("#chat-drilldown-output-text")).toContainText("safe shell output");
    if (phase !== "running") await control(request, { op: "shellPhase", shellId: shell.shellId, shellPhase: phase });
    const removed = page.waitForResponse(response => response.url().includes("/tasks/") && response.url().endsWith("/stop"));
    await page.locator("#chat-drilldown-task [data-stop-task]").click();
    const confirmation = page.getByRole("dialog", { name: "Stop shell worker?" });
    await expect(confirmation).toContainText("removes its provider record and output");
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeHidden();
    await expect(page.locator("#chat-drilldown")).toBeVisible();
    await expect(page.locator("#chat-drilldown-task [data-stop-task]")).toBeFocused();
    expect((await control(request, { op: "state" })).calls.filter((call: string) => call.startsWith("DELETE /api/shell/"))).toHaveLength(0);
    await page.locator("#chat-drilldown-task [data-stop-task]").click();
    await confirmation.getByRole("button", { name: "Stop shell worker", exact: true }).click();
    expect((await removed).ok()).toBe(true);
    if (phase !== "captureBeforeRemove") {
      await expect(page.locator("#chat-drilldown-task [data-stop-task]")).toHaveText("Stopping…");
      await control(request, { op: "shellPhase", shellId: shell.shellId, shellPhase: "capture" });
    }
    await expect(page.locator("#chat-drilldown-task")).toContainText(phase === "captureBeforeRemove" ? "finished" : "failed");
    await expect(page.locator("#chat-drilldown-output-note")).toContainText("Output unavailable");
    await expect(page.locator("#chat-drilldown-output-text")).toContainText("safe shell output");
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-background-tasks-items [data-inspect-task]")).toHaveCount(2);
    const state = await control(request, { op: "state" });
    expect(state.calls.filter((call: string) => call.startsWith("POST ") && call.includes("/background"))).toHaveLength(1);
    expect(state.calls.filter((call: string) => call.startsWith("DELETE /api/shell/"))).toHaveLength(1);
    expect(state.shells[shell.shellId]).toMatchObject({ removed: true, waiter: phase === "running" ? "failed" : "exited", captured: true, outputAvailable: false });
    expect(state.calls.some((call: string) => call.startsWith("POST ") && call.includes("/interrupt"))).toBe(false);
  });
}

for (const kind of ["child", "shell"] as const) test(`unknown ${kind} stop stays deduplicated through refresh and reload`, async ({ page, request }) => {
  const conversationId = await boot(page, request);
  const worker = await control(request, { op: kind === "child" ? "launchWorker" : "launchShell", conversationId });
  await control(request, { op: "loseWorkerResponse" });
  let requestId = "";
  page.on("request", request => { if (request.url().includes("/tasks/") && request.url().endsWith("/stop")) requestId = request.postDataJSON().requestId; });
  await page.locator(`[data-background-task="${worker.taskId}"] [data-stop-task]`).click();
  if (kind === "shell") await page.getByRole("dialog", { name: "Stop shell worker?" }).getByRole("button", { name: "Stop shell worker", exact: true }).click();
  await expect(page.locator("#chat-state")).toContainText("Outcome unknown");
  const retry = await page.request.post(`/api/chat/conversations/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(worker.taskId)}/stop`, { headers: { origin: new URL(page.url()).origin }, data: { requestId } });
  expect(retry.status()).toBe(409);
  await page.reload(); await openChatPanel(page);
  await expect(page.locator("#chat-background-tasks-items [data-inspect-task]")).toHaveCount(1);
  const state = await control(request, { op: "state" });
  const calls = state.calls.filter((call: string) => kind === "child" ? call.startsWith("POST ") && call.includes("/interrupt") : call.startsWith("DELETE /api/shell/"));
  expect(calls).toHaveLength(1);
});

test("historical result inspection stays on the selected occurrence when its child is reused", async ({ page, request }) => {
  const conversationId = await boot(page, request);
  const first = await control(request, { op: "launchWorker", conversationId });
  await control(request, { op: "settleWorker", childId: first.childId, text: "Earlier worker report" });
  await expect(page.locator(`[data-chat-item-id="task:${first.taskId}"]`)).toContainText("finished");
  const later = await control(request, { op: "launchWorker", conversationId, childId: first.childId });
  expect(later.childId).toBe(first.childId);
  await expect(page.locator(`[data-background-task="${later.taskId}"]`)).toBeVisible();
  for (const group of await page.locator("#chat-items details.chat-activity-group:not([open]) > summary").all()) await group.click();
  const report = page.locator(`[data-chat-item-id="task:${first.taskId}"]`);
  await report.locator("> summary").click();
  await report.getByRole("button", { name: "Open transcript" }).click();
  await expect(page.locator("#chat-drilldown-task")).toContainText("finished");
  await expect(page.locator("#chat-drilldown-task")).not.toContainText("Earlier worker report");
  await expect(page.locator("#chat-drilldown-task [data-stop-task]")).toHaveCount(0);
  await expect(page.locator("#chat-conversation-select")).toHaveValue(conversationId);
  await page.locator("#chat-drilldown-task").getByRole("button", { name: "View worker result" }).click();
  await expect(page.locator("#chat-drilldown")).toBeHidden();
  await expect(report).toContainText("Earlier worker report");
});

test("narrow keyboard Continue suppresses duplicates and worker updates do not steal draft focus", async ({ page, request }) => {
  // Desktop below 900px intentionally yields Chat to Preview; exercise a
  // narrow split panel above that existing layout guard instead.
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const conversationId = await boot(page, request);
  const worker = await control(request, { op: "launchWorker", conversationId, background: false });
  await page.locator("#chat-input").fill("Keyboard draft stays here");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/chat/conversations/*/background", async route => { await gate; await route.continue(); });
  const proceed = page.getByRole("button", { name: "Continue while workers run", exact: true });
  await proceed.focus();
  await expect(proceed).toBeFocused();
  const box = (await proceed.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);
  await proceed.press("Enter");
  await expect(proceed).toBeDisabled();
  await expect(page.locator("#chat-input")).toHaveValue("Keyboard draft stays here");
  release();
  const row = page.locator(`[data-background-task="${worker.taskId}"]`);
  await expect(row).toBeVisible();
  const inspect = (await row.locator("[data-inspect-task]").boundingBox())!;
  const stop = (await row.locator("[data-stop-task]").boundingBox())!;
  expect(inspect.height).toBeGreaterThanOrEqual(44);
  expect(stop.height).toBeGreaterThanOrEqual(44);
  expect(stop.x - inspect.x - inspect.width).toBeGreaterThanOrEqual(8);
  await row.locator("[data-inspect-task]").focus();
  await page.keyboard.press("Tab");
  await expect(row.locator("[data-stop-task]")).toBeFocused();
  expect(await row.locator("[data-stop-task]").evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await page.locator("#chat-input").focus();
  await control(request, { op: "settleWorker", childId: worker.childId, text: "Keyboard result" });
  await expect(row).toHaveCount(0);
  await expect(page.locator("#chat-input")).toBeFocused();
  await expect(page.locator("#chat-input")).toHaveValue("Keyboard draft stays here");
  expect((await control(request, { op: "state" })).calls.filter((call: string) => call.startsWith("POST ") && call.includes("/background"))).toHaveLength(1);
});

test("provider reconnect recovers a missed pending result while another parent is selected", async ({ page, request }) => {
  const conversationId = await boot(page, request);
  const worker = await control(request, { op: "launchWorker", conversationId });
  await control(request, { op: "finish", conversationId });
  await expect(page.locator(`[data-background-task="${worker.taskId}"]`)).toBeVisible();
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue(conversationId);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await control(request, { op: "pauseEvents" });
  expect((await control(request, { op: "state" })).eventSubscribers).toBe(0);
  await control(request, { op: "settleWorker", childId: worker.childId, text: "Missed completion recovered" });
  await control(request, { op: "reconnectEvents" });
  await expect.poll(async () => (await control(request, { op: "state" })).eventSubscribers).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.locator("#chat-conversation-select").selectOption(conversationId);
  const result = page.locator(`[data-chat-item-id="task:${worker.taskId}"]`);
  await expect(result).toContainText("finished");
  await expect(page.locator("#chat-background-tasks-items [data-inspect-task]")).toHaveCount(0);
  for (const group of await page.locator("#chat-items details.chat-activity-group:not([open]) > summary").all()) await group.click();
  await result.locator("> summary").click();
  await expect(result).toContainText("Missed completion recovered");
  await result.getByRole("button", { name: "Open transcript" }).click();
  await expect(page.locator("#chat-drilldown-items")).toContainText("Missed completion recovered");
  await expect(page.locator("#chat-conversation-select")).toHaveValue(conversationId);
  const state = await control(request, { op: "state" });
  expect(state.calls.filter((call: string) => call.startsWith("POST ") && /\/(background|interrupt)/.test(call))).toEqual([]);
});

test("an oldest-page launch survives return and a terminal result racing the browser snapshot", async ({ page, request }) => {
  const conversationId = await boot(page, request);
  const worker = await control(request, { op: "launchWorker", conversationId });
  await control(request, { op: "appendHistory", conversationId, count: 60 });
  await control(request, { op: "finish", conversationId });
  await page.locator("#chat-input").fill("Draft on paged parent");
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue(conversationId);
  let release!: () => void;
  let captured!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { captured = resolve; });
  await page.route(`**/api/chat/conversations/${encodeURIComponent(conversationId)}?*`, async route => {
    const response = await route.fetch(); captured(); await gate; await route.fulfill({ response });
  }, { times: 1 });
  await page.locator("#chat-conversation-select").selectOption(conversationId);
  await reading;
  await control(request, { op: "settleWorker", childId: worker.childId, text: "Result won the stale snapshot" });
  release();
  await expect(page.locator(`[data-chat-item-id="task:${worker.taskId}"]`)).toContainText("finished");
  await expect(page.locator("#chat-background-tasks-items [data-inspect-task]")).toHaveCount(0);
  await expect(page.locator("#chat-input")).toHaveValue("Draft on paged parent");
  await page.locator("#chat-load-older").click();
  await expect(page.locator(`[data-chat-item-id="task:${worker.taskId}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-chat-item-id="task:${worker.taskId}"]`)).toContainText("finished");
});

test("keyboard child inspection retries the exact hidden child and returns focus without losing the parent draft", async ({ page, request }) => {
  const conversationId = await boot(page, request);
  const worker = await control(request, { op: "launchWorker", conversationId });
  await page.locator("#chat-input").fill("Preserved reading draft");
  const inspect = page.locator(`[data-background-task="${worker.taskId}"] [data-inspect-task]`);
  await expect(inspect).toBeVisible();
  expect(await page.locator("#chat-conversation-select option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).not.toContain(`opencode:${worker.childId}`);
  const childURL = `**/api/chat/conversations/${encodeURIComponent(`opencode:${worker.childId}`)}?*`;
  await page.route(childURL, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary fixture read failure" }) }), { times: 1 });
  await inspect.focus();
  await inspect.press("Enter");
  const retry = page.locator("#chat-drilldown").getByRole("button", { name: /Retry/ });
  await expect(retry).toBeVisible();
  await expect(page.locator("#chat-conversation-select")).toHaveValue(conversationId);
  await retry.click();
  await expect(page.locator("#chat-drilldown-items")).toContainText("Check fixture");
  await page.keyboard.press("Escape");
  await expect(page.locator("#chat-drilldown")).toBeHidden();
  await expect(inspect).toBeFocused();
  await expect(page.locator("#chat-input")).toHaveValue("Preserved reading draft");
  await inspect.press("Enter");
  await expect(page.locator("#chat-drilldown-items")).toContainText("Check fixture");
  await page.keyboard.press("Escape");
  await expect(inspect).toBeFocused();
});

for (const engine of ["chromium", "webkit"] as const) test.describe(`worker controls on ${engine} touch`, () => {
  test.use({ page: async ({ launchBrowser, baseURL }, use) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await use(page); await browser.close();
  } });
  test("settlement during shell confirmation restores the surviving inspection action", async ({ page, request }, testInfo) => {
    await settleDuringShellConfirmation(page, request);
    await captureScreenshot(page, testInfo, `review-shell-confirmation-focus-${engine}`);
  });
  test("Continue activates on its first touch while composing", async ({ page, request }, testInfo) => {
    const conversationId = await boot(page, request);
    await control(request, { op: "launchWorker", conversationId, background: false });
    const input = page.locator("#chat-input");
    await input.fill("Keep this composing draft");
    await input.focus();
    await revealTouchContinue(page);
    const proceed = page.getByRole("button", { name: "Continue while workers run", exact: true });
    await expect(input).toBeFocused();
    await expect(proceed).toBeVisible();
    await proceed.tap();
    await expect.poll(async () => (await control(request, { op: "state" })).calls.filter((call: string) => call.startsWith("POST ") && call.includes("/background")).length).toBe(1);
    await expect(page.locator("#chat-compact-workers-items [data-inspect-task]")).toHaveCount(1);
    await expect(input).toHaveValue("Keep this composing draft");
    await expect(input).toBeFocused();
    await captureScreenshot(page, testInfo, `review-continue-first-touch-${engine}`);
  });
  test("touch work stays collapsed across conversations before and after detachment", async ({ page, request }, testInfo) => {
    const firstId = await boot(page, request);
    const firstWorker = await control(request, { op: "launchWorker", conversationId: firstId, background: false });
    const track = page.locator("#chat-compact-workers");
    await expect(track).not.toHaveAttribute("open");
    // No disclosure interaction: B must not inherit an automatic expansion.
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue(firstId);
    const secondId = await page.locator("#chat-conversation-select").inputValue();
    await page.locator("#chat-input").fill("Start conversation B work");
    const prompted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-send").tap();
    expect((await prompted).ok()).toBe(true);
    await control(request, { op: "launchWorker", conversationId: secondId, background: false });
    await expect(track).not.toHaveAttribute("open");
    await revealTouchContinue(page);
    await page.getByRole("button", { name: "Continue while workers run", exact: true }).tap();
    await expect(page.locator("#chat-compact-workers-items [data-inspect-task]")).toHaveCount(1);
    await expect(track).not.toHaveAttribute("open");
    const state = await control(request, { op: "state" });
    expect(state.calls.filter((call: string) => call.startsWith("POST ") && call.includes("/background"))).toEqual([`POST /api/session/${secondId.replace(/^opencode:/, "")}/background`]);
    expect(state.sessions[firstWorker.childId].running).toBe(true);
    await captureScreenshot(page, testInfo, `rereview-conversation-switch-${engine}`);
  });
  for (const deliberate of [false, true]) test(`touch detachment ${deliberate ? "preserves deliberate expansion" : "never expands collapsed workers"}`, async ({ page, request }, testInfo) => {
    const conversationId = await boot(page, request);
    await control(request, { op: "launchWorker", conversationId, background: false });
    const track = page.locator("#chat-compact-workers");
    await expect(track).not.toHaveAttribute("open");
    if (deliberate) {
      await page.locator("#chat-stop").focus();
      await track.locator(":scope > summary").tap();
      await expect(track).toHaveAttribute("open");
    }
    await revealTouchContinue(page);
    await page.getByRole("button", { name: "Continue while workers run", exact: true }).tap();
    await expect(page.locator("#chat-compact-workers-items [data-inspect-task]")).toHaveCount(1);
    if (deliberate) await expect(track).toHaveAttribute("open");
    else await expect(track).not.toHaveAttribute("open");
    await captureScreenshot(page, testInfo, `review-detached-${deliberate ? "deliberate" : "automatic"}-${engine}`);
  });
  for (const theme of ["light", "dark"] as const) test(`inspect and Stop have separate targets; settlement keeps the child open (${theme})`, async ({ page, request }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("response", response => { if (response.status() >= 400 && response.url().includes("/api/chat/")) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    const conversationId = await boot(page, request);
    const worker = await control(request, { op: "launchWorker", conversationId });
    const sibling = await control(request, { op: "launchWorker", conversationId });
    await revealTouchWorkers(page);
    const row = page.locator(`[data-background-task="${worker.taskId}"]`);
    const inspect = row.locator("[data-inspect-task]");
    const stop = row.locator("[data-stop-task]");
    const nextStop = page.locator(`[data-background-task="${sibling.taskId}"] [data-stop-task]`);
    await expect(nextStop).toBeVisible();
    await expect(inspect).toBeVisible();
    const a = (await inspect.boundingBox())!;
    const b = (await stop.boundingBox())!;
    const c = (await nextStop.boundingBox())!;
    expect(c.y - (b.y + b.height)).toBeGreaterThanOrEqual(8);
    for (const box of [a, b]) expect(box.width).toBeGreaterThanOrEqual(44);
    expect(a.height).toBeLessThanOrEqual(28); // Explicitly approved dense inspection.
    expect(b.height).toBeGreaterThanOrEqual(44); // Worker mutation remains independently safe.
    expect(b.x - (a.x + a.width)).toBeGreaterThanOrEqual(8);
    await expect(page.locator("#chat-compact-workers")).toHaveAttribute("open");
    await captureScreenshot(page, testInfo, `audit-background-${engine}-touch-${theme}-running`);
    await expect(page.locator("#chat-composer-status-live")).toHaveAttribute("aria-live", "polite");
    await page.touchscreen.tap(a.x + a.width + 4, a.y + a.height / 2);
    expect((await control(request, { op: "state" })).calls.some((call: string) => call.startsWith("POST ") && call.includes("/interrupt"))).toBe(false);
    // Native fat-finger adjustment can choose the harmless inspection
    // target in an 8px gap. It must never choose the destructive Stop.
    if (await page.locator("#chat-drilldown").isVisible()) await page.keyboard.press("Escape");
    await expect(page.locator("#chat-drilldown")).toBeHidden();
    // Hardware-keyboard Stop keeps focus on the same worker's surviving
    // inspection action, never a disabled control or the document body.
    await stop.focus();
    await page.keyboard.press("Enter");
    await expect(stop).toBeDisabled();
    await expect(inspect).toBeFocused();
    // Model the reduced visual viewport of an onscreen keyboard. This checks
    // reachability, not a claim of real iOS/Android keyboard validation.
    await page.locator("#chat-input").focus();
    await page.setViewportSize({ width: 390, height: 520 });
    await inspect.scrollIntoViewIfNeeded();
    const reachable = (await inspect.boundingBox())!;
    expect(reachable.y).toBeGreaterThanOrEqual(0);
    expect(reachable.y + reachable.height).toBeLessThanOrEqual(520);
    await inspect.tap();
    await expect(page.locator("#chat-drilldown-items")).toContainText("Check fixture");
    await page.setViewportSize({ width: 390, height: 844 });
    await control(request, { op: "settleWorker", childId: worker.childId, text: "Touch fixture complete" });
    await expect(page.locator("#chat-drilldown-task")).toContainText("finished");
    await captureScreenshot(page, testInfo, `audit-background-${engine}-touch-${theme}-settled`);
    // The unchanged generic usage probe asks this no-usage-capability fixture
    // once and receives its documented unsupported response. No other page,
    // console or chat-network error is accepted.
    expect(errors.sort()).toEqual([
      "409 /api/chat/usage",
      "Failed to load resource: the server responded with a status of 409 (Conflict)",
    ].sort());
  });
});
