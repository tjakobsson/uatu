// Ten permissions in one turn left a user unable to tell which still needed
// them. These assert the two things that answer "did I miss one?" — a count
// that does not scroll away, and a way to reach the one you can act on.
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { APIRequestContext, Page } from "@playwright/test";

import type { ConversationItem, PermissionOutcome } from "../../src/chat/types";
import { captureScreenshot, openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

// Where the confirm-always-allow-scope change keeps its evidence.
const CONFIRM_SCREENSHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../openspec/changes/confirm-always-allow-scope/screenshots");

test("outstanding requests are counted, reachable, and clear at zero", async ({ page, request }) => {
  await request.post("/__e2e/reset");
  const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
  const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Batch", items: [] } })
    .then(r => r.json()) as { conversation: { id: string } };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await openChatPanel(page);
  const id = seeded.conversation.id;
  const jump = page.locator("#chat-requests-jump");
  await expect(jump).toBeHidden();

  for (const i of [0, 1, 2]) {
    const item: ConversationItem = {
      id: `permission:p${i}`, type: "permission", createdAt: 10 + i, requestId: `p${i}`,
      action: "bash", resources: [`cmd-${i}`], status: "pending",
    };
    await request.post("/__e2e/chat", { data: { action: "item", conversationId: id, item } });
  }
  await expect(jump).toHaveText("3 requests need your answer");

  await jump.click();
  await expect(page.locator('[data-chat-item-id="permission:p2"]')).toBeInViewport();

  for (const i of [0, 1, 2]) {
    await request.post("/__e2e/chat", { data: { action: "item", conversationId: id, item: {
      id: `permission:p${i}`, type: "permission", createdAt: 10 + i, requestId: `p${i}`,
      action: "bash", resources: [`cmd-${i}`], status: "resolved", outcome: "approved-once",
    } } });
  }
  await expect(jump).toBeHidden();

  // Recovered requests can share a timestamp and arrive in provider order.
  // Admission breaks that tie by greatest id, not by whichever arrived last.
  for (const requestId of ["z", "a"]) {
    await request.post("/__e2e/chat", { data: { action: "item", conversationId: id, item: {
      id: `permission:${requestId}`, type: "permission", createdAt: 20, requestId,
      action: "bash", resources: [`cmd-${requestId}`], status: "pending",
    } } });
  }
  await expect(jump).toHaveAttribute("data-request-target", "permission:z");
  await expect(page.locator('[data-chat-item-id="permission:z"]')).toHaveAttribute("data-request-state", "needs-answer");
  await expect(page.locator('[data-chat-item-id="permission:a"]')).toHaveAttribute("data-request-state", "queued");
});

test("a variant without a model is refused at the boundary", async ({ page, request }) => {
  await request.post("/__e2e/reset");
  const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
  const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Variant pairing", items: [] } })
    .then(r => r.json()) as { conversation: { id: string } };
  // The browser context carries the workspace session; page.request shares it.
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  // A variant names an effort OF a model; accepting a bare one would tie its
  // validity to server-side memory of the conversation's current model, which
  // an adapter restart empties while the session keeps its model.
  const response = await page.request.post(`/api/chat/conversations/${seeded.conversation.id}/prompts`, {
    // The browser sends these itself; the request context must state them.
    headers: { origin: new URL(page.url()).origin },
    data: { requestId: "r-variant-alone", text: "think hard", variant: "high" },
  });
  expect(response.status()).toBe(400);
  expect(await response.json()).toMatchObject({ error: "variant requires a model selection" });
});

test("a pending edit permission shows its diff, and a resolved one recedes", async ({ page, request }) => {
  await request.post("/__e2e/reset");
  const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
  const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Review", items: [] } })
    .then(r => r.json()) as { conversation: { id: string } };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await openChatPanel(page);
  const id = seeded.conversation.id;

  // A pending edit permission shows the change it would apply, beside its choices.
  const edit: ConversationItem = {
    id: "permission:edit", type: "permission", createdAt: 20, requestId: "edit",
    action: "edit", resources: ["src/app.ts"], status: "pending",
    diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
  };
  await request.post("/__e2e/chat", { data: { action: "item", conversationId: id, item: edit } });
  const card = page.locator('[data-chat-item-id="permission:edit"]');
  await expect(card.locator(".chat-request-change .chat-diff")).toContainText("const a = 2;");
  await expect(card.locator('[data-permission-outcome="approved-once"]')).toBeVisible();

  // Resolve it: the card recedes to a one-line trace, its diff gone, its resource
  // still reachable in the collapsed body.
  await request.post("/__e2e/chat", { data: { action: "item", conversationId: id, item: {
    ...edit, status: "resolved", outcome: "approved-once",
  } } });
  await expect(card.locator(".chat-request-trace")).toHaveText("Allowed once");
  await expect(card.locator(".chat-request-change")).toHaveCount(0);
  await expect(card).not.toHaveAttribute("open", /.*/);
  await expect(card.locator("ul code")).toContainText("src/app.ts");
});

test("a surfaced subagent request opens its transcript without changing the parent selection", async ({ page, request }) => {
  await request.post("/__e2e/reset");
  const child = await request.post("/__e2e/chat", { data: { action: "seed", title: "Child transcript", child: true, items: [
    { id: "part:child", type: "assistant_message", createdAt: 1, markdown: "child findings" },
  ] } }).then(response => response.json()) as { conversation: { id: string } };
  const requestItem: ConversationItem = {
    id: "permission:surfaced", type: "permission", createdAt: 3, requestId: "surfaced",
    conversationId: child.conversation.id, action: "bash", resources: ["bun test"], status: "pending",
  };
  const parent = await request.post("/__e2e/chat", { data: { action: "seed", title: "Parent", items: [
    {
      id: "tool:agent", type: "tool", createdAt: 2, name: "task", status: "completed",
      input: JSON.stringify({ description: "Review renderer", subagent_type: "explore", prompt: "go" }),
      childConversationId: child.conversation.id,
    },
    requestItem,
  ] } }).then(response => response.json()) as { conversation: { id: string } };
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await openChatPanel(page);

  const card = page.locator('[data-chat-item-id="permission:surfaced"]');
  await expect(card.locator(".chat-request-origin")).toContainText("Requested by explore · Review renderer.");
  await card.getByRole("button", { name: "Open transcript" }).click();
  await expect(page.locator("#chat-drilldown-items")).toContainText("child findings");
  await expect(page.locator("#chat-conversation-select")).toHaveValue(parent.conversation.id);

  await page.locator("#chat-drilldown-back").click();
  await expect(page.locator("#chat-drilldown")).toBeHidden();
  await expect(page.locator("#chat-conversation-select")).toHaveValue(parent.conversation.id);
  await expect(card).toBeVisible();
});

// "Allow always" is the one choice that outlives the request, and OpenCode's
// rule is not the command on the card: `git status --short` installs
// `git status *`. These prove the reply waits for a confirmation that shows
// the agent's own pattern, and that nothing else about the card changed.
test.describe("Allow always asks for confirmation", () => {
  type Replies = { permissionChoices: Array<{ interactionId: string; outcome: PermissionOutcome; choiceId?: string }> };
  const replies = async (request: APIRequestContext) => (await request.post("/__e2e/chat", { data: { action: "stats" } }).then(r => r.json()) as Replies).permissionChoices;
  const publish = (request: APIRequestContext, conversationId: string, item: ConversationItem) =>
    request.post("/__e2e/chat", { data: { action: "item", conversationId, item } });
  const shell = (requestId: string, createdAt: number, alwaysPatterns?: string[], action = "bash", resources = ["git status --short"]): ConversationItem => ({
    id: `permission:${requestId}`, type: "permission", createdAt, requestId, action, resources, status: "pending",
    ...(alwaysPatterns ? { alwaysPatterns } : {}),
  });

  async function boot(page: Page, request: APIRequestContext): Promise<string> {
    await request.post("/__e2e/reset");
    const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
    const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Status check", items: [
      { id: "message:u1", type: "user_message", createdAt: 1, text: "Is the tree clean?" },
    ] } }).then(r => r.json()) as { conversation: { id: string } };
    await page.goto(`/?t=${encodeURIComponent(token.token)}`);
    await openChatPanel(page);
    return seeded.conversation.id;
  }

  test("shows the agent's pattern apart from the command, and replies only on Confirm", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    const id = await boot(page, request);
    await publish(request, id, shell("shell", 20, ["git status *"]));
    const card = page.locator('[data-chat-item-id="permission:shell"]');
    const always = card.getByRole("button", { name: "Allow always" });
    const stage = card.locator("[data-permission-confirming]");
    await expect(always).toBeVisible();

    // Allow always opens the stage and sends nothing.
    await always.click();
    await expect(stage).toBeVisible();
    await expect(always).toBeHidden();
    // The agent's pattern is what will be allowed; the command stays above,
    // apart from it, so the reader sees where the two differ.
    await expect(stage.locator(".chat-request-always code")).toHaveText(["git status *"]);
    await expect(card.locator(":scope > ul > li code")).toHaveText(["git status --short"]);
    await expect(stage.locator(".chat-request-confirm-action")).toHaveText("bash");
    await expect(stage.locator(".chat-request-scope")).toContainText("until OpenCode restarts");
    await expect(stage.getByRole("button", { name: "Cancel" })).toBeFocused();
    expect(await replies(request)).toEqual([]);
    await captureScreenshot(page, testInfo, CONFIRM_SCREENSHOTS, "after-confirmation-prefix-desktop");

    // Cancel returns to the pending choices; still nothing sent.
    await stage.getByRole("button", { name: "Cancel" }).click();
    await expect(stage).toBeHidden();
    await expect(always).toBeVisible();
    await expect(always).toBeFocused();
    expect(await replies(request)).toEqual([]);

    // Escape inside the stage is Cancel.
    await always.click();
    await expect(stage).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(stage).toBeHidden();
    await expect(always).toBeVisible();
    expect(await replies(request)).toEqual([]);

    // Confirm sends the persistent reply once, and the card records it as before.
    await always.click();
    await stage.getByRole("button", { name: "Confirm" }).click();
    await expect(card.locator(".chat-request-trace")).toHaveText("Allowed always");
    await expect(card).toHaveAttribute("data-request-state", "resolved");
    expect(await replies(request)).toEqual([{ interactionId: "shell", outcome: "approved-session" }]);
  });

  test("a sole wildcard names the whole action, and no pattern is said plainly", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    const id = await boot(page, request);
    await publish(request, id, shell("fetch", 20, ["*"], "webfetch", ["https://example.com/docs"]));
    const fetchCard = page.locator('[data-chat-item-id="permission:fetch"]');
    await fetchCard.getByRole("button", { name: "Allow always" }).click();
    const wildcard = fetchCard.locator("[data-permission-confirming]");
    await expect(wildcard.locator(".chat-request-confirm-lead")).toContainText("every");
    await expect(wildcard.locator(".chat-request-confirm-action")).toHaveText("webfetch");
    await expect(wildcard.locator(".chat-request-always")).toHaveCount(0);
    await captureScreenshot(page, testInfo, CONFIRM_SCREENSHOTS, "after-confirmation-wildcard-desktop");
    await wildcard.getByRole("button", { name: "Cancel" }).click();

    // A newer request with nothing reusable becomes the answerable one.
    await publish(request, id, shell("bare", 21, [], "skill", ["review-code"]));
    const bareCard = page.locator('[data-chat-item-id="permission:bare"]');
    await bareCard.getByRole("button", { name: "Allow always" }).click();
    const bare = bareCard.locator("[data-permission-confirming]");
    await expect(bare.locator(".chat-request-confirm-lead")).toContainText("no reusable pattern");
    await expect(bare.locator(".chat-request-confirm-lead")).toContainText("only this request");
    await expect(bare.locator(".chat-request-always")).toHaveCount(0);
    await captureScreenshot(page, testInfo, CONFIRM_SCREENSHOTS, "after-confirmation-no-pattern-desktop");
    expect(await replies(request)).toEqual([]);
  });

  test("a request resolved elsewhere closes its confirmation; once and reject still reply on one click", async ({ page, request }) => {
    const id = await boot(page, request);
    await publish(request, id, shell("shell", 20, ["git status *"]));
    const card = page.locator('[data-chat-item-id="permission:shell"]');
    await card.getByRole("button", { name: "Allow always" }).click();
    await expect(card.locator("[data-permission-confirming]")).toBeVisible();
    // Answered from another client: the card recedes as any resolved one.
    await publish(request, id, { ...shell("shell", 20, ["git status *"]), status: "resolved", outcome: "approved-once" });
    await expect(card.locator(".chat-request-trace")).toHaveText("Allowed once");
    await expect(card.locator("[data-permission-confirming]")).toHaveCount(0);
    await expect(card.getByRole("button")).toHaveCount(0);
    expect(await replies(request)).toEqual([]);

    await publish(request, id, shell("once", 21, ["git status *"]));
    await page.locator('[data-chat-item-id="permission:once"]').getByRole("button", { name: "Allow once" }).click();
    await expect(page.locator('[data-chat-item-id="permission:once"] .chat-request-trace')).toHaveText("Allowed once");
    await publish(request, id, shell("reject", 22, ["git status *"]));
    await page.locator('[data-chat-item-id="permission:reject"]').getByRole("button", { name: "Reject" }).click();
    await expect(page.locator('[data-chat-item-id="permission:reject"] .chat-request-trace')).toHaveText("Rejected");
    expect(await replies(request)).toEqual([
      { interactionId: "once", outcome: "approved-once" },
      { interactionId: "reject", outcome: "rejected" },
    ]);
  });

  test.describe("at phone width", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("the stage fits the card in touch mode", async ({ page, request }, testInfo) => {
      await request.post("/__e2e/reset");
      const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Status check", items: [
        { id: "message:u1", type: "user_message", createdAt: 1, text: "Is the tree clean?" },
      ] } }).then(r => r.json()) as { conversation: { id: string } };
      const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
      await page.goto(`/?t=${encodeURIComponent(token.token)}`);
      await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
      await page.locator("#touch-tab-chat").click();
      await expect(page.locator("#chat-conversation-select")).toHaveValue(seeded.conversation.id);
      await publish(request, seeded.conversation.id, shell("shell", 20, ["git status *"]));
      const card = page.locator('[data-chat-item-id="permission:shell"]');
      await card.getByRole("button", { name: "Allow always" }).click();
      const stage = card.locator("[data-permission-confirming]");
      await expect(stage.locator(".chat-request-always code")).toHaveText(["git status *"]);
      await expect(stage.getByRole("button", { name: "Confirm" })).toBeVisible();
      await captureScreenshot(page, testInfo, CONFIRM_SCREENSHOTS, "after-confirmation-phone");
      expect(await replies(request)).toEqual([]);
    });
  });
});
