import { test as base, expect } from "./fixtures";
import { withEngineBrowsers } from "./page-diagnostics";
import { writeFile } from "node:fs/promises";

const test = withEngineBrowsers(base);
for (const engine of ["chromium", "webkit"] as const) test.describe(`hold and sparse queue ${engine}`, () => {
test.use({ page: async ({ launchBrowser, baseURL }, use) => {
  const browser = await launchBrowser(engine);
  const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  await page.addInitScript(() => Object.defineProperty(window, "visualViewport", { configurable: true, value: Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 }) }));
  await use(page); await browser.close();
} });

test("sparse pending entries grow from one to two to five beside busy workers", async ({ page, request }, info) => {
    await request.post("/__e2e/reset");
    await request.post("/__e2e/chat", { data: { action: "agents", stack: "opencode-v2", backgroundPreview: true } });
    const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await page.locator("#touch-tab-chat").click();
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    await page.locator("#chat-input").fill("Implement the example task list");
    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-stop")).toBeEnabled();
    const conversationId = await page.locator("#chat-conversation-select").inputValue();
    for (let i = 0; i < 6; i++) await request.post("/__e2e/chat", { data: { action: "opencode", op: "launchWorker", conversationId } });
    await expect(page.locator("#chat-compact-workers [data-worker-id]")).toHaveCount(6);
    await page.locator("#chat-compact-workers > summary").click();
    await expect(page.locator("#chat-compact-workers")).toHaveAttribute("open", "");
    const sizes: number[] = [];
    for (let count = 1; count <= 5; count++) {
      await page.locator("#chat-input").fill(`Follow-up ${count}`);
      await page.locator("#chat-input").press("Alt+Enter");
      await expect(page.locator(".chat-queued-message")).toHaveCount(count);
      const toggle = page.locator("[data-pending-toggle]");
      if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
      if (![1, 2, 5].includes(count)) continue;
      await expect.poll(() => page.locator(".chat-queue-content").evaluate(node => {
        const row = node.querySelector(".chat-queued-message")!.getBoundingClientRect();
        return Math.min(node.clientHeight, node.scrollHeight) >= Math.min(node.scrollHeight, row.height * Math.min(node.querySelectorAll(".chat-queued-message").length, 2));
      })).toBe(true);
      sizes.push(await page.locator("#chat-queue").evaluate(node => node.getBoundingClientRect().height));
      await page.screenshot({ path: info.outputPath(`sparse-${count}.png`) });
    }
    expect(sizes[1]).toBeGreaterThan(sizes[0]! + 30);
    expect(sizes[2]).toBeGreaterThan(sizes[1]! + 30);
    await page.locator("[data-pending-toggle]").click();
    await expect(page.locator("[data-pending-toggle]")).toHaveAttribute("aria-expanded", "false");
    await page.locator("#chat-compact-workers > summary").click();
    await expect(page.locator("#chat-compact-workers")).not.toHaveAttribute("open");
    await expect.poll(() => page.locator("#chat-work-dock").evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(80);
});

test("hold portal matches Send when the fixed viewport origin differs from client coordinates", async ({ page, request }, info) => {
  await request.post("/__e2e/reset");
  await request.post("/__e2e/chat", { data: { action: "agents", stack: "opencode-v2", backgroundPreview: true } });
  const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await page.locator("#touch-tab-chat").click();
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
  await page.locator("#chat-input").fill("Start work"); await page.locator("#chat-send").click();
  await expect(page.locator("#chat-stop")).toBeEnabled();
  await page.locator("#chat-input").fill("Keep this anchored draft");
  // Synthetic WebKit-style fixed/client origin mismatch. This is not native
  // iPhone verification: the transform models the paint-space displacement.
  await page.addStyleTag({ content: "body { transform: translate(13px, 11px) } .chat-hold-upward, .chat-hold-origin { transform: translate(var(--test-fixed-x, -17px), var(--test-fixed-y, -240px)) }" });
  expect(await page.locator(".chat-hold-origin").evaluate(node => {
    const box = node.getBoundingClientRect(), css = getComputedStyle(node);
    return { inert: (node as HTMLElement).inert, hidden: node.getAttribute("aria-hidden"), width: box.width, height: box.height, pointer: css.pointerEvents, tabIndex: (node as HTMLElement).tabIndex };
  })).toEqual({ inert: true, hidden: "true", width: 0, height: 0, pointer: "none", tabIndex: -1 });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const send = (await page.locator("#chat-send").boundingBox())!;
  await page.mouse.move(send.x + send.width / 2, send.y + send.height / 2); await page.mouse.down();
  await page.clock.runFor(499);
  await expect(page.locator(".chat-hold-upward")).toBeHidden();
  await page.clock.runFor(1);
  await page.screenshot({ path: info.outputPath("hold-offset.png") });
  const visual = (await page.locator(".chat-hold-upward").boundingBox())!;
  expect(visual.x).toBeCloseTo(send.x, 0);
  expect(visual.y + visual.height).toBeCloseTo(send.y + send.height, 0);
  expect(visual.height).toBeCloseTo(send.height + 104, 0);
  await page.clock.runFor(500);
  expect(await page.locator(".chat-hold-upward").boundingBox()).toEqual(visual);
  // A changing fixed paint origin must not translate the overlay twice.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--test-fixed-x", "-23px");
    document.documentElement.style.setProperty("--test-fixed-y", "-180px");
    Object.assign(window.visualViewport!, { offsetTop: 0, scale: 1.5 });
    window.visualViewport!.dispatchEvent(new Event("scroll"));
  });
  await page.clock.runFor(200);
  const panned = (await page.locator(".chat-hold-upward").boundingBox())!;
  expect(panned.x).toBeCloseTo(send.x, 0);
  expect(panned.y + panned.height).toBeCloseTo(send.y + send.height, 0);
  await page.clock.runFor(800);
  expect(await page.locator(".chat-hold-upward").boundingBox()).toEqual(visual);
  await page.clock.runFor(499);
  await expect(page.locator(".chat-queued-message")).toHaveCount(0);
  const accepted = page.waitForResponse(response => response.url().endsWith("/prompts") && response.request().method() === "POST");
  await page.clock.runFor(1);
  expect((await accepted).ok()).toBe(true);
  await page.clock.runFor(32); // Paint the acknowledged live projection.
  await expect(page.locator('.chat-queued-message[data-delivery="queue"]')).toHaveCount(1);
  await page.mouse.up();
  await page.clock.runFor(2100);
  await expect(page.locator(".chat-queued-message")).toHaveCount(1);
  for (const change of ["keyboard opens", "keyboard closes", "viewport pans", "toolbar grows"] as const) {
    await page.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 380, offsetTop: 48, scale: 1 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    if (change === "keyboard opens") await page.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 844, offsetTop: 0 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await page.locator("#chat-input").fill(`Retain draft when ${change}`);
    await page.clock.runFor(64);
    const current = (await page.locator("#chat-send").boundingBox())!;
    await page.mouse.move(current.x + current.width / 2, current.y + current.height / 2); await page.mouse.down();
    await page.clock.runFor(550);
    const anchored = (await page.locator(".chat-hold-upward").boundingBox())!;
    expect(anchored.y + anchored.height).toBeCloseTo(current.y + current.height, 0);
    await page.evaluate(change => {
      if (change === "toolbar grows") document.querySelector<HTMLElement>("#chat-composer")!.style.paddingBottom = "24px";
      else {
        Object.assign(window.visualViewport!, change === "keyboard opens" ? { height: 380, offsetTop: 48 } : change === "keyboard closes" ? { height: 844, offsetTop: 0 } : { offsetTop: 96 });
        window.visualViewport!.dispatchEvent(new Event("resize"));
        window.visualViewport!.dispatchEvent(new Event("scroll"));
      }
    }, change);
    await page.clock.runFor(2100);
    await expect(page.locator(".chat-hold-upward")).toBeHidden();
    await page.mouse.up();
    await expect(page.locator(".chat-queued-message")).toHaveCount(1);
    await expect(page.locator("#chat-input")).toHaveValue(`Retain draft when ${change}`);
  }
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect(page.locator(".chat-hold-origin, .chat-hold-upward")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.locator(".chat-hold-origin")).toHaveCount(1);
  await expect(page.locator(".chat-hold-upward")).toHaveCount(1);
});
});

