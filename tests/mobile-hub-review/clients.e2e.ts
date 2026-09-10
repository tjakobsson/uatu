import { expect, test } from "@playwright/test";

test("actual workspace clients boot; pending upload settles through real Chat owner", async ({ page, request }) => {
  await request.post("/review/reset", { data: { scenario: "mixed" } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/s/atlas/README.md");
  await expect(page.locator("#preview")).toContainText("Synthetic review document");
  await expect(page.locator("#preview")).toContainText("No live workspace was read.");
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Conversation", exact: true })).toHaveValue("review:conversation-1");
  await page.getByRole("textbox", { name: "Message Synthetic agent" }).fill("Synthetic unsent draft");
  await request.post("/review/control/upload-hold");
  await page.locator("#chat-attach-input").setInputFiles({ name: "review.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6p1sAAAAASUVORK5CYII=", "base64") });
  await expect.poll(async () => (await (await request.get("/review/state")).json()).protocols.pendingUploads).toBe(1);
  await request.post("/review/control/upload-settle");
  await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Message Synthetic agent" })).toHaveValue("Synthetic unsent draft");
  expect((await (await request.get("/review/state")).json()).protocols.uploadAttempts).toBe(1);
  await page.getByRole("button", { name: "Open workspace navigation", exact: true }).click();
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await expect(page.locator('[data-terminal-ready="true"]')).toHaveCount(1);
  await request.post("/review/control/chat-output");
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await expect(page.locator("#chat-items")).toContainText("Synthetic streamed response 1");
  expect(errors).toEqual([]);
});
