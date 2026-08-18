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