for (const touch of [false, true]) for (const theme of ["light", "dark"] as const) test(`hold frames do not force layout by resetting the painted portal: ${touch ? "mobile" : "desktop"} ${theme}`, async ({ browser, baseURL, request }, info) => {
  const page = await browser.newPage({ baseURL, viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: touch, hasTouch: touch, colorScheme: theme });
  try {
  await request.post("/__e2e/reset");
  await request.post("/__e2e/chat", { data: { action: "agents", stack: "opencode-v2", backgroundPreview: true } });
  const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  if (touch) await page.locator("#touch-tab-chat").click();
  else await page.locator("#chat-expand").click();
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("#chat-state")).toContainText("Started new conversation with OpenCode");
  await page.locator("#chat-input").fill("Start fixture work"); await page.locator("#chat-send").click();
  await expect(page.locator("#chat-stop")).toBeEnabled();
  await page.locator("#chat-input").fill("Trace the held follow-up");
  const box = (await page.locator("#chat-send").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline.stack", transferMode: "ReturnAsStream" });
  await page.mouse.down();
  await expect(page.locator(".chat-hold-upward")).toBeVisible();
  await page.waitForTimeout(650); // Sample real rendering, not a virtual clock.
  const completed = new Promise<string>(resolve => cdp.once("Tracing.tracingComplete", event => resolve(event.stream!)));
  await cdp.send("Tracing.end");
  const handle = await completed;
  let trace = "";
  for (;;) {
    const chunk = await cdp.send("IO.read", { handle });
    trace += chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send("IO.close", { handle });
  await page.mouse.up();
  type TraceEvent = { name: string; dur?: number; args?: { beginData?: { stackTrace?: Array<{ functionName: string }> }; stackTrace?: Array<{ functionName: string }> } };
  const events = (JSON.parse(trace) as { traceEvents: TraceEvent[] }).traceEvents;
  const forced = events.filter(event => ["Layout", "UpdateLayoutTree"].includes(event.name)
    && (event.args?.beginData?.stackTrace ?? event.args?.stackTrace ?? []).some(frame => frame.functionName === "paintHold"));
  // A read at frame entry may resolve prior browser/style work. The regression
  // is a Layout flush, or a second direct style flush at the origin read after
  // writes in this frame. Retain all stacks so that distinction is reviewable.
  const calibrationFlushes = forced.filter(event => event.name === "Layout"
    || (event.args?.beginData?.stackTrace ?? event.args?.stackTrace ?? [])[0]?.functionName === "paintHold");
  const evidence = info.outputPath("hold-forced-layouts.json");
  await writeFile(evidence, JSON.stringify({ sampleMs: 650, forcedCount: forced.length, layoutCount: forced.filter(event => event.name === "Layout").length, calibrationFlushes: calibrationFlushes.length, events: forced }, null, 2));
  await info.attach("hold-forced-layouts.json", { path: evidence, contentType: "application/json" });
  expect(calibrationFlushes).toHaveLength(0);
  } finally { await page.close(); }
});
