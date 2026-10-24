import type { APIRequestContext, Page } from "@playwright/test";

import { openChatConfiguration, openChatPanel } from "./chat-helpers";
import { captureScreenshot, saveEvidence } from "./evidence";
import { expect, test as base } from "./fixtures";
import { attachPageDiagnosticsOnFailure, withEngineBrowsers } from "./page-diagnostics";

const test = withEngineBrowsers(base);
attachPageDiagnosticsOnFailure(test);

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<any> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function submit(page: Page, text: string, queue = false): Promise<any> {
  await page.locator("#chat-input").fill(text);
  const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
  if (queue) await page.locator("#chat-input").press("Alt+Enter");
  else await page.locator("#chat-send").click();
  const response = await accepted;
  expect(response.ok()).toBe(true);
  await expect(page.locator("#chat-input")).toHaveValue("");
  return response.json();
}

// The scripted native provider advances only at explicit step/finish controls.
// Admission goes through the real HTTP adapter and OpenCode V2 provider.
for (const engine of ["chromium", "webkit"] as const) for (const mode of ["desktop", "touch"] as const) {
  test(`next-turn choices explain native steer admission (${engine}, ${mode})`, async ({ launchBrowser, baseURL, request }, testInfo) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: mode === "touch" ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: mode === "touch", isMobile: mode === "touch" });
    try {
      await request.post("/__e2e/reset");
      await control(request, { action: "agents", stack: "opencode-v2" });
      const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
      await page.goto(`/?t=${encodeURIComponent(token)}`);
      await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
      if (mode === "touch") await page.locator("#touch-tab-chat").tap();
      else await openChatPanel(page);
      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await expect(page.locator("#chat-state")).toContainText("Started new conversation with OpenCode");
      const conversationId = await page.locator("#chat-conversation-select").inputValue();
      const trigger = page.locator("#chat-configuration-trigger");
      const notice = page.locator("#chat-configuration-scope");
      await expect(notice).toBeHidden();
      await expect(trigger).not.toHaveAccessibleName(/Next turn/);
      expect(await submit(page, "Start in Build")).toMatchObject({ pending: false, configuration: { mode: "build" } });
      await expect(page.locator("#chat-stop")).toBeEnabled();
      await expect(notice).toBeHidden();

      await openChatConfiguration(page);
      await page.locator("#chat-configuration-mode").selectOption("plan");
      await page.locator("#chat-configuration-done").click();
      await page.locator("#chat-input").fill("Steer the active Build turn");
      // Must explain the distinction before the first steer, with no Pending
      // disclosure to open and no hover/title needed to discover it.
      await expect(page.locator("#chat-queue")).toBeHidden();
      await expect(notice).toBeVisible();
      await expect(notice).toHaveText("Steers keep the active turn’s settings. Changes apply to queued or new turns.");
      await expect(trigger).toHaveAccessibleName(/Next turn.*Mode: Plan/);
      await expect(trigger).toContainText("Next turn");
      await expect(page.locator("#chat-send")).toHaveAccessibleDescription(/Steers keep the active turn/);
      // Measure the actual copy, not the paragraph's empty trailing width:
      // WebKit rounds fractional scrollport/block edges differently.
      await expect(notice.locator("span")).toBeInViewport({ ratio: 1 });
      await captureScreenshot(page, testInfo, `configuration-truth-before-send-${engine}-${mode}`);

      const steer = await submit(page, "Steer the active Build turn");
      expect(steer).toMatchObject({ pending: true, delivery: "steer", configuration: { mode: "build" } });
      await expect(trigger).toHaveAccessibleName(/Next turn.*Mode: Plan/);
      await expect(notice).toBeVisible();
      await control(request, { action: "opencode", op: "step", conversationId });
      await expect(page.locator("#chat-items")).toContainText("Steer the active Build turn");
      const queued = await submit(page, "Use Plan for the next turn", true);
      expect(queued).toMatchObject({ pending: true, delivery: "queue", configuration: { mode: "plan" } });
      await control(request, { action: "opencode", op: "finish", conversationId, text: "Build finished" });
      await expect(page.locator("#chat-items")).toContainText("Use Plan for the next turn");
      const read = await page.request.get(`/api/chat/conversations/${encodeURIComponent(conversationId)}`);
      expect(read.ok()).toBe(true);
      const snapshot = await read.json();
      expect(snapshot.configuration).toMatchObject({ mode: "plan" });
      await saveEvidence(testInfo, `configuration-truth-admission-${engine}-${mode}.json`, JSON.stringify({ steer, queued, configuration: snapshot.configuration }, null, 2));
      await expect.poll(async () => (await control(request, { action: "opencode", op: "state" })).sessions[conversationId.replace(/^opencode:/, "")]?.running).toBe(true);
      await control(request, { action: "opencode", op: "finish", conversationId, text: "Plan finished" });
      await expect(page.locator("#chat-stop")).toBeDisabled();
      await expect(notice).toBeHidden();
      await expect(trigger).not.toHaveAccessibleName(/Next turn/);
      expect((await control(request, { action: "opencode", op: "state" })).unhandled).toEqual([]);
    } finally {
      await browser.close();
    }
  });
}
