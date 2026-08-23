import type { APIRequestContext, Page } from "@playwright/test";

import { chooseChatModel, openChatPanel } from "./chat-helpers";
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
  const select = page.locator("#chat-conversation-select");
  // Waits for the value to CHANGE, not merely be non-empty: a second call
  // would otherwise read the previous conversation's id before the newly
  // created one lands in the select.
  const before = await select.inputValue().catch(() => "");
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(select).not.toHaveValue(before);
  return select.inputValue();
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

    // A mixed paste stages the image and refuses the rest out loud.
    await page.evaluate(async ({ bytes }) => {
      const input = document.querySelector<HTMLTextAreaElement>("#chat-input")!;
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "mixed-paste.png", { type: "image/png" }));
      transfer.items.add(new File(["words"], "clipboard.txt", { type: "text/plain" }));
      input.focus();
      input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, { bytes: Array.from(PNG) });
    await expect(page.locator("#chat-composer-error")).toContainText("clipboard.txt is not a supported image");
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(2);
    await expect(page.locator("#chat-input")).toHaveValue("words that must survive");

    // The per-message bound refuses the ninth image and keeps the eight.
    for (let index = 0; index < 6; index += 1) await attachViaPicker(page, `extra-${index}.png`);
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

    // A mixed drop stages the image and refuses the rest out loud — a file
    // that vanished silently would read as attached.
    await page.evaluate(async ({ bytes }) => {
      const form = document.querySelector<HTMLFormElement>("#chat-composer")!;
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "mixed.png", { type: "image/png" }));
      transfer.items.add(new File(["words"], "notes.txt", { type: "text/plain" }));
      form.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, { bytes: Array.from(PNG) });
    await expect(page.locator("#chat-composer-error")).toContainText("notes.txt is not a supported image");
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(2);
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

test.describe("chat image attachments — review regressions", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("a submit racing an in-flight upload waits and sends the image with that message", async ({ page }) => {
    await newConversation(page);
    // Stall the upload long enough for Enter to land while it is in flight.
    await page.route("**/attachments", async route => {
      await new Promise(resolve => setTimeout(resolve, 700));
      await route.continue();
    });
    await page.locator("#chat-attach-input").setInputFiles({ name: "racing.png", mimeType: "image/png", buffer: PNG });
    await page.locator("#chat-input").fill("message with a racing image");
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").press("Enter");
    const promptBody = (await accepted).request().postDataJSON() as { attachments?: unknown[] };
    // The prompt carried the attachment despite Enter beating the upload.
    expect(promptBody.attachments).toHaveLength(1);
    await expect(page.locator("#chat-items .chat-user-message .chat-message-attachment-thumb")).toHaveCount(1);
    // Nothing leaked into pending for a next message.
    await expect(page.locator("#chat-attachments")).toBeHidden();
    await page.unroute("**/attachments");
  });

  test("a retry with a changed attachment set mints a fresh request id", async ({ page, request }) => {
    await newConversation(page);
    await attachViaPicker(page);
    await control(request, { action: "failPrompt" });
    const failed = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").fill("same words twice");
    await page.locator("#chat-input").press("Enter");
    await failed;
    await expect(page.locator("#chat-composer-error")).toContainText("Draft restored");
    // The refused message's attachment came back to pending; remove it, so
    // the resubmission has the same text but a different attachment set.
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(1);
    await page.locator("#chat-attachments .chat-attachment-remove").click();
    const resubmitted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").press("Enter");
    await resubmitted;
    const stats = await control(request, { action: "stats" }) as { promptAttempts: string[] };
    // Two attempts, two distinct request ids: the changed set is a different
    // message, never a replay of the failed one's receipt.
    expect(stats.promptAttempts).toHaveLength(2);
    expect(new Set(stats.promptAttempts).size).toBe(2);
  });
});

test.describe("image-only messages", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("an attachment makes an empty draft sendable; removing it disables send again", async ({ page }) => {
    await newConversation(page);
    const send = page.locator("#chat-send");
    await expect(send).toBeDisabled();

    await attachViaPicker(page);
    await expect(send).toBeEnabled();

    // Removing the only attachment with no text returns to unsendable.
    await page.locator("#chat-attachments .chat-attachment-remove").click();
    await expect(send).toBeDisabled();

    await attachViaPicker(page, "solo.png");
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await send.click();
    const body = (await accepted).request().postDataJSON() as { text: string; attachments?: unknown[] };
    expect(body.text).toBe("");
    expect(body.attachments).toHaveLength(1);
    const message = page.locator("#chat-items .chat-user-message").last();
    await expect(message.locator(".chat-message-attachment-thumb")).toHaveCount(1);
    // No empty text block renders under the thumbnail.
    await expect(message.locator("div")).toHaveCount(1);
  });
});

