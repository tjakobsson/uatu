import type { APIRequestContext, Page } from "@playwright/test";

import type { ConversationItem } from "../../src/chat/types";
import { expect, test } from "./fixtures";

async function bootChat(page: Page, request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset");
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await page.getByRole("radio", { name: "Chat" }).click();
  await expect(page.locator("#chat-surface")).toBeVisible();
  await expect(page.locator("#chat-state")).not.toContainText("Loading OpenCode");
}

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<unknown> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

test.describe("desktop OpenCode chat", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("creates, resumes, steers, cancels, and retains the mounted surface", async ({ page }) => {
    await page.getByRole("button", { name: "New" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    const firstId = await page.locator("#chat-conversation-select").inputValue();
    const modelSelect = page.locator("#chat-model-select");
    await expect(modelSelect.locator("option")).toHaveText(["Anthropic: Claude Sonnet", "OpenAI: GPT-5"]);
    await modelSelect.selectOption({ label: "OpenAI: GPT-5" });

    const input = page.locator("#chat-input");
    await input.fill("Initial prompt");
    const firstResponse = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await input.press("Enter");
    await expect(modelSelect).toBeDisabled();
    const response = await firstResponse;
    expect(response.request().postDataJSON()).toMatchObject({ model: { providerId: "openai", modelId: "gpt-5" } });
    expect(await response.json()).toMatchObject({ delivery: "queue", conversation: { title: "Initial prompt" } });
    await expect(page.locator("#chat-title")).toHaveText("Initial prompt");
    await expect(page.locator("#chat-conversation-select option:checked")).toHaveText("Initial prompt");
    await expect(modelSelect).toBeEnabled();
    await expect(page.locator("#chat-items")).toContainText("Initial prompt");
    await expect(page.locator("#chat-send")).toHaveText("Steer");

    await input.fill("Use the smaller approach");
    const steerResponse = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-send").click();
    expect(await (await steerResponse).json()).toMatchObject({ delivery: "steer" });
    await expect(page.locator("#chat-items")).toContainText("Use the smaller approach");

    await input.fill("draft retained across surfaces");
    await page.getByRole("radio", { name: "Preview" }).click();
    await expect(page.locator(".preview-shell")).toBeVisible();
    await page.getByRole("radio", { name: "Chat" }).click();
    await expect(input).toHaveValue("draft retained across surfaces");
    await expect(modelSelect.locator("option:checked")).toHaveText("OpenAI: GPT-5");

    await page.locator("#chat-cancel").click();
    await expect(page.locator("#chat-composer-status")).toHaveText("Cancelled");
    await expect(page.locator("#chat-items")).toContainText("Initial prompt");

    await page.reload();
    await page.getByRole("radio", { name: "Chat" }).click();
    await expect(modelSelect.locator("option:checked")).toHaveText("OpenAI: GPT-5");
    await expect(page.locator("#chat-title")).toHaveText("Initial prompt");

    await page.getByRole("button", { name: "New" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue(firstId);
    await page.locator("#chat-conversation-select").selectOption(firstId);
    await expect(page.locator("#chat-items")).toContainText("Initial prompt");
    await expect(input).toHaveValue("draft retained across surfaces");
  });

  test("completes slash commands at the caret without sending prematurely", async ({ page }) => {
    await page.getByRole("button", { name: "New" }).click();
    const input = page.locator("#chat-input");
    await input.fill("Use /rev");
    const menu = page.locator("#chat-command-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option")).toHaveCount(1);
    await expect(menu).toContainText("/review");
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("Use /review ");
    await expect(menu).toBeHidden();

    await input.fill("/review API routes");
    const response = page.waitForResponse(candidate => candidate.url().endsWith("/prompts"));
    await page.locator("#chat-send").click();
    expect((await response).request().postDataJSON()).toMatchObject({ text: "/review API routes" });
    await expect(page.locator("#chat-items")).toContainText("/review API routes");
  });

  test("keeps an active turn timer across conversation navigation", async ({ page }) => {
    await page.getByRole("button", { name: "New" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    const firstId = await page.locator("#chat-conversation-select").inputValue();
    await page.locator("#chat-input").fill("Keep timing this turn");
    await page.locator("#chat-input").press("Enter");
    await expect(page.locator("#chat-composer-status")).toContainText("OpenCode is working");
    await page.waitForTimeout(1_100);
    const before = elapsedSeconds(await page.locator("#chat-composer-status").textContent());
    expect(before).toBeGreaterThanOrEqual(1);

    await page.getByRole("button", { name: "New" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue(firstId);
    await page.locator("#chat-conversation-select").selectOption(firstId);
    await expect(page.locator("#chat-composer-status")).toContainText("OpenCode is working");
    expect(elapsedSeconds(await page.locator("#chat-composer-status").textContent())).toBeGreaterThanOrEqual(before);
  });

  test("streams Markdown and updates one tool entry in place", async ({ page, request }) => {
    const seeded = await control(request, { action: "seed", title: "Streaming", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await page.getByRole("radio", { name: "Chat" }).click();
    const id = seeded.conversation.id;
    const assistant: ConversationItem = { id: "part:answer", type: "assistant_message", createdAt: 10, markdown: "## Result\n\n" };
    await control(request, { action: "item", conversationId: id, item: assistant });
    await control(request, { action: "delta", conversationId: id, itemId: assistant.id, delta: "**streamed** safely" });
    await expect(page.locator("#chat-items h2")).toHaveText("Result");
    await expect(page.locator("#chat-items strong")).toHaveText("streamed");

    const running: ConversationItem = { id: "tool:read", type: "tool", createdAt: 11, name: "Read", status: "running", input: "README.md" };
    await control(request, { action: "item", conversationId: id, item: running });
    await expect(page.locator('[data-chat-item-id="tool:read"]')).toContainText("running");
    await control(request, { action: "item", conversationId: id, item: { ...running, status: "completed", output: "read complete" } });
    await expect(page.locator('[data-chat-item-id="tool:read"]')).toHaveCount(1);
    await expect(page.locator('[data-chat-item-id="tool:read"]')).toContainText("completed");
  });

  test("resolves permissions and structured questions once", async ({ page, request }) => {
    const seeded = await control(request, { action: "seed", title: "Interactions", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await page.getByRole("radio", { name: "Chat" }).click();
    const id = seeded.conversation.id;
    const permission: ConversationItem = { id: "permission:perm-1", type: "permission", createdAt: 10, requestId: "perm-1", action: "run command", resources: ["bun test"], status: "pending" };
    await control(request, { action: "item", conversationId: id, item: permission });
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(page.locator('[data-chat-item-id="permission:perm-1"]')).toContainText("Resolved: approved-once");
    await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);

    const question: ConversationItem = {
      id: "question:q-1", type: "question", createdAt: 11, requestId: "q-1", status: "pending",
      questions: [{ header: "Approach", prompt: "Which implementation?", multiple: false, allowFreeForm: true, options: [{ label: "Minimal", description: "Small change" }] }],
    };
    await control(request, { action: "item", conversationId: id, item: question });
    await page.getByRole("radio", { name: "Minimal Small change" }).check();
    await page.getByRole("button", { name: "Answer" }).click();
    await expect(page.locator('[data-chat-item-id="question:q-1"]')).toContainText("Answered");
    await expect(page.getByRole("button", { name: "Answer" })).toHaveCount(0);
  });

  test("streaming beside a pending question keeps the answer being typed", async ({ page, request }) => {
    const seeded = await control(request, { action: "seed", title: "Concurrent", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await page.getByRole("radio", { name: "Chat" }).click();
    const id = seeded.conversation.id;
    const question: ConversationItem = {
      id: "question:q-2", type: "question", createdAt: 11, requestId: "q-2", status: "pending",
      questions: [{ header: "Approach", prompt: "Which implementation?", multiple: false, allowFreeForm: true, options: [{ label: "Minimal", description: "Small change" }] }],
    };
    await control(request, { action: "item", conversationId: id, item: question });
    await control(request, { action: "item", conversationId: id, item: { id: "part:stream", type: "assistant_message", createdAt: 12, markdown: "Thinking" } });

    const freeForm = page.locator('[data-chat-item-id="question:q-2"] input[type="text"]');
    await freeForm.fill("my own answer");
    await page.getByRole("radio", { name: "Minimal Small change" }).check();

    // The agent keeps streaming while the answer sits half-typed; a timeline
    // rebuild here would silently discard both the text and the selection.
    for (const delta of [" about", " your", " question"]) {
      await control(request, { action: "delta", conversationId: id, itemId: "part:stream", delta });
    }
    await expect(page.locator('[data-chat-item-id="part:stream"]')).toContainText("Thinking about your question");

    await expect(freeForm).toHaveValue("my own answer");
    await expect(page.getByRole("radio", { name: "Minimal Small change" })).toBeChecked();

    await page.getByRole("button", { name: "Answer" }).click();
    await expect(page.locator('[data-chat-item-id="question:q-2"]')).toContainText("Answered");
  });

  test("replays a missed event, resyncs a stale generation, and opens workspace files", async ({ page, request }) => {
    const seeded = await control(request, { action: "seed", title: "Reconnect", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await page.getByRole("radio", { name: "Chat" }).click();
    const id = seeded.conversation.id;
    await expect.poll(async () => (await page.locator("#chat-state").textContent()) ?? "").not.toContain("Loading");

    await control(request, { action: "disconnect" });
    await control(request, { action: "item", conversationId: id, item: { id: "notice:replayed", type: "notice", createdAt: 10, level: "info", message: "replayed after disconnect" } });
    await expect(page.locator("#chat-items")).toContainText("replayed after disconnect", { timeout: 10_000 });

    let snapshots = 0;
    page.on("response", response => {
      if (new URL(response.url()).pathname.endsWith(`/api/chat/conversations/${id}`)) snapshots += 1;
    });
    await control(request, { action: "resync" });
    await expect.poll(() => snapshots, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(page.locator("#chat-items")).toContainText("replayed after disconnect");

    await control(request, { action: "item", conversationId: id, item: { id: "part:file", type: "assistant_message", createdAt: 20, markdown: "Open [setup](guides/setup.md:2)." } });
    await page.getByRole("button", { name: "setup" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-main-surface", "preview");
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
  });
});

test("the chat backend starts only when Chat becomes the active surface", async ({ page, request }) => {
  await request.post("/__e2e/reset");
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  // Opening the app on Preview must not touch chat status — in production that
  // call lazily launches the OpenCode server.
  await page.waitForTimeout(250);
  expect(((await control(request, { action: "stats" })) as { statusCalls: number }).statusCalls).toBe(0);
  await page.getByRole("radio", { name: "Chat" }).click();
  await expect(page.locator("#chat-surface")).toBeVisible();
  await expect(page.locator("#chat-state")).not.toContainText("Loading OpenCode");
  await expect.poll(async () => ((await control(request, { action: "stats" })) as { statusCalls: number }).statusCalls).toBeGreaterThan(0);
});

function elapsedSeconds(value: string | null): number {
  const match = /(?:·\s*)?(?:(\d+)m\s+)?(\d+)s/.exec(value ?? "");
  return match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : -1;
}
