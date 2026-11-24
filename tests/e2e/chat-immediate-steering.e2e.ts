import type { APIRequestContext, Page } from "@playwright/test";

import { openChatPanel, openChatPending } from "./chat-helpers";
import { expect, test } from "./fixtures";

// add-antigravity-chat D9: a stub agent declaring `immediate-steering` and
// `send-now`, not `steering`. Busy ordinary text steers at once, with no
// pending Steer entry in the dock; Alt/Option+Enter still holds a message
// in the workspace queue until the turn ends.

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<unknown> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function boot(page: Page, request: APIRequestContext): Promise<string> {
  expect((await request.post("/__e2e/reset")).ok()).toBe(true);
  await control(request, { action: "declareOnly", capabilities: ["models", "modes", "commands", "permissions", "context", "immediate-steering", "send-now"] });
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await openChatPanel(page);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
  return page.locator("#chat-conversation-select").inputValue();
}

async function submit(page: Page, text: string, key: "Enter" | "Alt+Enter" | "click"): Promise<void> {
  const input = page.locator("#chat-input");
  await input.fill(text);
  const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
  if (key === "click") await page.locator("#chat-send").click();
  else await input.press(key);
  expect((await accepted).ok()).toBe(true);
}

test("an immediate steer joins the turn once, with no Steer entry, while Alt+Enter queues", async ({ page, request }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  const conversationId = await boot(page, request);
  await submit(page, "Start the work", "Enter");
  await expect(page.locator("#chat-stop")).toBeEnabled();

  await page.locator("#chat-input").fill("Also check the tests");
  await expect(page.locator("#chat-send")).toHaveAttribute("aria-label", "Send as steer; hold 2.5 seconds to queue");
  await expect(page.locator("#chat-keyboard-hint")).toHaveText("Enter: steer · Alt+Enter: queue");
  await submit(page, "Also check the tests", "click");
  const steered = page.locator("#chat-items [data-chat-item-id^='message:']").filter({ hasText: "Also check the tests" });
  await expect(steered).toHaveCount(1);
  await expect(page.locator(".chat-queued-message")).toHaveCount(0);
  await expect(page.locator("#chat-stop")).toBeEnabled();

  await submit(page, "After this turn", "Alt+Enter");
  await openChatPending(page);
  const queued = page.locator(".chat-queued-message");
  await expect(queued).toHaveCount(1);
  await expect(queued).toContainText("After this turn");
  // Not a steering dock: no switch to steer, and no Send now while running.
  await expect(page.locator("[data-queue-steer]")).toHaveCount(0);
  await expect(page.locator("[data-queue-send-now]")).toHaveCount(0);

  await control(request, { action: "status", conversationId, status: "completed" });
  await expect(queued).toHaveCount(0);
  await expect(page.locator("#chat-items [data-chat-item-id^='message:']").filter({ hasText: "After this turn" })).toHaveCount(1);
  await expect(steered).toHaveCount(1);
});

test("holding Send for 2.5 seconds queues on an immediate-steering agent", async ({ page, request }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await boot(page, request);
  await submit(page, "Start the work", "Enter");
  await expect(page.locator("#chat-stop")).toBeEnabled();
  await page.locator("#chat-input").fill("Hold to queue this");
  const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
  const box = (await page.locator("#chat-send").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const response = await accepted;
  await page.mouse.up();
  expect(await response.json()).toEqual(expect.objectContaining({ pending: true, delivery: "queue" }));
  expect(JSON.parse(response.request().postData() ?? "{}")).toEqual(expect.objectContaining({ delivery: "queue" }));
  await openChatPending(page);
  await expect(page.locator(".chat-queued-message")).toContainText("Hold to queue this");
  await expect(page.locator("#chat-items [data-chat-item-id^='message:']").filter({ hasText: "Hold to queue this" })).toHaveCount(0);
});
