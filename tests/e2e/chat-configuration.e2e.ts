import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";

import type { ChatModel, ConversationConfiguration } from "../../src/chat/types";
import { chooseChatModel, openChatConfiguration, openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<any> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function token(request: APIRequestContext): Promise<string> {
  return request.get("/__e2e/terminal-token").then(response => response.json()).then(value => value.token as string);
}

async function boot(page: Page, credential: string): Promise<void> {
  await page.goto(`/?t=${encodeURIComponent(credential)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
}

async function secondClient(browser: Browser, credential: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await boot(page, credential);
  return { context, page };
}

test.describe("conversation configuration and rename", () => {
  test("restores accepted configuration in a second client and live-updates it", async ({ page, request, browser }) => {
    await request.post("/__e2e/reset");
    const initial: ConversationConfiguration = { model: { providerId: "openai", modelId: "gpt-5" }, mode: "plan" };
    await control(request, { action: "seed", title: "Shared configuration", items: [], configuration: initial });
    const credential = await token(request);
    await boot(page, credential);
    const second = await secondClient(browser, credential);
    try {
      for (const client of [page, second.page]) {
        await expect(client.locator("#chat-configuration-trigger")).toHaveAttribute("aria-label", /Model: GPT-5.*Mode: plan/);
      }

      await chooseChatModel(page, "Claude Sonnet");
      await page.locator("#chat-configuration-mode").selectOption("build");
      await page.locator("#chat-configuration-variant").selectOption("xhigh");
      await page.locator("#chat-configuration-done").click();
      await expect(page.locator("#chat-configuration-trigger")).toHaveAttribute("aria-label", /Model: Claude Sonnet.*Mode: build.*Reasoning: xhigh/);
      await page.locator("#chat-input").fill("share this configuration");
      const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
      await page.locator("#chat-send").click();
      expect((await accepted).request().postDataJSON()).toMatchObject({
        model: { providerId: "anthropic", modelId: "claude-sonnet" }, mode: "build", variant: "xhigh",
      });

      await expect(second.page.locator("#chat-configuration-trigger")).toHaveAttribute("aria-label", /Model: Claude Sonnet.*Mode: build.*Reasoning: xhigh/);

      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await expect(page.locator("#chat-configuration-trigger")).toHaveAttribute("aria-label", /Model: Claude Sonnet.*Mode: build.*Reasoning: xhigh/);
    } finally {
      await second.context.close();
    }
  });

  test("unknown configuration omits selections and legacy browser maps are pruned", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const seeded = await control(request, { action: "seed", title: "Unknown configuration", items: [], configuration: {} }) as { conversation: { id: string } };
    const credential = await token(request);
    await page.goto(`/?t=${encodeURIComponent(credential)}`);
    await page.evaluate(() => localStorage.setItem(
      "uatu:presentation:v1:%2F:uatu:chat-presentation",
      JSON.stringify({
        drafts: {}, expanded: [], anchors: {}, workingSince: {}, dismissedSubagents: {},
        model: { providerId: "openai", modelId: "gpt-5" }, models: { stale: { providerId: "openai", modelId: "gpt-5" } },
        mode: "build", modes: { stale: "build" }, variant: "high", variants: { stale: "high" },
      }),
    ));
    await page.reload();
    await openChatPanel(page);
    await expect(page.locator("#chat-configuration-trigger")).toHaveAttribute("aria-label", /Model: chosen by Fixture Agent.*Mode: chosen by Fixture Agent/);

    await page.locator("#chat-input").fill("do not invent defaults");
    const sent = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-send").click();
    const body = (await sent).request().postDataJSON();
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("mode");
    expect(body).not.toHaveProperty("variant");

    await control(request, {
      action: "configuration", conversationId: seeded.conversation.id,
      configuration: { model: { providerId: "retired", modelId: "old-model" }, mode: "audit", variant: "deep" },
    });
    await openChatConfiguration(page);
    await expect(page.locator(".chat-configuration-model:disabled")).toContainText("retired/old-model");
    await expect(page.locator("#chat-configuration-mode option:checked")).toHaveText("audit (current, unavailable)");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("uatu:presentation:v1:%2F:uatu:chat-presentation") ?? "{}"));
    expect(stored).not.toHaveProperty("models");
    expect(stored).not.toHaveProperty("modes");
    expect(stored).not.toHaveProperty("variants");
  });

  test("a new conversation shows OpenCode's resolved model without a default reasoning sentinel", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await control(request, {
      action: "seed",
      title: "Configured conversation",
      items: [],
      configuration: { model: { providerId: "anthropic", modelId: "claude-sonnet" }, mode: "build", variant: "xhigh" },
    });
    await boot(page, await token(request));
    await expect(page.locator("#chat-configuration-trigger")).toHaveAttribute("aria-label", /Reasoning: xhigh/);

    await control(request, {
      action: "nextConversationConfiguration",
      configuration: { model: { providerId: "anthropic", modelId: "claude-sonnet" }, mode: "build" },
    });
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect(page.locator("#chat-configuration-trigger")).toHaveAttribute("aria-label", /Model: Claude Sonnet.*Mode: build.*Reasoning: chosen by Fixture Agent/);
    await openChatConfiguration(page);
    await expect(page.locator("#chat-configuration-variant option").filter({ hasText: "current, unavailable" })).toHaveCount(0);
  });

  test("keeps staged choices during a remote update and recovers configuration after restart", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const seeded = await control(request, {
      action: "seed", title: "Staged configuration", items: [],
      configuration: { model: { providerId: "openai", modelId: "gpt-5" }, mode: "plan" },
    }) as { conversation: { id: string } };
    await boot(page, await token(request));
    await chooseChatModel(page, "Claude Sonnet");
    await page.locator("#chat-configuration-mode").selectOption("build");
    await page.locator("#chat-configuration-variant").selectOption("high");

    // Choosing the non-claiming options discards local overrides and returns
    // the controls to the effective conversation state.
    await page.locator("#chat-configuration-mode").selectOption("plan");
    await expect(page.locator("#chat-configuration-mode")).toHaveValue("plan");
    await page.locator(".chat-configuration-model", { hasText: "GPT-5" }).click();
    await expect(page.locator(".chat-configuration-model[aria-pressed='true']")).toContainText("GPT-5");
    await page.locator(".chat-configuration-model", { hasText: "Claude Sonnet" }).click();
    await page.locator("#chat-configuration-mode").selectOption("build");
    await page.locator("#chat-configuration-variant").selectOption("high");
    await page.locator("#chat-configuration-done").click();

    await control(request, {
      action: "configuration", conversationId: seeded.conversation.id,
      configuration: { model: { providerId: "openai", modelId: "gpt-5" }, mode: "plan" },
    });
    await expect(page.locator("#chat-configuration-trigger")).toHaveAttribute("aria-label", /Model: Claude Sonnet.*Mode: build.*Reasoning: high/);

    await page.locator("#chat-input").fill("accept staged choices");
    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-items")).toContainText("accept staged choices");
    await control(request, { action: "restart" });
    await page.reload();
    await openChatPanel(page);
    await expect(page.locator("#chat-configuration-trigger")).toHaveAttribute("aria-label", /Model: Claude Sonnet.*Mode: build.*Reasoning: high/);
  });

  test("filters a large grouped inventory across every identity field with keyboard selection", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const inventory: ChatModel[] = Array.from({ length: 120 }, (_, index) => ({
      selection: { providerId: `provider-${index % 12}`, modelId: `model-${index}` },
      provider: `Provider ${index % 12}`,
      name: `Model ${index}`,
    }));
    inventory.push(
      { selection: { providerId: "human-provider", modelId: "plain-id" }, provider: "Plain Provider", name: "Nebula Human Name" },
      { selection: { providerId: "provider-name-id", modelId: "plain-model" }, provider: "Acme Labs", name: "Plain Human" },
      { selection: { providerId: "unique-provider-id", modelId: "another-model" }, provider: "Ordinary Provider", name: "Ordinary Human" },
      { selection: { providerId: "last-provider", modelId: "unique-model-id" }, provider: "Last Provider", name: "Last Human" },
    );
    await control(request, { action: "models", models: inventory });
    await control(request, { action: "seed", title: "Large inventory", items: [], configuration: {} });
    await boot(page, await token(request));
    await openChatConfiguration(page);
    await expect(page.locator("#chat-configuration-result-status")).toHaveText("124 models");

    const search = page.locator("#chat-configuration-search");
    for (const [query, result] of [
      ["NEBULA HUMAN", "Nebula Human Name"],
      ["acme LABS", "Plain Human"],
      ["UNIQUE-PROVIDER-ID", "Ordinary Human"],
      ["UNIQUE-MODEL-ID", "Last Human"],
    ] as const) {
      await search.fill(query);
      await expect(page.locator("#chat-configuration-result-status")).toHaveText("1 model");
      await expect(page.locator(".chat-configuration-provider")).toHaveCount(1);
      await expect(page.locator(".chat-configuration-model-name")).toHaveText(result);
    }

    await search.fill("no matching identity");
    await expect(page.locator("#chat-configuration-result-status")).toHaveText("0 models");
    await expect(page.locator(".chat-configuration-provider")).toHaveCount(0);
    await expect(page.locator("#chat-configuration-empty")).toHaveText("No models match your search.");

    await search.fill("UNIQUE-MODEL-ID");
    await search.press("ArrowDown");
    await expect(page.locator(".chat-configuration-model")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".chat-configuration-model[aria-pressed='true']")).toContainText("Last Human");
    await page.locator("#chat-configuration-done").click();
    await expect(page.locator("#chat-configuration-trigger")).toContainText("Last Human");
    await expect(page.locator("#chat-configuration-trigger")).toBeFocused();
  });

  test("stages a same-named reasoning variant after changing models", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const inventory: ChatModel[] = [
      { selection: { providerId: "first", modelId: "model-a" }, provider: "First", name: "Model A", variants: ["high"] },
      { selection: { providerId: "second", modelId: "model-b" }, provider: "Second", name: "Model B", variants: ["high"] },
    ];
    await control(request, { action: "models", models: inventory });
    await control(request, {
      action: "seed", title: "Shared variant", items: [],
      configuration: { model: inventory[0]!.selection, variant: "high" },
    });
    await boot(page, await token(request));

    await chooseChatModel(page, "Model B");
    await page.locator("#chat-configuration-variant").selectOption("high");
    await page.locator("#chat-configuration-done").click();
    await expect(page.locator("#chat-configuration-trigger")).toHaveAttribute("aria-label", /Model: Model B.*Reasoning: high/);

    await page.locator("#chat-input").fill("keep high reasoning");
    const sent = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-send").click();
    expect((await sent).request().postDataJSON()).toMatchObject({ model: inventory[1]!.selection, variant: "high" });
  });

  test("propagates and persists rename, hides unsupported rename, and names creation exactly", async ({ page, request, browser }) => {
    await request.post("/__e2e/reset");
    await control(request, { action: "seed", title: "Before rename", items: [], configuration: {} });
    const credential = await token(request);
    await boot(page, credential);
    const second = await secondClient(browser, credential);
    try {
      await expect(page.getByRole("button", { name: "New conversation", exact: true })).toBeVisible();
      await expect(page.getByText("New agent", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Rename conversation" }).click();
      const oversized = String.fromCodePoint(0x1f642).repeat(60);
      await page.locator("#chat-rename-title").fill(oversized);
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await expect(page.locator("#chat-state")).toContainText("at most 200 bytes");
      await expect(page.locator("#chat-rename-title")).toHaveValue(oversized);
      await page.locator("#chat-rename-title").fill("Renamed everywhere");
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await expect(second.page.locator("#chat-conversation-select option:checked")).toHaveText("Renamed everywhere");

      await control(request, { action: "restart" });
      await second.page.reload();
      await openChatPanel(second.page);
      await expect(second.page.locator("#chat-conversation-select option:checked")).toHaveText("Renamed everywhere");
    } finally {
      await second.context.close();
    }

    await control(request, { action: "declareOnly", capabilities: ["models", "modes", "variants"] });
    await page.reload();
    await openChatPanel(page);
    await expect(page.getByRole("button", { name: "Rename conversation" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New conversation", exact: true })).toBeVisible();
  });
});
