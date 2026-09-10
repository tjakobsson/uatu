import { expect, test } from "@playwright/test";

test("real composer accepts, queues, cancels and creates synthetic conversations", async ({ page, request }) => {
  await request.post("/review/reset", { data: { scenario: "mixed" } });
  await page.goto("/s/atlas/README.md");
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "Message Synthetic agent" });
  await composer.fill("Synthetic first prompt");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator("#chat-items")).toContainText("Synthetic");
  await composer.fill("Synthetic queued prompt");
  await composer.press("Enter");
  await expect.poll(async () => (await (await request.get("/s/atlas/api/chat/conversations/review%3Aconversation-1?limit=50")).json()).queued.length).toBe(1);
  await page.getByRole("button", { name: /Cancel.*(turn|response)|Stop response|Cancel turn/i }).click();
  await expect.poll(async () => (await (await request.get("/s/atlas/api/chat/conversations/review%3Aconversation-1?limit=50")).json()).conversation.status).toBe("interrupted");
  await page.getByRole("button", { name: /New conversation/i }).click();
  await expect(page.getByRole("combobox", { name: "Conversation", exact: true })).not.toHaveValue("review:conversation-1");
});

test("real xterm switcher creates a second synthetic session", async ({ page, request }) => {
  await request.post("/review/reset", { data: { scenario: "mixed" } });
  await page.goto("/s/atlas/README.md");
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await expect(page.locator('[data-terminal-ready="true"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Switch terminal", exact: true }).click();
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect(page.locator('[data-terminal-ready="true"]')).toHaveCount(2);
  const inventory = (await (await request.get("/s/atlas/api/terminal/sessions")).json()).sessions;
  expect(inventory).toHaveLength(2);
  expect(inventory.every((row: { label: string }) => row.label.includes("Synthetic"))).toBe(true);
  const emitted = await request.post("/review/control/terminal-output", { data: { sessionId: inventory[0].id } });
  expect((await emitted.json()).recipients).toBe(1);
  await page.getByRole("button", { name: "Close pane", exact: true }).filter({ visible: true }).click();
  await page.locator("#terminal-confirm-accept").click();
  await expect(page.locator('[data-terminal-ready="true"]')).toHaveCount(1);
  await expect.poll(async () => (await (await request.get("/s/atlas/api/terminal/sessions")).json()).sessions.length).toBe(1);
});
