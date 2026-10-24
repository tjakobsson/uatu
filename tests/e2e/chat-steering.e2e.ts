import type { APIRequestContext, Page } from "@playwright/test";

import { openChatPanel } from "./chat-helpers";
import { captureScreenshot, recordEvidence, saveEvidence } from "./evidence";
import { expect, test as base } from "./fixtures";
import { withEngineBrowsers } from "./page-diagnostics";
import { expectWorkLayoutReady, expectWorkTranscriptBudget } from "./work-panel-assertions";
import { enlargedPendingFixture } from "./enlarged-pending-fixture";

const test = withEngineBrowsers(base);

// Steering on OpenCode 2.x (opencode-v2-steering), end to end over the real
// ChatAdapter and OpenCodeV2Provider and the scripted fake OpenCode 2.0.28
// server (tests/e2e/opencode-v2-fake.ts). A turn advances only when the test
// says so: `step` is a step boundary, `finish` ends the turn.

type FakeState = { sessions: Record<string, { running: boolean; pending: Array<{ id: string; delivery: string; payload: { text: string } }> }>; unhandled: string[] };

async function control(request: APIRequestContext, body: Record<string, unknown>): Promise<unknown> {
  const response = await request.post("/__e2e/chat", { data: body });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function bootChat(page: Page, request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset");
  await control(request, { action: "agents", stack: "opencode-v2" });
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  if (await page.locator("html").getAttribute("data-ui-mode") === "touch") await page.locator("#touch-tab-chat").tap();
  else await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
}

async function fakeSession(request: APIRequestContext, conversationId: string): Promise<FakeState["sessions"][string] | undefined> {
  const state = await control(request, { action: "opencode", op: "state" }) as FakeState;
  return state.sessions[conversationId.replace(/^opencode:/, "")];
}

async function newConversation(page: Page): Promise<string> {
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.locator("#chat-state")).toContainText("Started new conversation with OpenCode");
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
  return page.locator("#chat-conversation-select").inputValue();
}

// Submit with a key and wait for the acceptance; the answer says how the
// workspace took it.
async function submit(page: Page, text: string, key: "Enter" | "Alt+Enter" = "Enter"): Promise<{ pending: boolean; delivery: string }> {
  const input = page.locator("#chat-input");
  await input.fill(text);
  // Enter accepts an autocomplete match before it submits the command.
  if (text.startsWith("/")) {
    await expect(page.locator("#chat-command-menu")).toBeVisible();
    await input.press("Enter");
  }
  const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
  await input.press(key === "Enter" && await page.locator("html").getAttribute("data-ui-mode") === "touch" ? "Control+Enter" : key);
  const response = await accepted;
  expect(response.ok()).toBe(true);
  await expect(input).toHaveValue("");
  return response.json();
}

// A running turn with one prompt in it.
async function startTurn(page: Page, request: APIRequestContext): Promise<string> {
  const conversationId = await newConversation(page);
  expect(await submit(page, "Start the work")).toMatchObject({ pending: false });
  await expect(page.locator("#chat-items")).toContainText("Start the work");
  await expect(page.locator("#chat-stop")).toBeEnabled();
  await expect.poll(async () => (await fakeSession(request, conversationId))?.running).toBe(true);
  return conversationId;
}

const dock = (page: Page) => page.locator("#chat-queue .chat-queued-message");
const steers = (page: Page) => page.locator("#chat-queue .chat-queued-message[data-delivery='steer']");
const held = (page: Page) => page.locator("#chat-queue .chat-queued-message[data-delivery='queue']");

async function inspectPending(page: Page): Promise<void> {
  const pending = page.locator("[data-pending-toggle]");
  await expect(pending).toBeVisible();
  if (await pending.getAttribute("aria-expanded") === "false") await pending.click();
  await expect(pending).toHaveAttribute("aria-expanded", "true");
}

