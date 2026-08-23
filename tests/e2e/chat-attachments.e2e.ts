import type { APIRequestContext, Page } from "@playwright/test";

import { openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

// 1x1 red PNG — small enough to inline, real enough to sniff.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let token = "";

async function bootChat(page: Page, request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset");
  const response = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
  token = response.token;
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
}

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<unknown> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function newConversation(page: Page): Promise<string> {
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
  return page.locator("#chat-conversation-select").inputValue();
}

async function attachViaPicker(page: Page, name = "shot.png"): Promise<void> {
  const uploaded = page.waitForResponse(response => response.url().includes("/attachments") && response.request().method() === "POST");
  await page.locator("#chat-attach-input").setInputFiles({ name, mimeType: "image/png", buffer: PNG });
  expect((await uploaded).status()).toBe(201);
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.locator("#chat-input");
  await input.fill(text);
  const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
  await input.press("Enter");
  await accepted;
}

// Dispatches a synthetic paste carrying an image file (and optionally text)
// onto the composer input — the clipboard itself is not scriptable headlessly.
async function pasteImage(page: Page, options: { text?: string; type?: string; name?: string } = {}): Promise<void> {
  await page.evaluate(async ({ bytes, text, type, name }) => {
    const input = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], name, { type }));
    if (text) transfer.setData("text/plain", text);
    input.focus();
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, { bytes: Array.from(PNG), text: options.text ?? "", type: options.type ?? "image/png", name: options.name ?? "pasted.png" });
}

test.describe("chat image attachments", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("picker attaches, sends with the message, renders in the timeline, and survives reload", async ({ page }) => {
    await newConversation(page);

    await attachViaPicker(page);
    const pending = page.locator("#chat-attachments .chat-attachment");
    await expect(pending).toHaveCount(1);
    await expect(pending.first()).toContainText("shot.png");

    await send(page, "look at this screenshot");
    // The strip clears optimistically and the message renders its thumbnail
    // from the workspace's serve route, not from local state.
    await expect(page.locator("#chat-attachments")).toBeHidden();
    const thumb = page.locator("#chat-items .chat-user-message .chat-message-attachment-thumb");
    await expect(thumb).toHaveCount(1);
    await expect(thumb).toHaveAttribute("src", /\/api\/chat\/attachments\//);
    // The bytes actually serve: a broken image would have naturalWidth 0.
    await expect.poll(() => thumb.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

    // Replay: a reload rebuilds the same presentation from stored history.
    await page.reload();
    await openChatPanel(page);
    const replayed = page.locator("#chat-items .chat-user-message .chat-message-attachment-thumb");
    await expect(replayed).toHaveCount(1);
    await expect.poll(() => replayed.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  });

  test("paste stages images and keeps pasted text; unsupported and excess intakes are refused", async ({ page }) => {
    await newConversation(page);

    await pasteImage(page, { text: "words that must survive" });
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(1);
    await expect(page.locator("#chat-input")).toHaveValue("words that must survive");

    // An unsupported type is refused with a visible reason; the draft and the
    // staged attachment are untouched.
    await pasteImage(page, { type: "image/tiff", name: "scan.tiff" });
    await expect(page.locator("#chat-composer-error")).toContainText("not a supported image");
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(1);
    await expect(page.locator("#chat-input")).toHaveValue("words that must survive");

    // The per-message bound refuses the ninth image and keeps the eight.
    for (let index = 0; index < 7; index += 1) await attachViaPicker(page, `extra-${index}.png`);
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(8);
    await pasteImage(page, { name: "ninth.png" });
    await expect(page.locator("#chat-composer-error")).toContainText("at most 8 images");
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(8);

    // Removal drops exactly the removed attachment.
    await page.locator("#chat-attachments .chat-attachment", { hasText: "pasted.png" }).locator(".chat-attachment-remove").click();
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(7);
    await expect(page.locator("#chat-input")).toHaveValue("words that must survive");
  });

  test("drop stages images, non-image drops are refused, and the highlight resets", async ({ page }) => {
    await newConversation(page);

    await page.evaluate(async ({ bytes }) => {
      const form = document.querySelector<HTMLFormElement>("#chat-composer")!;
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "dropped.png", { type: "image/png" }));
      form.dispatchEvent(new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true }));
      form.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, { bytes: Array.from(PNG) });
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(1);
    await expect(page.locator("#chat-composer")).not.toHaveClass(/is-drop-target/);

    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>("#chat-composer")!;
      const transfer = new DataTransfer();
      transfer.items.add(new File(["not an image"], "notes.txt", { type: "text/plain" }));
      form.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await expect(page.locator("#chat-composer-error")).toContainText("Only PNG, JPEG, GIF, or WebP");
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(1);
  });

  test("attach affordances are absent without the capability and inactive for a blind model", async ({ page, request }) => {
    // Without the attachments capability the control is removed, not disabled.
    await control(request, { action: "declareOnly", capabilities: ["models"] });
    await page.reload();
    await openChatPanel(page);
    await newConversation(page);
    await expect(page.locator("#chat-attach")).toHaveCount(0);
    // Paste falls through to default behavior: nothing stages, no error.
    await pasteImage(page);
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(0);

    // With the capability but a model that cannot see images, the control is
    // visible but inactive and names the model; paste is refused the same way.
    // A reset rotates the workspace credential, so the page re-boots fully.
    await bootChat(page, request);
    await control(request, {
      action: "models",
      models: [{ selection: { providerId: "openai", modelId: "gpt-5" }, provider: "OpenAI", name: "GPT-5", contextLimit: 100000 }],
    });
    await control(request, { action: "nextConversationConfiguration", configuration: { model: { providerId: "openai", modelId: "gpt-5" } } });
    await newConversation(page);
    const attach = page.locator("#chat-attach");
    await expect(attach).toBeVisible();
    await expect(attach).toBeDisabled();
    await expect(attach).toHaveAttribute("aria-label", "GPT-5 cannot see images");
    await pasteImage(page);
    await expect(page.locator("#chat-composer-error")).toContainText("GPT-5 cannot see images");
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(0);
  });

  test("held messages keep their thumbnails and deliver with them when the turn ends", async ({ page, request }) => {
    const conversationId = await newConversation(page);

    await send(page, "Start the work");
    await expect(page.locator("#chat-send")).toHaveAttribute("aria-label", "Cancel response");

    await attachViaPicker(page, "follow-up.png");
    await send(page, "and look at this");
    const held = page.locator("#chat-queue .is-held");
    await expect(held).toHaveCount(1);
    await expect(held.locator(".chat-message-attachment-thumb")).toHaveCount(1);

    await control(request, { action: "status", conversationId, status: "completed" });
    await expect(page.locator("#chat-queue .is-held")).toHaveCount(0);
    const delivered = page.locator("#chat-items [data-chat-item-id]").last();
    await expect(delivered).toContainText("and look at this");
    await expect(delivered.locator(".chat-message-attachment-thumb")).toHaveCount(1);
  });

  test("stored attachments require the workspace credential to serve", async ({ page, request }) => {
    await newConversation(page);
    await attachViaPicker(page);
    await send(page, "guarded image");
    const src = await page.locator("#chat-items .chat-message-attachment-thumb").first().getAttribute("src");
    expect(src).toBeTruthy();

    const authorized = await request.get(`${src}?t=${encodeURIComponent(token)}`);
    expect(authorized.status()).toBe(200);
    expect((await authorized.body()).byteLength).toBe(PNG.byteLength);
    const anonymous = await request.get(src!);
    expect(anonymous.status()).toBe(401);
  });
});
