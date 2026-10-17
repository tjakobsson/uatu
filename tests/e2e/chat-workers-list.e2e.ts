import type { ConversationItem } from "../../src/chat/types";
import { test as base, expect } from "./fixtures";
import { withEngineBrowsers } from "./page-diagnostics";
import { captureScreenshot } from "./evidence";
import { openChatPanel } from "./chat-helpers";

const test = withEngineBrowsers(base);

for (const engine of ["chromium", "webkit"] as const) test.describe(`canonical workers ${engine}`, () => {
  test.use({ page: async ({ launchBrowser, baseURL }, use) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await page.addInitScript(() => {
      const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    });
    await use(page); await browser.close();
  } });

  test("one finished plus twenty hidden stays compact, including after dismissal", async ({ page, request }, info) => {
    await request.post("/__e2e/reset");
    await request.post("/__e2e/chat", { data: { action: "agents", count: 2 } });
    const snapshot = await request.post("/__e2e/chat", { data: { action: "seed", agent: "claude", title: "Compact finished overview", items: Array.from({ length: 20 }, (_, i) => ({
      id: `old-${i}`, type: "background_task", taskId: `old-${i}`, description: `Earlier task ${i}`, status: "completed", createdAt: i + 1,
    })) } }).then(response => response.json());
    const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await page.locator("#touch-tab-chat").tap();
    const track = page.locator("#chat-compact-workers");
    const summary = track.locator(":scope > summary");
    const dismiss = track.getByRole("button", { name: "Dismiss finished", exact: true });
    await dismiss.tap();
    await expect(track).not.toHaveAttribute("open");
    expect((await request.post("/__e2e/chat", { data: { action: "item", conversationId: snapshot.conversation.id, item: {
      id: "new-finished", type: "background_task", taskId: "new-finished", toolUseId: "new-launch", description: "Research browser backup restore", status: "completed", createdAt: Date.now(), usage: { totalTokens: 230000, toolUses: 4, durationMs: 1000 },
    } } })).ok()).toBe(true);
    expect((await request.post("/__e2e/chat", { data: { action: "item", conversationId: snapshot.conversation.id, item: {
      id: "tool:new-launch", type: "tool", name: "task", status: "completed", createdAt: Date.now(), model: "gpt-6-astra", input: '{"description":"Research browser backup restore"}',
    } } })).ok()).toBe(true);
    await expect(page.locator("#chat-compact-workers-label")).toHaveText("1 finished");
    await summary.tap();
    await expect(track.locator(".chat-worker-model")).toHaveText("gpt-6-astra");
    await expect(track.locator(".chat-worker-tokens")).toHaveText("Σ 230k");
    for (const theme of ["light", "dark"] as const) for (const width of [390, 320]) {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(width => {
        Object.assign(window.visualViewport!, { height: 844, width });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      }, width);
      await expect(track.locator("[data-worker-id]")).toHaveCount(1);
      expect((await track.boundingBox())!.height).toBeLessThanOrEqual(60);
      const header = (await summary.boundingBox())!;
      const action = (await dismiss.boundingBox())!;
      expect(action.y).toBe(header.y);
      expect(action.x).toBeGreaterThan(header.x + header.width / 2);
      expect((await track.locator(".chat-worker-row").boundingBox())!.height).toBeLessThanOrEqual(28);
      expect(await summary.evaluate(node => getComputedStyle(node, "::before").content)).toBe('""');
      await captureScreenshot(page, info, `workers-${engine}-${theme}-${width}-one-finished-20-hidden`);
    }
    for (const scene of [
      { width: 390, height: 844, visual: 450 }, { width: 390, height: 844, visual: 380 },
      { width: 844, height: 390, visual: 230 },
    ]) {
      await page.setViewportSize({ width: scene.width, height: scene.height });
      await page.locator("#chat-input").fill("Preserve compact-card draft");
      await page.locator("#chat-input").focus();
      await page.evaluate(scene => {
        Object.assign(window.visualViewport!, { height: scene.visual, width: scene.width });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      }, scene);
      await expect(page.locator("html")).toHaveAttribute(scene.width < 600 ? "data-chat-keyboard" : "data-chat-wide-short");
      expect((await track.boundingBox())!.height).toBeLessThanOrEqual(60);
      expect((await page.locator("#chat-work-dock").boundingBox())!.height).toBeLessThanOrEqual(62);
      await expect(page.locator("#chat-input")).toBeFocused();
      await captureScreenshot(page, info, `workers-${engine}-one-finished-${scene.width}-vv${scene.visual}`);
    }
    await dismiss.tap();
    await expect(track).toBeHidden();
    await expect(track.locator("[data-worker-id]")).toHaveCount(0);
    expect((await page.locator("#chat-work-dock").boundingBox())!.height).toBeLessThanOrEqual(32);
    await expect(track).toHaveAttribute("open"); // Dismiss never toggles the parent.
    await captureScreenshot(page, info, `workers-${engine}-all-dismissed-vv230`);
    await expect(page.locator('#chat-items [data-chat-item-id="new-finished"]')).toHaveCount(1);
  });

  test("finished-only dismissal hides the whole overview and persists through reselection", async ({ page, request }) => {
    await request.post("/__e2e/reset");
    await request.post("/__e2e/chat", { data: { action: "agents", count: 2 } });
    const empty = await request.post("/__e2e/chat", { data: { action: "seed", agent: "claude", title: "Empty", items: [] } }).then(response => response.json());
    const finished = await request.post("/__e2e/chat", { data: { action: "seed", agent: "claude", title: "Finished", items: [
      { id: "failed", type: "background_task", taskId: "failed", status: "failed", description: "Failed worker", createdAt: 1 },
      { id: "stopped", type: "background_task", taskId: "stopped", status: "stopped", description: "Stopped worker", createdAt: 2 },
    ] } }).then(response => response.json());
    const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await page.locator("#touch-tab-chat").tap();
    await page.locator("#chat-conversation-select").selectOption(finished.conversation.id);
    const track = page.locator("#chat-compact-workers");
    const summary = page.locator("#chat-compact-workers-label");
    await expect(summary).toHaveText("2 finished");
    await summary.tap();
    await track.getByRole("button", { name: "Dismiss finished", exact: true }).tap();
    await expect(track).toBeHidden();
    await expect(page.locator("#chat-surface")).not.toContainText(/\d+ hidden/);
    await page.locator("#chat-conversation-select").selectOption(empty.conversation.id);
    await expect(track).toBeHidden();
    await expect(summary).toHaveText("No workers");
    await expect(track.locator(":scope > summary")).toHaveAttribute("aria-label", "Workers: No workers");
    await page.locator("#chat-conversation-select").selectOption(finished.conversation.id);
    await expect(track).toBeHidden();
    await expect(page.locator('#chat-items [data-chat-item-id="failed"]')).toHaveCount(1);
  });

  for (const theme of ["light", "dark"] as const) test(`20 mixed jobs use one readable list with reachable constrained controls (${theme})`, async ({ page, request }, info) => {
    test.setTimeout(60_000); // One fixture captures the complete viewport/theme matrix.
    await page.emulateMedia({ colorScheme: theme });
    await request.post("/__e2e/reset");
    await request.post("/__e2e/chat", { data: { action: "agents", count: 2 } });
    const child = await request.post("/__e2e/chat", { data: {
      action: "seed", agent: "claude", child: true, title: "Retained worker transcript",
      items: [{ id: "child-answer", type: "assistant_message", createdAt: 1, markdown: "Retained child inspection after dismissal." }],
    } }).then(response => response.json());
    const now = Date.now();
    const items: ConversationItem[] = [
      { id: "user", type: "user_message", createdAt: now - 1_500_000, text: "Build independent themes, audit contrast and add JSON backup and restore." },
      { id: "answer", type: "assistant_message", createdAt: now - 1_400_000, markdown: "I’ll add JSON backup and restore next, with validation and a preview before replacing any tasks. The theme work can continue separately; I’ll combine the documentation and review both changes afterwards." },
      ...Array.from({ length: 20 }, (_, index): ConversationItem => ({
        id: `job:${index}`, type: "background_task", taskId: `worker-${index}`, createdAt: now - (21 - index) * 60_000,
        description: index === 18 ? "Build independent theme module with accessible palettes and persistent preferences" : index === 19 ? "bun test contrast accessibility --reporter detailed" : ["Add three theme palettes", "Run independent contrast audit", "Write usage documentation", "Validate JSON backup and restore"][index % 4]!,
        status: index >= 18 ? "running" : index % 5 === 0 ? "failed" : index % 4 === 0 ? "stopped" : "completed",
        ...(index < 18 ? { summary: `Retained worker report ${index}` } : {}),
        ...(index === 16 ? { childConversationId: child.conversation.id } : {}),
        taskType: index === 19 || index === 17 ? "shell" : "agent", outputFile: "fixture-output",
        ...(index === 18 ? { toolUseIds: ["alias-a", "alias-b"], progress: "Editing themes/dark.css" } : {}),
      })),
      { id: "tool:alias-a", type: "tool", createdAt: now, name: "task", input: '{"description":"Launch theme worker"}', status: "completed", model: "GPT-6.1 Sol", usage: { input: 220000, output: 9000 } },
      { id: "tool:alias-b", type: "tool", createdAt: now, name: "task", input: '{"description":"Observe same execution"}', status: "completed" },
      { id: "foreground", type: "command", createdAt: now, command: "cat index.html styles.css USAGE.md; node --check app.js", status: "completed" },
    ];
    const snapshot = await request.post("/__e2e/chat", { data: { action: "seed", agent: "claude", title: "Theme implementation", items } }).then(response => response.json());
    const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await page.locator("#touch-tab-chat").tap();
    const track = page.locator("#chat-compact-workers");
    const summary = track.locator(":scope > summary");
    const label = track.locator("#chat-compact-workers-label");
    const rows = track.locator("[data-worker-id]");
    await expect(label).toHaveText("2 working · 18 finished");
    expect((await summary.boundingBox())!.height).toBeLessThanOrEqual(40);
    await expect(rows).toHaveCount(20);
    await expect(track).not.toHaveAttribute("open");
    await captureScreenshot(page, info, `workers-${engine}-${theme}-closed`);
    await summary.tap();
    await expect(track.locator("details")).toHaveCount(0);
    await expect(track.locator("ul")).toHaveCount(1);
    await expect(track.locator('[data-state="working"]')).toHaveCount(2);
    for (const row of await track.locator('[data-state="working"]').all()) {
      const inspect = (await row.locator(".chat-worker-inspect").boundingBox())!;
      const stop = (await row.locator("[data-stop-task]").boundingBox())!;
      expect(inspect.height).toBeLessThanOrEqual(28); // Only Stop needs the separate full target.
      expect(stop.height).toBeGreaterThanOrEqual(44);
      expect(stop.x - inspect.x - inspect.width).toBeGreaterThanOrEqual(8);
    }
    await expect(track).not.toContainText("node --check");
    expect(await track.locator(".chat-worker-name").evaluateAll(nodes => [...new Set(nodes.map(node => getComputedStyle(node).fontSize))])).toEqual(["14px"]);
    expect(await track.locator(".chat-worker-meta").evaluateAll(nodes => [...new Set(nodes.map(node => getComputedStyle(node).fontSize))])).toEqual(["13px"]);
    await expect.poll(() => page.locator("#chat-timeline").evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(844 * 0.4);
    await captureScreenshot(page, info, `workers-${engine}-${theme}-active-first`);
    for (const row of await track.locator('[data-state="completed"], [data-state="failed"], [data-state="stopped"]').all()) {
      expect((await row.boundingBox())!.height).toBeLessThanOrEqual(28);
    }
    expect(await rows.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.workerId))).toEqual(["job:18", "job:19", ...Array.from({ length: 18 }, (_, i) => `job:${17 - i}`)]);
    const scrollContainers = await page.locator("#chat-work-dock").evaluate(node => [node, ...node.querySelectorAll("*")].filter(element => element.getBoundingClientRect().height > 0 && /auto|scroll/.test(getComputedStyle(element).overflowY)).map(element => element.id || element.className));
    expect(scrollContainers).toEqual(["chat-work-dock"]);
    await captureScreenshot(page, info, `workers-${engine}-${theme}-history`);
    await expect(track.locator('[data-worker-id="job:18"] .chat-worker-model')).toHaveText("GPT-6.1 Sol");
    await expect(track.locator('[data-worker-id="job:18"] .chat-worker-tokens')).toHaveText("Σ 229k");
    await track.getByRole("button", { name: "Dismiss finished", exact: true }).tap();
    await expect(label).toHaveText("2 working");
    await expect(rows).toHaveCount(2);
    await page.reload();
    await page.locator("#touch-tab-chat").tap();
    await expect(label).toHaveText("2 working");
    await expect(rows).toHaveCount(2);
    if (await track.getAttribute("open") === null) await summary.tap();
    await expect(track.getByRole("button", { name: /Restore finished/ })).toHaveCount(0);
    await expect(track.getByRole("button", { name: "Dismiss finished", exact: true })).toBeHidden();
    await captureScreenshot(page, info, `workers-${engine}-${theme}-dismissed-no-restore`);
    // Dismissal changes only this overview. Provider results and timeline stay.
    await expect(page.locator('#chat-items [data-chat-item-id="job:17"]')).toHaveCount(1);
    const result = page.locator('#chat-items [data-chat-item-id="job:17"]');
    const group = result.locator("xpath=ancestor::details").first();
    if (await group.getAttribute("open") === null) await group.locator(":scope > summary").tap();
    await result.locator(":scope > summary").tap();
    await expect(result).toContainText("Retained worker report 17");
    const childResult = page.locator('#chat-items [data-chat-item-id="job:16"]');
    await childResult.locator(":scope > summary").tap();
    await childResult.locator("[data-open-conversation]").tap();
    await expect(page.locator("#chat-drilldown-items")).toContainText("Retained child inspection after dismissal.");
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-drilldown")).toBeHidden();
    await summary.tap();
    await page.locator("#chat-input").fill("Preserve this private composing draft");

    for (const scene of [
      { width: 390, height: 844, visual: 450 }, { width: 390, height: 844, visual: 380 },
      { width: 844, height: 390, visual: 390 }, { width: 844, height: 390, visual: 230 },
      { width: 667, height: 375, visual: 375 },
      { width: 320, height: 568, visual: 568 }, { width: 320, height: 568, visual: 380 },
      { width: 768, height: 1024, visual: 1024 }, { width: 768, height: 1024, visual: 700 },
      { width: 1024, height: 768, visual: 500 },
    ]) {
      await page.setViewportSize({ width: scene.width, height: scene.height });
      await page.locator("#chat-input").focus();
      await page.evaluate(scene => {
        Object.assign(window.visualViewport!, { height: scene.visual, width: scene.width });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      }, scene);
      await expect(summary).toBeVisible();
      if (scene.width < 600 && scene.visual < scene.height) {
        // Without pending work the surviving keyboard header owns the band,
        // not one half of an otherwise empty two-column summary layout.
        expect((await summary.boundingBox())!.width).toBeGreaterThan(scene.width - 50);
      }
      await summary.tap();
      const stop = track.locator('[data-state="working"] [data-stop-task]').first();
      await stop.scrollIntoViewIfNeeded();
      expect(await stop.evaluate(node => { const rect = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })).toBe(true);
      await expect(page.locator("#chat-input")).toHaveValue("Preserve this private composing draft");
      await expect(page.locator("#chat-input")).toBeFocused();
      await captureScreenshot(page, info, `workers-${engine}-${theme}-${scene.width}-vv${scene.visual}`);
      await summary.tap();
    }
    // Unknown state is a retained warning, never authority for a stop.
    await request.post("/__e2e/chat", { data: { action: "item", conversationId: snapshot.conversation.id, item: { ...items.find(item => item.id === "job:18"), stateUncertain: true } } });
    await summary.tap();
    await expect(track.locator('[data-state="unknown"] [data-stop-task]')).toBeDisabled();
    await expect(label).toHaveText("1 working · 1 unknown");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#chat-input").blur();
    await page.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 844, width: 390 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await captureScreenshot(page, info, `workers-${engine}-${theme}-unknown`);
    // The same twenty-job snapshot on a fine-pointer desktop preserves the
    // established tracks and keeps primary controls in short windows.
    const desktop = await page.context().browser()!.newPage({ viewport: { width: 1280, height: 844 }, hasTouch: false, isMobile: false, colorScheme: theme });
    try {
      const desktopUrl = new URL(page.url());
      desktopUrl.searchParams.set("t", token);
      await desktop.goto(desktopUrl.toString());
      await expect(desktop.locator("#connection-state .connection-label")).toHaveText("Connected");
      await openChatPanel(desktop);
      await desktop.locator("#chat-conversation-select").selectOption(snapshot.conversation.id);
      await expect(desktop.locator("#chat-compact-workers")).toBeHidden();
      for (const height of [844, 600, 480]) {
        await desktop.setViewportSize({ width: 1280, height });
        await expect(desktop.locator("#chat-send")).toBeVisible();
        await expect.poll(async () => (await desktop.locator("#chat-stop").boundingBox())!.y).toBeLessThan(height);
        await captureScreenshot(desktop, info, `workers-${engine}-${theme}-desktop-${height}`);
      }
    } finally { await desktop.close(); }
  });
});
