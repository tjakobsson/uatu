import type { APIRequestContext, Page } from "@playwright/test";

import { openChatPanel } from "./chat-helpers";
import { captureScreenshot } from "./evidence";
import { expect, test } from "./fixtures";

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

async function send(page: Page, text: string): Promise<void> {
  const input = page.locator("#chat-input");
  await input.fill(text);
  const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
  await input.press("Enter");
  await accepted;
}

test.describe("chat message queue", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("non-steering busy conversations can enqueue with visible Send without stopping", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    await send(page, "Start the work");
    await expect(page.locator("#chat-stop")).toBeEnabled();
    await expect(page.locator("#chat-delivery-toggle")).toBeHidden();
    await expect(page.locator("#chat-send-help")).not.toContainText(/Steer|Hold Send|Alt\+Enter/);
    const configuration = (await page.locator("#chat-configuration-trigger").boundingBox())!;
    const sendGroup = (await page.locator("#chat-send-group").boundingBox())!;
    expect(Math.abs(configuration.y + configuration.height / 2 - sendGroup.y - sendGroup.height / 2)).toBeLessThan(1);
    await page.locator("#chat-input").fill("Queue by clicking Send");
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.getByRole("button", { name: "Queue message", exact: true }).click();
    expect((await accepted).ok()).toBe(true);
    await expect(page.locator("#chat-queue .is-held")).toContainText("Queue by clicking Send");
    await expect(page.locator("#chat-stop")).toBeEnabled();
    await captureScreenshot(page, testInfo, "non-steering-busy-send");
  });

  test("busy submissions pin at the composer, survive reload, are removable, and deliver in order", async ({ page, request }) => {
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    const conversationId = await page.locator("#chat-conversation-select").inputValue();

    await send(page, "Start the work");
    await expect(page.locator("#chat-stop")).toBeEnabled();

    await send(page, "Refine the plan");
    await send(page, "Then write tests");
    const held = page.locator("#chat-queue .is-held");
    await expect(held).toHaveCount(2);
    await expect(held.nth(0)).toContainText("Refine the plan");
    await expect(held.nth(1)).toContainText("Then write tests");
    // Held messages dock against the composer, outside the timeline scroll:
    // the transcript itself never contains them.
    await expect(page.locator("#chat-queue")).toBeVisible();
    await expect(page.locator("#chat-items")).not.toContainText("Then write tests");

    // The queue is workspace state: a reload presents the same held messages.
    await page.reload();
    await openChatPanel(page);
    await expect(page.locator("#chat-queue .is-held")).toHaveCount(2);

    // Removing a held message deletes it before it ever reaches the agent.
    const removal = page.waitForResponse(response => response.url().includes("/queue/") && response.request().method() === "DELETE");
    await page.locator("#chat-queue .is-held", { hasText: "Refine the plan" }).locator("[data-queue-remove]").click();
    expect((await removal).status()).toBe(200);
    await expect(page.locator("#chat-queue .is-held")).toHaveCount(1);
    await expect(page.locator("#chat-items")).not.toContainText("Refine the plan");

    // The turn ending on its own delivers the remaining held message, which
    // leaves the pinned block and becomes an ordinary head-of-turn message.
    await control(request, { action: "status", conversationId, status: "completed" });
    await expect(page.locator("#chat-queue .is-held")).toHaveCount(0);
    await expect(page.locator("#chat-items [data-chat-item-id]").last()).toContainText("Then write tests");
  });

  test("cancellation leaves the queue dormant and the next submission resumes it in order", async ({ page, request }) => {
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    const conversationId = await page.locator("#chat-conversation-select").inputValue();

    await send(page, "Start the work");
    await send(page, "Queued follow-up");
    await expect(page.locator("#chat-queue .is-held")).toHaveCount(1);

    // Cancel stops the agent; the held message stays, visibly queued.
    await page.locator("#chat-stop").click();
    await expect(page.locator("#chat-composer-status")).toHaveAttribute("aria-label", "Cancelled");
    await expect(page.locator("#chat-queue .is-held")).toHaveCount(1);

    // Even a trailing idle transition delivers nothing while dormant.
    await control(request, { action: "status", conversationId, status: "idle" });
    await expect(page.locator("#chat-queue .is-held")).toHaveCount(1);

    // The next submission joins the back of the queue and delivery resumes
    // from the head: the older held message reaches the agent first.
    await send(page, "Fresh instruction");
    await expect(page.locator("#chat-items [data-chat-item-id]").last()).toContainText("Queued follow-up");
    await expect(page.locator("#chat-queue .is-held")).toHaveCount(1);
    await expect(page.locator("#chat-queue .is-held")).toContainText("Fresh instruction");
  });

  test("Claude Send now delivers the chosen dormant message and leaves the rest held; a running turn offers neither Send now nor steering", async ({ page, request }, testInfo) => {
    await control(request, { action: "agents", count: 2 });
    await page.reload();
    await openChatPanel(page);
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.locator("#chat-agent-menu .chat-agent-menu__item", { hasText: "Claude Code" }).click();
    await expect(page.locator("#chat-context")).toContainText("Claude Code");
    const conversationId = await page.locator("#chat-conversation-select").inputValue();
    expect(conversationId).toMatch(/^claude:/);

    await send(page, "Start Claude work");
    await send(page, "Held first");
    await send(page, "Send this now");
    await send(page, "Held last");
    const held = page.locator("#chat-queue .is-held");
    await expect(held).toHaveText([/Held first/, /Send this now/, /Held last/]);
    await expect(page.locator("#chat-delivery-toggle")).toBeHidden();
    await expect(held.locator("[data-queue-steer], [data-queue-send-now]")).toHaveCount(0);

    await page.locator("#chat-stop").click();
    await expect(page.locator("#chat-composer-status")).toHaveAttribute("aria-label", "Cancelled");
    await expect(held.locator("[data-queue-send-now]")).toHaveCount(3);
    await expect(page.locator("#chat-queue .is-held[data-paused]")).toHaveCount(3);
    await captureScreenshot(page, testInfo, "claude-dormant-send-now");

    const sent = page.waitForResponse(response => response.url().endsWith("/send-now"));
    await held.filter({ hasText: "Send this now" }).getByRole("button", { name: "Send now “Send this now”", exact: true }).click();
    expect((await sent).status()).toBe(200);
    await expect(page.locator("#chat-items").getByText("Send this now", { exact: true })).toHaveCount(1);
    await expect(held).toHaveText([/Held first/, /Held last/]);
    await expect(page.locator("#chat-items")).not.toContainText("Held first");
    await expect(page.locator("#chat-items")).not.toContainText("Held last");
    await expect(held.locator("[data-queue-send-now], [data-queue-steer]")).toHaveCount(0);
    await expect(page.locator("#chat-delivery-toggle")).toBeHidden();

    // Ending the selected message's turn must not drain the dormant backlog.
    await control(request, { action: "status", conversationId, status: "completed" });
    await expect(page.locator("#chat-stop")).toBeDisabled();
    await expect(held).toHaveText([/Held first/, /Held last/]);
    await page.reload();
    await openChatPanel(page);
    await expect(held).toHaveText([/Held first/, /Held last/]);
  });
});
