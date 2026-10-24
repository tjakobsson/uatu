import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "./fixtures";
import { openChatPanel, openChatPending } from "./chat-helpers";

/** The real enlarged-pending route state, shared with the opt-in Linux probe.
 * Keep the conversation text, images, selection and render sequence identical. */
export async function enlargedPendingFixture(page: Page, request: APIRequestContext, width: number, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width, height: 844 });
  await request.post("/__e2e/reset");
  await request.post("/__e2e/chat", { data: { action: "agents", stack: "opencode-v2" } });
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  if (await page.locator("html").getAttribute("data-ui-mode") === "touch") await page.locator("#touch-tab-chat").tap();
  else await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.locator("#chat-state")).toContainText("Started new conversation with OpenCode");
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
  const submit = async (text: string, pending: boolean) => {
    await page.locator("#chat-input").fill(text);
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").press(pending ? "Alt+Enter" : await page.locator("html").getAttribute("data-ui-mode") === "touch" ? "Control+Enter" : "Enter");
    const response = await accepted;
    expect(response.ok()).toBe(true);
    await expect(page.locator("#chat-input")).toHaveValue("");
    expect(await response.json()).toMatchObject({ pending });
  };
  await submit("Start the work", false);
  await expect(page.locator("#chat-items")).toContainText("Start the work");
  await expect(page.locator("#chat-stop")).toBeEnabled();
  const conversationId = await page.locator("#chat-conversation-select").inputValue();
  await expect.poll(async () => {
    const state = await request.post("/__e2e/chat", { data: { action: "opencode", op: "state" } }).then(r => r.json());
    return state.sessions[conversationId.replace(/^opencode:/, "")]?.running;
  }).toBe(true);
  await submit("Readable first line\nSecond line with descenders gyjp\nThird line stays separate\nA_long_unbroken_message_must_wrap_without_horizontal_overflow", true);
  const image = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 320;
    const context = canvas.getContext("2d")!; context.fillStyle = "#286cb9"; context.fillRect(0, 0, 640, 320);
    context.fillStyle = "white"; context.font = "32px sans-serif"; context.fillText("Pending image", 24, 64);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }), "base64");
  for (const text of ["Image and message\nAnother readable line", ""]) {
    const upload = page.waitForResponse(response => response.url().endsWith("/attachments") && response.request().method() === "POST");
    await page.locator("#chat-attach-input").setInputFiles({ name: "pending.png", mimeType: "image/png", buffer: image });
    expect((await upload).status()).toBe(201);
    await submit(text, true);
  }
  const held = page.locator("#chat-queue .chat-queued-message[data-delivery='queue']");
  await expect(held).toHaveCount(3);
  await openChatPending(page);
  await expect(held.first()).toBeVisible();
  const beforeHeight = (await held.first().boundingBox())!.height;
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  return beforeHeight;
}