test.describe("staging chain regressions", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("an upload started while submission drains still joins the message", async ({ page }) => {
    await newConversation(page);
    await page.route("**/attachments", async route => {
      await new Promise(resolve => setTimeout(resolve, 400));
      await route.continue();
    });
    // First upload in flight; Enter lands during it; a second attach starts
    // while submission is draining the chain. Both must ride this message.
    await page.locator("#chat-attach-input").setInputFiles({ name: "first.png", mimeType: "image/png", buffer: PNG });
    await page.locator("#chat-input").fill("both images please");
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").press("Enter");
    await page.locator("#chat-attach-input").setInputFiles({ name: "second.png", mimeType: "image/png", buffer: PNG });
    const body = (await accepted).request().postDataJSON() as { attachments?: Array<{ name: string }> };
    expect(body.attachments?.map(entry => entry.name).sort()).toEqual(["first.png", "second.png"]);
    await expect(page.locator("#chat-attachments")).toBeHidden();
    await page.unroute("**/attachments");
  });

  test("overlapping intakes near the bound keep eight and refuse the excess", async ({ page }) => {
    await newConversation(page);
    for (let index = 0; index < 7; index += 1) await attachViaPicker(page, `base-${index}.png`);
    // Two back-to-back pastes race for the last slot: staging is serialized,
    // so exactly one lands and the other is refused — never nine pending.
    await pasteImage(page, { name: "eighth.png" });
    await pasteImage(page, { name: "ninth.png" });
    await expect(page.locator("#chat-composer-error")).toContainText("at most 8 images");
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(8);
  });
});

test.describe("image-only staging wait", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("an image-only submit during its own upload waits and sends", async ({ page }) => {
    await newConversation(page);
    await page.route("**/attachments", async route => {
      await new Promise(resolve => setTimeout(resolve, 500));
      await route.continue();
    });
    await page.locator("#chat-attach-input").setInputFiles({ name: "only.png", mimeType: "image/png", buffer: PNG });
    // Send lights up on the in-flight staging, before the chip lands.
    await expect(page.locator("#chat-send")).toBeEnabled();
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-send").click();
    const body = (await accepted).request().postDataJSON() as { text: string; attachments?: unknown[] };
    expect(body.text).toBe("");
    expect(body.attachments).toHaveLength(1);
    await page.unroute("**/attachments");
  });
});

test.describe("restore stays within the cap", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("intake during a failing submit cannot overfill the restored draft", async ({ page, request }) => {
    await newConversation(page);
    for (let index = 0; index < 8; index += 1) await attachViaPicker(page, `full-${index}.png`);
    await control(request, { action: "failPrompt" });
    const failed = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").fill("send all eight");
    await page.locator("#chat-input").press("Enter");
    // The submitted batch is in flight (failPrompt stalls 500ms); a ninth
    // intake now must be refused against the reserved eight, so the failure
    // restore lands at exactly eight sendable references.
    await pasteImage(page, { name: "ninth-during-flight.png" });
    await expect(page.locator("#chat-composer-error")).toContainText("at most 8 images");
    await failed;
    await expect(page.locator("#chat-composer-error")).toContainText("Draft restored");
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(8);
  });
});

