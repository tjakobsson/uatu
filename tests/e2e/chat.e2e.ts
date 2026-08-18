import type { APIRequestContext, Page } from "@playwright/test";

import type { ConversationItem } from "../../src/chat/types";
import { openChatPanel } from "./chat-helpers";
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
    // Collapse to the strip and reopen: the surface stays mounted, so the
    // draft, model choice, and conversation survive — and Preview is
    // co-visible the whole time.
    await page.locator("#chat-collapse").click();
    await expect(page.locator("#chat-timeline")).toBeHidden();
    await expect(page.locator(".preview-shell")).toBeVisible();
    await openChatPanel(page);
    await expect(input).toHaveValue("draft retained across surfaces");
    await expect(modelSelect.locator("option:checked")).toHaveText("OpenAI: GPT-5");

    await page.locator("#chat-cancel").click();
    await expect(page.locator("#chat-composer-status")).toHaveText("Cancelled");
    await expect(page.locator("#chat-items")).toContainText("Initial prompt");

    await page.reload();
    await openChatPanel(page);
    await expect(modelSelect.locator("option:checked")).toHaveText("OpenAI: GPT-5");
    await expect(page.locator("#chat-title")).toHaveText("Initial prompt");

    await page.getByRole("button", { name: "New" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue(firstId);
    await page.locator("#chat-conversation-select").selectOption(firstId);
    await expect(page.locator("#chat-items")).toContainText("Initial prompt");
    await expect(input).toHaveValue("draft retained across surfaces");
  });

  test("switches the mode for a prompt and defaults to the agent's own", async ({ page }) => {
    await page.getByRole("button", { name: "New" }).click();
    const modeSelect = page.locator("#chat-mode-select");
    await expect(modeSelect.locator("option")).toHaveText(["Mode: default", "Mode: Build", "Mode: Plan"]);
    await expect(modeSelect).toHaveValue("");

    const input = page.locator("#chat-input");
    await input.fill("stay on the default mode");
    const defaulted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await input.press("Enter");
    expect((await defaulted).request().postDataJSON()).not.toHaveProperty("mode");

    // Stuck in a read-only mode is the whole point: choosing Build must
    // reach the provider with the next prompt.
    await modeSelect.selectOption({ label: "Mode: Build" });
    await input.fill("now write some code");
    const switched = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await input.press("Enter");
    expect((await switched).request().postDataJSON()).toMatchObject({ mode: "build" });

    // No way back to "default": the mode is session state in the agent, so a
    // prompt omitting it would keep Build while the picker claimed default.
    await expect(modeSelect.locator('option[value=""]')).toBeDisabled();
  });

  // The surface takes its name from what the agent reported, so a workspace
  // with a different agent renames itself without a line of copy changing.
  test("names the agent it is talking to", async ({ page }) => {
    await expect(page.locator("#chat-title")).toHaveText("Fixture Agent Chat");
    await expect(page.locator("#chat-input")).toHaveAttribute("placeholder", "Ask Fixture Agent…");
    // The visible header, not only the assistive one: a workspace always has a
    // root label, so the agent has to sit beside it rather than behind it.
    await expect(page.locator("#chat-context")).toContainText("Fixture Agent");
  });

  // The one path a workspace with a single real agent can never reach: an
  // agent that offers less. The control must be gone, not disabled — a
  // disabled control claims the feature exists and is merely unavailable now.
  test("removes a control the agent does not declare", async ({ page, request }) => {
    await control(request, { action: "declareOnly", capabilities: ["models", "commands", "permissions"] });
    await page.reload();
    await openChatPanel(page);
    await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
    await page.getByRole("button", { name: "New" }).click();
    await expect(page.locator("#chat-model-select")).toBeVisible();
    await expect(page.locator("#chat-mode-select")).toHaveCount(0);
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
    await expect(page.locator("#chat-composer-status")).toContainText("Working");
    await page.waitForTimeout(1_100);
    const before = elapsedSeconds(await page.locator("#chat-composer-status").textContent());
    expect(before).toBeGreaterThanOrEqual(1);

    await page.getByRole("button", { name: "New" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue(firstId);
    await page.locator("#chat-conversation-select").selectOption(firstId);
    await expect(page.locator("#chat-composer-status")).toContainText("Working");
    expect(elapsedSeconds(await page.locator("#chat-composer-status").textContent())).toBeGreaterThanOrEqual(before);
  });

  test("streams Markdown and updates one tool entry in place", async ({ page, request }) => {
    const seeded = await control(request, { action: "seed", title: "Streaming", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await openChatPanel(page);
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
    await openChatPanel(page);
    const id = seeded.conversation.id;
    const permission: ConversationItem = { id: "permission:perm-1", type: "permission", createdAt: 10, requestId: "perm-1", action: "run command", resources: ["bun test"], status: "pending" };
    await control(request, { action: "item", conversationId: id, item: permission });

    // The persistent reply reaches past this conversation into every later one
    // the same OpenCode server handles, and covers the request's `always`
    // pattern rather than only the resource shown. The surface must say so
    // where the choice is made, and must not offer the old "Allow session"
    // wording, which implied a single conversation.
    const card = page.locator('[data-chat-item-id="permission:perm-1"]');
    await expect(card.getByRole("button", { name: "Allow always" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Allow session" })).toHaveCount(0);
    await expect(card).toContainText("later conversations");
    await expect(card).toContainText("until OpenCode restarts");

    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(page.locator('[data-chat-item-id="permission:perm-1"]')).toContainText("Resolved: approved-once");
    await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);

    const question: ConversationItem = {
      id: "question:q-1", type: "question", createdAt: 11, requestId: "q-1", status: "pending",
      questions: [{ header: "Approach", prompt: "Which implementation?", multiple: false, allowFreeForm: true, options: [{ label: "Minimal", description: "Small change" }] }],
    };
    await control(request, { action: "item", conversationId: id, item: question });
    await page.getByRole("radio", { name: "Minimal Small change" }).check();
    await page.getByRole("button", { name: "Answer", exact: true }).click();
    await expect(page.locator('[data-chat-item-id="question:q-1"]')).toContainText("Answered");
    await expect(page.getByRole("button", { name: "Answer", exact: true })).toHaveCount(0);
  });

  test("streaming beside a pending question keeps the answer being typed", async ({ page, request }) => {
    const seeded = await control(request, { action: "seed", title: "Concurrent", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await openChatPanel(page);
    const id = seeded.conversation.id;
    const question: ConversationItem = {
      id: "question:q-2", type: "question", createdAt: 11, requestId: "q-2", status: "pending",
      questions: [{ header: "Approach", prompt: "Which implementation?", multiple: false, allowFreeForm: true, options: [{ label: "Minimal", description: "Small change" }] }],
    };
    await control(request, { action: "item", conversationId: id, item: question });
    await control(request, { action: "item", conversationId: id, item: { id: "part:stream", type: "assistant_message", createdAt: 12, markdown: "Thinking" } });

    const freeForm = page.locator('[data-chat-item-id="question:q-2"] input[type="text"]');
    await freeForm.fill("my own answer");

    // The agent keeps streaming while the answer sits half-typed; a timeline
    // rebuild here would silently discard the text.
    for (const delta of [" about", " your"]) {
      await control(request, { action: "delta", conversationId: id, itemId: "part:stream", delta });
    }
    await expect(page.locator('[data-chat-item-id="part:stream"]')).toContainText("Thinking about your");
    await expect(freeForm).toHaveValue("my own answer");

    // Single choice: picking an option supersedes the half-typed "Other" —
    // exactly one answer may reach the server.
    await page.getByRole("radio", { name: "Minimal Small change" }).check();
    await expect(freeForm).toHaveValue("");
    await control(request, { action: "delta", conversationId: id, itemId: "part:stream", delta: " question" });
    await expect(page.locator('[data-chat-item-id="part:stream"]')).toContainText("Thinking about your question");
    await expect(page.getByRole("radio", { name: "Minimal Small change" })).toBeChecked();

    await page.getByRole("button", { name: "Answer", exact: true }).click();
    await expect(page.locator('[data-chat-item-id="question:q-2"]')).toContainText("Answered");
  });

  test("resending after a failure reuses the request id for at-most-once delivery", async ({ page, request }) => {
    await page.getByRole("button", { name: "New" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    await control(request, { action: "failPrompt" });
    await page.locator("#chat-input").fill("retry me");
    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-composer-status")).toHaveText("Message not accepted; draft restored");
    await expect(page.locator("#chat-input")).toHaveValue("retry me");

    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-items")).toContainText("retry me");
    const stats = await control(request, { action: "stats" }) as { promptAttempts: string[] };
    // Same id both times: the server's idempotency receipt can dedupe a
    // request whose first response was lost after acceptance.
    expect(stats.promptAttempts).toHaveLength(2);
    expect(stats.promptAttempts[0]).toBe(stats.promptAttempts[1]);
  });

  test("a success in another conversation does not discard a retained retry id", async ({ page, request }) => {
    const first = await control(request, { action: "seed", title: "First", items: [] }) as { conversation: { id: string } };
    const second = await control(request, { action: "seed", title: "Second", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await openChatPanel(page);
    await page.locator("#chat-conversation-select").selectOption(first.conversation.id);
    await control(request, { action: "failPrompt" });
    await page.locator("#chat-input").fill("cross retry");
    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-composer-status")).toHaveText("Message not accepted; draft restored");

    await page.locator("#chat-conversation-select").selectOption(second.conversation.id);
    await page.locator("#chat-input").fill("unrelated message");
    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-items")).toContainText("unrelated message");

    await page.locator("#chat-conversation-select").selectOption(first.conversation.id);
    await expect(page.locator("#chat-input")).toHaveValue("cross retry");
    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-items")).toContainText("cross retry");

    const stats = await control(request, { action: "stats" }) as { promptAttempts: string[] };
    expect(stats.promptAttempts).toHaveLength(3);
    expect(stats.promptAttempts[2]).toBe(stats.promptAttempts[0]);
    expect(stats.promptAttempts[1]).not.toBe(stats.promptAttempts[0]);
  });

  test("a prompt failure after switching conversations restores the draft on return", async ({ page, request }) => {
    const first = await control(request, { action: "seed", title: "First", items: [] }) as { conversation: { id: string } };
    const second = await control(request, { action: "seed", title: "Second", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await openChatPanel(page);
    await page.locator("#chat-conversation-select").selectOption(first.conversation.id);
    await expect(page.locator("#chat-title")).toHaveText("First");

    await control(request, { action: "failPrompt" });
    await page.locator("#chat-input").fill("doomed message");
    await page.locator("#chat-send").click();
    // Switch away inside the fixture's 500ms in-flight window, before the
    // rejection lands.
    await page.locator("#chat-conversation-select").selectOption(second.conversation.id);
    await expect(page.locator("#chat-composer-status")).toHaveText("Message not accepted; draft restored");

    await page.locator("#chat-conversation-select").selectOption(first.conversation.id);
    await expect(page.locator("#chat-input")).toHaveValue("doomed message");
  });

  test("replays a missed event, resyncs a stale generation, and opens workspace files", async ({ page, request }) => {
    const seeded = await control(request, { action: "seed", title: "Reconnect", items: [] }) as { conversation: { id: string } };
    await page.reload();
    await openChatPanel(page);
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
    // Navigation happens in the co-visible Preview — the panel must not
    // collapse or hide the conversation.
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
    await expect(page.locator("html")).toHaveAttribute("data-chat-panel", "open");
    await expect(page.locator("#chat-timeline")).toBeVisible();
  });
});

test("the chat backend starts only when the panel opens", async ({ page, request }) => {
  await request.post("/__e2e/reset");
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  // Booting with the panel collapsed must not touch chat status — in
  // production that call lazily launches the OpenCode server.
  await page.waitForTimeout(250);
  expect(((await control(request, { action: "stats" })) as { statusCalls: number }).statusCalls).toBe(0);
  await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
  await expect.poll(async () => ((await control(request, { action: "stats" })) as { statusCalls: number }).statusCalls).toBeGreaterThan(0);
});

function elapsedSeconds(value: string | null): number {
  const match = /(?:·\s*)?(?:(\d+)m\s+)?(\d+)s/.exec(value ?? "");
  return match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : -1;
}
