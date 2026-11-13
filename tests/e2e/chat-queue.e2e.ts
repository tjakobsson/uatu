import type { APIRequestContext, Page } from "@playwright/test";

import { openChatPanel, openChatPending } from "./chat-helpers";
import { captureScreenshot } from "./evidence";
import { expect, test as base } from "./fixtures";
import { withEngineBrowsers } from "./page-diagnostics";

const test = withEngineBrowsers(base);

async function bootChat(page: Page, request: APIRequestContext): Promise<void> {
  expect((await request.post("/__e2e/reset")).ok()).toBe(true);
  const tokenResponse = await request.get("/__e2e/terminal-token");
  expect(tokenResponse.ok()).toBe(true);
  const token = await tokenResponse.json() as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  if (await page.locator("html").getAttribute("data-ui-mode") === "touch") await page.locator("#touch-tab-chat").click();
  else await openChatPanel(page);
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
    // The responsive desktop composer may wrap its configuration onto its
    // own row; both controls must stay inside the bounded composer.
    const composer = (await page.locator("#chat-composer").boundingBox())!;
    for (const box of [configuration, sendGroup]) {
      expect(box.y).toBeGreaterThanOrEqual(composer.y);
      expect(box.y + box.height).toBeLessThanOrEqual(composer.y + composer.height);
    }
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
    await openChatPending(page);
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
    await openChatPending(page);
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

for (const engine of ["chromium", "webkit"] as const) for (const touch of [false, true]) {
  test(`Send now refusal preserves server-owned pending input (${engine} ${touch ? "touch" : "desktop"})`, async ({ launchBrowser, baseURL, request }, testInfo) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: touch, isMobile: touch });
    try {
      await bootChat(page, request);
      await control(request, { action: "agents", count: 2 });
      await page.reload();
      if (touch) await page.locator("#touch-tab-chat").click();
      else await openChatPanel(page);
      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await page.locator("#chat-agent-menu .chat-agent-menu__item", { hasText: "Claude Code" }).click();
      await expect(page.locator("#chat-conversation-select")).toHaveValue(/^claude:/);
      const conversationId = await page.locator("#chat-conversation-select").inputValue();
      expect(conversationId).toMatch(/^claude:/);
      const input = page.locator("#chat-input");
      const submit = async (text: string) => {
        await input.fill(text);
        const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
        if (touch) await page.locator("#chat-send").tap();
        else await input.press("Enter");
        expect((await accepted).ok()).toBe(true);
      };
      await submit("Start Claude work");
      await submit("Pending input must remain inspectable");
      await page.locator("#chat-stop").click();
      await expect(page.locator("#chat-stop")).toBeDisabled();
      const row = page.locator("#chat-queue .is-held");
      await expect(row).toHaveCount(1);
      const id = await row.getAttribute("data-chat-queued-id");
      const snapshotUrl = `/api/chat/conversations/${encodeURIComponent(conversationId)}`;
      // Diagnose the old observation channel without logging credentials or
      // conversation content. The standalone fixture does not share this page's
      // authenticated browser context.
      const standalone = await request.get(snapshotUrl);
      const standaloneValue = await standalone.json().catch(() => null);
      console.info(JSON.stringify({ channel: "standalone", status: standalone.status(), keys: standaloneValue && typeof standaloneValue === "object" ? Object.keys(standaloneValue).sort() : [] }));
      let mutations = 0, reads = 0, failRead = false;
      const serverPending = async () => {
        const before = reads;
        // APIRequestContext shares the page's existing session cookies, but
        // does not go through page.route: this observes real server ownership
        // independently even when the browser's reread is deliberately failed.
        const response = await page.request.get(snapshotUrl);
        const value = await response.json();
        console.info(JSON.stringify({ channel: "page-context", status: response.status(), keys: Object.keys(value).sort() }));
        expect(response.status()).toBe(200);
        expect(response.ok()).toBe(true);
        expect(value.conversation?.id).toBe(conversationId);
        expect(Array.isArray(value.queued)).toBe(true);
        expect(reads).toBe(before);
        return value.queued;
      };
      const original = await serverPending();
      expect(original.map((entry: { id: string }) => entry.id)).toEqual([id]);
      const toggle = page.locator("[data-pending-toggle]");
      await expect(toggle).toHaveAttribute("aria-expanded", touch ? "false" : "true");
      await openChatPending(page);
      await input.fill("Private unsent draft");

      // Public HTTP refusal seam: no status stream accompanies this response.
      // The real adapter's Claude-shaped running-turn refusal is covered by
      // adapter.test.ts; this server retains the exact held entry throughout.
      await page.route("**/send-now", route => {
        mutations++;
        return route.fulfill({ status: 409, json: { error: "Send now is unavailable while a turn is running" } });
      });
      await page.route(url => url.pathname === snapshotUrl, route => {
        reads++;
        return failRead ? route.fulfill({ status: 503, json: { error: "Read unavailable" } }) : route.continue();
      });
      const sendNow = row.locator("[data-queue-send-now]");
      for (const unavailableRead of [false, true]) {
        failRead = unavailableRead;
        await input.focus();
        if (touch) await sendNow.tap();
        else await sendNow.click();
        await expect(page.locator("#chat-composer-error")).toContainText("Send now is unavailable");
        if (unavailableRead) await expect(page.locator("#chat-composer-error")).toContainText("could not be checked");
        await expect(sendNow).toBeEnabled();
        await expect(row.locator("[data-queue-edit]")).toBeEnabled();
        await expect(row.locator("[data-queue-remove]")).toBeEnabled();
        await expect(row).toContainText("Pending input must remain inspectable");
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(input).toHaveValue("Private unsent draft");
        if (touch) await expect(input).toBeFocused();
        expect(await serverPending()).toEqual(original);
        expect(mutations).toBe(unavailableRead ? 2 : 1);
        expect(reads).toBe(unavailableRead ? 2 : 1);
        console.info(JSON.stringify({ checkpoint: unavailableRead ? "failed-reread" : "successful-reread", mutations, reads, serverEntryRetained: true, draftRetained: true }));
      }
      await captureScreenshot(page, testInfo, `send-now-refused-${engine}-${touch ? "touch" : "desktop"}`);
      // Explicit removal still targets the same server-owned identity.
      const removed = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().includes(`/queue/${id}`));
      await row.locator("[data-queue-remove]").click();
      expect((await removed).ok()).toBe(true);
      await expect(row).toHaveCount(0);
      expect(await serverPending()).toEqual([]);
      await expect(input).toHaveValue("Private unsent draft");
      expect(mutations).toBe(2);
      expect(reads).toBe(2);
      console.info(JSON.stringify({ checkpoint: "explicit-removal", mutations, reads, serverPending: 0, draftRetained: true }));
    } finally { await page.close(); }
  });
}
