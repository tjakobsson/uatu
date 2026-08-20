import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";

import type { ConversationConfiguration } from "../../src/chat/types";
import { openChatPanel } from "./chat-helpers";
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
        await expect(client.locator("#chat-model-select")).toHaveValue(JSON.stringify(["openai", "gpt-5"]));
        await expect(client.locator("#chat-mode-select")).toHaveValue("plan");
        await expect(client.locator('#chat-model-select option[value=""]')).toBeDisabled();
        await expect(client.locator('#chat-mode-select option[value=""]')).toBeDisabled();
      }

      await page.locator("#chat-model-select").selectOption({ label: "Anthropic: Claude Sonnet" });
      await page.locator("#chat-mode-select").selectOption("build");
      await page.locator("#chat-variant-select").selectOption("xhigh");
      await expect(page.locator('#chat-model-select option[value=""]')).toHaveText("Use current model");
      await expect(page.locator('#chat-model-select option[value=""]')).toBeEnabled();
      await expect(page.locator('#chat-mode-select option[value=""]')).toHaveText("Use current mode");
      await expect(page.locator('#chat-mode-select option[value=""]')).toBeEnabled();
      await page.locator("#chat-input").fill("share this configuration");
      const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
      await page.locator("#chat-send").click();
      expect((await accepted).request().postDataJSON()).toMatchObject({
        model: { providerId: "anthropic", modelId: "claude-sonnet" }, mode: "build", variant: "xhigh",
      });

      await expect(second.page.locator("#chat-model-select")).toHaveValue(JSON.stringify(["anthropic", "claude-sonnet"]));
      await expect(second.page.locator("#chat-mode-select")).toHaveValue("build");
      await expect(second.page.locator("#chat-variant-select")).toHaveValue("xhigh");

      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await expect(page.locator("#chat-model-select")).toHaveValue(JSON.stringify(["anthropic", "claude-sonnet"]));
      await expect(page.locator("#chat-mode-select")).toHaveValue("build");
      await expect(page.locator("#chat-variant-select")).toHaveValue("xhigh");
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
    await expect(page.locator("#chat-model-select")).toHaveValue("");
    await expect(page.locator("#chat-model-select option:checked")).toHaveText("Model: current unknown");
    await expect(page.locator("#chat-mode-select")).toHaveValue("");

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
    await expect(page.locator("#chat-model-select option:checked")).toHaveText("Current model (unavailable): retired/old-model");
    await expect(page.locator("#chat-mode-select option:checked")).toHaveText("Mode: Audit (current, unavailable)");
    await expect(page.locator("#chat-variant-select option:checked")).toHaveText("Reasoning: deep (current, unavailable)");
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
    await expect(page.locator("#chat-variant-select")).toHaveValue("xhigh");

    await control(request, {
      action: "nextConversationConfiguration",
      configuration: { model: { providerId: "anthropic", modelId: "claude-sonnet" }, mode: "build" },
    });
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect(page.locator("#chat-model-select option:checked")).toHaveText("Anthropic: Claude Sonnet");
    await expect(page.locator("#chat-mode-select")).toHaveValue("build");
    await expect(page.locator("#chat-variant-select option:checked")).toHaveText("Reasoning: current unknown");
    await expect(page.locator("#chat-variant-select option").filter({ hasText: "current, unavailable" })).toHaveCount(0);
  });

  test("keeps staged choices during a remote update and recovers configuration after restart", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const seeded = await control(request, {
      action: "seed", title: "Staged configuration", items: [],
      configuration: { model: { providerId: "openai", modelId: "gpt-5" }, mode: "plan" },
    }) as { conversation: { id: string } };
    await boot(page, await token(request));
    await page.locator("#chat-model-select").selectOption({ label: "Anthropic: Claude Sonnet" });
    await page.locator("#chat-mode-select").selectOption("build");
    await page.locator("#chat-variant-select").selectOption("high");

    // Choosing the non-claiming options discards local overrides and returns
    // the controls to the effective conversation state.
    await page.locator("#chat-mode-select").selectOption("");
    await expect(page.locator("#chat-mode-select")).toHaveValue("plan");
    await page.locator("#chat-model-select").selectOption("");
    await expect(page.locator("#chat-model-select")).toHaveValue(JSON.stringify(["openai", "gpt-5"]));
    await page.locator("#chat-model-select").selectOption({ label: "Anthropic: Claude Sonnet" });
    await page.locator("#chat-mode-select").selectOption("build");
    await page.locator("#chat-variant-select").selectOption("high");

    await control(request, {
      action: "configuration", conversationId: seeded.conversation.id,
      configuration: { model: { providerId: "openai", modelId: "gpt-5" }, mode: "plan" },
    });
    await expect(page.locator("#chat-model-select")).toHaveValue(JSON.stringify(["anthropic", "claude-sonnet"]));
    await expect(page.locator("#chat-mode-select")).toHaveValue("build");
    await expect(page.locator("#chat-variant-select")).toHaveValue("high");

    await page.locator("#chat-input").fill("accept staged choices");
    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-items")).toContainText("accept staged choices");
    await control(request, { action: "restart" });
    await page.reload();
    await openChatPanel(page);
    await expect(page.locator("#chat-model-select")).toHaveValue(JSON.stringify(["anthropic", "claude-sonnet"]));
    await expect(page.locator("#chat-mode-select")).toHaveValue("build");
    await expect(page.locator("#chat-variant-select")).toHaveValue("high");
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
