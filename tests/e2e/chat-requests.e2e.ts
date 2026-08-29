// Ten permissions in one turn left a user unable to tell which still needed
// them. These assert the two things that answer "did I miss one?" — a count
// that does not scroll away, and a way to reach the one you can act on.
import type { ConversationItem } from "../../src/chat/types";
import { openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

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