test.describe("steering an OpenCode 2.x turn", () => {
  test.beforeEach(async ({ page, request }) => bootChat(page, request));

  test("duplicate text and image-only dock actions stay uniquely named after removal", async ({ page, request }, testInfo) => {
    await startTurn(page, request);
    await submit(page, "Identical pending", "Alt+Enter");
    await submit(page, "Identical pending", "Alt+Enter");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=", "base64");
    for (let index = 0; index < 2; index++) {
      const uploaded = page.waitForResponse(response => response.url().endsWith("/attachments") && response.request().method() === "POST");
      await page.locator("#chat-attach-input").setInputFiles({ name: "same-image.png", mimeType: "image/png", buffer: png });
      expect((await uploaded).status()).toBe(201);
      const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
      await page.locator("#chat-send").click();
      expect((await accepted).ok()).toBe(true);
    }
    await expect(dock(page)).toHaveCount(4);
    await inspectPending(page);
    const removes = page.locator("#chat-queue [data-queue-remove]");
    const labels = await removes.evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")));
    expect(new Set(labels).size).toBe(4);
    for (const label of labels) expect(label).toMatch(/, pending message \d+$/);
    const survivor = held(page).nth(1).locator("[data-queue-remove]");
    const survivorLabel = await survivor.getAttribute("aria-label");
    const removed = page.waitForResponse(response => response.url().includes("/queue/") && response.request().method() === "DELETE");
    await held(page).first().locator("[data-queue-remove]").click();
    expect((await removed).ok()).toBe(true);
    await expect(held(page)).toHaveCount(3);
    await expect(held(page).getByRole("button", { name: survivorLabel!, exact: true })).toHaveAttribute("aria-label", survivorLabel!);
    await saveEvidence(testInfo, "review-unique-pending-actions.json", JSON.stringify({ labelsBeforeRemoval: labels, retainedLabel: survivorLabel }, null, 2));
    await captureScreenshot(page, testInfo, "review-unique-pending-actions");
  });

  test("successful removals update the dock silently without replay on routine worker updates", async ({ page, request }) => {
    const conversationId = await startTurn(page, request);
    await submit(page, "Remove first", "Alt+Enter");
    await submit(page, "Remove second", "Alt+Enter");
    await expect(held(page)).toHaveCount(2);
    await inspectPending(page);
    await page.evaluate(() => {
      const live = document.querySelector("#chat-composer-status-live")!;
      const messages: string[] = [];
      (window as unknown as { removalAnnouncements: string[] }).removalAnnouncements = messages;
      new MutationObserver(() => { if (live.textContent === "Pending message removed") messages.push(live.textContent); }).observe(live, { childList: true, subtree: true, characterData: true });
    });
    let deletes = 0;
    page.on("request", request => { if (request.method() === "DELETE" && request.url().includes("/queue/")) deletes++; });
    for (const text of ["Remove first", "Remove second"]) {
      const removed = page.waitForResponse(response => response.url().includes("/queue/") && response.request().method() === "DELETE");
      await held(page).filter({ hasText: text }).locator("[data-queue-remove]").click();
      expect((await removed).ok()).toBe(true);
    }
    await expect(held(page)).toHaveCount(0);
    const announcements = () => page.evaluate(() => (window as unknown as { removalAnnouncements: string[] }).removalAnnouncements);
    expect(await announcements()).toEqual([]);
    expect(deletes).toBe(2);
    await control(request, { action: "opencode", op: "launchWorker", conversationId });
    await expect(page.locator("#chat-compact-workers")).toContainText("Inspect safe fixture");
    expect(await announcements()).toEqual([]);
    expect(deletes).toBe(2);
  });

  for (const mode of ["desktop", "touch"] as const) for (const theme of ["light", "dark"] as const) test(`audited dock targets, sticky counts and overflow on ${mode} ${theme}`, async ({ page, request }, testInfo) => {
    await startTurn(page, request);
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: mode === "touch" ? 390 : 1600, height: 1000 });
    await page.evaluate(({ mode, theme }) => {
      document.documentElement.dataset.uiMode = mode;
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.activeTab = "chat";
    }, { mode, theme });
    // Five short entries can now fit completely in the expanded capacity.
    // Fill the supported inbox to keep this a real overflow/fade regression.
    for (let index = 1; index <= 20; index++) await submit(page, `Audit pending ${index}: preserve this longer message for a readable dock`, index > 2 ? "Alt+Enter" : "Enter");
    await inspectPending(page);
    const queue = page.locator("#chat-queue");
    const scroller = page.locator("#chat-queue-content");
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await expect(queue.locator(".chat-queue-header")).toContainText("2 steers · 18 queued");
    await expect(dock(page)).toHaveCount(20);
    await expect(queue).toHaveClass(/has-more-below/);
    const metrics = await scroller.evaluate(element => ({ height: element.clientHeight, viewport: innerHeight }));
    expect(metrics.height).toBeGreaterThan(135);
    await expectWorkTranscriptBudget(page, metrics.viewport);
    await saveEvidence(testInfo, `audit-dock-${mode}-${theme}-metrics.json`, JSON.stringify(await scroller.evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      header: element.parentElement!.querySelector(".chat-queue-header")?.textContent,
      actions: Array.from(element.querySelectorAll<HTMLButtonElement>(".chat-queued-message button")).map(button => {
        const rect = button.getBoundingClientRect();
        return { text: button.textContent, label: button.getAttribute("aria-label"), width: rect.width, height: rect.height };
      }),
    })), null, 2));
    for (const button of await queue.locator(".chat-queued-message button").all()) {
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(32);
      expect(box.width).toBeGreaterThanOrEqual(32);
      expect(await button.getAttribute("aria-label")).toContain("“Audit pending");
    }
    await captureScreenshot(page, testInfo, `audit-dock-${mode}-${theme}`);
    await expect(page.locator("#chat-delivery-toggle, #chat-delivery-menu")).toHaveCount(0);
    await captureScreenshot(page, testInfo, `audit-composer-${mode}-${theme}`);
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(queue).not.toHaveClass(/has-more-below/);
    await expect(queue.locator(".chat-queue-header")).toBeInViewport();
  });

  for (const key of ["Enter", "Alt+Enter"] as const) {
    test(`cancellation blocks ${key} without losing the draft or leaking a delivery override`, async ({ page, request }) => {
      await startTurn(page, request);
      // Retain a paused steer after Stop so the next submission still has a
      // delivery choice, making a leaked Alt override observable on the wire.
      await submit(page, "Pending before cancellation");
      let releaseCancel!: () => void;
      let enteredCancel!: () => void;
      const gate = new Promise<void>(resolve => { releaseCancel = resolve; });
      const entered = new Promise<void>(resolve => { enteredCancel = resolve; });
      await page.route("**/cancel", async route => {
        enteredCancel();
        await gate;
        await route.continue();
      });
      const prompts: unknown[] = [];
      page.on("request", request => {
        if (request.url().endsWith("/prompts")) prompts.push(request.postDataJSON());
      });
      const input = page.locator("#chat-input");
      await input.fill("Keep this draft until cancellation settles");
      const cancelled = page.waitForResponse(response => response.url().endsWith("/cancel"));
      try {
        await page.locator("#chat-stop").click();
        await entered;
        await expect(page.locator("#chat-send")).toBeDisabled();
        await input.press(key);
        await expect(input).toHaveValue("Keep this draft until cancellation settles");
        expect(prompts).toEqual([]);
      } finally {
        releaseCancel();
      }
      expect((await cancelled).ok()).toBe(true);
      await expect(page.locator("#chat-send")).toBeEnabled();
      await expect(page.locator("#chat-stop")).toBeDisabled();
      const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
      await input.press("Enter");
      expect(await (await accepted).json()).toMatchObject({ pending: true, delivery: "steer" });
      expect(prompts).toEqual([expect.objectContaining({ text: "Keep this draft until cancellation settles", delivery: "steer" })]);
      await expect(input).toHaveValue("");
    });
  }

  test("composer explains fixed shortcuts despite legacy delivery with readable Send contrast", async ({ page, request }, testInfo) => {
    await newConversation(page);
    await expect(page.locator("#chat-delivery-toggle")).toHaveCount(0);
    await submit(page, "Start the work");
    await expect(page.locator("#chat-stop")).toBeEnabled();
    await page.locator("#chat-input").fill("Keep preference draft");
    await page.evaluate(() => localStorage.setItem("uatu:presentation:v1:%2F:chat-delivery", "queue"));
    await page.locator("#chat-input").fill("Keep preference draft updated");
    await expect(page.locator("#chat-send")).toHaveAttribute("aria-label", "Send as steer; hold 2.5 seconds to queue");
    await expect(page.locator("#chat-send-help")).toContainText("Enter: Steer; Alt+Enter: Queue");
    await expect(page.locator("#chat-send")).toHaveAttribute("aria-describedby", "chat-send-help");
    await page.emulateMedia({ colorScheme: "dark" });
    const contrast = await page.locator("#chat-send").evaluate(element => {
      const colors = getComputedStyle(element);
      const luminance = (color: string) => {
        const rgb = color.match(/\d+/g)!.slice(0, 3).map(Number).map(value => { const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; });
        return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
      };
      return (luminance(colors.color) + 0.05) / (luminance(colors.backgroundColor) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await saveEvidence(testInfo, "audit-enabled-send-dark-contrast.json", JSON.stringify({ contrast }, null, 2));
    await captureScreenshot(page, testInfo, "audit-composer-enabled-dark");
  });

  test("keyboard Queue submits while only Stop cancels", async ({ page, request }, testInfo) => {
    const conversationId = await newConversation(page);
    const send = page.locator("#chat-send");
    const stop = page.getByRole("button", { name: "Stop response", exact: true });
    await expect(stop).toBeDisabled();
    await submit(page, "Start the work");
    await expect(stop).toBeEnabled();
    await expect(send).toBeVisible();
    await expect(send).toBeDisabled();
    const input = page.locator("#chat-input");
    const mutations: string[] = [];
    page.on("request", request => {
      if (/\/(prompts|cancel)$/.test(request.url())) mutations.push(request.url());
    });
    await input.fill("Later, please");
    await expect(input).toHaveValue("Later, please");
    await expect(input).toBeFocused();
    expect(mutations).toEqual([]);
    await captureScreenshot(page, testInfo, "steering-separated-actions-desktop");
    const queued = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await input.press("Alt+Enter");
    expect(await (await queued).json()).toMatchObject({ pending: true, delivery: "queue" });
    await expect(held(page)).toContainText("Later, please");
    expect((await fakeSession(request, conversationId))?.running).toBe(true);
    expect(mutations.filter(url => url.endsWith("/cancel"))).toEqual([]);
    await input.fill("Keep my unsent draft");
    const cancelled = page.waitForResponse(response => response.url().endsWith("/cancel"));
    await stop.click();
    expect((await cancelled).ok()).toBe(true);
    await expect(stop).toBeDisabled();
    await expect(input).toHaveValue("Keep my unsent draft");
    await expect(send).toBeEnabled();
    await expect(held(page)).toHaveAttribute("data-paused");
  });

  test("Space hold is keyboard-accessible, Escape cancels, Enter remains quick Send", async ({ page, request }, testInfo) => {
    await startTurn(page, request);
    const send = page.locator("#chat-send");
    await page.locator("#chat-input").fill("Keyboard held draft");
    await send.focus();
    await page.clock.install();
    await page.keyboard.down("Space");
    await page.clock.runFor(350);
    await captureScreenshot(page, testInfo, "steering-keyboard-hold");
    await page.keyboard.press("Escape");
    await page.keyboard.up("Space");
    await page.clock.runFor(2100);
    await expect(dock(page)).toHaveCount(0);
    await expect(send).toBeFocused();
    await expect(page.locator("#chat-input")).toHaveValue("Keyboard held draft");
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await send.press("Enter");
    expect(await (await accepted).json()).toMatchObject({ delivery: "steer" });
  });

  test("Enter steers by default: the steer waits in the dock and joins the timeline only at the step boundary", async ({ page, request }, testInfo) => {
    const conversationId = await startTurn(page, request);
    await expect(page.locator("#chat-delivery-toggle")).toHaveCount(0);
    expect(await submit(page, "Use the other approach")).toMatchObject({ pending: true, delivery: "steer" });
    const steer = steers(page).filter({ hasText: "Use the other approach" });
    await expect(steer).toHaveCount(1);
    await expect(steer.locator(".chat-queued-badge")).toHaveText("Steer");
    await expect(page.locator("#chat-queue-note")).toContainText("model and mode");
    await expect(page.locator("#chat-items")).not.toContainText("Use the other approach");
    await expect.poll(async () => (await fakeSession(request, conversationId))?.pending.map(entry => entry.delivery)).toEqual(["steer"]);
    await captureScreenshot(page, testInfo, "steering-pending-steer");

    await control(request, { action: "opencode", op: "step", conversationId });
    await expect(page.locator("#chat-items")).toContainText("Use the other approach");
    await expect(steer).toHaveCount(0);
    await expect(page.locator("#chat-queue-note")).toBeHidden();
    await control(request, { action: "opencode", op: "finish", conversationId, text: "Steered answer" });
    await expect(page.locator("#chat-items")).toContainText("Steered answer");
    const order = await page.locator("#chat-items").innerText();
    expect(order.indexOf("Start the work")).toBeLessThan(order.indexOf("Use the other approach"));
    expect(order.indexOf("Use the other approach")).toBeLessThan(order.indexOf("Steered answer"));
  });

  test("Option+Enter uses the other delivery: the message is held, labelled Queue, and never reaches the inbox", async ({ page, request }) => {
    const conversationId = await startTurn(page, request);
    expect(await submit(page, "Afterwards, write tests", "Alt+Enter")).toMatchObject({ pending: true, delivery: "queue" });
    const entry = held(page).filter({ hasText: "Afterwards, write tests" });
    await expect(entry).toHaveCount(1);
    await expect(entry).toHaveClass(/is-held/);
    await expect(entry.locator(".chat-queued-badge")).toHaveText("Queue");
    await expect(page.locator("#chat-queue-note")).toBeHidden();
    expect((await fakeSession(request, conversationId))?.pending).toEqual([]);
    // Released when the turn ends: it starts its own turn.
    await control(request, { action: "opencode", op: "finish", conversationId, text: "First answer" });
    await expect(page.locator("#chat-items")).toContainText("Afterwards, write tests");
    await expect(dock(page)).toHaveCount(0);
  });

  test("a queued message switches to steer and a steer back to queue, keeping its place", async ({ page, request }, testInfo) => {
    const conversationId = await startTurn(page, request);
    expect(await submit(page, "Held first", "Alt+Enter")).toMatchObject({ delivery: "queue" });
    expect(await submit(page, "Steer me")).toMatchObject({ delivery: "steer" });
    expect(await submit(page, "Held later", "Alt+Enter")).toMatchObject({ delivery: "queue" });
    // Steers list first.
    await expect(dock(page)).toHaveText([/Steer me/, /Held first/, /Held later/]);
    await inspectPending(page);
    await captureScreenshot(page, testInfo, "steering-dock-mixed");

    // Queued → steer: the message leaves the workspace's queue for the inbox.
    const switched = page.waitForResponse(response => response.url().includes("/queue/") && response.request().method() === "PATCH");
    await held(page).filter({ hasText: "Held later" }).locator("[data-queue-steer]").click();
    expect((await switched).status()).toBe(200);
    await expect(steers(page)).toHaveText([/Steer me/, /Held later/]);
    await expect.poll(async () => (await fakeSession(request, conversationId))?.pending.map(entry => entry.payload.text)).toEqual(["Steer me", "Held later"]);

    // Steer → queue: withdrawn from the inbox once OpenCode confirms, and
    // held again at its submission-order position, before "Held later".
    const back = page.waitForResponse(response => response.url().includes("/queue/") && response.request().method() === "PATCH");
    await steers(page).filter({ hasText: "Steer me" }).locator("[data-queue-queue]").click();
    expect((await back).status()).toBe(200);
    await expect(dock(page)).toHaveText([/Held later/, /Held first/, /Steer me/]);
    await expect(held(page).filter({ hasText: "Steer me" })).toHaveCount(1);
    await expect.poll(async () => (await fakeSession(request, conversationId))?.pending.map(entry => entry.payload.text)).toEqual(["Held later"]);
  });

  test("lost native withdrawal response permits only manual cancellation of the original inbox ID", async ({ page, request }) => {
    const conversationId = await startTurn(page, request);
    await submit(page, "Keep original withdrawal text");
    await inspectPending(page);
    const entry = steers(page).filter({ hasText: "Keep original withdrawal text" });
    const id = await entry.getAttribute("data-chat-queued-id");
    const input = page.locator("#chat-input");
    await input.fill("Newer private draft");
    const mutations: Array<{ method: string; path: string }> = [];
    page.on("request", request => {
      if (request.url().includes("/queue/") && request.method() !== "GET") mutations.push({ method: request.method(), path: new URL(request.url()).pathname });
    });
    // Lose the browser request without a response. The server's fresh read
    // still shows the native entry; it does not authorize editing/replay.
    await page.route("**/queue/*", async route => {
      if (route.request().method() === "DELETE" && mutations.length === 1) await route.abort("failed");
      else await route.continue();
    });
    await entry.locator("[data-queue-edit]").click();
    await expect(page.locator("#chat-action-feedback")).toContainText("Status checked; withdrawal still unconfirmed");
    await expect(entry.locator("[data-queue-remove]")).toHaveText("Retry withdrawal");
    await expect(entry.locator("[data-queue-edit], [data-queue-queue]")).toHaveCount(0);
    await expect(input).toHaveValue("Newer private draft");
    expect(mutations).toHaveLength(1);
    expect((await fakeSession(request, conversationId))?.pending.map(entry => entry.id)).toContain(id);
    const retry = page.waitForResponse(response => response.url().includes("/queue/") && response.request().method() === "DELETE");
    await entry.locator("[data-queue-remove]").click();
    expect((await retry).ok()).toBe(true);
    await expect(entry).toHaveCount(0);
    expect(mutations).toEqual([{ method: "DELETE", path: expect.stringContaining(encodeURIComponent(id!)) }, { method: "DELETE", path: mutations[0]!.path }]);
    await expect(input).toHaveValue("Newer private draft");
    expect((await fakeSession(request, conversationId))?.pending).toEqual([]);
  });

  test("server-applied conversion with a lost browser response does not resurrect the native withdrawal target", async ({ page, request }) => {
    const conversationId = await startTurn(page, request);
    await submit(page, "Convert once despite lost response");
    await inspectPending(page);
    const entry = steers(page).filter({ hasText: "Convert once despite lost response" });
    const originalId = await entry.getAttribute("data-chat-queued-id");
    await page.locator("#chat-input").fill("Private newer draft");
    let patches = 0;
    await page.route("**/queue/*", async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      patches++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    });
    const lostResponse = page.waitForEvent("requestfailed", request => request.method() === "PATCH" && request.url().includes("/queue/"));
    await entry.locator("[data-queue-queue]").click();
    await lostResponse;
    const converted = held(page).filter({ hasText: "Convert once despite lost response" });
    await expect(converted).toHaveCount(1);
    await expect(converted.locator("[data-queue-remove]")).toHaveText("Remove");
    await expect(page.locator(`[data-chat-queued-id="${originalId}"]`)).toHaveCount(0);
    await expect(page.locator("#chat-action-feedback")).not.toContainText("withdrawal still unconfirmed");
    await expect(page.locator("#chat-input")).toHaveValue("Private newer draft");
    expect(patches).toBe(1);
    expect((await fakeSession(request, conversationId))?.pending).toEqual([]);
  });

  test("a steer can be removed, or edited back into the composer, once OpenCode confirms the withdrawal", async ({ page, request }) => {
    const conversationId = await startTurn(page, request);
    expect(await submit(page, "Remove me")).toMatchObject({ delivery: "steer" });
    expect(await submit(page, "Edit me instead")).toMatchObject({ delivery: "steer" });
    await expect(steers(page)).toHaveCount(2);
    await inspectPending(page);

    const removal = page.waitForResponse(response => response.url().includes("/queue/") && response.request().method() === "DELETE");
    await steers(page).filter({ hasText: "Remove me" }).locator("[data-queue-remove]").click();
    expect((await removal).status()).toBe(200);
    await expect(steers(page)).toHaveCount(1);
    await expect(page.locator("#chat-items")).not.toContainText("Remove me");

    const withdrawal = page.waitForResponse(response => response.url().includes("/queue/") && response.request().method() === "DELETE");
    await steers(page).filter({ hasText: "Edit me instead" }).locator("[data-queue-edit]").click();
    expect((await withdrawal).status()).toBe(200);
    await expect(steers(page)).toHaveCount(0);
    await expect(page.locator("#chat-input")).toHaveValue("Edit me instead");
    expect((await fakeSession(request, conversationId))?.pending).toEqual([]);
    await control(request, { action: "opencode", op: "finish", conversationId, text: "Done" });
    await expect(page.locator("#chat-items")).not.toContainText("Remove me");
    await expect(page.locator("#chat-items")).not.toContainText("Edit me instead");
  });

  for (const action of ["queue", "edit", "remove"] as const) {
    test(`a steer delivered before ${action} shows the too-late notice, preserves the draft, and appears once`, async ({ page, request }, testInfo) => {
      const conversationId = await startTurn(page, request);
      expect(await submit(page, "Too late to change")).toMatchObject({ delivery: "steer" });
      const steer = steers(page).filter({ hasText: "Too late to change" });
      await expect(steer).toHaveCount(1);
      await inspectPending(page);
      const inboxId = await steer.getAttribute("data-chat-queued-id");
      await page.locator("#chat-input").fill("My private draft");
      // OpenCode delivers the entry as the cancel arrives, and confirms no cancel.
      await control(request, { action: "opencode", op: "raceDeliverOnCancel", inboxId });
      const attempt = page.waitForResponse(response => response.url().includes("/queue/") && response.request().method() === (action === "queue" ? "PATCH" : "DELETE"));
      await steer.locator(`[data-queue-${action}]`).click();
      expect((await attempt).status()).toBe(409);
      await expect(page.locator("#chat-composer-error")).toBeVisible();
      await expect(page.locator("#chat-composer-error")).toContainText("Too late — already delivered");
      await expect(page.locator("#chat-composer-error")).toHaveClass(/is-notice/);
      await expect(page.locator("#chat-state")).not.toHaveClass(/is-error/);
      await expect(page.locator("#chat-state")).not.toContainText("Too late — already delivered");
      await expect(dock(page)).toHaveCount(0);
      await expect(page.locator("#chat-input")).toHaveValue("My private draft");
      await expect(page.locator("#chat-items").getByText("Too late to change", { exact: true })).toHaveCount(1);
      await captureScreenshot(page, testInfo, `steering-too-late-${action}`);
      await control(request, { action: "opencode", op: "finish", conversationId, text: "Done" });
      await expect(page.locator("#chat-items").getByText("Too late to change", { exact: true })).toHaveCount(1);
      expect((await control(request, { action: "opencode", op: "state" }) as FakeState).unhandled).toEqual([]);
    });
  }

  test("cancel leaves steers with OpenCode, paused; Send now wakes them together", async ({ page, request }, testInfo) => {
    const conversationId = await startTurn(page, request);
    expect(await submit(page, "First steer")).toMatchObject({ delivery: "steer" });
    expect(await submit(page, "Second steer")).toMatchObject({ delivery: "steer" });
    expect(await submit(page, "Held behind", "Alt+Enter")).toMatchObject({ delivery: "queue" });
    await expect(dock(page)).toHaveCount(3);

    const cancel = page.waitForResponse(response => response.url().endsWith("/cancel"));
    await page.locator("#chat-stop").click();
    expect((await cancel).status()).toBe(200);
    await expect(page.locator("#chat-composer-status")).toHaveAttribute("aria-label", "Cancelled");
    await expect.poll(async () => (await fakeSession(request, conversationId))?.running).toBe(false);
    // Nothing was delivered, and every entry reads paused.
    expect((await fakeSession(request, conversationId))?.pending.map(entry => entry.payload.text)).toEqual(["First steer", "Second steer"]);
    await expect(page.locator("#chat-queue .chat-queued-message[data-paused]")).toHaveCount(3);
    await expect(steers(page).first().locator(".chat-queued-paused")).toHaveText("Paused");
    const wake = page.locator(".chat-queue-batch [data-queue-send-now]");
    await expect(wake).toHaveText("Send 2 paused steers now");
    await captureScreenshot(page, testInfo, "steering-paused-after-cancel");

    const sent = page.waitForResponse(response => response.url().endsWith("/send-now"));
    await wake.click();
    expect((await sent).status()).toBe(200);
    // OpenCode resumed and delivered both steers, oldest first; the held
    // message stays, dormant.
    await expect(page.locator("#chat-items")).toContainText("First steer");
    await expect(page.locator("#chat-items")).toContainText("Second steer");
    await expect(steers(page)).toHaveCount(0);
    await expect(held(page)).toHaveCount(1);
    const order = await page.locator("#chat-items").innerText();
    expect(order.indexOf("First steer")).toBeLessThan(order.indexOf("Second steer"));
    await control(request, { action: "opencode", op: "finish", conversationId, text: "Resumed answer" });
    await expect(page.locator("#chat-items")).toContainText("Resumed answer");
    await expect(held(page)).toHaveCount(1);
  });

  test("queued Send now explains and confirms waking paused steers", async ({ page, request }) => {
    const conversationId = await startTurn(page, request);
    await submit(page, "Paused first");
    await submit(page, "Send selected queue", "Alt+Enter");
    await submit(page, "Leave held", "Alt+Enter");
    const cancelled = page.waitForResponse(response => response.url().endsWith("/cancel"));
    await page.locator("#chat-stop").click();
    expect((await cancelled).ok()).toBe(true);
    await inspectPending(page);
    const action = held(page).filter({ hasText: "Send selected queue" }).locator("[data-queue-send-now]");
    await expect(action).toHaveText("Send now + paused steers");
    await action.click();
    const confirmation = page.getByRole("dialog", { name: "Send queued message now?" });
    await expect(confirmation).toContainText("also sends all 1 paused steer");
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dock(page)).toHaveCount(3);
    const sent = page.waitForResponse(response => response.url().endsWith("/send-now"));
    await action.click();
    await confirmation.getByRole("button", { name: "Send now", exact: true }).click();
    expect((await sent).ok()).toBe(true);
    await expect(steers(page)).toHaveCount(0);
    await expect(held(page)).toHaveCount(1);
    await expect(held(page)).toContainText("Leave held");
    await expect(page.locator("#chat-items")).toContainText("Paused first");
    await expect(page.locator("#chat-items")).toContainText("Send selected queue");
    expect((await fakeSession(request, conversationId))?.running).toBe(true);
  });

  test("a new steer resumes paused steers", async ({ page, request }) => {
    const conversationId = await startTurn(page, request);
    expect(await submit(page, "Stranded")).toMatchObject({ delivery: "steer" });
    await page.locator("#chat-stop").click();
    await expect(page.locator("#chat-composer-status")).toHaveAttribute("aria-label", "Cancelled");
    await expect(steers(page).filter({ hasText: "Stranded" })).toHaveAttribute("data-paused", "");
    expect(await submit(page, "And this")).toMatchObject({ delivery: "steer" });
    await expect(page.locator("#chat-items")).toContainText("Stranded");
    await expect(page.locator("#chat-items")).toContainText("And this");
    await expect(steers(page)).toHaveCount(0);
    await expect.poll(async () => (await fakeSession(request, conversationId))?.running).toBe(true);
  });

  test("Undo counts pending steers and the replacement delivers them oldest first ahead of the held queue", async ({ page, request }, testInfo) => {
    const conversationId = await startTurn(page, request);
    await submit(page, "Keep this steer");
    await submit(page, "Keep this held", "Alt+Enter");
    await page.locator("#chat-input").fill("/undo");
    await expect(page.locator("#chat-command-menu")).toBeVisible();
    const undone = page.waitForResponse(response => response.url().endsWith("/undo"));
    // The explicit submit shortcut bypasses autocomplete, including a catalog
    // refresh that can reopen its menu after Escape.
    await page.locator("#chat-input").press("Control+Enter");
    expect((await undone).status()).toBe(200);
    await expect(page.locator("#chat-composer-status-live")).toContainText("1 pending steer");
    await expect(page.locator("#chat-composer-status-live")).toContainText("delivered together with your replacement");
    await expect(page.locator("#chat-input")).toHaveValue("Start the work");
    await expect(page.locator("#chat-queue .chat-queued-message[data-paused]")).toHaveCount(2);
    await captureScreenshot(page, testInfo, "steering-undo-confirmation");
    await expect(page.locator("#chat-queue-note")).toContainText("1 pending steer");
    await expect(page.locator("#chat-queue-note")).toContainText("delivered together with your replacement");

    expect(await submit(page, "Replacement work")).toMatchObject({ delivery: "steer" });
    await expect(steers(page)).toHaveCount(0);
    await expect(held(page)).toHaveText([/Keep this held/]);
    await expect(page.locator("#chat-items")).toContainText("Replacement work");
    const order = await page.locator("#chat-items").innerText();
    expect(order.indexOf("Keep this steer")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("Keep this steer")).toBeLessThan(order.indexOf("Replacement work"));
    await control(request, { action: "opencode", op: "finish", conversationId });
    await expect(page.locator("#chat-items")).toContainText("Answer 1");
    await expect(page.locator("#chat-items")).toContainText("Keep this held");
    await expect(held(page)).toHaveCount(0);
  });

  test("Revert reveals its replacement warning in an already-scrolled dock without stealing subsequent scroll", async ({ page, request }, testInfo) => {
    await startTurn(page, request);
    for (let index = 1; index <= 6; index++) await submit(page, `Pending steer ${index}`);
    await inspectPending(page);
    const queue = page.locator("#chat-queue-content");
    const note = page.locator("#chat-queue-note");
    await queue.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await queue.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await page.locator("#chat-items").getByRole("button", { name: "Revert message", exact: true }).click();
    await expect(note).toContainText("delivered together with your replacement");
    await captureScreenshot(page, testInfo, "steering-scrolled-revert-warning");
    await expect(note).toBeInViewport({ ratio: 1 });
    // Reading lower entries after the reveal is deliberate. A later queue
    // update must not drag the reader back to the still-active warning.
    await queue.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await steers(page).last().getByRole("button", { name: "Remove “Pending steer 6”", exact: true }).click();
    await expect(steers(page)).toHaveCount(5);
    await expect(note).not.toContainText("Pending steer 6");
    expect(await queue.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(note).not.toBeInViewport();
  });

  test("a command always queues, whatever the delivery, and offers no steer", async ({ page, request }) => {
    const conversationId = await startTurn(page, request);
    expect(await submit(page, "/reload")).toMatchObject({ pending: true, delivery: "queue" });
    const command = held(page).filter({ hasText: "/reload" });
    await expect(command).toHaveCount(1);
    await inspectPending(page);
    await expect(command.locator("[data-queue-steer]")).toHaveCount(0);
    await expect(command.locator("[data-queue-send-now]")).toHaveCount(0);
    await expect(command.locator("[data-queue-remove]")).toHaveCount(1);
    expect((await fakeSession(request, conversationId))?.pending).toEqual([]);
    await command.locator("[data-queue-remove]").click();
    await expect(dock(page)).toHaveCount(0);
  });

  test("a reload shows the same dock: steers first, then the queue, with their paused state", async ({ page, request }) => {
    await startTurn(page, request);
    expect(await submit(page, "Steer one")).toMatchObject({ delivery: "steer" });
    expect(await submit(page, "Held one", "Alt+Enter")).toMatchObject({ delivery: "queue" });
    await page.locator("#chat-stop").click();
    await expect(page.locator("#chat-composer-status")).toHaveAttribute("aria-label", "Cancelled");
    await expect(page.locator("#chat-queue .chat-queued-message[data-paused]")).toHaveCount(2);

    await page.reload();
    await openChatPanel(page);
    await expect(dock(page)).toHaveText([/Steer one/, /Held one/]);
    await expect(dock(page).nth(0)).toHaveAttribute("data-delivery", "steer");
    await expect(dock(page).nth(1)).toHaveAttribute("data-delivery", "queue");
    await expect(page.locator("#chat-queue .chat-queued-message[data-paused]")).toHaveCount(2);
    await inspectPending(page);
    await expect(page.locator("#chat-queue-note")).toBeVisible();
  });
});

