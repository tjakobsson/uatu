// Opt-in documentation captures: actual application + synthetic providers.
// Captures are local Playwright artifacts and report attachments, not repository images.
import { test, expect } from "./fixtures";
import { openChatPanel, openChatWorkers } from "./chat-helpers";
import type { Page, APIRequestContext, TestInfo } from "@playwright/test";
import { captureScreenshot, evidencePath, recordEvidence } from "./evidence";

test.skip(process.env.UATU_CAPTURE_CHAT_SCREENSHOTS !== "1", "Opt-in documentation screenshots");
async function shot(page: Page, info: TestInfo, name: string) {
  if (process.env.UATU_CAPTURE_HOLD_ONLY === "1" && !name.startsWith("04-hold-")) return;
  if (process.env.UATU_CAPTURE_WORKERS_ONLY === "1" && !/^(02-|03-|04-|05-|06-|07-|09-replacement-)/.test(name)) return;
  await page.evaluate(() => document.fonts.ready);
  // Keep timed hold frames free of captureScreenshot's settling delay.
  const target = evidencePath(info, `${name}.png`);
  await page.screenshot({ path: target, animations: "disabled" });
  await recordEvidence(info, target);
}
async function control(request: APIRequestContext, data: Record<string, unknown>) {
  const response = await request.post("/__e2e/chat", { data });
  expect(response.ok()).toBe(true); return response.json();
}
async function enter(page: Page, request: APIRequestContext) {
  const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await openChatPanel(page);
}

test("desktop documentation gallery", async ({ page, request }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("uatu:presentation:v1:%2F:uatu:chat-panel", JSON.stringify({ open: true, fraction: 0.8 })));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await request.post("/__e2e/reset");
  await control(request, { action: "agents" });
  await control(request, { action: "modes", modes: [{ name: "Build", description: "Implement and verify changes" }, { name: "Plan", description: "Plan without edits" }] });
  await control(request, { action: "models", models: [{ selection: { providerId: "fixture", modelId: "review-model" }, provider: "Fixture provider", name: "Review Model", variants: ["low", "medium", "high"], contextLimit: 200000, contextWindow: { source: "catalog", freshness: "current" } }] });
  const seeded = await control(request, { action: "seed", title: "Task-list layout review", configuration: { mode: "Build", model: { providerId: "fixture", modelId: "review-model" }, variant: "medium" }, items: [
    { id: "user:brief", type: "user_message", createdAt: Date.now() - 10000, text: "Review the task-list layout and keep the implementation small." },
    { id: "answer:plan", type: "assistant_message", createdAt: Date.now() - 9000, markdown: "The task list is ready for review. **Keyboard navigation** and JSON backup are covered; the next change can focus on appearance preferences." },
    { id: "context:usage", type: "context_report", createdAt: Date.now() - 8000, total: 64000, max: 200000, model: { providerId: "fixture", modelId: "review-model" } },
  ] });
  await enter(page, request);
  await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
  await page.locator("#chat-input").fill("Add appearance preferences without changing saved tasks.");
  await expect(page.locator("#chat-configuration-summary")).toContainText("Review Model");
  await shot(page, info, "01-overview-light");
  await page.locator("#chat-configuration-trigger").click();
  await expect(page.locator("#chat-configuration-dialog")).toBeVisible();
  await shot(page, info, "01-configuration-light");
  await page.keyboard.press("Escape");
  await control(request, { action: "item", conversationId: seeded.conversation.id, item: { id: "worker:audit", type: "background_task", taskId: "audit", description: "Audit keyboard navigation", subagentType: "reviewer", status: "running", createdAt: Date.now() } });
  await control(request, { action: "item", conversationId: seeded.conversation.id, item: { id: "question:theme", type: "question", requestId: "theme", status: "pending", createdAt: Date.now(), questions: [{ header: "Appearance", prompt: "Which appearance preference should be the default?", multiple: false, allowFreeForm: true, options: [{ label: "System", description: "Follow the device appearance" }, { label: "Light", description: "Always use the light palette" }] }] } });
  await expect(page.locator('[data-chat-item-id="question:theme"]')).toContainText("Which appearance");
  await openChatWorkers(page);
  await shot(page, info, "06-question-with-workers-light");

  // Native 2.x adapter, backed only by the local scripted OpenCode server.
  await request.post("/__e2e/reset");
  await control(request, { action: "agents", stack: "opencode-v2", backgroundPreview: true });
  await enter(page, request);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("#chat-state")).toContainText("Started new conversation with OpenCode");
  const conversationId = await page.locator("#chat-conversation-select").inputValue();
  await page.locator("#chat-input").fill("Implement the task list and review accessibility independently.");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-stop")).toBeEnabled();
  const workers: string[] = [];
  for (let i = 0; i < 3; i++) {
    const worker = await control(request, { action: "opencode", op: "launchWorker", conversationId }); workers.push(worker.childId);
    await control(request, { action: "opencode", op: "workerReport", childId: worker.childId, usedModel: "Fixture Model", usedEffort: i === 0 ? "medium" : "high", costUsd: i === 0 ? 0.0012 : 0 });
  }
  await control(request, { action: "opencode", op: "settleWorker", childId: workers[2], workerState: "completed" });
  await expect(page.locator("#chat-compact-workers-label")).toHaveText("2 working · 1 finished");
  await openChatWorkers(page);
  for (const row of await page.locator(".chat-worker-inspect").all()) expect(await row.evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(28);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, info, "02-workers-dark");
  await page.locator("#chat-compact-workers [data-inspect-task]").first().click();
  await expect(page.locator("#chat-drilldown")).toBeVisible();
  await shot(page, info, "05-worker-inspection-dark");
  await page.locator("#chat-drilldown-back").click();
  await page.locator("#chat-input").fill("/btw Summarize the review checklist");
  await page.route("**/aside", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { text: "# Review checklist\n\nThe workers continue independently. Check **keyboard access** before merging.\n\n| Area | Check |\n| --- | --- |\n| Focus | Visible and stable |\n| Backup | Validate before restore |\n\n```ts\nconst preferences = { appearance: 'system' };\n```\n\nSee [README.md](README.md) for the workspace guide." } });
  });
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-aside-ready")).toHaveText("Side answer ready");
  await shot(page, info, "07-side-answer-ready-dark");
  await page.locator("#chat-aside-ready").click();
  await expect(page.locator("#chat-aside-answer table")).toBeVisible();
  await shot(page, info, "07-side-reader-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await captureScreenshot(page, info, "desktop-side-reader-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.keyboard.press("Escape");
  await page.locator("#chat-input").fill("Queue the follow-up review");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000));
  const box = (await page.locator("#chat-send").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.clock.runFor(1000); await shot(page, info, "04-hold-quarter-dark");
  const earlyEnvelope = (await page.locator(".chat-hold-upward").boundingBox())!;
  await page.clock.runFor(1100); await shot(page, info, "04-hold-near-dark");
  expect(await page.locator(".chat-hold-upward").boundingBox()).toEqual(earlyEnvelope);
  const held = page.waitForResponse(response => response.url().endsWith("/prompts") && response.request().method() === "POST");
  await page.clock.runFor(400); expect((await held).ok()).toBe(true); await page.mouse.up();
  await page.clock.resume();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator('.chat-queued-message[data-delivery="queue"]')).toHaveCount(1);
  if (process.env.UATU_CAPTURE_HOLD_ONLY === "1") return;
  for (let i = 3; i < 20; i++) await control(request, { action: "opencode", op: "launchWorker", conversationId });
  for (let i = 1; i < 20; i++) {
    await page.locator("#chat-input").fill(`Review follow-up ${i + 1}: preserve keyboard focus and saved tasks`);
    await page.locator("#chat-input").press("Alt+Enter");
    await expect(page.locator(".chat-queued-message")).toHaveCount(i + 1);
  }
  const pending = page.locator("[data-pending-toggle]");
  if (await pending.getAttribute("aria-expanded") !== "true") await pending.click();
  await expect(page.locator("#chat-compact-workers [data-worker-id]")).toHaveCount(20);
  await page.emulateMedia({ colorScheme: "light" });
  await shot(page, info, "03-expanded-queue-workers-light");
  // Stage a genuine replacement boundary; the warning is rendered by the app.
  await page.locator("[data-queue-remove]").last().click();
  await expect(page.locator(".chat-queued-message")).toHaveCount(19);
  expect((await page.request.post(`/api/chat/conversations/${encodeURIComponent(conversationId)}/prompts`, { headers: { origin: new URL(page.url()).origin }, data: { requestId: "gallery-steer", text: "Keep the review checklist", delivery: "steer" } })).status()).toBe(202);
  expect((await page.request.post(`/api/chat/conversations/${encodeURIComponent(conversationId)}/undo`, { headers: { origin: new URL(page.url()).origin }, data: { requestId: "gallery-undo" } })).ok()).toBe(true);
  await expect(page.locator("#chat-queue-note")).toContainText("delivered together with your replacement");
  await page.locator(".chat-queue-content").evaluate(node => { node.scrollTop = 0; });
  await shot(page, info, "09-replacement-warning-light");
});

