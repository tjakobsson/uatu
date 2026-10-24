import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test as base } from "./fixtures";
import { withEngineBrowsers } from "./page-diagnostics";
import { openChatPanel, openChatPending } from "./chat-helpers";
import { captureScreenshot, saveEvidence } from "./evidence";

const test = withEngineBrowsers(base);
function cases(engine: "chromium" | "webkit") {
for (const touch of [false, true]) test(`side answer minimises and reopens without regeneration (${touch ? "mobile" : "desktop"})`, async ({ launchBrowser, baseURL, request }) => {
  const browser = await launchBrowser(engine);
  const page = await browser.newPage({ baseURL, viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: touch, isMobile: touch });
  try {
    await boot(page, request);
    let generations = 0;
    await page.route("**/aside", route => { generations++; return route.fulfill({ json: { text: Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: retained answer and reading position.`).join("\n\n") } }); });
    await page.locator("#chat-input").fill("/btw Keep this answer");
    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-aside-ready")).toHaveText("Side answer ready");
    await page.locator("#chat-aside-ready").click();
    const reader = page.locator("#chat-aside-dialog");
    await expect(reader).toHaveAttribute("aria-modal", touch ? "true" : "false");
    if (!touch) {
      await page.locator("#chat-input").click();
      await page.locator("#chat-input").fill("Independent draft while reading");
      await page.locator("#chat-input").press("Escape");
      await expect(reader).toBeVisible();
      await expect(page.locator("#chat-input")).toBeFocused();
      await page.locator("#chat-input").press("Alt+Enter");
      await expect(page.locator(".chat-queued-message")).toHaveCount(1);
      await openChatPending(page);
      await page.locator("[data-queue-remove]").click();
      await expect(page.locator(".chat-queued-message")).toHaveCount(0);
      await page.locator("#chat-stop").click();
      await expect(page.locator("#chat-stop")).toBeDisabled();
      await expect(reader).toBeVisible();
    }
    await reader.evaluate(node => { node.scrollTop = 350; });
    await page.locator("#chat-aside-close").click();
    await expect(reader).toBeHidden();
    await expect(page.locator("#chat-aside-ready")).toBeFocused();
    await page.locator("#chat-aside-ready").click();
    expect(await reader.evaluate(node => node.scrollTop)).toBeGreaterThan(300);
    expect(generations).toBe(1);
    await expect(page.locator("#chat-items")).not.toContainText("Keep this answer");
    if (!touch) {
      await page.evaluate(async () => {
        document.querySelector<HTMLButtonElement>("#chat-aside-close")!.click();
        document.querySelector<HTMLElement>("#chat-input")!.focus();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
      await expect(page.locator("#chat-input")).toBeFocused();
      await page.locator("#chat-aside-ready").click();
    }
    await page.locator("#chat-aside-close").focus();
    await page.keyboard.press("Escape");
    await expect(reader).toBeHidden();
  } finally { await page.close(); }
});
for (const coarse of [false, true]) test(`side reader minimises on live UI mode changes (${coarse ? "coarse" : "fine"} pointer)`, async ({ launchBrowser, baseURL, request }) => {
  const browser = await launchBrowser(engine);
  const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 }, hasTouch: coarse, isMobile: coarse });
  await page.addInitScript(() => localStorage.setItem("uatu:presentation:v1:%2F:uatu:ui-mode", "desktop"));
  try {
    await boot(page, request);
    let generations = 0;
    await page.route("**/aside", route => { generations++; return route.fulfill({ json: { text: Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: retained mode-switch answer.`).join("\n\n") } }); });
    await page.locator("#chat-input").fill("/btw Retain through mode changes");
    await page.locator("#chat-send").click();
    const notice = page.locator("#chat-aside-ready"), reader = page.locator("#chat-aside-dialog"), input = page.locator("#chat-input");
    await expect(notice).toHaveText("Side answer ready");
    const stableTimeline = () => page.locator("#chat-items [data-chat-item-id]").evaluateAll(nodes => nodes.map(n => ({ id: n.getAttribute("data-chat-item-id"), type: n.className, content: [...n.querySelectorAll("p, .markdown-body")].map(body => body.textContent) })));
    const timeline = await stableTimeline();
    await notice.click();
    expect(await reader.evaluate(node => node.matches(":modal"))).toBe(false);
    await reader.evaluate(node => { node.scrollTop = 350; });
    // A real user override on coarse hardware must work too: do not infer
    // presentation from pointer capability instead of the chosen UI mode.
    if (coarse) await page.locator("#ui-mode-toggle").click();
    else await page.locator("#ui-mode-toggle").evaluate(node => (node as HTMLButtonElement).click());
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
    await expect(reader).toBeHidden();
    expect(await reader.evaluate(node => node.matches(":modal"))).toBe(false);
    await page.locator("#touch-tab-chat").click();
    await input.click();
    await input.fill("Preserved draft after mode switch");
    await expect(input).toBeFocused();
    await notice.click();
    await expect(reader).toHaveAttribute("aria-modal", "true");
    expect(await reader.evaluate(node => node.matches(":modal"))).toBe(true);
    expect(await reader.evaluate(node => node.scrollTop)).toBeGreaterThan(300);
    // A shell/settings mode event can occur while its current modal reader
    // makes the toggle inert. Invoke the real toggle handler, not an ARIA or
    // data-attribute mutation, then begin another interaction in that turn.
    await page.evaluate(async () => {
      document.querySelector<HTMLButtonElement>("#ui-mode-toggle")!.click();
      document.querySelector<HTMLElement>("#chat-input")!.focus();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "desktop");
    await expect(reader).toBeHidden();
    expect(await reader.evaluate(node => node.matches(":modal"))).toBe(false);
    await expect(input).toBeFocused();
    await input.click(); // Native modal inertness/scroll locking is gone.
    await notice.click();
    await expect(reader).toHaveAttribute("aria-modal", "false");
    expect(await reader.evaluate(node => node.matches(":modal"))).toBe(false);
    expect(await reader.evaluate(node => node.scrollTop)).toBeGreaterThan(300);
    await expect(page.locator("#chat-aside-answer")).toContainText("retained mode-switch answer");
    await expect(input).toHaveValue("Preserved draft after mode switch");
    expect(await stableTimeline()).toEqual(timeline);
    expect(generations).toBe(1);
  } finally { await page.close(); }
});
test("native touch tap steers once and a focused touch-page pointer hold queues", async ({ launchBrowser, baseURL, request }, info) => {
  const browser = await launchBrowser(engine);
  const touch = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await touch.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });
  try {
    await boot(touch, request);
    await touch.locator("#chat-input").fill("Native quick tap");
    await touch.locator("#chat-send").tap();
    await expect(touch.locator('.chat-queued-message[data-delivery="steer"]')).toHaveCount(1);
    await touch.locator("#chat-input").fill("Touch-page pointer hold");
    await touch.locator("#chat-input").focus();
    const target = await press(touch);
    await expect(touch.locator(".chat-hold-upward")).toBeVisible();
    await expect.poll(async () => target.y - (await touch.locator(".chat-hold-upward").boundingBox())!.y, { intervals: [25] }).toBeGreaterThanOrEqual(80);
    expect((await touch.locator(".chat-hold-upward").boundingBox())!.y).toBeLessThanOrEqual(target.y - 80);
    await expect(touch.locator("#chat-input")).toBeFocused();
    await captureScreenshot(touch, info, `touch-page-${engine}-pointer-hold`);
    await expect(touch.locator('.chat-queued-message[data-delivery="queue"]')).toHaveCount(1);
    await touch.mouse.up();
    await expect(touch.locator(".chat-queued-message")).toHaveCount(2);
    const conversationId = await touch.locator("#chat-conversation-select").inputValue();
    for (let i = 0; i < 12; i++) expect((await request.post("/__e2e/chat", { data: { action: "opencode", op: "launchWorker", conversationId } })).ok()).toBe(true);
    await expect(touch.locator("#chat-compact-workers [data-worker-id]")).toHaveCount(12);
    await touch.locator("#chat-compact-workers > summary").tap();
    await touch.locator("#chat-input").fill("Queue past expanded workers");
    await touch.locator("#chat-input").focus();
    await touch.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 380 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect(touch.locator("html")).toHaveAttribute("data-chat-keyboard");
    await press(touch);
    await expect(touch.locator(".chat-hold-upward")).toBeVisible();
    await captureScreenshot(touch, info, `touch-page-${engine}-hold-over-expanded-workers`);
    const feedbackOnTop = await touch.locator(".chat-hold-upward").evaluate(node => {
      // Temporarily hit-test the paint layer; the real visual stays transparent
      // to pointers. A bounding box alone cannot detect another layer covering it.
      const element = node as HTMLElement;
      const previous = element.style.pointerEvents;
      element.style.pointerEvents = "auto";
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + 18);
      element.style.pointerEvents = previous;
      return element.contains(hit);
    });
    await expect(touch.locator('.chat-queued-message[data-delivery="queue"]')).toHaveCount(2);
    await touch.mouse.up();
    await expect(touch.locator(".chat-queued-message")).toHaveCount(3);
    expect(feedbackOnTop).toBe(true);
  } finally { await touch.close(); }
});
test("/btw answers natively without foreground admission or interruption", async ({ page, request }) => {
  await boot(page, request);
  const before = await request.post("/__e2e/chat", { data: { action: "opencode", op: "state" } }).then(response => response.json());
  await page.locator("#chat-input").fill("/btw What does the current task mean?");
  await expect(page.locator("#chat-send-help")).not.toContainText("Hold Send");
  const answer = page.waitForResponse(response => response.url().endsWith("/aside"));
  await page.locator("#chat-send").click();
  expect((await answer).ok()).toBe(true);
  await expect(page.locator("#chat-aside-ready")).toHaveText("Side answer ready");
  await page.locator("#chat-aside-ready").click();
  await expect(page.locator("#chat-aside-answer")).toContainText("native side answer");
  const after = await request.post("/__e2e/chat", { data: { action: "opencode", op: "state" } }).then(response => response.json());
  expect(after.sessions).toEqual(before.sessions);
  expect(after.calls.slice(before.calls.length).filter((call: string) => call.startsWith("POST"))).toEqual([expect.stringMatching(/^POST \/api\/session\/[^/]+\/generate$/)]);
  await page.locator("#chat-aside-close").click();
  await expect(page.locator("#chat-items")).not.toContainText("What does the current task mean?");
  await expect(page.locator("#chat-stop")).toBeEnabled();
});
test("side reader uses safe chat markdown with locally scrolling tables", async ({ page, request }, info) => {
  await boot(page, request);
  const columns = Array.from({ length: 16 }, (_, i) => `Column ${i}`);
  const text = `# Side heading\n\n**Important** and *emphasis*, \`inline\`, [safe link](https://example.com).\n\n\`\`\`js\nconst value = 1;\n\`\`\`\n\n| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n| ${columns.map(() => "Wide selectable cell content").join(" | ")} |\n\n[bad](javascript:alert(1)) <script>window.sideXss = true</script><img src=x onerror="window.sideXss=true">\n\nhttps://example.com/${"long".repeat(100)}`;
  await page.route("**/aside", route => route.fulfill({ json: { text } }));
  await page.locator("#chat-input").fill("/btw Format this answer");
  await page.locator("#chat-send").click();
  const notice = page.locator("#chat-aside-ready");
  await expect(notice).toHaveText("Side answer ready");
  expect(await notice.evaluate(node => Boolean(node.closest("#chat-composer-notices")))).toBe(false);
  await page.locator("#chat-input").fill("Keep my selection");
  await notice.click();
  const reader = page.locator("#chat-aside-dialog");
  const answer = page.locator("#chat-aside-answer");
  await expect(answer.locator("h1")).toHaveText("Side heading");
  await expect(answer.locator("strong")).toHaveText("Important");
  await expect(answer.locator("em")).toHaveText("emphasis");
  await expect(answer.locator("pre code")).toContainText("const value = 1;");
  await expect(answer.locator("table")).toHaveCount(1);
  await expect(answer.locator('script, [onerror], a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { sideXss?: boolean }).sideXss)).toBeUndefined();
  expect(await reader.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  expect(await answer.locator("table").evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await captureScreenshot(page, info, `safe-side-reader-${engine}`);
  await page.keyboard.press("Escape");
  await expect(reader).toBeHidden();
  await expect(notice).toBeFocused();
  await expect(page.locator("#chat-input")).toHaveValue("Keep my selection");
});
for (const mode of ["desktop", "touch"] as const) test(`side-reader workspace links open in-app without losing the answer or admitting another prompt (${mode})`, async ({ launchBrowser, baseURL, request }, info) => {
  const browser = await launchBrowser(engine);
  const page = await browser.newPage({ baseURL, viewport: { width: mode === "touch" ? 390 : 1280, height: 844 }, hasTouch: mode === "touch", isMobile: mode === "touch" });
  try {
    await boot(page, request);
    const conversation = await page.locator("#chat-conversation-select").inputValue();
    const state = await page.request.get("/api/state").then(response => response.json());
    const qualified = `${state.roots[0].path}/guides/setup.md:3`;
    const before = await request.post("/__e2e/chat", { data: { action: "opencode", op: "state" } }).then(response => response.json());
    const mutations: string[] = [];
    page.on("request", request => { if (request.method() === "POST" && /\/(aside|prompts)$/.test(request.url())) mutations.push(new URL(request.url()).pathname); });
    await page.context().route("https://example.test/side-review", route => route.fulfill({ contentType: "text/html", body: "External fixture only" }));
    await page.route("**/aside", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { text: `Retained side answer. [workspace](README.md) [qualified](${encodeURI(qualified)}) [encoded](guides%2Fsetup.md) [external](https://example.test/side-review) [escaped](..%2FREADME.md) [malformed](%E0%A4%A) [unsafe](javascript:alert(1)) <a href="javascript:alert(1)" data-file-ref="README.md" onclick="window.sideXss=true">forged</a>` } });
    });
    await page.locator("#chat-input").fill("/btw Find the workspace document");
    const generated = page.waitForResponse(response => response.url().endsWith("/aside"));
    await page.locator("#chat-send").click(); await generated;
    await page.locator("#chat-input").fill("Keep this exact draft");
    // WebKit's native timeOrigin can vary within one Document. Install once,
    // after boot, so a new Document cannot inherit or recreate this identity.
    const documentIdentity = await page.evaluate(() => {
      const token = crypto.randomUUID();
      Object.defineProperty(document, "__sideReaderIdentity", { value: token });
      return token;
    });
    const reader = page.locator("#chat-aside-dialog");
    const answer = page.locator("#chat-aside-answer");
    const reopen = async () => {
      if (mode === "touch" && await page.locator("html").getAttribute("data-active-tab") !== "chat") await page.locator("#touch-tab-chat").click();
      const notice = page.locator("#chat-aside-ready");
      await expect.poll(() => notice.evaluate(node => {
        const box = node.getBoundingClientRect();
        const transcript = node.closest(".chat-transcript-area")!.getBoundingClientRect();
        return box.height >= 44 && box.top >= transcript.top && box.bottom <= transcript.bottom
          && node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), { message: "the whole side-answer target stays inside the transcript and receives native input" }).toBe(true);
      await notice.click();
      await expect(answer).toContainText("Retained side answer.");
    };
    await reopen();
    for (const label of ["workspace", "qualified", "encoded"]) {
      const link = answer.getByRole("button", { name: label, exact: true });
      await expect(link).not.toHaveAttribute("href");
      await expect(link).toHaveAttribute("tabindex", "0");
    }
    for (const label of ["escaped", "malformed", "unsafe", "forged"]) await expect(answer.getByText(label, { exact: true })).not.toHaveAttribute("data-file-ref");
    await expect(answer.locator('script, [onclick], a[href^="javascript:"]')).toHaveCount(0);
    await captureScreenshot(page, info, `side-links-${engine}-${mode}-reader`);
    await answer.getByRole("button", { name: "workspace", exact: true }).click();
    expect(await page.evaluate(() => (document as Document & { __sideReaderIdentity?: string }).__sideReaderIdentity)).toBe(documentIdentity);
    await expect(reader).toBeHidden();
    await expect(page.locator("#preview-path")).toHaveText("README.md");
    if (mode === "touch") {
      await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
      await expect(page.locator("#chat-aside-ready")).not.toBeFocused();
    }
    await reopen();
    const qualifiedLink = answer.getByRole("button", { name: "qualified", exact: true });
    await expect(qualifiedLink).toHaveAttribute("data-file-ref", qualified);
    await qualifiedLink.focus(); await qualifiedLink.press("Enter");
    await expect(reader).toBeHidden();
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
    await expect(page.locator('#preview .uatu-cl[data-ln="3"]')).toHaveClass(/chat-file-line-target/);
    await captureScreenshot(page, info, `side-links-${engine}-${mode}-qualified-preview`);
    await reopen();
    await answer.getByRole("button", { name: "encoded", exact: true }).focus();
    await answer.getByRole("button", { name: "encoded", exact: true }).press("Space");
    await expect(reader).toBeHidden();
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
    await reopen();
    const external = answer.getByRole("link", { name: "external", exact: true });
    await expect(external).toHaveAttribute("target", "_blank");
    expect((await external.getAttribute("rel"))!.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    const popupReady = page.waitForEvent("popup"); await external.click();
    const popup = await popupReady; await popup.waitForLoadState();
    expect(popup.url()).toBe("https://example.test/side-review"); await popup.close();
    await expect(reader).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-aside-ready")).toBeFocused();
    // Retained markup is not activation authority once its reader is closed.
    await answer.getByRole("button", { name: "workspace", exact: true, includeHidden: true }).evaluate(node => (node as HTMLElement).click());
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
    await expect(page.locator("#chat-input")).toHaveValue("Keep this exact draft");
    await expect(page.locator("#chat-conversation-select")).toHaveValue(conversation);
    expect(await page.evaluate(() => (document as Document & { __sideReaderIdentity?: string }).__sideReaderIdentity)).toBe(documentIdentity);
    expect(mutations).toEqual([expect.stringMatching(/\/aside$/)]);
    const after = await request.post("/__e2e/chat", { data: { action: "opencode", op: "state" } }).then(response => response.json());
    expect(after.calls.slice(before.calls.length).filter((call: string) => call.startsWith("POST"))).toEqual([expect.stringMatching(/\/generate$/)]);
  } finally { await browser.close(); }
});
test("side completion preserves composing focus and concurrent requests never duplicate inference", async ({ page, request }) => {
  await boot(page, request);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route("**/aside", async route => { calls++; await gate; await route.continue(); });
  await page.locator("#chat-input").fill("/btw First side question");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-aside-ready")).toHaveText("Side answer…");
  await page.locator("#chat-input").fill("/btw Second side question");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-composer-error")).toContainText("already in progress");
  await page.locator("#chat-input").fill("New foreground draft");
  await page.locator("#chat-input").focus();
  release();
  await expect(page.locator("#chat-aside-ready")).toHaveText("Side answer ready");
  expect(calls).toBe(1);
  await expect(page.locator("#chat-input")).toHaveValue("New foreground draft");
  await expect(page.locator("#chat-input")).toBeFocused();
  await expect(page.locator("#chat-aside-dialog")).not.toBeVisible();
});
test("mobile side reader stays inside the visual viewport and completion preserves reading and selection", async ({ launchBrowser, baseURL, request }, info) => {
  const browser = await launchBrowser(engine);
  const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  await page.addInitScript(() => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 }) });
  });
  await page.route("**/*", async route => {
    if (!["stylesheet", "script", "document"].includes(route.request().resourceType())) return route.fallback();
    const response = await route.fetch();
    const body = (await response.text()).replace(/env\(\s*safe-area-inset-(top|bottom)\s*(,[^()]*(\([^()]*\))?[^()]*)?\)/g, (_match, edge: string) => `var(--reader-safe-${edge}, ${edge === "top" ? "47px" : "34px"})`);
    await route.fulfill({ response, body });
  });
  try {
    await boot(page, request);
    const conversationId = await page.locator("#chat-conversation-select").inputValue();
    await request.post("/__e2e/chat", { data: { action: "opencode", op: "appendHistory", conversationId, count: 60 } });
    await request.post("/__e2e/chat", { data: { action: "opencode", op: "launchWorker", conversationId } });
    await page.locator("#chat-compact-workers > summary").tap();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    await page.route("**/aside", async route => {
      calls++;
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response, json: { text: `# Readable answer\n\n**Formatted** \`inline\` [safe](https://example.com).\n\n| ${Array.from({ length: 16 }, (_, i) => `Field ${i}`).join(" | ")} |\n| ${Array(16).fill("---").join(" | ")} |\n| ${Array(16).fill("Long cell content").join(" | ")} |\n\n\`\`\`js\n${"const sample = 'selectable';\n".repeat(20)}\`\`\`\n\n[unsafe](javascript:alert(1)) <img src=x onerror="window.sideXss=true"><script>window.sideXss=true</script>\n\n${"Retained paragraph with https://example.com/" + "long".repeat(100)}` } });
    });
    await page.locator("#chat-input").fill("/btw Explain while work continues");
    await page.locator("#chat-send").tap();
    const notice = page.locator("#chat-aside-ready");
    await expect(notice).toHaveText("Side answer…");
    await page.locator("#chat-input").fill("Keep this selected draft");
    await page.locator("#chat-input").evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(5, 9));
    await page.locator("#chat-timeline").evaluate(node => { node.scrollTop = 100; });
    const scrollTop = await page.locator("#chat-timeline").evaluate(node => node.scrollTop);
    await captureScreenshot(page, info, `side-notice-working-${engine}`);
    release();
    await expect(notice).toHaveText("Side answer ready");
    await expect(page.locator("#chat-input")).toBeFocused();
    expect(await page.locator("#chat-input").evaluate(node => [(node as HTMLTextAreaElement).selectionStart, (node as HTMLTextAreaElement).selectionEnd])).toEqual([5, 9]);
    expect(await page.locator("#chat-timeline").evaluate(node => node.scrollTop)).toBe(scrollTop);
    expect(calls).toBe(1);
    const noticeBox = (await notice.boundingBox())!;
    const stopBox = (await page.locator("#chat-compact-workers [data-stop-task]").first().boundingBox())!;
    expect(noticeBox.height).toBeGreaterThanOrEqual(44);
    expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(stopBox.y);
    await captureScreenshot(page, info, `side-notice-ready-${engine}`);
    const native = await request.post("/__e2e/chat", { data: { action: "opencode", op: "state" } }).then(response => response.json());
    expect(native.calls.filter((call: string) => call.startsWith("POST") && /\/(generate|background|interrupt)(\?|$)/.test(call))).toEqual([expect.stringMatching(/\/generate$/)]);
    for (const scene of [{ width: 390, height: 844, visual: 450, top: 0 }, { width: 390, height: 844, visual: 380, top: 28 }, { width: 844, height: 390, visual: 230, top: 16 }]) {
      await page.setViewportSize({ width: scene.width, height: scene.height });
      await notice.tap();
      await page.evaluate(scene => {
        document.documentElement.style.setProperty("--reader-safe-top", scene.width === 390 ? "47px" : "0px");
        document.documentElement.style.setProperty("--reader-safe-bottom", scene.width === 390 ? "34px" : "21px");
        Object.assign(window.visualViewport!, { width: scene.width, height: scene.visual, offsetTop: scene.top });
        window.visualViewport!.dispatchEvent(new Event("resize")); window.visualViewport!.dispatchEvent(new Event("scroll"));
      }, scene);
      const reader = page.locator("#chat-aside-dialog");
      await expect(reader).toBeVisible();
      expect(await reader.evaluate(node => node.scrollTop)).toBe(0);
      await expect.poll(async () => (await reader.boundingBox())!.y).toBeGreaterThanOrEqual(scene.top + 11);
      const rect = (await reader.boundingBox())!;
      expect(rect.y).toBeGreaterThanOrEqual(scene.width === 390 ? 47 : scene.top + 11);
      expect(rect.y + rect.height).toBeLessThanOrEqual(scene.top + scene.visual - 11);
      expect(await reader.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      await expect(reader.locator("h1")).toHaveText("Readable answer");
      await expect(reader.locator('script, [onerror], a[href^="javascript:"]')).toHaveCount(0);
      expect(await reader.locator("table").evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
      expect(await reader.locator("a").first().getAttribute("href")).toBe("https://example.com");
      await reader.locator("strong").evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("Formatted");
      await captureScreenshot(page, info, `side-reader-mobile-${engine}-${scene.width}-vv${scene.visual}-pan${scene.top}`);
      await page.keyboard.press("Escape");
      await expect(reader).toBeHidden();
      await expect(page.locator("#chat-compact-workers")).toHaveAttribute("open");
      await expect(notice).toBeFocused();
      await expect(page.locator("#chat-input")).toHaveValue("Keep this selected draft");
    }
  } finally { await browser.close(); }
});
test("a stale side callback stays with its original conversation and switching closes its reader", async ({ page, request }) => {
  await boot(page, request);
  const original = await page.locator("#chat-conversation-select").inputValue();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/aside", async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
  await page.locator("#chat-input").fill("/btw Original conversation question");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-aside-ready")).toHaveText("Side answer…");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("#chat-state")).toContainText("Started new conversation");
  const other = await page.locator("#chat-conversation-select").inputValue();
  expect(other).not.toBe(original);
  await page.locator("#chat-input").fill("Other conversation draft");
  const done = page.waitForResponse(response => response.url().endsWith("/aside"));
  release(); await done;
  await expect(page.locator("#chat-aside-ready")).toBeHidden();
  await expect(page.locator("#chat-aside-dialog")).not.toBeVisible();
  await expect(page.locator("#chat-input")).toHaveValue("Other conversation draft");
  let releaseRead!: () => void;
  let readStarted!: () => void;
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const reading = new Promise<void>(resolve => { readStarted = resolve; });
  await page.route(`**/api/chat/conversations/${encodeURIComponent(original)}?*`, async route => {
    const response = await route.fetch(); readStarted(); await readGate; await route.fulfill({ response });
  }, { times: 1 });
  await page.locator("#chat-conversation-select").selectOption(original);
  await reading;
  try {
    await expect(page.locator("#chat-aside-ready")).toBeDisabled();
    await expect(page.locator("#chat-aside-dialog")).not.toBeVisible();
  } finally { releaseRead(); }
  await expect(page.locator("#chat-aside-ready")).toHaveText("Side answer ready");
  await expect(page.locator("#chat-aside-ready")).toBeEnabled();
  await page.locator("#chat-aside-ready").click();
  await expect(page.locator("#chat-aside-question")).toHaveText("Original conversation question");
  // Native modal UI prevents clicking behind the reader; exercise selection
  // reconciliation directly, as a deleted/reselected conversation can do.
  await page.locator("#chat-conversation-select").evaluate((node, id) => { (node as HTMLSelectElement).value = id; node.dispatchEvent(new Event("change", { bubbles: true })); }, other);
  await expect(page.locator("#chat-aside-dialog")).not.toBeVisible();
  await expect(page.locator("#chat-input")).toHaveValue("Other conversation draft");
});
test("failed side inference retains the question without changing a newer draft or replaying", async ({ page, request }) => {
  await boot(page, request);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route("**/aside", async route => { calls++; await gate; await route.fulfill({ status: 503, json: { error: "Scripted side failure" } }); });
  await page.locator("#chat-input").fill("/btw Retain this side question");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-aside-ready")).toHaveText("Side answer…");
  await page.locator("#chat-input").fill("My exact newer draft");
  release();
  await expect(page.locator("#chat-aside-ready")).toHaveText("Side question failed");
  await expect(page.locator("#chat-input")).toHaveValue("My exact newer draft");
  await page.locator("#chat-aside-ready").click();
  await expect(page.locator("#chat-aside-question")).toHaveText("Retain this side question");
  await expect(page.locator("#chat-aside-answer")).toContainText("No automatic retry");
  expect(calls).toBe(1);
});
async function boot(page: Page, request: APIRequestContext, start = true, native = true) {
  const reset = await request.post("/__e2e/reset");
  expect(reset.status()).toBe(200);
  const agents = await request.post("/__e2e/chat", { data: { action: "agents", ...(native ? { stack: "opencode-v2", backgroundPreview: true } : {}) } });
  expect(agents.status()).toBe(200);
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  if (await page.locator("html").getAttribute("data-ui-mode") === "touch") await page.locator("#touch-tab-chat").click();
  else await openChatPanel(page);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
  if (!start) return;
  await page.locator("#chat-input").fill("Start work");
  const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
  await page.locator("#chat-send").click();
  expect((await accepted).ok()).toBe(true);
  await expect(page.locator("#chat-stop")).toBeEnabled();
}
async function press(page: Page) {
  const box = (await page.locator("#chat-send").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  return box;
}
test("unsupported side generation is absent and typed /btw refuses without ordinary admission", async ({ page, request }) => {
  await boot(page, request, false, false);
  const mutations: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && /\/(prompts|aside)$/.test(request.url())) mutations.push(request.url()); });
  await page.locator("#chat-input").fill("/btw Do not send this as a prompt");
  await expect(page.locator('#chat-command-menu [data-command-name="btw"]')).toHaveCount(0);
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-composer-error")).toContainText("not supported");
  await expect(page.locator("#chat-input")).toHaveValue("/btw Do not send this as a prompt");
  expect(mutations).toEqual([]);
});
test("side question refuses and retains a real uploaded attachment", async ({ page, request }) => {
  await boot(page, request);
  const upload = page.waitForResponse(response => response.url().endsWith("/attachments") && response.request().method() === "POST");
  await page.locator("#chat-attach-input").setInputFiles({ name: "side.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=", "base64") });
  expect((await upload).status()).toBe(201);
  await page.locator("#chat-input").fill("/btw Explain the existing context");
  const mutations: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && /\/(prompts|aside)$/.test(request.url())) mutations.push(request.url()); });
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-composer-error")).toContainText("Remove pending images");
  await expect(page.locator("#chat-attachments")).toContainText("side.png");
  await expect(page.locator("#chat-input")).toHaveValue("/btw Explain the existing context");
  expect(mutations).toEqual([]);
});
test("idle hold dispatches normally without inventing a pending queue entry", async ({ page, request }) => {
  await boot(page, request, false);
  await page.locator("#chat-input").fill("Idle held draft");
  const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
  await press(page);
  expect(await (await accepted).json()).toMatchObject({ pending: false, delivery: "queue" });
  await page.mouse.up();
  await expect(page.locator(".chat-queued-message")).toHaveCount(0);
  await expect(page.locator("#chat-items")).toContainText("Idle held draft");
});
test("legacy Queue is ignored by tap and keyboard; Space hold queues without a menu", async ({ page, request }) => {
  await boot(page, request);
  await page.locator("#chat-input").fill("Tap is steer");
  await page.evaluate(() => localStorage.setItem("uatu:presentation:v1:%2F:chat-delivery", "queue"));
  await page.locator("#chat-send").click();
  await expect(page.locator('.chat-queued-message[data-delivery="steer"]')).toHaveCount(1);
  await page.locator("#chat-input").fill("Accessible queue");
  await page.locator("#chat-send").focus();
  await page.keyboard.down("Space");
  await expect(page.locator('.chat-queued-message[data-delivery="queue"]')).toHaveCount(1);
  await page.keyboard.up("Space");
  await expect(page.locator('.chat-queued-message[data-delivery="queue"]')).toHaveCount(1);
  await page.locator("#chat-input").fill("Fixed keyboard steer");
  await page.locator("#chat-input").press("Enter");
  await expect(page.locator('.chat-queued-message[data-delivery="steer"]')).toHaveCount(2);
  await page.locator("#chat-input").fill("Explicit keyboard queue");
  await page.locator("#chat-input").press("Alt+Enter");
  await expect(page.locator('.chat-queued-message[data-delivery="queue"]')).toHaveCount(2);
});
test("transient target movement during silent arming invalidates even a later tap", async ({ page, request }) => {
  await boot(page, request);
  await page.locator("#chat-input").fill("Retain after movement");
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await press(page);
  await page.clock.runFor(250);
  await page.locator("#chat-send").evaluate(node => { node.style.transform = "translateX(-20px)"; });
  await page.clock.runFor(32);
  await page.locator("#chat-send").evaluate(node => { node.style.transform = ""; });
  await page.clock.runFor(217);
  await page.mouse.up();
  await page.clock.runFor(3000);
  await expect(page.locator(".chat-queued-message")).toHaveCount(0);
  await expect(page.locator("#chat-input")).toHaveValue("Retain after movement");
});
for (const duration of [250, 499, 500]) test(`release at ${duration}ms respects arming without a duplicate native click`, async ({ page, request }) => {
  await boot(page, request);
  await page.locator("#chat-input").fill("Boundary draft");
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await press(page);
  await page.clock.runFor(duration);
  if (duration < 500) await expect(page.locator(".chat-hold-upward")).toBeHidden();
  else await expect(page.locator(".chat-hold-cap")).toHaveText("Queue\n2.0s");
  const accepted = duration < 500
    ? page.waitForResponse(response => response.url().endsWith("/prompts") && response.request().method() === "POST")
    : null;
  await page.mouse.up();
  if (accepted) {
    expect((await accepted).ok()).toBe(true);
    await page.clock.runFor(32); // Paint the acknowledged projection before advancing past stale timers.
  }
  await page.clock.runFor(3000);
  await expect(page.locator(".chat-hold-upward")).toBeHidden();
  await expect(page.locator(".chat-queued-message")).toHaveCount(duration < 500 ? 1 : 0);
  if (duration < 500) await expect(page.locator('.chat-queued-message[data-delivery="steer"]')).toHaveCount(1);
  else await expect(page.locator("#chat-input")).toHaveValue("Boundary draft");
});
test("arming delays the fixed-height countdown and queues exactly at 2500ms", async ({ page, request }, testInfo) => {
  await boot(page, request);
  await page.locator("#chat-input").fill("Held draft");
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const before = await press(page);
  await page.clock.runFor(499);
  await expect(page.locator(".chat-hold-upward")).toBeHidden();
  await expect(page.locator("#chat-send")).not.toHaveClass(/is-holding/);
  await page.clock.runFor(1);
  await expect(page.locator(".chat-hold-upward")).toBeVisible();
  const extension = (await page.locator(".chat-hold-upward").boundingBox())!;
  expect(extension.height).toBeCloseTo(before.height + 104, 0);
  await expect(page.locator(".chat-hold-cap")).toHaveText("Queue\n2.0s");
  let previousFill = 0;
  for (const elapsed of [500, 1000]) {
    await page.clock.runFor(elapsed);
    expect(await page.locator(".chat-hold-upward").boundingBox()).toEqual(extension);
    expect(await page.locator("#chat-send").boundingBox()).toEqual(before);
    const fill = await page.locator(".chat-hold-upward").evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node, "::before").transform).m22);
    expect(fill).toBeGreaterThan(previousFill);
    previousFill = fill;
  }
  const progress = await page.locator(".chat-hold-upward").evaluate(node => Number((node as HTMLElement).style.getPropertyValue("--hold-progress")));
  expect(progress).toBeGreaterThan(0.74);
  expect(progress).toBeLessThanOrEqual(0.75);
  await captureScreenshot(page, testInfo, "hold-upward");
  await page.clock.runFor(499);
  await expect(page.locator(".chat-queued-message")).toHaveCount(0);
  const accepted = page.waitForResponse(response => response.url().endsWith("/prompts") && response.request().method() === "POST");
  await page.clock.runFor(1);
  expect((await accepted).ok()).toBe(true);
  await page.clock.runFor(32);
  await expect(page.locator('.chat-queued-message[data-delivery="queue"]')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator("#chat-input")).toHaveValue("");
  await expect(page.locator(".chat-queued-message")).toHaveCount(1);
});
for (const cancellation of ["early Space release", "keyboard focus leaves Send"] as const) {
  test(`${cancellation} never sends through a later native click or timer`, async ({ page, request }) => {
    await boot(page, request);
    await page.locator("#chat-input").fill("Keep keyboard draft");
    await page.locator("#chat-send").focus();
    await page.clock.install();
    await page.keyboard.down("Space");
    await page.clock.runFor(550);
    if (cancellation === "keyboard focus leaves Send") await page.keyboard.press("Tab");
    await page.keyboard.up("Space");
    await page.clock.runFor(2100);
    await expect(page.locator(".chat-queued-message")).toHaveCount(0);
    await expect(page.locator("#chat-input")).toHaveValue("Keep keyboard draft");
    await expect(page.locator("#chat-stop")).toBeEnabled();
    await expect(page.locator(".chat-hold-upward")).toBeHidden();
  });
}
for (const cancellation of ["early release", "drag out", "Escape", "blur", "draft change", "lost capture", "pointercancel", "visibilitychange", "layout change"] as const) {
  test(`${cancellation} cancels a deliberate hold without steering`, async ({ page, request }) => {
    await boot(page, request);
    await page.locator("#chat-input").fill("Keep this draft");
    await page.clock.install();
    const box = await press(page);
    await page.clock.runFor(550); // Armed deliberate hold, not a readiness sleep.
    if (cancellation === "drag out") await page.mouse.move(box.x - 20, box.y);
    if (cancellation === "Escape") await page.keyboard.press("Escape");
    if (cancellation === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    if (cancellation === "draft change") await page.locator("#chat-input").fill("Edited draft");
    if (cancellation === "lost capture" || cancellation === "pointercancel") await page.locator("#chat-send").dispatchEvent(cancellation === "lost capture" ? "lostpointercapture" : "pointercancel");
    if (cancellation === "visibilitychange") await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    if (cancellation === "layout change") await page.locator("#chat-send").evaluate(node => { node.style.transform = "translateX(-20px)"; });
    await page.mouse.up();
    await page.clock.runFor(2100);
    await expect(page.locator(".chat-queued-message")).toHaveCount(0);
    await expect(page.locator("#chat-input")).toHaveValue(cancellation === "draft change" ? "Edited draft" : "Keep this draft");
  });
}
test("conversation selection invalidates an owned hold and retains its original draft", async ({ page, request }) => {
  await boot(page, request);
  const original = await page.locator("#chat-conversation-select").inputValue();
  await page.locator("#chat-input").fill("Original held draft");
  const before = await request.post("/__e2e/chat", { data: { action: "opencode", op: "state" } }).then(response => response.json());
  await page.clock.install();
  await press(page);
  await page.clock.runFor(350);
  // Programmatic activation changes context without a pointer drag-out first.
  await page.locator("#chat-new-conversation").evaluate((node: HTMLButtonElement) => node.click());
  await expect(page.locator("#chat-conversation-select")).not.toHaveValue(original);
  await page.clock.runFor(2100);
  await page.mouse.up();
  await page.locator("#chat-conversation-select").selectOption(original);
  await expect(page.locator("#chat-input")).toHaveValue("Original held draft");
  await expect(page.locator(".chat-queued-message")).toHaveCount(0);
  const after = await request.post("/__e2e/chat", { data: { action: "opencode", op: "state" } }).then(response => response.json());
  expect(after.calls.slice(before.calls.length).filter((call: string) => call.startsWith("POST") && /\/(prompt|interrupt|background)$/.test(call))).toEqual([]);
});
test("touch inline controls retain real labels and minimum targets", async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("uatu:presentation:v1:%2F:uatu:ui-mode", "touch"));
  await boot(page, request);
  await expect(page.locator("#chat-options-toggle, #chat-options-menu, #chat-delivery-toggle, #chat-delivery-menu")).toHaveCount(0);
  await expect(page.locator("#chat-context-usage")).toBeHidden();
  const metrics = await page.evaluate(() => Object.fromEntries(["chat-attach", "chat-configuration-trigger", "chat-send", "chat-stop"].map(id => {
    const box = document.getElementById(id)!.getBoundingClientRect();
    return [id, { width: box.width, height: box.height, right: box.right }];
  })));
  for (const box of Object.values(metrics)) { expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44); expect(box.right).toBeLessThanOrEqual(390); }
  await expect(page.locator("#chat-inline-configuration")).toContainText("Build · Fake Model");
  await captureScreenshot(page, testInfo, "inline-composer");
  await page.locator("#chat-configuration-trigger").click();
  await expect(page.locator("#chat-configuration-dialog")).toBeVisible();
  await saveEvidence(testInfo, "inline-controls.json", JSON.stringify(metrics, null, 2));
  await captureScreenshot(page, testInfo, "inline-model-chooser");
  await page.locator("#chat-configuration-done").click();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.locator("#chat-input").fill("Hold without losing this draft");
    const button = await press(page);
    await expect(page.locator(".chat-hold-upward")).toBeVisible();
    await expect.poll(() => page.locator(".chat-hold-upward").evaluate(node => Number((node as HTMLElement).style.getPropertyValue("--hold-progress")))).toBeGreaterThanOrEqual(0.25);
    expect((await page.locator(".chat-hold-upward").boundingBox())!.height).toBeCloseTo(button.height + 104, 0);
    await page.evaluate(box => {
      const finger = document.createElement("div"); finger.id = "simulated-finger";
      Object.assign(finger.style, { position: "fixed", pointerEvents: "none", zIndex: "9999", left: `${box.x + box.width / 2 - 29}px`, top: `${box.y + box.height / 2 - 29}px`, width: "58px", height: "58px", borderRadius: "50%", background: "#c6947f80", border: "1px solid #be826a99" });
      document.body.append(finger);
    }, button);
    await captureScreenshot(page, testInfo, `inline-hold-finger-${theme}`);
    await page.keyboard.press("Escape"); await page.mouse.up();
    await page.evaluate(() => document.getElementById("simulated-finger")?.remove());
    await expect(page.locator("#chat-input")).toHaveValue("Hold without losing this draft");
  }
});
test("inline context uses the latest occupancy, not output or cumulative session tokens", async ({ page, request }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("uatu:presentation:v1:%2F:uatu:ui-mode", "touch"));
  await boot(page, request, false, false);
  const conversationId = await page.locator("#chat-conversation-select").inputValue();
  const model = { providerId: "openai", modelId: "gpt-5" };
  for (const item of [
    { type: "context_report", id: "context", createdAt: 1, total: 11000, max: 100000, model },
    { type: "assistant_message", id: "earlier-usage", createdAt: 2, markdown: "Earlier call", model, usage: { input: 80000, output: 300000 } },
    { type: "assistant_message", id: "latest-usage", createdAt: 3, markdown: "Latest call", model, usage: { input: 20000, cacheRead: 5000, output: 900000 } },
  ]) expect((await request.post("/__e2e/chat", { data: { action: "item", conversationId, item } })).ok()).toBe(true);
  await expect(page.locator("#chat-inline-context")).toHaveText("25% · 25k/100k context");
  await expect(page.locator("#chat-inline-context")).toHaveAttribute("title", "25,000 tokens in context; 100,000 reported limit");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await captureScreenshot(page, info, `inline-context-known-${theme}`);
  }
});
}
for (const engine of ["chromium", "webkit"] as const) test.describe(`B composer ${engine}`, () => {
  test.use({ page: async ({ launchBrowser, baseURL }, use) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 1280, height: 720 } });
    await use(page);
    await browser.close();
  } });
  cases(engine);
});