test.describe("attachment viewer", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("thumbnails open full size in place and dismiss on Escape or click", async ({ page }) => {
    await newConversation(page);
    await attachViaPicker(page);
    // Pending-strip thumbnail opens the local preview.
    await page.locator("#chat-attachments .chat-attachment-view").click();
    const viewer = page.locator("#chat-image-viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.locator("img")).toHaveAttribute("alt", "shot.png");
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();

    await send(page, "see attached");
    // Timeline thumbnail opens the served image; a click dismisses.
    await page.locator("#chat-items .chat-attachment-view").first().click();
    await expect(viewer).toBeVisible();
    await expect(viewer.locator("img")).toHaveAttribute("src", /\/api\/chat\/attachments\//);
    await expect.poll(() => viewer.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await viewer.click();
    await expect(viewer).toBeHidden();
    // Still in the conversation — no navigation happened.
    await expect(page.locator("#chat-items")).toContainText("see attached");
  });

  test("closing the viewer never leaves the log holding a focus ring", async ({ page }) => {
    await newConversation(page);
    await attachViaPicker(page);
    await send(page, "ring check");
    // Safari focuses the tapped tabindex="0" log, not the thumbnail button,
    // so the dialog's focus restoration returns to the container and paints
    // a ring around the whole conversation. Emulate that flow: the log holds
    // focus and the opening click is synthetic, moving none.
    await page.evaluate(() => {
      document.getElementById("chat-timeline")!.focus();
      document.querySelector<HTMLButtonElement>("#chat-items .chat-attachment-view")!.click();
    });
    await expect(page.locator("#chat-image-viewer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-image-viewer")).toBeHidden();
    // The close handler blurs the restored container focus.
    await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? "")).not.toBe("chat-timeline");
  });
});