for (const browserName of ["chromium", "webkit"] as const) test.describe(`steering on touch (${browserName})`, () => {
  test.use({ page: async ({ launchBrowser, baseURL }, use) => {
    const browser = await launchBrowser(browserName);
    const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await use(page);
    await browser.close();
  } });

  test("legacy Queue leaves touch Enter as newline and modified submission fixed", async ({ page, request }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem("uatu:presentation:v1:%2F:chat-delivery", "queue"));
    await bootChat(page, request);
    await newConversation(page);
    const input = page.locator("#chat-input");
    await input.fill("Idle newline");
    await input.press("Enter");
    await expect(input).toHaveValue("Idle newline\n");
    expect(await submit(page, "Start work")).toMatchObject({ pending: false });
    await expect(page.locator("#chat-stop")).toBeEnabled();
    const prompts: unknown[] = [];
    page.on("request", request => { if (request.url().endsWith("/prompts")) prompts.push(request.postDataJSON()); });
    await input.fill("Keep newline");
    await input.press("Enter");
    await expect(input).toHaveValue("Keep newline\n");
    expect(prompts).toHaveLength(0);
    await input.fill("/reload");
    await expect(page.locator("#chat-command-menu")).toBeVisible();
    await input.press("Enter");
    await expect(input).toHaveValue("/reload\n");
    expect(prompts).toHaveLength(0);
    for (const key of ["Control+Enter", "Meta+Enter", "Alt+Enter"]) {
      await input.fill(`Explicit ${key}`);
      const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
      await input.press(key);
      expect(await (await accepted).json()).toMatchObject({ pending: true, delivery: key === "Alt+Enter" ? "queue" : "steer" });
    }
    await page.reload();
    await page.locator("#touch-tab-chat").tap();
    await expect(page.locator("#chat-stop")).toBeEnabled();
    await input.fill("Reloaded touch steer");
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await input.press("Control+Enter");
    expect(await (await accepted).json()).toMatchObject({ pending: true, delivery: "steer" });
    expect(prompts).toHaveLength(4);
    await captureScreenshot(page, testInfo, `fixed-delivery-touch-${browserName}`);
  });

  test("large separated targets keep narrow layouts stable and edge taps never stop work", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await bootChat(page, request);
    const conversationId = await newConversation(page);
    const controls = ["#chat-send", "#chat-stop"];
    const boxes = async () => Promise.all(controls.map(async selector => {
      const box = await page.locator(selector).boundingBox();
      expect(box).not.toBeNull();
      return box!;
    }));
    const idle = await boxes();
    await page.locator("#chat-input").fill("Start narrow work");
    await page.locator("#chat-send").tap();
    await expect(page.locator("#chat-stop")).toBeEnabled();
    expect(await boxes()).toEqual(idle);
    const mutations: string[] = [];
    page.on("request", request => {
      if (/\/(prompts|cancel)$/.test(request.url())) mutations.push(request.url());
    });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 740 });
      await page.locator("#chat-input").fill("Unsent draft");
      const before = await boxes();
      for (const [index, box] of before.entries()) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        if (index > 0) {
          expect(box.x - (before[index - 1]!.x + before[index - 1]!.width)).toBeGreaterThanOrEqual(8);
          expect(box.y).toEqual(before[0]!.y);
        }
      }
      // The empty gap before Stop is not a hidden extension of its hit area.
      await page.touchscreen.tap(before[1]!.x - 4, before[1]!.y + 22);
      expect(await boxes()).toEqual(before);
      expect(mutations).toEqual([]);
      expect((await fakeSession(request, conversationId))?.running).toBe(true);
      expect(await page.locator("#chat-surface").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await captureScreenshot(page, testInfo, `steering-separated-${width}-${browserName}`);
    }
    // Hardware-keyboard navigation on touch retains the same safe semantics.
    await page.locator("#chat-send").focus();
    await expect(page.locator("#chat-send")).toHaveAttribute("aria-describedby", "chat-send-help");
    await expect(page.locator("#chat-input")).toHaveValue("Unsent draft");
    expect(mutations).toEqual([]);
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-send").tap();
    expect(await (await accepted).json()).toMatchObject({ pending: true, delivery: "steer" });
    await expect(page.locator("#chat-stop")).toBeEnabled();
    const stopped = page.waitForResponse(response => response.url().endsWith("/cancel"));
    await page.locator("#chat-stop").tap();
    expect((await stopped).ok()).toBe(true);
    await expect(page.locator("#chat-stop")).toBeDisabled();
    expect(mutations.filter(url => url.endsWith("/cancel"))).toHaveLength(1);
  });

  test("touch dock supports switch, edit, cancel, resume, and a visible Undo warning", async ({ page, request }, testInfo) => {
    await bootChat(page, request);
    const conversationId = await newConversation(page);
    const input = page.locator("#chat-input");
    await input.fill("Start touch work");
    await page.locator("#chat-send").tap();
    await captureScreenshot(page, testInfo, `steering-touch-start-${browserName}`);
    await expect(page.locator("#chat-stop")).toBeEnabled();
    const sendChoice = async (text: string, delivery: "steer" | "queue") => {
      await input.fill(text);
      const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
      if (delivery === "queue") {
        await input.press("Alt+Enter");
      } else await page.locator("#chat-send").tap();
      expect(await (await accepted).json()).toMatchObject({ pending: true, delivery });
      await expect(input).toHaveValue("");
    };
    await sendChoice("Touch steer", "steer");
    await page.locator("[data-pending-toggle]").tap();
    await steers(page).locator("[data-queue-queue]").tap();
    await captureScreenshot(page, testInfo, `steering-touch-switch-${browserName}`);
    await expect(held(page)).toHaveText([/Touch steer/]);
    await held(page).locator("[data-queue-steer]").tap();
    await expect(steers(page)).toHaveText([/Touch steer/]);
    await input.fill("Private draft");
    await steers(page).locator("[data-queue-edit]").tap();
    await expect(input).toHaveValue("Touch steer\nPrivate draft");
    await expect(input).toBeFocused();
    await expect(dock(page)).toHaveCount(0);
    await sendChoice("First touch steer", "steer");
    await sendChoice("Second touch steer", "steer");
    await sendChoice("Held touch work", "queue");
    await page.locator("#chat-stop").tap();
    await expect(page.locator("#chat-queue [data-paused]")).toHaveCount(3);
    await captureScreenshot(page, testInfo, `steering-touch-paused-${browserName}`);
    await page.getByRole("button", { name: "Send 2 paused steers now", exact: true }).tap();
    await expect(steers(page)).toHaveCount(0);
    await expect(held(page)).toHaveCount(1);
    await expect(page.locator("#chat-items")).toContainText("Second touch steer");
    await sendChoice("Keep this touch steer", "steer");
    await page.locator("#chat-items").getByRole("button", { name: "Revert message", exact: true }).last().tap();
    await expect(input).toHaveValue("Second touch steer");
    await expect(page.locator("#chat-queue-note")).toContainText("1 pending steer");
    await expect(page.locator("#chat-queue-note")).toContainText("delivered together with your replacement");
    await expect(page.locator("#chat-queue-note")).toBeInViewport();
    await captureScreenshot(page, testInfo, `steering-touch-undo-${browserName}`);
    // No clipped horizontal controls; the dock itself scrolls vertically.
    expect(await page.locator("#chat-surface").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await input.fill("Touch replacement");
    await page.locator("#chat-send").tap();
    await expect(page.locator("#chat-items")).toContainText("Touch replacement");
    await expect(held(page)).toHaveText([/Held touch work/]);
    // The echoed replacement is optimistic; finish only after the fake
    // provider has actually resumed its turn, not while admission is in flight.
    await expect.poll(async () => {
      const state = await control(request, { action: "opencode", op: "state" }) as { sessions: Record<string, { running: boolean }> };
      return state.sessions[conversationId.replace(/^opencode:/, "")]?.running;
    }).toBe(true);
    await control(request, { action: "opencode", op: "finish", conversationId });
    await expect(page.locator("#chat-items")).toContainText("Held touch work");
  });

  for (const theme of ["light", "dark"] as const) test(`pending overview is dense and omits zero counts (${theme})`, async ({ page, request }, info) => {
    await page.emulateMedia({ colorScheme: theme });
    await bootChat(page, request);
    await startTurn(page, request);
    await submit(page, "Add middle theme", "Alt+Enter");
    const header = page.locator(".chat-queue-header");
    await page.locator("[data-pending-toggle]").tap();
    const card = held(page).first();
    const dimensions = { header: await header.boundingBox(), card: await card.boundingBox() };
    await saveEvidence(info, `pending-${browserName}-${theme}-dimensions.json`, JSON.stringify(dimensions, null, 2));
    await captureScreenshot(page, info, `pending-${browserName}-${theme}-density`);
    expect(dimensions.header!.height).toBeCloseTo(28, 0);
    expect(dimensions.card!.height).toBeCloseTo(64, 0);
    await expect(header).toHaveText(/1 queued/);
    await expect(header).not.toContainText(/0 steers|1 pending/);
    const actions = await card.locator("button").all();
    for (let index = 0; index < actions.length; index++) {
      const rect = (await actions[index]!.boundingBox())!;
      expect(rect.height).toBeGreaterThanOrEqual(32);
      if (index > 0) { const previous = (await actions[index - 1]!.boundingBox())!; expect(rect.x - previous.x - previous.width).toBeGreaterThanOrEqual(8); }
    }
    // Readable content, one scroll owner and transcript budget survive keyboards.
    const scenes = [{ width: 390, height: 844, visual: 450 }, { width: 390, height: 844, visual: 380 }, { width: 844, height: 390, visual: 230 }];
    for (const scene of scenes) {
      await page.setViewportSize({ width: scene.width, height: scene.height });
      await page.locator("#chat-input").fill("Keep this draft");
      await page.locator("#chat-input").focus();
      await page.evaluate(scene => {
        const viewport = Object.assign(new EventTarget(), { height: scene.visual, width: scene.width, offsetTop: 0, offsetLeft: 0, scale: 1 });
        Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
        viewport.dispatchEvent(new Event("resize"));
        window.dispatchEvent(new Event("resize"));
      }, scene);
      await expect(page.locator("html")).toHaveAttribute(scene.width < 600 ? "data-chat-keyboard" : "data-chat-wide-short");
      await expectWorkTranscriptBudget(page, scene.visual);
      await expect(page.locator("#chat-input")).toBeFocused();
      await expect(page.locator("#chat-input")).toHaveValue("Keep this draft");
      await captureScreenshot(page, info, `pending-${browserName}-${theme}-${scene.width}-vv${scene.visual}`);
    }
  });

  for (const theme of ["light", "dark"] as const) for (const width of [390, 320]) test(`enlarged pending text has separate glyph lines and reachable image/actions (${theme} ${width})`, async ({ page, request }, info) => {
    const evidence = `pending-${browserName}-${theme}-${width}`;
    const before = await enlargedPendingFixture(page, request, width, theme);
    const glyphs = await held(page).locator(":scope > p").evaluateAll(paragraphs => paragraphs.map(paragraph => {
      const text = paragraph.firstChild!;
      const lines: Array<{ top: number; bottom: number; text: string }> = [];
      for (let index = 0; index < (text.textContent?.length ?? 0); index++) {
        const char = text.textContent![index]!;
        if (/\s/.test(char)) continue;
        const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + 1);
        const rect = range.getBoundingClientRect();
        const previous = lines.at(-1);
        if (previous && Math.abs(previous.top - rect.top) < 1) { previous.bottom = Math.max(previous.bottom, rect.bottom); previous.text += char; }
        else lines.push({ top: rect.top, bottom: rect.bottom, text: char });
      }
      const style = getComputedStyle(paragraph);
      return { font: style.fontSize, lineHeight: style.lineHeight, lines };
    }));
    await saveEvidence(info, `${evidence}-200pct-glyphs.json`, JSON.stringify({ beforeHeight: before, enlargedHeight: (await held(page).first().boundingBox())!.height, paragraphs: glyphs }, null, 2));
    await captureScreenshot(page, info, `${evidence}-200pct`);
    await page.locator("#chat-queue-content").evaluate(node => { node.scrollTop = 100; });
    await captureScreenshot(page, info, `${evidence}-200pct-scrolled-text`);
    expect(glyphs[0]!.lines.length).toBeGreaterThanOrEqual(4);
    for (const paragraph of glyphs) {
      expect(paragraph.font).toBe("28px");
      for (let index = 1; index < paragraph.lines.length; index++) expect(paragraph.lines[index]!.top).toBeGreaterThanOrEqual(paragraph.lines[index - 1]!.bottom);
    }
    expect((await held(page).first().boundingBox())!.height).toBeGreaterThan(before);
    await saveEvidence(info, `${evidence}-200pct-widths.json`, JSON.stringify(await page.locator("#chat-surface").evaluate(node => ({
      width: node.clientWidth, scrollWidth: node.scrollWidth,
      overflowing: [...node.querySelectorAll<HTMLElement>("*")].filter(element => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === "visible").map(element => ({
        tag: element.id || element.className || element.tagName, width: element.clientWidth, scrollWidth: element.scrollWidth,
      })),
    })), null, 2));
    expect(await page.locator("#chat-work-dock").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.locator("#chat-surface").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    // Load lazy thumbnails through real viewport entry before checking action
    // geometry; a decode during those checks can resize the card mid-scroll.
    for (const image of await held(page).locator("img").all()) {
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate(node => node.naturalWidth)).toBe(640);
    }
    for (const card of await held(page).all()) {
      expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      const buttons = await card.locator(".chat-queued-action").all();
      for (const [index, button] of buttons.entries()) {
        await button.scrollIntoViewIfNeeded();
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(32); expect(box.height).toBeGreaterThanOrEqual(32);
        if (index > 0) {
          const previous = (await buttons[index - 1]!.boundingBox())!;
          expect(box.y > previous.y + 1 ? box.y - previous.y - previous.height : box.x - previous.x - previous.width).toBeGreaterThanOrEqual(8);
        }
        expect(await button.evaluate(node => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
      }
    }
    await captureScreenshot(page, info, `${evidence}-200pct-image-actions`);
    // Enlarged cards grow inside Pending's independent content pane.
    const scroller = page.locator("#chat-queue-content");
    expect(await scroller.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await expectWorkTranscriptBudget(page, 844);
    await expect(page.locator("#chat-send, #chat-stop")).toHaveCount(2);
    await expect(held(page)).toHaveCount(3); // Inspecting and scrolling never mutates pending work.
    await expect(held(page).locator(".chat-message-attachments")).toHaveCount(2);
    await expect.poll(() => held(page).locator("img").evaluateAll(images => images.map(image => image.naturalWidth))).toEqual([640, 640]);
    await expect(held(page).last().locator(":scope > p")).toHaveCount(0); // Image-only case.
    // Replacement/batch safety remains readable and reachable at the same scale.
    await submit(page, "Pause this steer with the replacement");
    const reverted = page.waitForResponse(response => response.url().endsWith("/revert"));
    await page.locator("#chat-items").getByRole("button", { name: "Revert message", exact: true }).last().click();
    expect((await reverted).ok()).toBe(true);
    const warning = page.locator("#chat-queue-note");
    await expect(warning).toContainText("delivered together with your replacement");
    await saveEvidence(info, `${evidence}-200pct-replacement-budget.json`, JSON.stringify(await page.locator("#chat-surface").evaluate(node => ({
      surface: node.clientHeight, dock: document.querySelector("#chat-work-dock")!.getBoundingClientRect().height,
      warning: document.querySelector("#chat-queue-note")!.getBoundingClientRect().height,
      chrome: [...node.children].map(child => ({ id: child.id, height: child.getBoundingClientRect().height, display: getComputedStyle(child).display, position: getComputedStyle(child).position })),
    })), null, 2));
    await warning.scrollIntoViewIfNeeded();
    await saveEvidence(info, `${evidence}-200pct-warning-exposure.json`, JSON.stringify(await warning.evaluate(node => {
      const dock = node.closest(".chat-queue-content")!;
      return { warning: node.getBoundingClientRect().toJSON(), dock: dock.getBoundingClientRect().toJSON(), scroll: dock.scrollTop,
        work: node.closest(".chat-work-dock")!.getAttribute("style"),
        tracks: [...node.closest(".chat-work-dock")!.children].map(child => ({ id: child.id, box: child.getBoundingClientRect().toJSON(), style: child.getAttribute("style"), display: getComputedStyle(child).display, min: getComputedStyle(child).minHeight, max: getComputedStyle(child).maxHeight, margin: getComputedStyle(child).margin, padding: getComputedStyle(child).padding, basis: getComputedStyle(child).flexBasis })),
        heading: node.closest(".chat-queue")!.querySelector(".chat-queue-header")!.getBoundingClientRect().toJSON(),
        styles: [dock, node.parentElement!, node.closest(".chat-queue")!.querySelector(".chat-queue-header")!].map(e => ({ tag: e.id || e.className, display: getComputedStyle(e).display, position: getComputedStyle(e).position, container: getComputedStyle(e).container, padding: getComputedStyle(e).scrollPaddingTop })) };
    }), null, 2));
    await expect(warning).toBeInViewport({ ratio: 1 });
    // Reveal text below the sticky count/batch header, not merely within the
    // viewport bounds behind that header. This is a deliberate dock scroll.
    await warning.evaluate(node => {
      const dock = node.closest(".chat-queue-content")!;
      const header = node.closest(".chat-queue")!.querySelector(".chat-queue-header")!;
      dock.scrollTop += node.getBoundingClientRect().top - Math.max(dock.getBoundingClientRect().top, header.getBoundingClientRect().bottom) - 4;
    });
    expect(await warning.locator(".chat-queue-replacement").evaluate(node => {
      const range = document.createRange(); range.setStart(node.firstChild!, 0); range.setEnd(node.firstChild!, 1);
      const box = range.getBoundingClientRect();
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    // The fade is pointer-transparent, so glyph hit testing alone cannot
    // prove that the final model/delivery sentence is visibly unobscured.
    expect(await warning.evaluate(node => {
      const queue = node.closest<HTMLElement>(".chat-queue")!;
      const fadeHeight = queue.classList.contains("has-more-below") ? parseFloat(getComputedStyle(queue, "::after").height) || 0 : 0;
      const clearBottom = queue.getBoundingClientRect().bottom - fadeHeight;
      const range = document.createRange(); range.selectNodeContents(node);
      return [...range.getClientRects()].every(box => box.bottom + 4 <= clearBottom);
    })).toBe(true);
    await captureScreenshot(page, info, `${evidence}-200pct-warning-text`);
    const warningLines = await warning.locator(".chat-queue-replacement").evaluate(node => {
      const dock = node.closest(".chat-queue-content")!;
      const header = node.closest(".chat-queue")!.querySelector(".chat-queue-header")!;
      const range = document.createRange(); range.selectNodeContents(node);
      return [...range.getClientRects()].map((_, index) => {
        const before = range.getClientRects()[index]!;
        dock.scrollTop += before.top - Math.max(dock.getBoundingClientRect().top, header.getBoundingClientRect().bottom) - 4;
        const line = range.getClientRects()[index]!;
        return node.contains(document.elementFromPoint(line.x + line.width / 2, line.y + line.height / 2));
      });
    });
    expect(warningLines.length).toBeGreaterThan(1);
    expect(warningLines.every(Boolean)).toBe(true);
    const batch = page.getByRole("button", { name: "Send 1 paused steer now", exact: true });
    await batch.scrollIntoViewIfNeeded();
    expect((await batch.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await batch.evaluate(node => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
    // The documented 40% floor applies to standard text. Keep the enlarged
    // warning reachable too, and record its budget without inventing a new
    // enlarged-text floor or silently changing unrelated replacement chrome.
    const enlargedWarningHeight = (await page.locator("#chat-timeline").boundingBox())!.height;
    const previousLeading = await page.addStyleTag({ content: 'html[data-ui-mode="touch"] .chat-queued-message > p { line-height: 20px; }' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const previousWarningHeight = (await page.locator("#chat-timeline").boundingBox())!.height;
    await previousLeading.evaluate(node => node.remove());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(enlargedWarningHeight).toBeCloseTo(previousWarningHeight, 0);
    await saveEvidence(info, `${evidence}-200pct-warning-budget.json`, JSON.stringify({ visualHeight: 844, enlargedWarningHeight, previousWarningHeight }, null, 2));
    await captureScreenshot(page, info, `${evidence}-200pct-warning`);
    // Revert changes queued-entry labels to the longer paused-batch action.
    // Recheck the real post-replacement state, not only the earlier short labels.
    const replacementWidths = await scroller.evaluate(node => ({
      width: node.clientWidth, scrollWidth: node.scrollWidth,
      cards: [...node.querySelectorAll<HTMLElement>(".chat-queued-message")].map(card => ({
        width: card.clientWidth, scrollWidth: card.scrollWidth,
        footer: card.querySelector("footer")!.getBoundingClientRect().width,
        actions: [...card.querySelectorAll(".chat-queued-action")].map(action => ({ text: action.textContent, width: action.getBoundingClientRect().width })),
      })),
    }));
    await saveEvidence(info, `${evidence}-200pct-replacement-widths.json`, JSON.stringify(replacementWidths, null, 2));
    expect(replacementWidths.scrollWidth).toBeLessThanOrEqual(replacementWidths.width);
    for (const card of replacementWidths.cards) expect(card.scrollWidth).toBeLessThanOrEqual(card.width);
    expect(await scroller.evaluate(node => { node.scrollLeft = 1000; return node.scrollLeft; })).toBe(0);
    for (const [cardIndex, card] of (await held(page).all()).entries()) {
      const actions = await card.locator(".chat-queued-action").all();
      for (const [index, action] of actions.entries()) {
        await action.focus();
        await expect(action).toBeFocused();
        await action.scrollIntoViewIfNeeded();
        await action.evaluate(node => {
          const dock = node.closest(".chat-queue-content")!;
          const header = node.closest(".chat-queue")!.querySelector(".chat-queue-header")!;
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          const ring = Math.max(2, (parseFloat(style.outlineWidth) || 0) + (parseFloat(style.outlineOffset) || 0));
          const fade = dock.classList.contains("has-more-below") ? parseFloat(getComputedStyle(dock, "::after").height) || 0 : 0;
          const top = Math.max(dock.getBoundingClientRect().top, header.getBoundingClientRect().bottom) + ring;
          const bottom = dock.getBoundingClientRect().bottom - ring - fade;
          if (box.top < top) dock.scrollTop += box.top - top;
          else if (box.bottom > bottom) dock.scrollTop += box.bottom - bottom;
        });
        const visible = await action.evaluate(node => {
          const box = node.getBoundingClientRect();
          const ancestors = [];
          let left = Math.max(0, box.left), right = Math.min(innerWidth, box.right);
          let top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
          for (let parent = node.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
            ancestors.push({ tag: parent.id || parent.className || parent.tagName, top: rect.top, bottom: rect.bottom, height: parent.clientHeight, overflow: style.overflow });
            if (/hidden|clip|auto|scroll/.test(style.overflowX)) { left = Math.max(left, rect.left + parent.clientLeft); right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth); }
            if (/hidden|clip|auto|scroll/.test(style.overflowY)) { top = Math.max(top, rect.top + parent.clientTop); bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight); }
          }
          const centerX = box.left + box.width / 2, centerY = box.top + box.height / 2;
          const points = [[box.left + 2, centerY], [box.right - 2, centerY], [centerX, box.top + 2], [centerX, box.bottom - 2], [centerX, centerY]];
          return { width: box.width, height: box.height, visibleWidth: right - left, visibleHeight: bottom - top,
            occludedBy: points.map(([x, y]) => { const hit = document.elementFromPoint(x!, y!); return { x, y, hit: hit?.outerHTML.slice(0, 220), owned: node.contains(hit) }; }),
            top: box.top, bottom: box.bottom, ancestors,
            header: node.closest(".chat-work-dock")!.querySelector(".chat-queue-header")!.getBoundingClientRect().toJSON(),
            unoccluded: points.every(([x, y]) => node.contains(document.elementFromPoint(x!, y!))) };
        });
        await saveEvidence(info, `${evidence}-200pct-replacement-card-${cardIndex}-action-${index}.json`, JSON.stringify(visible, null, 2));
        expect(visible.width).toBeGreaterThanOrEqual(32); expect(visible.height).toBeGreaterThanOrEqual(32);
        expect(visible.visibleWidth).toBeCloseTo(visible.width, 0); expect(visible.visibleHeight).toBeCloseTo(visible.height, 0);
        expect(visible.unoccluded).toBe(true);
        if (index > 0) {
          const box = (await action.boundingBox())!, previous = (await actions[index - 1]!.boundingBox())!;
          expect(box.y > previous.y + 1 ? box.y - previous.y - previous.height : box.x - previous.x - previous.width).toBeGreaterThanOrEqual(8);
        }
        if (index === 0) await captureScreenshot(page, info, `${evidence}-200pct-replacement-card-${cardIndex}`);
      }
    }
    const sendNow = held(page).first().locator("[data-queue-send-now]");
    await expect(sendNow).toHaveText("Send now + paused steers");
    const mutations: string[] = [];
    page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/send-now")) mutations.push(request.url()); });
    const replacementDraft = await page.locator("#chat-input").inputValue();
    await sendNow.click();
    const confirmation = page.getByRole("dialog", { name: "Send queued message now?" });
    await expect(confirmation).toContainText("also sends all 1 paused steer");
    await expect(confirmation).toContainText("Other queued messages stay held");
    await captureScreenshot(page, info, `${evidence}-200pct-replacement-confirmation`);
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(mutations).toHaveLength(0);
    await expect(held(page)).toHaveCount(3);
    await expect(steers(page)).toHaveCount(1);
    await expect(page.locator("#chat-input")).toHaveValue(replacementDraft);
    await sendNow.click();
    const sent = page.waitForResponse(response => response.url().endsWith("/send-now"));
    await confirmation.getByRole("button", { name: "Send now", exact: true }).click();
    expect((await sent).ok()).toBe(true);
    expect(mutations).toHaveLength(1);
    await expect(steers(page)).toHaveCount(0);
    await expect(held(page)).toHaveCount(2);
    await expect(page.locator("#chat-items")).toContainText("Pause this steer with the replacement");
    await expect(page.locator("#chat-items")).toContainText("Readable first line");
  });

  for (const theme of ["light", "dark"] as const) for (const scene of [
    { width: 390, height: 844, visual: 844 }, { width: 390, height: 844, visual: 450 },
    { width: 390, height: 844, visual: 380 }, { width: 844, height: 390, visual: 230 },
  ]) test(`hold envelope appears after arming and stays fixed above Send (${theme} ${scene.width} vv${scene.visual})`, async ({ page, request }, info) => {
    await page.emulateMedia({ colorScheme: theme });
    await bootChat(page, request);
    await startTurn(page, request);
    const send = page.locator("#chat-send");
    await expect(send).toBeDisabled();
    await page.locator("#chat-input").fill("Later, please");
    await page.locator("#chat-input").focus();
    await page.setViewportSize({ width: scene.width, height: scene.height });
    await page.evaluate(scene => {
      const viewport = Object.assign(new EventTarget(), { height: scene.visual, width: scene.width, offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
      window.dispatchEvent(new Event("resize"));
    }, scene);
    await expect(send).toBeEnabled();
    // Wait for viewport ownership/layout before pinning the immutable target.
    await expectWorkLayoutReady(page);
    const original = (await send.boundingBox())!;
    const accepted: unknown[] = [];
    page.on("response", async response => { if (response.url().endsWith("/prompts")) accepted.push(await response.json()); });
    const touch = browserName === "chromium" ? await page.context().newCDPSession(page) : null;
    if (touch) await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: original.x + original.width / 2, y: original.y + original.height / 2 }] });
    else {
      await page.mouse.move(original.x + original.width / 2, original.y + original.height / 2);
      await page.mouse.down();
    }
    await page.evaluate(original => {
      const finger = document.createElement("span"); finger.id = "test-finger";
      finger.style.cssText = `position:fixed;pointer-events:none;z-index:126;left:${original.x - 7}px;top:${original.y + 8}px;width:58px;height:58px;border-radius:50%;background:#c6947f80;border:1px solid #be826a99`;
      document.body.append(finger);
    }, original);
    const frames = [];
    const start = performance.now();
    for (const ms of [200, 600, 1000, 1800]) {
      await page.waitForTimeout(Math.max(0, ms - (performance.now() - start)));
      frames.push(await page.locator(".chat-hold-upward").evaluate((node, original) => {
        const box = node.getBoundingClientRect();
        const cap = node.querySelector(".chat-hold-cap")!.getBoundingClientRect();
        const ancestors = [];
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
          ancestors.push({ tag: parent.id || parent.className || parent.tagName, overflow: style.overflow, z: style.zIndex,
            clips: /(hidden|clip|auto|scroll)/.test(style.overflowY) && (box.top < rect.top || box.bottom > rect.bottom) });
        }
        // Hit-test with only this pointer-transparent visual temporarily participating.
        node.style.pointerEvents = "auto";
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + 4);
        const unoccluded = hit === node || node.contains(hit);
        node.style.pointerEvents = "";
        return { hidden: (node as HTMLElement).hidden, progress: parseFloat((node as HTMLElement).style.getPropertyValue("--hold-progress")), top: box.top, bottom: box.bottom, height: box.height, capBottom: cap.bottom, text: node.textContent,
          extension: original.y - box.top, unoccluded, ancestors };
      }, original));
      const path = info.outputPath(`hold-${browserName}-${theme}-${scene.width}-vv${scene.visual}-${ms}ms.png`);
      await page.screenshot({ path });
      await recordEvidence(info, path);
    }
    await saveEvidence(info, `hold-${browserName}-${theme}-${scene.width}-vv${scene.visual}-frames.json`, JSON.stringify({ original, frames }, null, 2));
    expect(await send.boundingBox()).toEqual(original);
    expect(frames[0]!.hidden).toBe(true);
    expect(frames[1]!.extension).toBe(Math.min(104, original.y - 8));
    expect(frames[1]!.progress).toBeLessThan(frames[2]!.progress);
    expect(frames[2]!.progress).toBeLessThan(frames[3]!.progress);
    expect(accepted).toHaveLength(0);
    for (const frame of frames.slice(1)) {
      expect(frame.hidden).toBe(false);
      expect(frame.height).toBe(frames[1]!.height);
      expect(frame.capBottom).toBeLessThan(original.y);
      expect(frame.bottom).toBeCloseTo(original.y + original.height, 0);
      expect(frame.ancestors.filter(ancestor => ancestor.clips)).toEqual([]);
      expect(frame.unoccluded).toBe(true);
    }
    await expect.poll(() => accepted.length).toBe(1);
    expect(accepted[0]).toMatchObject({ pending: true, delivery: "queue" });
    if (touch) { await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await touch.detach(); }
    else await page.mouse.up();
    await page.locator("#test-finger").evaluate(node => node.remove());
    await page.waitForTimeout(100);
    expect(accepted).toHaveLength(1);
    await expect(held(page)).toHaveCount(1);
  });

  test("touch hold queues without menus and keeps the rails stable", async ({ page, request }, testInfo) => {
    await request.post("/__e2e/reset");
    await control(request, { action: "agents", stack: "opencode-v2" });
    const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
    await page.goto(`/?t=${encodeURIComponent(token.token)}`);
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await page.locator("#touch-tab-chat").click();
    await expect(page.locator("#chat-surface")).toBeVisible();
    const conversationId = await newConversation(page);
    const input = page.locator("#chat-input");
    await input.fill("Start the work");
    const started = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-send").tap();
    expect(await (await started).json()).toMatchObject({ pending: false });
    await expect(page.locator("#chat-stop")).toBeEnabled();
    await expect.poll(async () => (await fakeSession(request, conversationId))?.running).toBe(true);

    const rail = page.locator(".chat-composer-actions");
    const before = await rail.boundingBox();
    const sendBefore = await page.locator("#chat-send").boundingBox();
    await expect(page.locator("#chat-delivery-toggle, #chat-delivery-menu")).toHaveCount(0);
    await captureScreenshot(page, testInfo, `steering-touch-inline-${browserName}`);
    const after = await rail.boundingBox();
    const sendAfter = await page.locator("#chat-send").boundingBox();
    expect(after!.height).toBeCloseTo(before!.height, 0);
    expect(after!.y).toBeCloseTo(before!.y, 0);
    expect(sendAfter!.x).toBeCloseTo(sendBefore!.x, 0);
    expect(sendAfter!.width).toBeCloseTo(sendBefore!.width, 0);
    // Holding is the only touch Queue affordance, and does not move Send.
    await input.fill("Later, please");
    const queued = page.waitForResponse(response => response.url().endsWith("/prompts"));
    const box = (await page.locator("#chat-send").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    expect(await (await queued).json()).toMatchObject({ pending: true, delivery: "queue" });
    await page.mouse.up();
    await expect(held(page).filter({ hasText: "Later, please" })).toHaveCount(1);
    await input.fill("Also later");
    const again = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await input.press("Alt+Enter");
    expect(await (await again).json()).toMatchObject({ pending: true, delivery: "queue" });
    await expect(page.locator("#chat-send-help")).toContainText("Alt+Enter: Queue");
  });
});