test("mobile side answer minimises without losing the answer", async ({ browser, request, baseURL }, info) => {
  const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "light" });
  try {
    await request.post("/__e2e/reset");
    await control(request, { action: "agents", stack: "opencode-v2" });
    const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await page.locator("#touch-tab-chat").click();
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect(page.locator("#chat-state")).toContainText("Started new conversation");
    await page.route("**/aside", route => route.fulfill({ json: { text: "# Review checklist\n\nCheck **keyboard access** and saved task backup before merging.\n\n| Area | Check |\n| --- | --- |\n| Focus | Visible and stable |\n| Backup | Validate before restore |\n\nThe answer stays available from the conversation notice after minimising." } }));
    await page.locator("#chat-input").fill("/btw Summarize the review checklist");
    await page.locator("#chat-send").tap();
    await expect(page.locator("#chat-aside-ready")).toHaveText("Side answer ready");
    await page.locator("#chat-aside-ready").tap();
    await expect(page.locator("#chat-aside-answer table")).toBeVisible();
    await shot(page, info, "10-mobile-side-reader-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await captureScreenshot(page, info, "mobile-side-reader-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.locator("#chat-aside-close").tap();
    await expect(page.locator("#chat-aside-dialog")).toBeHidden();
    await shot(page, info, "10-mobile-side-minimised-light");
    await page.locator("#chat-aside-ready").tap();
    await expect(page.locator("#chat-aside-answer")).toContainText("Review checklist");
  } finally { await page.close(); }
});