test("native Chromium touch hold keeps capture across repaints and queues exactly once", async ({ launchBrowser, baseURL, request }, info) => {
  const browser = await launchBrowser("chromium");
  const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await request.post("/__e2e/reset");
    await request.post("/__e2e/chat", { data: { action: "agents", stack: "opencode-v2", backgroundPreview: true } });
    const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await page.locator("#touch-tab-chat").tap();
    await page.getByRole("button", { name: "New conversation", exact: true }).tap();
    await expect(page.locator("#chat-state")).toContainText("Started new conversation with OpenCode.");
    await page.locator("#chat-input").fill("Start native touch work");
    await page.locator("#chat-send").tap();
    await expect(page.locator("#chat-stop")).toBeEnabled();
    const conversationId = await page.locator("#chat-conversation-select").inputValue();
    await page.locator("#chat-input").fill("Native touch queue");
    await page.locator("#chat-input").focus();
    await page.evaluate(() => {
      const events: string[] = [];
      (window as any).__holdEvents = events;
      for (const name of ["pointerdown", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture", "contextmenu", "selectstart"])
        document.getElementById("chat-send")!.addEventListener(name, event => events.push(`${name}:${event.isTrusted}:${(event as PointerEvent).pointerType ?? ""}`));
    });
    const box = (await page.locator("#chat-send").boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
    await expect(page.locator(".chat-hold-upward")).toBeVisible();
    await expect.poll(() => page.locator(".chat-hold-upward").evaluate(node => Number((node as HTMLElement).style.getPropertyValue("--hold-progress")))).toBeGreaterThan(0.1);
    // Real live-channel repaints, not direct calls into the gesture controller.
    for (let i = 0; i < 3; i++) expect((await request.post("/__e2e/chat", { data: { action: "opencode", op: "appendHistory", conversationId, count: 1 } })).ok()).toBe(true);
    await expect(page.locator("#chat-items")).toContainText("Historical fixture answer 0");
    await expect.poll(async () => box.y - (await page.locator(".chat-hold-upward").boundingBox())!.y, { intervals: [25] }).toBeGreaterThanOrEqual(80);
    const visual = (await page.locator(".chat-hold-upward").boundingBox())!;
    expect(visual.y).toBeLessThanOrEqual(box.y - 80);
    expect(await page.locator("#chat-send").boundingBox()).toEqual(box);
    // Check every clipping ancestor, not just the nominal bar rectangle.
    expect(await page.locator(".chat-hold-upward").evaluate(node => {
      const bar = node.getBoundingClientRect();
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (/hidden|clip|auto|scroll/.test(getComputedStyle(parent).overflowY)) {
          const rect = parent.getBoundingClientRect();
          if (bar.top < rect.top || bar.bottom > rect.bottom) return false;
        }
      }
      return true;
    })).toBe(true);
    await captureScreenshot(page, info, "native-touch-held-live-repaint");
    await expect(page.locator('.chat-queued-message[data-delivery="queue"]')).toHaveCount(1);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.locator(".chat-queued-message")).toHaveCount(1);
    await expect(page.locator("#chat-input")).toHaveValue("");
    const events = await page.evaluate(() => (window as any).__holdEvents as string[]);
    expect(events).toContain("pointerdown:true:touch");
    expect(events).not.toContain("pointercancel:true:touch");
    await page.clock.install();
    for (const cancellation of ["early release", "native cancel", "drag away"] as const) {
      await page.locator("#chat-input").fill(`Keep native draft: ${cancellation}`);
      const current = (await page.locator("#chat-send").boundingBox())!;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: current.x + current.width / 2, y: current.y + current.height / 2 }] });
      await page.clock.runFor(550);
      if (cancellation === "drag away") await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: current.x - 20, y: current.y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: cancellation === "native cancel" ? "touchCancel" : "touchEnd", touchPoints: [] });
      await page.clock.runFor(2100);
      await expect(page.locator(".chat-queued-message")).toHaveCount(1);
      await expect(page.locator("#chat-input")).toHaveValue(`Keep native draft: ${cancellation}`);
      await expect(page.locator(".chat-hold-upward")).toBeHidden();
    }
    const allEvents = await page.evaluate(() => (window as any).__holdEvents as string[]);
    expect(allEvents).toContain("pointercancel:true:touch");
    expect(allEvents.some(event => event.startsWith("selectstart:"))).toBe(false);
    await saveEvidence(info, "native-touch-events.json", JSON.stringify(allEvents));
  } finally { await page.close(); }
});
