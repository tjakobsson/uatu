import type { APIRequestContext, Locator, Page, TestInfo } from "@playwright/test";
import { expect, test as base } from "./fixtures";
import { attachPageDiagnosticsOnFailure, withEngineBrowsers } from "./page-diagnostics";
import { evidencePath, recordEvidence, saveEvidence } from "./evidence";
import { openChatPanel } from "./chat-helpers";

const test = withEngineBrowsers(base);
attachPageDiagnosticsOnFailure(test);

async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const target = evidencePath(testInfo, `${name}.png`);
  await page.screenshot({ path: target, animations: "disabled", caret: "hide" });
  await recordEvidence(testInfo, target);
}

async function control(request: APIRequestContext, body: Record<string, unknown>) {
  const response = await request.post("/__e2e/chat", { data: { action: "opencode", ...body } });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function fakeViewport(page: Page) {
  await page.addInitScript(size => {
    const viewport = Object.assign(new EventTarget(), { height: size.height, width: size.width, offsetTop: 0, offsetLeft: 0, scale: 1, pageTop: 0 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  }, page.viewportSize()!);
}

async function visualHeight(page: Page, height: number) {
  await page.evaluate(height => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, "height", { configurable: true, value: height });
    Object.defineProperty(viewport, "width", { configurable: true, value: innerWidth });
    viewport.dispatchEvent(new Event("resize"));
  }, height);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect.poll(() => page.locator("#chat-surface").evaluate(element => parseFloat(element.style.getPropertyValue("--chat-visual-height"))))
    .toBeLessThanOrEqual(height);
}

async function safeAreas(page: Page, insets: { top: number; bottom: number; left: number; right: number }) {
  await page.route("**/*", async route => {
    if (!["stylesheet", "script", "document"].includes(route.request().resourceType())) return route.fallback();
    const response = await route.fetch();
    if (!/css|javascript|html/.test(response.headers()["content-type"] ?? "")) return route.fulfill({ response });
    const body = (await response.text()).replace(/env\(\s*safe-area-inset-(top|right|bottom|left)\s*(,[^()]*(\([^()]*\))?[^()]*)?\)/g, (_match, edge: keyof typeof insets) => `${insets[edge]}px`);
    await route.fulfill({ response, body });
  });
}

async function boot(page: Page, request: APIRequestContext) {
  await request.post("/__e2e/reset");
  await request.post("/__e2e/chat", { data: { action: "agents", stack: "opencode-v2", backgroundPreview: true } });
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  if (await page.locator("html").getAttribute("data-ui-mode") === "touch") await page.locator("#touch-tab-chat").tap();
  else await openChatPanel(page);
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
  return page.locator("#chat-conversation-select").inputValue();
}

async function submit(page: Page, text: string, delivery: "steer" | "queue" = "steer") {
  const touch = await page.locator("html").getAttribute("data-ui-mode") === "touch";
  const activate = async (selector: string) => touch ? page.locator(selector).tap() : page.locator(selector).click();
  await page.locator("#chat-input").fill(text);
  const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
  if (delivery === "queue") {
    await page.locator("#chat-input").press("Alt+Enter");
  } else await activate("#chat-send");
  expect((await accepted).ok()).toBe(true);
  await expect(page.locator("#chat-input")).toHaveValue("");
}

async function loaded(page: Page, request: APIRequestContext) {
  const id = await boot(page, request);
  for (let index = 1; index <= 3; index++) {
    await submit(page, `Question ${index}`);
    await control(request, { op: "finish", conversationId: id, text: `Answer ${index}. ${"Readable conversation content. ".repeat(12)}` });
    await expect(page.locator("#chat-items")).toContainText(`Answer ${index}.`);
  }
  await submit(page, "Start the work");
  await submit(page, "Steer one");
  await submit(page, "Steer two");
  await submit(page, "Queued work", "queue");
  await expect(page.locator(".chat-queued-message")).toHaveCount(3);
  await control(request, { op: "launchWorker", conversationId: id, background: false });
  await control(request, { op: "launchWorker", conversationId: id });
  await expect(page.locator("#chat-compact-workers-items [data-worker-item]")).toHaveCount(2);
  return id;
}

async function containedControls(page: Page, height: number) {
  await expect.poll(() => page.locator(".chat-header").evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
  const touch = await page.locator("html").getAttribute("data-ui-mode") === "touch";
  for (const id of [...(touch ? ["chat-configuration-trigger"] : []), "chat-send", "chat-stop"]) {
    const control = page.locator(`#${id}`);
    await expect(control).toBeVisible();
    await expect.poll(() => control.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(height);
    const box = (await control.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await control.evaluate(element => { const b = element.getBoundingClientRect(); const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return hit === element || element.contains(hit); })).toBe(true);
  }
  expect(await page.locator("#chat-surface").evaluate(element => element.scrollTop)).toBe(0);
}

async function workControlExposure(control: Locator) {
  return control.evaluate(node => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const ring = parseFloat(style.outlineWidth) + Math.max(0, parseFloat(style.outlineOffset));
    let top = 0, bottom = innerHeight, left = 0, right = innerWidth;
    const clips: unknown[] = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent);
      if (!/(auto|scroll|hidden|clip)/.test(`${css.overflowX} ${css.overflowY}`)) continue;
      const rect = parent.getBoundingClientRect();
      clips.push({ id: parent.id, className: parent.className, top: rect.top, bottom: rect.bottom, client: parent.clientHeight, scroll: parent.scrollTop });
      top = Math.max(top, rect.top + parent.clientTop); bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight);
      left = Math.max(left, rect.left + parent.clientLeft); right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth);
    }
    return { height: box.height, ring, focusVisible: node.matches(":focus-visible"), top: box.top - ring - top, bottom: bottom - box.bottom - ring, left: box.left - ring - left, right: right - box.right - ring, clips };
  });
}

