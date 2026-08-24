import type { APIRequestContext, Page, TestInfo } from "@playwright/test";

import { openChatPanel } from "./chat-helpers";
import { applyChatInventoryFixture } from "./chat-inventory-fixture";
import { expect, test } from "./fixtures";

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<any> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function boot(page: Page, request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset");
  for (const title of ["Review the inventory design", "Write release notes", "Trace the event stream"]) {
    await control(request, { action: "seed", title, items: [] });
  }
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  const mode = await page.locator("html").getAttribute("data-ui-mode");
  if (mode === "touch") await page.locator("#touch-tab-chat").click();
  else await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
  await expect(page.locator("#chat-conversation-select option")).toHaveCount(3);
  if (mode === "touch") await page.locator("#touch-tab-preview").click();
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const outputPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: outputPath, animations: "disabled", caret: "hide" });
  await testInfo.attach(name, { path: outputPath, contentType: "image/png" });
}

async function captureSchemes(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(100);
    await capture(page, testInfo, `${name}-${colorScheme}`);
  }
}

test.describe("desktop conversation inventory presentation", () => {
  test.beforeEach(async ({ page, request }) => {
    await boot(page, request);
    await openChatPanel(page);
  });

  test("drives zero, one, and several unseen conversations without moving focus", async ({ page }) => {
    const chooser = page.locator("#chat-conversation-select");
    await chooser.focus();

    await applyChatInventoryFixture(page, { unseenCount: 0 });
    await expect(page.locator("#chat-conversation-unseen-count")).toBeHidden();
    await expect(page.locator("#chat-expand")).toHaveAttribute("aria-label", "Open chat panel");

    await applyChatInventoryFixture(page, { unseenCount: 1, announce: true });
    await expect(page.locator("#chat-conversation-unseen-count")).toHaveAttribute("aria-label", "Acknowledge 1 new conversation");
    await expect(page.locator("#chat-conversation-unseen-count .chat-conversation-unseen-number")).toHaveText("1");
    await expect(page.locator("#chat-conversation-inventory-live")).toHaveText("1 new conversation available.");
    await expect(page.locator("#touch-tab-chat")).toHaveAttribute("aria-label", "Chat, 1 new conversation");
    await expect(chooser).toBeFocused();

    await applyChatInventoryFixture(page, { unseenCount: 3, announce: true });
    await expect(page.locator("#chat-conversation-unseen-count")).toHaveAttribute("aria-label", "Acknowledge 3 new conversations");
    await expect(page.locator("#chat-conversation-unseen-count .chat-conversation-unseen-number")).toHaveText("3");
    await expect(page.locator("#chat-conversation-inventory-live")).toHaveText("3 new conversations available.");
    await expect(chooser).toBeFocused();

    await page.locator("#chat-collapse").click();
    await expect(page.locator("#chat-expand")).toBeVisible();
    await expect(page.locator("#chat-expand")).toHaveAttribute("aria-label", "Open chat panel, 3 new conversations");
    await expect(page.locator("#chat-expand .chat-inventory-attention")).toBeVisible();
  });

  test("keeps the deleted selection explicit while preserving local presentation", async ({ page }) => {
    const chooser = page.locator("#chat-conversation-select");
    const selected = await chooser.inputValue();
    await page.locator("#chat-input").fill("Draft that must remain local");

    await applyChatInventoryFixture(page, { unseenCount: 2, selectedConversationDeleted: true });
    await expect(page.locator("#chat-conversation-unavailable")).toContainText("This conversation was deleted elsewhere.");
    await expect(page.locator("#chat-state")).toBeHidden();
    await expect(chooser).toHaveValue("");
    await expect(chooser).toBeEnabled();
    await expect(page.locator("#chat-new-conversation")).toBeEnabled();
    await expect(page.locator("#chat-rename-conversation")).toBeDisabled();
    await expect(page.locator("#chat-composer")).toHaveAttribute("inert", "");
    await expect(page.locator("#chat-input")).toHaveValue("Draft that must remain local");
    await expect(page.locator("#chat-timeline")).toBeVisible();

    await applyChatInventoryFixture(page, { unseenCount: 2, selectedConversationDeleted: false });
    await expect(page.locator("#chat-conversation-unavailable")).toBeHidden();
    await expect(chooser).toHaveValue(selected);
    await expect(page.locator("#chat-composer")).not.toHaveAttribute("inert", "");
  });

  test("captures desktop and narrow-desktop review states", async ({ page, request }, testInfo) => {
    const conversationId = await page.locator("#chat-conversation-select").inputValue();
    await control(request, { action: "status", conversationId, status: "running" });
    await control(request, { action: "item", conversationId, item: {
      id: "permission:inventory-review",
      type: "permission",
      createdAt: 1,
      requestId: "inventory-review",
      status: "pending",
      action: "bash",
      resources: ["bun test"],
    } });
    await expect(page.locator("#chat-send")).toHaveAttribute("aria-label", "Cancel response");
    await expect(page.locator("#chat-requests-jump")).toBeVisible();
    await applyChatInventoryFixture(page, { unseenCount: 3, announce: true });
    await page.locator("#chat-conversation-select").focus();
    await captureSchemes(page, testInfo, "desktop-open-several-running-request");

    await page.locator("#chat-collapse").click();
    await page.setViewportSize({ width: 880, height: 720 });
    await expect(page.locator("#chat-expand")).toBeVisible();
    await page.locator("#chat-expand").scrollIntoViewIfNeeded();
    await captureSchemes(page, testInfo, "desktop-narrow-collapsed-several");
  });
});

