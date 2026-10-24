import type { Page, APIRequestContext } from "@playwright/test";
import { test as base, expect } from "./fixtures";
import { withEngineBrowsers } from "./page-diagnostics";
import { openChatPanel } from "./chat-helpers";
import { expectWorkControlVisible, expectWorkLayoutReady, expectWorkTranscriptBudget } from "./work-panel-assertions";
const test = withEngineBrowsers(base);

async function boot(page: Page, request: APIRequestContext) {
  await request.post("/__e2e/reset");
  await request.post("/__e2e/chat", { data: { action: "agents", stack: "opencode-v2", backgroundPreview: true } });
  const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  if (await page.locator("html").getAttribute("data-ui-mode") === "touch") await page.locator("#touch-tab-chat").click();
  else await openChatPanel(page);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
  await page.locator("#chat-input").fill("Start fixture work");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-stop")).toBeEnabled();
}

for (const engine of ["chromium", "webkit"] as const) test.describe(`critique refinements ${engine}`, () => {
  test.use({ page: async ({ launchBrowser, baseURL }, use) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
    await page.addInitScript(() => {
      const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    });
    await use(page); await page.close();
  } });

  test("discovery retires only after an accepted hold, not cancellation, refusal or tap", async ({ page, request }) => {
    await boot(page, request);
    const input = page.locator("#chat-input"), send = page.locator("#chat-send"), hint = page.locator("#chat-queue-discovery");
    await expect(hint).toBeHidden();
    await input.fill("Discover queue"); await expect(hint).toBeVisible();
    await input.fill("/btw Explain"); await expect(hint).toBeHidden();
    await input.fill("Discover queue"); await expect(hint).toBeVisible();
    await send.focus(); await page.keyboard.down("Space"); await page.waitForTimeout(350); await page.keyboard.press("Escape"); await page.keyboard.up("Space");
    await expect(hint).toBeVisible(); await expect(page.locator(".chat-queued-message")).toHaveCount(0);
    await send.click(); await expect(page.locator(".chat-queued-message")).toHaveCount(1);
    await input.fill("Refused hold");
    await page.route("**/prompts", route => route.fulfill({ status: 400, json: { error: "Refused" } }));
    const refused = page.waitForResponse(r => r.url().endsWith("/prompts") && r.status() === 400);
    await send.focus(); await page.keyboard.down("Space"); await refused; await page.keyboard.up("Space");
    await expect(input).toHaveValue("Refused hold"); await expect(hint).toBeVisible();
    await page.unroute("**/prompts");
    await send.focus(); await page.keyboard.down("Space"); await expect(page.locator('.chat-queued-message[data-delivery="queue"]')).toHaveCount(1); await page.keyboard.up("Space");
    await input.fill("Already learned"); await expect(hint).toBeHidden();
    await page.reload(); await expect(input).toHaveValue("Already learned"); await expect(hint).toBeHidden();
  });

  test("expanded Pending retains focus and independent scrollers after the intact worker card", async ({ page, request }) => {
    await boot(page, request);
    const id = await page.locator("#chat-conversation-select").inputValue();
    await page.locator("#chat-input").fill("Pending message"); await page.locator("#chat-send").click();
    for (let i = 0; i < 8; i++) await request.post("/__e2e/chat", { data: { action: "opencode", op: "launchWorker", conversationId: id } });
    const workers = page.locator("#chat-compact-workers > summary"), pending = page.locator("[data-pending-toggle]");
    await expect(page.locator("#chat-compact-workers [data-worker-id]")).toHaveCount(8);
    await workers.click();
    const originalToggle = await pending.elementHandle();
    await pending.focus(); await page.keyboard.press("Enter"); await expect(pending).toBeFocused();
    expect(await pending.evaluate((node, original) => node === original, originalToggle)).toBe(true);
    await expect(pending).toHaveAttribute("aria-expanded", "true");
    for (const keyboard of [false, true]) {
      if (keyboard) await page.evaluate(() => { Object.assign(window.visualViewport!, { height: 380 }); window.visualViewport!.dispatchEvent(new Event("resize")); });
      await expectWorkLayoutReady(page);
      await expect.poll(() => page.locator("#chat-work-dock").evaluate(dock => {
        const card = dock.querySelector("#chat-compact-workers")!.getBoundingClientRect();
        const p = dock.querySelector(".chat-queue-header")!.getBoundingClientRect();
        return p.top >= card.bottom + 7 && getComputedStyle(dock).overflowY === "clip"
          && getComputedStyle(dock.querySelector("#chat-compact-workers-items")!).overflowY === "auto"
          && getComputedStyle(dock.querySelector(".chat-queue-content")!).overflowY === "auto";
      })).toBe(true);
      await expectWorkControlVisible(pending);
      await expectWorkControlVisible(workers);
      await expectWorkTranscriptBudget(page, keyboard ? 380 : 844);
    }
    // A second client can add an identical pending message without touching
    // this reader's keyboard focus. Its arrival adds the aria discriminator
    // to the first card, but must not replace that card or its live actions.
    const remove = page.locator("#chat-queue [data-queue-remove]").first();
    const originalRemove = await remove.elementHandle();
    const originalCard = await remove.locator("xpath=ancestor::article").elementHandle();
    const originalId = await remove.getAttribute("data-queue-remove");
    await remove.focus(); await expect(remove).toBeFocused();
    const panes = await page.locator("#chat-queue-content").elementHandle();
    const offsets = () => page.evaluate(() => ["chat-queue-content", "chat-compact-workers-items", "chat-timeline"].map(id => document.getElementById(id)!.scrollTop));
    const beforeRemote = await offsets();
    const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
    expect(await page.evaluate(async ({ id, token }) => {
      const response = await fetch(`/api/chat/conversations/${encodeURIComponent(id)}/prompts?t=${encodeURIComponent(token)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Pending message", delivery: "steer", requestId: crypto.randomUUID() }),
      });
      return response.status;
    }, { id, token })).toBe(202);
    await expect(page.locator("#chat-queue .chat-queued-message")).toHaveCount(2);
    await expect(remove).toHaveAttribute("aria-label", /pending message 1$/);
    await expect(remove).toBeFocused();
    expect(await remove.evaluate((node, previous) => node === previous, originalRemove)).toBe(true);
    expect(await remove.locator("xpath=ancestor::article").evaluate((node, previous) => node === previous, originalCard)).toBe(true);
    expect(await page.locator("#chat-queue-content").evaluate((node, previous) => node === previous, panes)).toBe(true);
    expect(await offsets()).toEqual(beforeRemote);
    await expect(workers.locator("..")).toHaveAttribute("open", "");
    await expect(pending).toHaveAttribute("aria-expanded", "true");
    const removed = page.waitForResponse(response => response.request().method() === "DELETE" && decodeURIComponent(new URL(response.url()).pathname).endsWith(`/queue/${originalId}`));
    await page.keyboard.press("Enter");
    expect((await removed).ok()).toBe(true);
    await expect(page.locator("#chat-queue .chat-queued-message")).toHaveCount(1);
    await expect(page.locator("#chat-queue [data-queue-remove]")).not.toHaveAttribute("data-queue-remove", originalId!);
  });

  test("enlarged question options never paint under the date pill", async ({ page, request }) => {
    await request.post("/__e2e/reset"); await request.post("/__e2e/chat", { data: { action: "agents", count: 2 } });
    await request.post("/__e2e/chat", { data: { action: "seed", agent: "claude", title: "Question", items: [{ id: "question:critique", type: "question", requestId: "critique", status: "pending", createdAt: Date.now(), questions: [{ header: "Approach", prompt: "Which approach should be used for the independent task?", multiple: false, allowFreeForm: true, options: [{ label: "Minimal change", description: "Preserve compact density and metadata" }, { label: "Broader audit", description: "Review long content safely" }] }] }] } });
    const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
    await page.goto(`/?t=${encodeURIComponent(token)}`); await page.locator("#touch-tab-chat").click();
    await page.addStyleTag({ content: "html { font-size:200% !important }" });
    const option = page.locator(".chat-question-option").first();
    await option.locator("input").focus();
    await expect(option).toBeInViewport();
    await option.evaluate(e => {
      const scroller = document.querySelector("#chat-timeline")!;
      scroller.scrollTop += e.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
    });
    expect(await option.evaluate(e => {
      const r = e.getBoundingClientRect(); const day = document.querySelector(".chat-day-separator time")!;
      const d = day.getBoundingClientRect();
      if (d.bottom <= r.top || d.top >= r.bottom || d.right <= r.left || d.left >= r.right) return true;
      const hit = document.elementFromPoint((Math.max(d.left, r.left) + Math.min(d.right, r.right)) / 2,
        (Math.max(d.top, r.top) + Math.min(d.bottom, r.bottom)) / 2);
      return !day.contains(hit);
    })).toBe(true);
    await page.keyboard.press("Space"); await expect(option.locator("input")).toBeChecked();
  });

  test("lost queue action names its safe originating excerpt and actual read lifecycle", async ({ page, request }) => {
    await boot(page, request);
    const id = await page.locator("#chat-conversation-select").inputValue();
    const origin = '<img src=x onerror="window.receiptXss=true"> original';
    await page.locator("#chat-input").fill(origin);
    await page.locator("#chat-send").focus(); await page.keyboard.down("Space");
    await expect(page.locator('.chat-queued-message[data-delivery="queue"]')).toHaveCount(1); await page.keyboard.up("Space");
    await page.locator("[data-pending-toggle]").click();
    const steer = page.locator("[data-queue-steer]");
    await expect(steer).toHaveCount(1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let checking!: () => void;
    const started = new Promise<void>(resolve => { checking = resolve; });
    await page.route(url => decodeURIComponent(url.pathname).endsWith(`/conversations/${id}`), async route => { checking(); await gate; await route.continue(); });
    let mutations = 0;
    await page.route("**/queue/*", route => { mutations++; return route.fulfill({ status: 409, json: { error: "Outcome unknown", code: "operation_outcome_unknown" } }); });
    try {
      await steer.click();
      await started;
      const notice = page.locator("#chat-action-feedback");
      await expect(notice).toContainText(`Queue → Steer “${origin}”`);
      await expect(notice).toContainText("Checking conversation status");
      release();
      await expect(notice).toContainText("Status checked; acceptance still unconfirmed");
      await expect(notice.locator("img, script, [onerror]")).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { receiptXss?: boolean }).receiptXss)).toBeUndefined();
      await page.locator("#chat-input").fill("Unrelated successful steer"); await page.locator("#chat-send").click();
      await expect(page.locator('.chat-queued-message[data-delivery="steer"]')).toHaveCount(1);
      await expect(notice).toContainText(origin);
      expect(mutations).toBe(1);
    } finally { release(); }
  });

  test("desktop uses the same bordered worker card and separate pending footer", async ({ launchBrowser, baseURL, request }) => {
    const browser = await launchBrowser(engine);
    const desktop = await browser.newPage({ baseURL, viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    try {
      await boot(desktop, request);
      await desktop.locator("#chat-input").fill("Pending desktop input"); await desktop.locator("#chat-send").click();
      const id = await desktop.locator("#chat-conversation-select").inputValue();
      for (let i = 0; i < 8; i++) await request.post("/__e2e/chat", { data: { action: "opencode", op: "launchWorker", conversationId: id } });
      await expect(desktop.locator("#chat-compact-workers-items li")).toHaveCount(8);
      await expect(desktop.locator("#chat-compact-workers")).toHaveAttribute("open");
      for (const scroll of [false, true]) {
        if (scroll) await desktop.locator("#chat-compact-workers-items").evaluate(e => { e.scrollTop = e.scrollHeight; });
        await expect.poll(() => desktop.locator("#chat-work-dock").evaluate(dock => {
          const r = dock.getBoundingClientRect();
          return ["#chat-compact-workers > summary", ".chat-queue-header"].every(selector => {
            const box = dock.querySelector(selector)!.getBoundingClientRect();
            return box.top >= r.top - 1 && box.bottom <= r.bottom + 1;
          }) && dock.querySelector("#chat-subagents, #chat-background-tasks") === null;
        })).toBe(true);
      }
    } finally { await desktop.close(); }
  });

  test("multiple contextual uncertainties stay readable without displacing the composer", async ({ page, request }) => {
    await boot(page, request);
    let prompts = 0;
    await page.route("**/prompts", async route => {
      prompts++;
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), automaticBackground: "unknown" } });
    });
    for (let index = 0; index < 5; index++) {
      await page.locator("#chat-input").fill(`Distinct uncertain follow-up ${index}`);
      await page.locator("#chat-send").click();
      await expect(page.locator("#chat-action-feedback")).toContainText(`Steer “Distinct uncertain follow-up ${index}”: Status checked`);
    }
    await page.locator("#chat-input").fill("Keep composing after uncertainty");
    const notices = page.locator("#chat-composer-notices");
    expect(await notices.evaluate(e => e.clientHeight)).toBeLessThanOrEqual(72);
    expect(await notices.evaluate(e => e.scrollHeight > e.clientHeight)).toBe(true);
    await expect(page.locator("#chat-input")).toBeInViewport();
    await expect(page.locator("#chat-stop")).toBeInViewport();
    await expect(page.locator("#chat-action-feedback")).toContainText("Distinct uncertain follow-up 0");
    expect(prompts).toBe(5);
  });
});