for (const engine of ["chromium", "webkit"] as const) test.describe(`mobile layout ${engine}`, () => {
  for (const scene of [{ width: 390, height: 844, visual: 380 }, { width: 844, height: 390, visual: 230 }]) test(`uncertain feedback preserves draft width and inline picker ${scene.width}`, async ({ page, request }, testInfo) => {
    const id = await loaded(page, request);
    await page.route("**/prompts", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), automaticBackground: "unknown" } });
    });
    await submit(page, "Steer with uncertain background outcome");
    await page.unroute("**/prompts");
    await page.locator("#chat-input").fill("Keep this editable draft");
    await page.setViewportSize({ width: scene.width, height: scene.height });
    await page.locator("#chat-input").focus();
    await visualHeight(page, scene.visual);
    const warning = page.locator("#chat-action-feedback");
    await expect(warning).toContainText("could not be confirmed");
    await expect(warning).toBeVisible();
    expect((await page.locator("#chat-input").boundingBox())!.width).toBeGreaterThanOrEqual(140);
    await containedControls(page, scene.visual);
    expect(await page.locator("#chat-timeline").evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(scene.visual * 0.4);
    await page.locator("#chat-configuration-trigger").tap();
    await expect(page.locator("#chat-configuration-dialog")).toBeVisible();
    await expect(page.locator("#chat-attach")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-input")).toHaveValue("Keep this editable draft");
    await captureScreenshot(page, testInfo, `mobile-${engine}-unknown-${scene.width}`);
    await control(request, { op: "finish", conversationId: id });
    await expect(warning).toContainText("could not be confirmed");
  });

  test("compact disclosures retain deliberate state and leave safety outside the collapse", async ({ page, request }, testInfo) => {
    const id = await loaded(page, request);
    const pending = page.locator("[data-pending-toggle]");
    const workers = page.locator("#chat-compact-workers");
    await expect(pending).toHaveText("2 steers · 1 queued");
    await expect(pending).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#chat-queue-items")).toBeHidden();
    await expect(workers).not.toHaveAttribute("open");
    await expect(page.locator("#chat-compact-workers-label")).toHaveText("2 working");
    await pending.tap();
    await workers.locator(":scope > summary").tap();
    await expect(page.locator("#chat-queue-items")).toBeVisible();
    await expect(workers).toHaveAttribute("open");
    await page.getByRole("button", { name: "New conversation", exact: true }).tap();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue(id);
    await page.locator("#chat-conversation-select").selectOption(id);
    await expect(pending).toHaveAttribute("aria-expanded", "true");
    await expect(workers).toHaveAttribute("open");
    await pending.tap();
    await workers.locator(":scope > summary").tap();
    const reverted = page.waitForResponse(response => response.url().endsWith("/revert"));
    await page.locator("#chat-items").getByRole("button", { name: "Revert message", exact: true }).last().tap();
    expect((await reverted).ok()).toBe(true);
    await expect(page.locator("#chat-queue-items")).toBeHidden();
    await expect(page.locator("#chat-queue-note")).toContainText("delivered together with your replacement");
    await expect(page.getByRole("button", { name: "Send 2 paused steers now", exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, `mobile-${engine}-compact-disclosures`);
  });

  test("inline picker owns one layer, consumes outside taps and restores its real invoker", async ({ page, request }) => {
    await loaded(page, request);
    const options = page.locator("#chat-configuration-trigger");
    const menu = page.locator("#chat-configuration-dialog");
    await expect(page.locator("#chat-options-toggle, #chat-options-menu")).toHaveCount(0);
    await page.locator("#chat-input").fill("Keep this draft");
    await page.locator("#chat-input").focus();
    await options.tap();
    await expect(menu).toBeVisible();
    await expect(options).toHaveAttribute("aria-expanded", "true");
    const mutations: string[] = [];
    page.on("request", request => { if (request.method() === "POST" && /\/(prompts|cancel)$/.test(request.url())) mutations.push(request.url()); });
    // The picker is a bottom sheet, unlike the removed floating Options box.
    // Its real outside region is above the sheet, not over the covered Send.
    const sheet = (await page.locator(".chat-configuration-sheet").boundingBox())!;
    expect(sheet.y).toBeGreaterThan(8);
    await page.touchscreen.tap(8, 8);
    await expect(menu).toBeHidden();
    expect(mutations).toEqual([]);
    await expect(page.locator("#chat-input")).toHaveValue("Keep this draft");
    await options.tap();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-configuration-dialog")).toBeHidden();
    await expect(page.locator("#chat-input")).toBeFocused();
    // Touch preserves composing focus; keyboard activation owns the real pill.
    await options.focus();
    await options.press("Enter");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(options).toBeFocused();
  });

  for (const enlarged of [false, true]) test(`expanded compact dock and picker retain target and visual bounds${enlarged ? " with enlarged text" : ""}`, async ({ page, request }, testInfo) => {
    await loaded(page, request);
    await page.locator("#chat-input").blur();
    if (enlarged) await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.locator("[data-pending-toggle]").tap();
    await page.locator("#chat-compact-workers > summary").tap();
    await expect(page.locator("#chat-queue-items")).toBeVisible();
    const scale = enlarged ? 2 : 1;
    await expect(page.locator(".chat-worker-name").first()).toHaveCSS("font-size", `${14 * scale}px`);
    await expect(page.locator(".chat-worker-model").first()).toHaveCSS("font-size", `${11 * scale}px`);
    const dock = await page.locator("#chat-work-dock").boundingBox();
    const band = await page.locator("#chat-surface").evaluate(element => parseFloat(element.style.getPropertyValue("--chat-visual-height")));
    await saveEvidence(testInfo, `compact-${engine}-${enlarged ? "enlarged" : "standard"}-bounds.json`, JSON.stringify(await page.evaluate(() => Object.fromEntries(["chat-surface", "chat-composer", "chat-work-dock", "chat-configuration-trigger", "chat-send", "chat-stop"].map(id => {
      const node = document.getElementById(id)!;
      const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
      return [id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, maxHeight: style.maxHeight, minHeight: style.minHeight, available: style.getPropertyValue("--chat-work-available") }];
    }))), null, 2));
    await captureScreenshot(page, testInfo, `compact-${engine}-${enlarged ? "enlarged" : "standard"}-expanded`);
    expect(dock!.height).toBeLessThanOrEqual(band * 0.35 + 1);
    for (const id of ["chat-configuration-trigger", "chat-send", "chat-stop"]) {
      const target = page.locator(`#${id}`);
      const box = (await target.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
    }
    await page.locator("#chat-configuration-trigger").tap();
    const menu = (await page.locator("#chat-configuration-dialog").boundingBox())!;
    expect(menu.y).toBeGreaterThanOrEqual(0); expect(menu.y + menu.height).toBeLessThanOrEqual(844);
    expect(menu.x).toBeGreaterThanOrEqual(0); expect(menu.x + menu.width).toBeLessThanOrEqual(390);
    await page.locator("#chat-configuration-done").scrollIntoViewIfNeeded();
    const settings = (await page.locator("#chat-configuration-done").boundingBox())!;
    expect(settings.width).toBeGreaterThanOrEqual(44); expect(settings.height).toBeGreaterThanOrEqual(44);
    await captureScreenshot(page, testInfo, `compact-${engine}-${enlarged ? "enlarged" : "standard"}-picker`);
  });
  test.use({ page: async ({ launchBrowser, baseURL }, use) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await fakeViewport(page);
    await use(page);
    await browser.close();
  } });

  test("outside picker touch dismisses without activating Revert", async ({ page, request }, testInfo) => {
    await boot(page, request);
    await submit(page, "Start the work");
    await page.locator("#chat-input").fill("Private draft");
    const mutations: string[] = [];
    page.on("request", request => { if (request.method() === "POST" && /\/(revert|undo|prompts)$/.test(request.url())) mutations.push(new URL(request.url()).pathname); });
    await page.locator("#chat-configuration-trigger").tap();
    await expect(page.locator("#chat-configuration-dialog")).toBeVisible();
    const revert = (await page.locator("#chat-items").getByRole("button", { name: "Revert message", exact: true }).boundingBox())!;
    await page.touchscreen.tap(revert.x + revert.width / 2, revert.y + revert.height / 2);
    await expect(page.locator("#chat-configuration-dialog")).toBeHidden();
    expect(mutations).toEqual([]);
    await expect(page.locator("#chat-input")).toHaveValue("Private draft");
    await expect(page.locator("#chat-items")).toContainText("Start the work");
    await captureScreenshot(page, testInfo, `mobile-${engine}-outside-dismiss`);
  });

  for (const size of [{ width: 844, height: 390 }, { width: 667, height: 375 }]) test(`landscape hard limit ${size.width}x${size.height}`, async ({ page, request }, testInfo) => {
    await loaded(page, request);
    await page.locator("#chat-input").blur();
    await page.setViewportSize(size);
    await visualHeight(page, size.height);
    await containedControls(page, size.height);
    await captureScreenshot(page, testInfo, `mobile-${engine}-landscape-${size.width}`);
  });

  for (const height of [450, 380]) test(`portrait keyboard hard limit ${height}`, async ({ page, request }, testInfo) => {
    await loaded(page, request);
    await page.locator("#chat-input").focus();
    await visualHeight(page, height);
    await containedControls(page, height);
    await captureScreenshot(page, testInfo, `mobile-${engine}-keyboard-${height}`);
  });

  test("keyboard keeps paused batch counts and replacement warning readable", async ({ page, request }, testInfo) => {
    await loaded(page, request);
    const reverted = page.waitForResponse(response => response.url().endsWith("/revert"));
    await page.locator("#chat-items").getByRole("button", { name: "Revert message", exact: true }).last().tap();
    expect((await reverted).ok()).toBe(true);
    await expect(page.locator("#chat-queue-note")).toContainText("delivered together with your replacement");
    await visualHeight(page, 380);
    await expect(page.locator("#chat-queue")).toBeVisible();
    await expect(page.locator(".chat-queue-header")).toContainText("2 steers · 1 queued");
    const batch = page.getByRole("button", { name: "Send 2 paused steers now", exact: true });
    await expect(batch).toBeVisible();
    for (const selector of ["#chat-queue-note", ".chat-queue-header"]) {
      await expect.poll(() => page.locator(selector).evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
      await expect.poll(() => page.locator(selector).evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(380);
    }
    expect((await batch.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await captureScreenshot(page, testInfo, `mobile-${engine}-replacement-keyboard`);
  });

  test("editing a dock entry keeps pending counts visible while typing", async ({ page, request }, testInfo) => {
    await loaded(page, request);
    await page.locator("[data-pending-toggle]").tap();
    await page.locator('[data-delivery="queue"] [data-queue-edit]').tap();
    await expect(page.locator("#chat-input")).toHaveValue("Queued work");
    await expect(page.locator("#chat-input")).toBeFocused();
    await visualHeight(page, 380);
    await expect(page.locator("#chat-queue")).toBeVisible();
    await expect(page.locator(".chat-queue-header")).toContainText("2 steers");
    await containedControls(page, 380);
    await captureScreenshot(page, testInfo, `mobile-${engine}-edit-keyboard`);
  });

  for (const scene of [
    { width: 390, height: 844, visual: 380 },
    { width: 390, height: 844, visual: 450 },
    { width: 844, height: 390, visual: 390 },
    { width: 844, height: 390, visual: 230 },
    { width: 768, height: 1024, visual: 700 },
    { width: 1024, height: 768, visual: 500 },
  ]) for (const expanded of [false, true]) test(`conversation budget ${scene.width}x${scene.height} visual ${scene.visual}${expanded ? " expanded" : " collapsed"}`, async ({ page, request }, testInfo) => {
    await safeAreas(page, scene.width === 390 ? { top: 47, bottom: 34, left: 0, right: 0 } : scene.width === 844 ? { top: 0, bottom: 21, left: 47, right: 47 } : { top: 24, bottom: 20, left: 0, right: 0 });
    await loaded(page, request);
    if (expanded) {
      await page.locator("#chat-input").blur();
      await page.locator("[data-pending-toggle]").tap();
      await page.locator("#chat-compact-workers > summary").tap();
    }
    await page.setViewportSize({ width: scene.width, height: scene.height });
    if (scene.visual < scene.height) await page.locator("#chat-input").focus();
    else await page.locator("#chat-input").blur();
    await visualHeight(page, scene.visual);
    await containedControls(page, scene.visual);
    await expect(page.locator("[data-pending-toggle]")).toHaveAttribute("aria-expanded", String(expanded));
    if (expanded) await expect(page.locator("#chat-compact-workers")).toHaveAttribute("open");
    else await expect(page.locator("#chat-compact-workers")).not.toHaveAttribute("open");
    await saveEvidence(testInfo, `budget-${engine}-${scene.width}-${scene.visual}-${expanded}.json`, JSON.stringify(await page.evaluate(() => Object.fromEntries(["chat-surface", "chat-composer", "chat-work-dock", "chat-compact-workers", "chat-queue", "chat-timeline"].map(id => {
      const node = document.getElementById(id)!; const box = node.getBoundingClientRect();
      return [id, { top: box.top, height: box.height, bottom: box.bottom, maxHeight: getComputedStyle(node).maxHeight }];
    }))), null, 2));
    await expect.poll(() => page.locator("#chat-timeline").evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(scene.visual * (scene.width === 390 || scene.width === 844 ? 0.4 : 0.35));
    const metrics = await page.locator("#chat-surface").evaluate(element => ({ surface: element.clientHeight, scrollTop: element.scrollTop, dock: document.querySelector("#chat-work-dock")!.getBoundingClientRect().height, overlay: getComputedStyle(document.querySelector("#chat-work-dock")!).position === "absolute", timeline: document.querySelector("#chat-timeline")!.getBoundingClientRect().height }));
    const hardwareEditing = await page.locator("html").evaluate(node => node.hasAttribute("data-chat-editing") && !node.hasAttribute("data-chat-keyboard"));
    const cap = hardwareEditing ? 0.24 : scene.width >= 768 ? 0.25 : 0.35;
    if (metrics.overlay) {
      // Explicit worker expansion uses the transcript as a sheet, not extra
      // in-flow chrome. Primary composer targets remain checked above.
      const dock = (await page.locator("#chat-work-dock").boundingBox())!;
      const composer = (await page.locator("#chat-composer").boundingBox())!;
      expect(dock.y).toBeGreaterThanOrEqual(0);
      expect(dock.y + dock.height).toBeLessThanOrEqual(composer.y + 1);
      const workerHeader = (await page.locator("#chat-compact-workers > summary").boundingBox())!;
      expect(workerHeader.height).toBeGreaterThanOrEqual(28);
      expect(workerHeader.y).toBeGreaterThanOrEqual(scene.width === 390 ? 47 : scene.width === 844 ? 0 : 24);
    } else expect(metrics.dock).toBeLessThanOrEqual(scene.visual * cap + 1);
    await saveEvidence(testInfo, `mobile-${engine}-${scene.width}-${scene.visual}.json`, JSON.stringify(metrics, null, 2));
    await page.locator("#chat-configuration-trigger").tap();
    {
      const options = (await page.locator("#chat-configuration-dialog").boundingBox())!;
      expect(options.y).toBeGreaterThanOrEqual(0);
      expect(options.y + options.height).toBeLessThanOrEqual(scene.visual);
      expect(options.x).toBeGreaterThanOrEqual(0);
      expect(options.x + options.width).toBeLessThanOrEqual(scene.width);
      await captureScreenshot(page, testInfo, `mobile-${engine}-${scene.width}-${scene.visual}-picker`);
    }
    await page.keyboard.press("Escape");
  });

  test("landscape keyboard shares space with the replacement warning and paused batch", async ({ page, request }, testInfo) => {
    await safeAreas(page, { top: 0, bottom: 21, left: 47, right: 47 });
    await loaded(page, request);
    const reverted = page.waitForResponse(response => response.url().endsWith("/revert"));
    await page.locator("#chat-items").getByRole("button", { name: "Revert message", exact: true }).last().tap();
    expect((await reverted).ok()).toBe(true);
    await page.setViewportSize({ width: 844, height: 390 });
    await visualHeight(page, 230);
    await containedControls(page, 230);
    await expect(page.locator("#chat-queue-note")).toBeVisible();
    const batch = page.getByRole("button", { name: "Send 2 paused steers now", exact: true });
    expect((await batch.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect.poll(() => page.locator("#chat-timeline").evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(230 * 0.4);
    await captureScreenshot(page, testInfo, `mobile-${engine}-landscape-replacement-230`);
  });

  for (const width of [667, 844]) for (const activation of ["click", "tap", "keyboard"] as const) test(`landscape Revert ${activation} activates once at ${width}px`, async ({ page, request }) => {
    await safeAreas(page, { top: 0, bottom: 21, left: width === 844 ? 47 : 0, right: width === 844 ? 47 : 0 });
    await loaded(page, request);
    await page.setViewportSize({ width, height: width === 844 ? 390 : 375 });
    await visualHeight(page, width === 844 ? 390 : 375);
    await page.locator("#chat-input").fill("Private landscape draft");
    const responses: number[] = [];
    page.on("response", response => { if (response.url().endsWith("/revert")) responses.push(response.status()); });
    const revert = page.locator("#chat-items").getByRole("button", { name: "Revert message", exact: true }).last();
    if (activation === "keyboard") { await revert.focus(); await page.keyboard.press("Enter"); }
    else await revert[activation]();
    await expect.poll(() => responses).toEqual([200]);
    await expect(page.locator("#chat-queue-note")).toContainText("delivered together with your replacement");
    // History Revert restores the selected message as the replacement;
    // unlike queue Edit, it does not concatenate the prior composer text.
    await expect(page.locator("#chat-input")).toHaveValue("Start the work");
  });

  test("hardware-keyboard editing reserves bottom safe area without doubling software-keyboard inset", async ({ page, request }, testInfo) => {
    await safeAreas(page, { top: 47, bottom: 34, left: 0, right: 0 });
    await boot(page, request);
    await page.locator("#chat-input").fill("Hardware keyboard draft");
    await expect(page.locator("html")).not.toHaveAttribute("data-chat-keyboard");
    expect(await page.locator("#chat-composer").evaluate(element => parseFloat(getComputedStyle(element).paddingBottom))).toBeGreaterThanOrEqual(34);
    expect((await page.locator("#chat-send").boundingBox())!.y + 44).toBeLessThanOrEqual(844 - 34);
    await captureScreenshot(page, testInfo, `mobile-${engine}-hardware-safe-area`);
    await visualHeight(page, 450);
    expect(await page.locator("#chat-composer").evaluate(element => parseFloat(getComputedStyle(element).paddingBottom))).toBeLessThan(10);
    await containedControls(page, 450);
    await captureScreenshot(page, testInfo, `mobile-${engine}-safe-hardware-to-software`);
  });

  test("loaded hardware-keyboard portrait retains forty percent conversation", async ({ page, request }, testInfo) => {
    await safeAreas(page, { top: 47, bottom: 34, left: 0, right: 0 });
    await loaded(page, request);
    await page.locator("#chat-input").fill("Hardware keyboard draft");
    await expect(page.locator("html")).not.toHaveAttribute("data-chat-keyboard");
    await expect.poll(() => page.locator("#chat-timeline").evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(844 * 0.4);
    await containedControls(page, 844 - 34);
    const metrics = await page.locator("#chat-surface").evaluate(element => ({ surface: element.clientHeight, transcript: document.querySelector("#chat-timeline")!.clientHeight, dock: document.querySelector("#chat-work-dock")!.getBoundingClientRect().height, composer: document.querySelector("#chat-composer")!.getBoundingClientRect().height }));
    await saveEvidence(testInfo, `review-${engine}-hardware-budget.json`, JSON.stringify(metrics, null, 2));
    await captureScreenshot(page, testInfo, `review-${engine}-hardware-budget`);
  });

  test.describe("short desktop", () => {
    test.use({ page: async ({ launchBrowser, baseURL }, use) => {
      const browser = await launchBrowser(engine);
      const page = await browser.newPage({ baseURL, viewport: { width: 1280, height: 720 }, reducedMotion: "reduce" });
      await use(page);
      await browser.close();
    } });
    for (const height of [600, 480]) test(`pending dock preserves Send and Stop at 1280x${height}`, async ({ page, request }, testInfo) => {
      await boot(page, request);
      await submit(page, "Start desktop work");
      for (let index = 0; index < 6; index++) await submit(page, `${index}: ${"Long pending message. ".repeat(18)}`, "queue");
      await page.setViewportSize({ width: 1280, height });
      await containedControls(page, height);
      const metrics = await page.locator("#chat-surface").evaluate(element => ({ surface: element.clientHeight, dock: document.querySelector("#chat-queue")!.clientHeight, transcript: document.querySelector("#chat-timeline")!.clientHeight }));
      expect(metrics.dock).toBeLessThanOrEqual(metrics.surface * 0.4 + 1);
      await saveEvidence(testInfo, `review-${engine}-desktop-${height}.json`, JSON.stringify(metrics, null, 2));
      await captureScreenshot(page, testInfo, `review-${engine}-desktop-${height}`);
    });
    test("desktop work uses an explicit sheet when a full inline action cannot fit", async ({ page, request }, testInfo) => {
      const id = await boot(page, request);
      await submit(page, "Start desktop work");
      await page.route("**/prompts", async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...await response.json(), automaticBackground: "unknown" } });
      });
      await submit(page, "One pending steer");
      await page.unroute("**/prompts");
      await control(request, { op: "launchWorker", conversationId: id });
      await page.locator("#chat-input").fill("Keep the draft and warning");
      await page.setViewportSize({ width: 1280, height: 480 });
      const toggle = page.locator("#chat-work-toggle");
      await expect(toggle).toBeVisible();
      expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await page.locator("#chat-timeline").evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(168);
      expect((await page.locator("#chat-composer").boundingBox())!.y + (await page.locator("#chat-composer").boundingBox())!.height).toBeLessThanOrEqual(480);
      await expect(page.locator("#chat-action-feedback")).toContainText("could not be confirmed");
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#chat-work-close")).toBeFocused();
      const stop = page.locator("#chat-background-tasks [data-stop-task]").first();
      await stop.scrollIntoViewIfNeeded();
      await stop.focus();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const exposure = await workControlExposure(stop);
      expect(exposure.height).toBeGreaterThanOrEqual(44);
      expect(exposure.focusVisible).toBe(true);
      expect(exposure.ring).toBeGreaterThan(0);
      for (const gap of [exposure.top, exposure.bottom, exposure.left, exposure.right]) expect(gap).toBeGreaterThanOrEqual(0);
      await saveEvidence(testInfo, `sheet-exposure-${engine}.json`, JSON.stringify(exposure, null, 2));
      await captureScreenshot(page, testInfo, `desktop-${engine}-work-sheet`);
      await page.locator("#chat-configuration-trigger").click();
      await expect(page.locator("#chat-configuration-dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("#chat-configuration-dialog")).toBeHidden();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await stop.focus();
      await page.keyboard.press("Escape");
      await expect(toggle).toBeFocused();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator("#chat-input")).toHaveValue("Keep the draft and warning");
      await captureScreenshot(page, testInfo, `desktop-${engine}-work-sheet-closed`);
    });
    test("live workers and pending steer share the short desktop budget", async ({ page, request }, testInfo) => {
      const id = await boot(page, request);
      for (let index = 1; index <= 3; index++) {
        await submit(page, `Historical question ${index}`);
        await control(request, { op: "finish", conversationId: id, text: `Historical answer ${index}. ${"Readable conversation content. ".repeat(12)}` });
        await expect(page.locator("#chat-items")).toContainText(`Historical answer ${index}.`);
      }
      await submit(page, "Start desktop work");
      await submit(page, "One pending steer");
      await control(request, { op: "launchWorker", conversationId: id });
      await expect(page.locator("#chat-subagents")).toHaveAttribute("open");
      await expect(page.locator("#chat-background-tasks")).toHaveAttribute("open");
      await expect(page.locator(".chat-queued-message")).toHaveCount(1);
      await page.locator("#chat-input").fill("Keep this desktop draft");
      for (const height of [844, 600, 480]) {
        await page.setViewportSize({ width: 1280, height });
        const surface = page.locator("#chat-surface");
        await expect.poll(() => surface.evaluate(node => node.clientHeight)).toBe(height);
        // The panel is measured by the desktop shell, not a viewport guess.
        await expect.poll(() => surface.evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1);
        for (const id of ["chat-send", "chat-stop"]) {
          const control = page.locator(`#${id}`);
          const box = (await control.boundingBox())!;
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height).toBeLessThanOrEqual(height);
          expect(await control.evaluate(node => { const rect = node.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return hit === node || node.contains(hit); })).toBe(true);
        }
        expect(await page.locator("#chat-timeline").evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(Math.min(192, height * 0.35));
        await expect(page.locator("#chat-input")).toBeFocused();
        await expect(page.locator("#chat-input")).toHaveValue("Keep this desktop draft");
        await expect(page.locator("#chat-subagents")).toHaveAttribute("open");
        await expect(page.locator("#chat-background-tasks")).toHaveAttribute("open");
        await saveEvidence(testInfo, `combined-${engine}-${height}.json`, JSON.stringify(await surface.evaluate(node => ({ panel: node.clientHeight, scroll: node.scrollHeight, transcript: document.querySelector("#chat-timeline")!.clientHeight, dock: document.querySelector("#chat-work-dock")!.getBoundingClientRect().height, composerBottom: document.querySelector("#chat-composer")!.getBoundingClientRect().bottom })), null, 2));
        await captureScreenshot(page, testInfo, `combined-${engine}-desktop-${height}`);
        const stop = page.locator("#chat-background-tasks [data-stop-task]").first();
        await stop.scrollIntoViewIfNeeded();
        await stop.focus();
        // macOS WebKit's full-control keyboard traversal uses Option+Tab.
        await page.keyboard.press(engine === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab");
        await page.keyboard.press(engine === "webkit" ? "Alt+Tab" : "Tab");
        await expect(stop).toBeFocused();
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const exposure = await workControlExposure(stop);
        await saveEvidence(testInfo, `worker-exposure-${engine}-${height}.json`, JSON.stringify(exposure, null, 2));
        expect(exposure.height).toBeGreaterThanOrEqual(44);
        expect(exposure.focusVisible).toBe(true);
        expect(exposure.ring).toBeGreaterThan(0);
        for (const gap of [exposure.top, exposure.bottom, exposure.left, exposure.right]) expect(gap).toBeGreaterThanOrEqual(0);
        await captureScreenshot(page, testInfo, `worker-exposure-${engine}-${height}`);
        await page.locator("#chat-input").focus();
      }
      await page.locator("#chat-work-dock").evaluate(node => { node.scrollTop = 0; });
      await page.locator("#chat-items").getByRole("button", { name: "Revert message", exact: true }).last().click();
      const warning = page.locator("#chat-queue-note .chat-queue-replacement");
      await expect(warning).toContainText("delivered together with your replacement");
      await expect(warning).toBeInViewport({ ratio: 1 });
      await saveEvidence(testInfo, `combined-warning-${engine}.json`, JSON.stringify(await page.evaluate(() => Object.fromEntries(["chat-work-dock", "chat-queue", "chat-queue-note"].map(id => { const node = document.getElementById(id)!; const box = node.getBoundingClientRect(); return [id, { top: box.top, bottom: box.bottom, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop }]; }))), null, 2));
      await expect(page.locator("#chat-input")).toHaveValue("Start desktop work");
      await captureScreenshot(page, testInfo, `combined-${engine}-desktop-replacement-warning`);
      await page.locator("#chat-work-dock").evaluate(node => { node.scrollTop = 0; });
      await control(request, { op: "launchWorker", conversationId: id });
      await expect(page.locator("#chat-background-tasks-items > li")).toHaveCount(2);
      expect(await page.locator("#chat-work-dock").evaluate(node => node.scrollTop)).toBe(0);
      await expect(warning).not.toBeInViewport();
    });
  });

  test("plain touch Enter inserts a newline both idle and busy; explicit modifier sends", async ({ page, request }) => {
    await boot(page, request);
    const input = page.locator("#chat-input");
    await input.fill("Idle line");
    await input.press("Enter");
    await expect(input).toHaveValue("Idle line\n");
    await submit(page, "Start work");
    const prompts: string[] = [];
    page.on("request", request => { if (request.url().endsWith("/prompts")) prompts.push(request.postData() ?? ""); });
    await input.fill("Busy line");
    await input.press("Enter");
    await expect(input).toHaveValue("Busy line\n");
    expect(prompts).toEqual([]);
    await expect(page.locator("#chat-send-help")).toContainText("Ctrl+Enter: Steer");
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await input.press("Control+Enter");
    expect((await accepted).ok()).toBe(true);
    await expect(input).toHaveValue("");
  });

  test("parent Stop explains its scope in the app before touch cancellation", async ({ page, request }, testInfo) => {
    const id = await boot(page, request);
    await submit(page, "Start parent");
    await control(request, { op: "launchWorker", conversationId: id, background: false });
    const detached = await control(request, { op: "launchWorker", conversationId: id });
    const stop = page.getByRole("button", { name: "Stop parent", exact: true });
    await stop.tap();
    const dialog = page.getByRole("dialog", { name: "Stop parent?", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Detached workers continue");
    await expect(dialog).toContainText("still-blocking");
    await captureScreenshot(page, testInfo, `mobile-${engine}-parent-stop-scope`);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await control(request, { op: "state" })).calls.filter((call: string) => call.includes("/interrupt"))).toEqual([]);
    await stop.tap();
    const cancelled = page.waitForResponse(response => response.url().endsWith("/cancel"));
    await dialog.getByRole("button", { name: "Stop parent", exact: true }).click();
    expect((await cancelled).ok()).toBe(true);
    expect((await control(request, { op: "state" })).sessions[detached.childId].running).toBe(true);
  });

  test("dock scrolling contains overscroll instead of chaining to the transcript", async ({ page, request }) => {
    await loaded(page, request);
    expect(await page.locator("#chat-queue").evaluate(element => getComputedStyle(element).overscrollBehaviorY)).toBe("contain");
    expect(await page.locator("#chat-work-dock").evaluate(element => getComputedStyle(element).overscrollBehaviorY)).toBe("contain");
  });

  test("historical workers do not label or confirm a parent-only Stop", async ({ page, request }) => {
    const id = await boot(page, request);
    await submit(page, "Current work");
    const worker = await control(request, { op: "launchWorker", conversationId: id });
    await expect(page.locator("#chat-stop")).toHaveText("Stop parent");
    await control(request, { op: "settleWorker", childId: worker.childId });
    await expect(page.locator("#chat-stop")).toHaveText("Stop");
    await expect(page.locator("#chat-stop")).toHaveAttribute("aria-label", "Stop response");
    const cancelled = page.waitForResponse(response => response.url().endsWith("/cancel"));
    await page.locator("#chat-stop").tap();
    await expect(page.locator("#chat-action-confirm")).not.toBeVisible();
    expect((await cancelled).ok()).toBe(true);
  });

  test("dock growth animates its bounded height and respects reduced motion", async ({ page, request }) => {
    const id = await boot(page, request);
    await submit(page, "Current work");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(false);
    const growing = page.evaluate(() => new Promise<void>(resolve => {
      const dock = document.querySelector("#chat-work-dock")!;
      const observer = new ResizeObserver(() => {
        if (dock.getAnimations().some(animation => animation.playState === "running")) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(dock);
    }));
    await control(request, { op: "launchWorker", conversationId: id });
    await expect(page.locator("#chat-compact-workers-items [data-inspect-task]")).toHaveCount(1);
    await growing;
    await page.locator("#chat-work-dock").evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await control(request, { op: "launchWorker", conversationId: id });
    await expect(page.locator("#chat-compact-workers-items [data-inspect-task]")).toHaveCount(2);
    expect(await page.locator("#chat-work-dock").evaluate(element => element.getAnimations().length)).toBe(0);
  });

  for (const motion of ["reduce", "no-preference"] as const) test(`dock growth preserves a real reading anchor and keeps deliberate bottom pinning (${motion})`, async ({ page, request }, testInfo) => {
    await page.emulateMedia({ reducedMotion: motion });
    const id = await boot(page, request);
    for (let index = 1; index <= 4; index++) {
      await submit(page, `History prompt ${index}`);
      await control(request, { op: "finish", conversationId: id, text: `History answer ${index}. ${"Readable history sentence. ".repeat(25)}` });
      await expect(page.locator("#chat-items")).toContainText(`History answer ${index}.`);
    }
    await submit(page, "Current work");
    const timeline = page.locator("#chat-timeline");
    await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const anchor = page.locator("#chat-items .chat-user-message").nth(1);
    await anchor.evaluate(element => { const timeline = document.querySelector<HTMLElement>("#chat-timeline")!; timeline.scrollTop += element.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 40; });
    const offset = () => anchor.evaluate(element => element.getBoundingClientRect().top - document.querySelector("#chat-timeline")!.getBoundingClientRect().top);
    await expect.poll(offset).toBeGreaterThanOrEqual(35);
    const before = await offset();
    // A remote worker update grows chrome without the deliberate jump to
    // latest that submitting one's own prompt correctly requests.
    await control(request, { op: "launchWorker", conversationId: id });
    await expect(page.locator("#chat-compact-workers-items [data-inspect-task]")).toHaveCount(1);
    await expect.poll(offset).toBeCloseTo(before, 0);
    const afterGrowth = await offset();
    await timeline.evaluate(element => {
      const trace: unknown[] = [];
      (window as any).__dockScrollTrace = trace;
      const sample = (event: string) => trace.push({ event, time: performance.now(), top: element.scrollTop, client: element.clientHeight, total: element.scrollHeight, dock: document.querySelector("#chat-work-dock")!.getBoundingClientRect().height });
      element.addEventListener("scroll", () => sample("scroll"));
      new ResizeObserver(() => sample("resize")).observe(element);
      sample("before-pin");
    });
    await timeline.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await submit(page, "Next steer while pinned");
    await expect(page.locator(".chat-queued-message")).toHaveCount(1);
    try {
      await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);
    } finally {
      await saveEvidence(testInfo, `mobile-${engine}-scroll-trace-${motion}.json`, JSON.stringify(await page.evaluate(() => (window as any).__dockScrollTrace), null, 2));
    }
    await saveEvidence(testInfo, `mobile-${engine}-reading-anchor-${motion}.json`, JSON.stringify({ before, afterGrowth, bottomDistance: await timeline.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop) }, null, 2));
    await captureScreenshot(page, testInfo, `review-${engine}-bottom-pinned-${motion}`);
  });

  test("touch work controls have readable text, targets, and native-highlight-free feedback", async ({ page, request }) => {
    await loaded(page, request);
    for (const selector of [".chat-task-stop", ".chat-queued-action"]) {
      const control = page.locator(selector).first();
      expect(await control.evaluate(element => getComputedStyle(element).getPropertyValue("-webkit-tap-highlight-color"))).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    }
    expect(await page.locator(".chat-task-stop").first().evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(13);
    expect(await page.locator("#chat-conversation-select").evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    await page.locator("#chat-compact-workers > summary").tap();
    const open = page.locator(".chat-worker-row:has(.chat-task-stop) .chat-worker-inspect").first();
    // Inspection stays dense even beside a separate full-height Stop target.
    expect((await open.boundingBox())!.height).toBeLessThanOrEqual(28);
    const dense = page.locator(".chat-worker-row:not(:has(.chat-task-stop)) .chat-worker-inspect").first();
    expect((await dense.boundingBox())!.height).toBeGreaterThanOrEqual(26);
    expect((await dense.boundingBox())!.height).toBeLessThanOrEqual(28);
    expect((await page.locator(".chat-worker-row .chat-task-stop").first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test("expanded workers leave Stop clear of the prompt rail", async ({ page, request }) => {
    await loaded(page, request);
    await expect(page.locator("#chat-prompt-rail")).toBeVisible();
    await page.locator("#chat-compact-workers > summary").tap();
    await expect(page.locator("#chat-compact-workers")).toHaveAttribute("open", "");
    await expect(page.locator("#chat-prompt-rail")).toBeHidden();
    const stop = page.locator("#chat-compact-workers .chat-task-stop").first();
    expect(await stop.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.right - 2, box.y + box.height / 2)); })).toBe(true);
  });

  test("320px dark layout wraps pending text and keeps the picker inside the keyboard band", async ({ page, request }, testInfo) => {
    await loaded(page, request);
    await submit(page, "LongPending".repeat(24), "queue");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 320, height: 568 });
    await visualHeight(page, 568);
    await page.locator("#chat-input").blur();
    await expect.poll(() => page.locator("#chat-surface").evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await captureScreenshot(page, testInfo, `mobile-${engine}-320-dark-wrap`);
    await page.locator("#chat-input").focus();
    await visualHeight(page, 380);
    await containedControls(page, 380);
    await page.locator("#chat-configuration-trigger").tap();
    for (const choice of [page.locator("#chat-configuration-dialog")]) {
      const box = (await choice.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(320);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(380);
    }
    await captureScreenshot(page, testInfo, `mobile-${engine}-320-dark-keyboard-picker`);
  });
});
