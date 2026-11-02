import { chromium, webkit } from "@playwright/test";
import type { BackgroundTaskItem, ConversationSnapshot } from "../../src/chat/types";
import { childChatControl, expect, openSessionTab, signIn, test } from "./hub-fixtures";
import { openChatPanel, openChatWorkers } from "./chat-helpers";
import { expectWorkControlVisible } from "./work-panel-assertions";

test.use({ hubWorkspaces: ["alpha"], hubWorkerDismissals: true });

for (const engine of ["chromium", "webkit"] as const) for (const failure of ["read", "save"] as const) {
  test(`${engine}: private dismissal ${failure} guidance remains reachable after successful composer submission`, async ({ hub }) => {
    const browser = await ({ chromium, webkit })[engine].launch();
    try {
      const workspace = hub.workspaces[0]!;
      const worker: BackgroundTaskItem = { type: "background_task", id: "worker:guidance", taskId: "guidance", taskType: "agent", description: "Unavailable fixture worker", status: "running", createdAt: 1,
        activity: { kind: "unavailable", executionId: "v1:guidance", generation: 1 }, control: { available: false, reason: "Fixture has no control proof" } };
      const snapshot = await childChatControl(workspace, { action: "seed", title: "Private feedback ownership", items: [worker] }) as ConversationSnapshot;
      const touch = engine === "webkit";
      const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 480 }, isMobile: touch, hasTouch: touch, reducedMotion: "reduce" });
      await context.route("**/api/personal-worker-dismissals**", async route => {
        if (route.request().method() === (failure === "read" ? "GET" : "POST")) {
          await route.fulfill({ status: 503, json: { error: "Synthetic personal-state storage failure" } });
        } else await route.continue();
      });
      const login = await context.newPage(); await signIn(login, hub); await login.close();
      // First response headers may precede an aborted read. Only a completed
      // read can synchronize the deliberately failed write.
      const dismissalUrl = new URL("api/personal-worker-dismissals", workspace.sessionUrl);
      const personalRead = context.waitForEvent("requestfinished", { predicate: request => {
        const url = new URL(request.url());
        return request.method() === "GET" && url.origin === dismissalUrl.origin && url.pathname === dismissalUrl.pathname
          && url.searchParams.get("conversationId") === snapshot.conversation.id;
      } });
      const page = await openSessionTab(context, workspace);
      if (touch) await page.locator("#touch-tab-chat").click(); else await openChatPanel(page);
      await expect(page.locator("#chat-conversation-select")).toHaveValue(snapshot.conversation.id);
      await openChatWorkers(page);
      const row = page.locator('[data-worker-id="worker:guidance"]');
      await expect(row).toBeVisible();
      const response = await (await personalRead).response();
      expect(response).not.toBeNull();
      if (failure === "save") {
        // The visible row may precede the initial personal-state read. Wait
        // for that client read before authorizing a deliberately failed write.
        expect(response!.status()).toBe(200);
        await row.getByRole("button", { name: "Dismiss worker from summary:", exact: false }).click();
      } else expect(response!.status()).toBe(503);
      const guidance = page.locator("#chat-composer-notices .chat-worker-dismissal-notice");
      const message = failure === "read" ? "Could not read saved worker dismissals." : "Could not save worker dismissal changes.";
      await expect(guidance).toContainText(message);
      await expect(guidance).toHaveAttribute("role", "status");
      await expect(row).toBeVisible();
      await expect(page.locator("#chat-work-dock .chat-worker-dismissal-notice")).toHaveCount(0);
      await page.locator("#chat-input").fill("An unrelated successful prompt");
      const sent = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/prompts") && response.request().method() === "POST");
      await page.locator("#chat-send").click(); expect((await sent).ok()).toBe(true);
      await expect(page.locator("#chat-input")).toHaveValue("");
      await expect(guidance).toContainText(message);
      await page.locator("#chat-input").fill("Keep this independent draft");
      const notices = page.locator("#chat-composer-notices");
      await notices.focus(); await notices.press("End");
      await expect(notices).toBeFocused();
      await expect.poll(() => notices.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(1);
      await expectWorkControlVisible(page.locator("#chat-send"));
      await expect(page.locator("#chat-input")).toHaveValue("Keep this independent draft");
      await expect(guidance).toContainText(message);
    } finally { await browser.close(); }
  });
}