test.describe("composer edits during the upload drain", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("typing while submission waits becomes the next draft, not part of the sent message", async ({ page }) => {
    await newConversation(page);
    await page.route("**/attachments", async route => {
      await new Promise(resolve => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.locator("#chat-attach-input").setInputFiles({ name: "slow.png", mimeType: "image/png", buffer: PNG });
    await page.locator("#chat-input").fill("the message that sends");
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").press("Enter");
    // The submit is draining the upload; the composer is already empty and
    // editable — this text belongs to the NEXT message.
    await page.locator("#chat-input").pressSequentially("draft for later");
    const body = (await accepted).request().postDataJSON() as { text: string };
    expect(body.text).toBe("the message that sends");
    await expect(page.locator("#chat-input")).toHaveValue("draft for later");
    await page.unroute("**/attachments");
  });
});

test.describe("conversation switch during the upload drain", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("the submitted text survives a switch, ahead of edits typed meanwhile", async ({ page }) => {
    const first = await newConversation(page);
    const second = await newConversation(page);
    await page.route("**/attachments", async route => {
      await new Promise(resolve => setTimeout(resolve, 700));
      await route.continue();
    });
    await page.locator("#chat-attach-input").setInputFiles({ name: "slow.png", mimeType: "image/png", buffer: PNG });
    await page.locator("#chat-input").fill("the submitted text");
    await page.locator("#chat-input").press("Enter");
    await page.locator("#chat-input").pressSequentially("newer edits");
    // Switch away before the drain completes: the switch stores the newer
    // edits as the conversation's draft, and the drained submission must
    // merge its never-sent text ahead of them rather than yielding to the
    // occupied slot.
    await page.locator("#chat-conversation-select").selectOption(first);
    await expect.poll(() => page.evaluate(() =>
      Object.keys(localStorage).some(key => key.includes("chat-presentation")
        && (localStorage.getItem(key) ?? "").includes("the submitted text\\nnewer edits")),
    )).toBe(true);
    await page.locator("#chat-conversation-select").selectOption(second);
    await expect(page.locator("#chat-input")).toHaveValue("the submitted text\nnewer edits");
    await page.unroute("**/attachments");
  });
});

test.describe("upload refusal during the drain", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("a text draft does not send when its in-flight upload is refused", async ({ page }) => {
    await newConversation(page);
    // The upload outlives Enter, then fails: the submit drained a chain
    // that lost a piece of this very message, so nothing may send.
    await page.route("**/attachments", async route => {
      await new Promise(resolve => setTimeout(resolve, 500));
      await route.fulfill({ status: 415, contentType: "application/json", body: JSON.stringify({ error: "attachments must be PNG, JPEG, GIF, or WebP images" }) });
    });
    await page.locator("#chat-attach-input").setInputFiles({ name: "doomed.png", mimeType: "image/png", buffer: PNG });
    let prompted = false;
    page.on("request", request => { if (request.url().endsWith("/prompts")) prompted = true; });
    await page.locator("#chat-input").fill("words that need their image");
    await page.locator("#chat-input").press("Enter");
    await expect(page.locator("#chat-composer-error")).toContainText("Could not attach");
    // The send stopped: the draft is intact and no prompt left the client.
    await expect(page.locator("#chat-input")).toHaveValue("words that need their image");
    await expect(page.locator("#chat-items .chat-user-message")).toHaveCount(0);
    expect(prompted).toBe(false);
    await page.unroute("**/attachments");
  });

  test("a mixed intake during the drain blocks the send like any refusal", async ({ page }) => {
    await newConversation(page);
    await page.route("**/attachments", async route => {
      await new Promise(resolve => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.locator("#chat-attach-input").setInputFiles({ name: "first.png", mimeType: "image/png", buffer: PNG });
    let prompted = false;
    page.on("request", request => { if (request.url().endsWith("/prompts")) prompted = true; });
    await page.locator("#chat-input").fill("needs every file");
    await page.locator("#chat-input").press("Enter");
    // A mixed drop while the submit drains: the image joins this message,
    // the text file is refused — a piece of the message went missing, so
    // nothing may send.
    await page.evaluate(async ({ bytes }) => {
      const form = document.querySelector<HTMLFormElement>("#chat-composer")!;
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "second.png", { type: "image/png" }));
      transfer.items.add(new File(["words"], "notes.txt", { type: "text/plain" }));
      form.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, { bytes: Array.from(PNG) });
    await expect(page.locator("#chat-composer-error")).toContainText("notes.txt is not a supported image");
    // Both staged images survive as pending, the draft is intact, no prompt.
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(2);
    await expect(page.locator("#chat-input")).toHaveValue("needs every file");
    expect(prompted).toBe(false);
    await page.unroute("**/attachments");
  });

  test("an all-unsupported drop during the drain blocks the send too", async ({ page }) => {
    await newConversation(page);
    await page.route("**/attachments", async route => {
      await new Promise(resolve => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.locator("#chat-attach-input").setInputFiles({ name: "first.png", mimeType: "image/png", buffer: PNG });
    let prompted = false;
    page.on("request", request => { if (request.url().endsWith("/prompts")) prompted = true; });
    await page.locator("#chat-input").fill("meant to carry the notes");
    await page.locator("#chat-input").press("Enter");
    // Nothing in this drop could stage, but it was meant for the message
    // being drained — the refusal must stop the send all the same.
    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>("#chat-composer")!;
      const transfer = new DataTransfer();
      transfer.items.add(new File(["not an image"], "notes.txt", { type: "text/plain" }));
      form.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await expect(page.locator("#chat-composer-error")).toContainText("Only PNG, JPEG, GIF, or WebP");
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(1);
    await expect(page.locator("#chat-input")).toHaveValue("meant to carry the notes");
    expect(prompted).toBe(false);
    await page.unroute("**/attachments");
  });
});

test.describe("draft restoration with mid-flight edits", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("a failing submission restores its text ahead of edits typed meanwhile", async ({ page, request }) => {
    await newConversation(page);
    await control(request, { action: "failPrompt" });
    const failed = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").fill("the failed message");
    await page.locator("#chat-input").press("Enter");
    // Typed while the refusal is in flight — the next draft, until the
    // failure makes the sent text a draft again too. Both survive.
    await page.locator("#chat-input").pressSequentially("meanwhile edits");
    await failed;
    await expect(page.locator("#chat-composer-error")).toContainText("Draft restored");
    await expect(page.locator("#chat-input")).toHaveValue("the failed message\nmeanwhile edits");
  });
});

test.describe("typeless intake defers to the byte sniff", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("a file with no MIME claim stages, and the stored type is the sniffed one", async ({ page }) => {
    await newConversation(page);
    // Browsers derive File.type from the filename; a local file with an
    // unknown extension claims nothing. The bytes are a real PNG, so the
    // upload route's sniff accepts it where a claim check would refuse.
    await pasteImage(page, { type: "", name: "untyped" });
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(1);
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").fill("sniffed, not claimed");
    await page.locator("#chat-input").press("Enter");
    const body = (await accepted).request().postDataJSON() as { attachments?: Array<{ mimeType: string }> };
    expect(body.attachments?.[0]?.mimeType).toBe("image/png");
  });
});

test.describe("upload refusals stay with their conversation", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("a refusal landing after a switch waits for its own conversation", async ({ page }) => {
    const first = await newConversation(page);
    const second = await newConversation(page);
    await page.route("**/attachments", async route => {
      await new Promise(resolve => setTimeout(resolve, 600));
      await route.fulfill({ status: 415, contentType: "application/json", body: JSON.stringify({ error: "attachments must be PNG, JPEG, GIF, or WebP images" }) });
    });
    await page.locator("#chat-attach-input").setInputFiles({ name: "doomed.png", mimeType: "image/png", buffer: PNG });
    // Switch away before the refusal lands: it must not flash here...
    await page.locator("#chat-conversation-select").selectOption(first);
    await page.waitForResponse(response => response.url().includes("/attachments"));
    await expect(page.locator("#chat-composer-error")).toBeHidden();
    // ...and the reason is waiting where the upload belonged.
    await page.locator("#chat-conversation-select").selectOption(second);
    await expect(page.locator("#chat-composer-error")).toContainText("Could not attach");
    await page.locator("#chat-conversation-select").selectOption(first);
    await expect(page.locator("#chat-composer-error")).toBeHidden();
    await page.unroute("**/attachments");
  });

  test("a prompt failure landing after a switch keeps its reason with its conversation", async ({ page, request }) => {
    const first = await newConversation(page);
    const second = await newConversation(page);
    await control(request, { action: "failPrompt" });
    const failed = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").fill("doomed message");
    await page.locator("#chat-input").press("Enter");
    // Switch away while the refusal is in flight: it must not flash here.
    await page.locator("#chat-conversation-select").selectOption(first);
    await failed;
    await expect(page.locator("#chat-composer-error")).toBeHidden();
    // The failed conversation holds both the restored draft and the reason.
    await page.locator("#chat-conversation-select").selectOption(second);
    await expect(page.locator("#chat-composer-error")).toContainText("Draft restored");
    await expect(page.locator("#chat-input")).toHaveValue("doomed message");
  });
});

test.describe("attachment name fallback", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("a whitespace-only filename falls back and the reference stays sendable", async ({ page }) => {
    await newConversation(page);
    // Legal on Unix, and constructible from the clipboard: a name the
    // prompt route would refuse as blank must never stage verbatim.
    await pasteImage(page, { name: " " });
    const chip = page.locator("#chat-attachments .chat-attachment");
    await expect(chip).toHaveCount(1);
    await expect(chip.first()).toContainText("image");
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").fill("named by fallback");
    await page.locator("#chat-input").press("Enter");
    const body = (await accepted).request().postDataJSON() as { attachments?: Array<{ name: string }> };
    expect(body.attachments?.[0]?.name).toBe("image");
  });
});

test.describe("model switch after staging", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("a blind model chosen after staging blocks the send and names the model", async ({ page }) => {
    await newConversation(page);
    await chooseChatModel(page, "Claude Sonnet");
    await page.locator("#chat-configuration-done").click();
    await attachViaPicker(page);
    await chooseChatModel(page, "GPT-5");
    await page.locator("#chat-configuration-done").click();
    await expect(page.locator("#chat-attach")).toBeDisabled();
    await page.locator("#chat-input").fill("send with a blind model");
    await page.locator("#chat-input").press("Enter");
    await expect(page.locator("#chat-composer-error")).toContainText("GPT-5 cannot see images");
    // Nothing left the composer: the image stays staged, the text stays put.
    await expect(page.locator("#chat-attachments .chat-attachment")).toHaveCount(1);
    await expect(page.locator("#chat-input")).toHaveValue("send with a blind model");
    // Back on a capable model the very same draft sends, image included.
    await chooseChatModel(page, "Claude Sonnet");
    await page.locator("#chat-configuration-done").click();
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").press("Enter");
    const body = (await accepted).request().postDataJSON() as { attachments?: unknown[] };
    expect(body.attachments).toHaveLength(1);
  });
});

test.describe("touch composer rail with attachments", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the attach control and a readable model name share the touch rail", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    const token = await request.get("/__e2e/terminal-token").then(r => r.json()) as { token: string };
    await page.goto(`/?t=${encodeURIComponent(token.token)}`);
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await page.locator("#touch-tab-chat").click();
    await expect(page.locator("#chat-surface")).toBeVisible();
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    await expect(page.locator("#chat-attach")).toBeVisible();
    // The regression squeezed the configuration trigger into a 2.25rem
    // column; a readable trigger occupies the rail's flexible track.
    const width = await page.locator("#chat-configuration-trigger").evaluate(element => element.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(120);
    // No horizontal overflow: send stays inside the viewport.
    const send = await page.locator("#chat-send").evaluate(element => element.getBoundingClientRect().right);
    expect(send).toBeLessThanOrEqual(390);
  });
});