test.describe("touch conversation inventory presentation", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page, request }) => {
    await boot(page, request);
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
  });

  test("keeps hidden-tab attention until chooser interaction is eventually connected", async ({ page }) => {
    await applyChatInventoryFixture(page, { unseenCount: 1, announce: true });
    await expect(page.locator("#touch-tab-chat")).toHaveAttribute("aria-label", "Chat, 1 new conversation");
    await expect(page.locator("#touch-tab-chat .chat-inventory-attention")).toBeVisible();

    await page.locator("#touch-tab-chat").click();
    await expect(page.locator("#chat-surface")).toBeVisible();
    await expect(page.locator("#touch-tab-chat .chat-inventory-attention")).toBeHidden();
    await expect(page.locator("#chat-conversation-unseen-count")).toHaveAttribute("aria-label", "Acknowledge 1 new conversation");

    await applyChatInventoryFixture(page, { unseenCount: 3, announce: true, selectedConversationDeleted: true });
    await expect(page.locator("#chat-conversation-unseen-count")).toHaveAttribute("aria-label", "Acknowledge 3 new conversations");
    await expect(page.locator("#chat-conversation-unavailable")).toBeVisible();
    await expect(page.locator("#chat-new-conversation")).toBeEnabled();
  });

  test("captures phone and tablet review states", async ({ page }, testInfo) => {
    await applyChatInventoryFixture(page, { unseenCount: 1, announce: true });
    await captureSchemes(page, testInfo, "phone-hidden-chat-one");

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: {
        top: 47, topMax: 47,
        right: 0, rightMax: 0,
        bottom: 34, bottomMax: 34,
        left: 0, leftMax: 0,
      },
    });
    await page.locator("#touch-tab-chat").click();
    await applyChatInventoryFixture(page, { unseenCount: 3, announce: true });
    await page.locator("#chat-conversation-select").focus();
    await expect(page.locator("#chat-surface")).toHaveCSS("padding-top", "47px");
    await captureSchemes(page, testInfo, "phone-visible-several-safe-area");

    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: {
        top: 0, topMax: 0,
        right: 0, rightMax: 0,
        bottom: 0, bottomMax: 0,
        left: 0, leftMax: 0,
      },
    });
    await page.setViewportSize({ width: 1024, height: 768 });
    await applyChatInventoryFixture(page, { unseenCount: 3, selectedConversationDeleted: true });
    await expect(page.locator("#chat-conversation-unavailable")).toBeVisible();
    await captureSchemes(page, testInfo, "tablet-selected-deletion");
  });
});
