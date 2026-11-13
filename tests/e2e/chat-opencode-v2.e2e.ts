import type { APIRequestContext, Page } from "@playwright/test";

import { openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

// The real 2.x stack end to end (opencode-v2-steering D13): the real
// ChatAdapter and OpenCodeV2Provider over the scripted fake OpenCode 2.0.28
// server in tests/e2e/opencode-v2-fake.ts. Turns wait for the test: `step`
// is a step boundary, `finish` ends the turn with an answer.

type FakeState = { sessions: Record<string, { running: boolean; pending: Array<{ id: string; delivery: string; payload: { text: string } }> }>; unhandled: string[] };

async function bootChat(page: Page, request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset");
  await control(request, { action: "agents", stack: "opencode-v2" });
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

async function fakeState(request: APIRequestContext, conversationId: string): Promise<FakeState["sessions"][string] | undefined> {
  const state = await control(request, { action: "opencode", op: "state" }) as FakeState;
  return state.sessions[conversationId.replace(/^opencode:/, "")];
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.locator("#chat-input");
  await input.fill(text);
  const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
  await input.press("Enter");
  await accepted;
}

// A prompt through the route, with the browser's session: accepted-pending
// answers 202.
async function submit(page: Page, conversationId: string, requestId: string, text: string, delivery: "steer" | "queue"): Promise<unknown> {
  const response = await page.request.post(`/api/chat/conversations/${encodeURIComponent(conversationId)}/prompts`, {
    // The browser sends these itself; the request context must state them.
    headers: { origin: new URL(page.url()).origin },
    data: { requestId, text, delivery },
  });
  expect(response.status()).toBe(202);
  return response.json();
}

async function newConversation(page: Page): Promise<string> {
  await page.getByRole("button", { name: "New conversation" }).click();
  // The chooser shows the new id before the conversation is attached; the
  // announcement comes once it is, and a submission before then is dropped.
  await expect(page.locator("#chat-state")).toContainText("Started new conversation with OpenCode");
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
  return page.locator("#chat-conversation-select").inputValue();
}

test.describe("chat over the OpenCode 2.x stack", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("a prompt answers, a held message delivers after the turn, and history reloads", async ({ page, request }) => {
    const conversationId = await newConversation(page);
    expect(conversationId).toMatch(/^opencode:ses_/);

    await send(page, "Start the work");
    const items = page.locator("#chat-items");
    await expect(items).toContainText("Start the work");
    await expect(page.locator("#chat-stop")).toBeEnabled();
    await expect.poll(async () => (await fakeState(request, conversationId))?.running).toBe(true);

    // A busy submission asking to queue: the workspace holds it in the dock.
    // Sent through the route so the delivery is explicit whatever the
    // composer's device default is (the keys are chat-steering's to cover).
    expect(await submit(page, conversationId, "r-queue-1", "Then write tests", "queue")).toMatchObject({ pending: true, delivery: "queue" });
    const docked = page.locator("#chat-queue .chat-queued-message", { hasText: "Then write tests" });
    await expect(docked).toHaveCount(1);
    await expect(items).not.toContainText("Then write tests");

    // The turn ends: the held message is released, OpenCode starts the next
    // turn with it, and its row joins the timeline.
    await control(request, { action: "opencode", op: "finish", conversationId, text: "First answer" });
    await expect(items).toContainText("First answer");
    await expect(docked).toHaveCount(0);
    await expect(items).toContainText("Then write tests");
    await expect.poll(async () => (await fakeState(request, conversationId))?.running).toBe(true);

    await control(request, { action: "opencode", op: "finish", conversationId, text: "Second answer" });
    await expect(items).toContainText("Second answer");
    await expect(page.locator("#chat-stop")).toBeDisabled();

    // History is OpenCode's stored messages, in order.
    await page.reload();
    await openChatPanel(page);
    await expect(page.locator("#chat-conversation-select")).toHaveValue(conversationId);
    for (const text of ["Start the work", "First answer", "Then write tests", "Second answer"]) await expect(items).toContainText(text);
    const order = await items.innerText();
    expect(order.indexOf("Start the work")).toBeLessThan(order.indexOf("First answer"));
    expect(order.indexOf("First answer")).toBeLessThan(order.indexOf("Then write tests"));
    expect(order.indexOf("Then write tests")).toBeLessThan(order.indexOf("Second answer"));

    expect((await control(request, { action: "opencode", op: "state" }) as FakeState).unhandled).toEqual([]);
  });

  test("a steer waits in OpenCode's inbox and joins the timeline at the step boundary", async ({ page, request }) => {
    const conversationId = await newConversation(page);
    await send(page, "Start the work");
    const items = page.locator("#chat-items");
    await expect(items).toContainText("Start the work");
    await expect.poll(async () => (await fakeState(request, conversationId))?.running).toBe(true);

    // A steer submitted mid-turn, through the prompt route.
    expect(await submit(page, conversationId, "r-steer-1", "Use the other approach", "steer")).toMatchObject({ pending: true, delivery: "steer" });

    // Pending with OpenCode: in the dock, not yet in the timeline.
    const docked = page.locator("#chat-queue .chat-queued-message", { hasText: "Use the other approach" });
    await expect(docked).toHaveCount(1);
    await expect(items).not.toContainText("Use the other approach");
    const pending = (await fakeState(request, conversationId))?.pending ?? [];
    expect(pending.map(entry => [entry.payload.text, entry.delivery])).toEqual([["Use the other approach", "steer"]]);

    // The step boundary delivers it: it leaves the dock and joins the turn.
    await control(request, { action: "opencode", op: "step", conversationId });
    await expect(items).toContainText("Use the other approach");
    await expect(docked).toHaveCount(0);
    expect((await fakeState(request, conversationId))?.pending).toEqual([]);

    await control(request, { action: "opencode", op: "finish", conversationId, text: "Steered answer" });
    await expect(items).toContainText("Steered answer");
    const order = await items.innerText();
    expect(order.indexOf("Start the work")).toBeLessThan(order.indexOf("Use the other approach"));
    expect(order.indexOf("Use the other approach")).toBeLessThan(order.indexOf("Steered answer"));
  });
});
