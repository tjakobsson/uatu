import { test as base, expect } from "./fixtures";
import { attachPageDiagnosticsOnFailure, withEngineBrowsers } from "./page-diagnostics";
import { expectWorkControlVisible, expectWorkLayoutReady } from "./work-panel-assertions";
import { captureScreenshot, saveEvidence } from "./evidence";

const test = withEngineBrowsers(base);
attachPageDiagnosticsOnFailure(test);

for (const engine of ["chromium", "webkit"] as const) {
  for (const enlarged of [false, true]) test(`header taps expose short-screen actions without focus assistance: ${engine} ${enlarged ? 200 : 100}%`, async ({ launchBrowser, request, baseURL }, info) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
    await page.addInitScript(() => Object.defineProperty(window, "visualViewport", { configurable: true, value: Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 }) }));
    try {
      await request.post("/__e2e/reset");
      await request.post("/__e2e/chat", { data: { action: "agents", stack: "opencode-v2", backgroundPreview: true } });
      const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
      await page.goto(`/?t=${encodeURIComponent(token)}`);
      await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
      await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
      await page.locator("#touch-tab-chat").tap();
      await expect(page.locator("#touch-tab-chat")).toHaveAttribute("aria-selected", "true");
      await page.getByRole("button", { name: "New conversation", exact: true }).tap();
      await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
      await page.locator("#chat-input").fill("Check independent action access");
      await page.locator("#chat-send").tap();
      await expect(page.locator("#chat-stop")).toBeEnabled();
      const conversationId = await page.locator("#chat-conversation-select").inputValue();
      for (let i = 0; i < 12; i++) await request.post("/__e2e/chat", { data: { action: "opencode", op: "launchWorker", conversationId } });
      for (let i = 0; i < 10; i++) {
        await page.locator("#chat-input").fill(`Follow-up ${i}`);
        const accepted = page.waitForResponse(r => r.url().endsWith("/prompts") && r.request().method() === "POST");
        await page.locator("#chat-input").press("Alt+Enter"); await accepted;
        await expect(page.locator(".chat-queued-message")).toHaveCount(i + 1);
      }
      const workers = page.locator("#chat-compact-workers > summary"), pending = page.locator("[data-pending-toggle]");
      await workers.tap(); await pending.tap();
      const offsets = () => page.evaluate(() => Object.fromEntries(["chat-compact-workers-items", "chat-queue-content", "chat-work-dock", "chat-timeline"].map(id => [id, document.getElementById(id)!.scrollTop])));
      await page.locator("#chat-compact-workers-items").evaluate(n => n.scrollTop = 140);
      await page.locator("#chat-queue-content").evaluate(n => n.scrollTop = 140);
      const before = await offsets();
      expect(before["chat-timeline"]).toBeGreaterThan(0);
      // A final-position poll misses a transient clamp followed by the owner's
      // correction in the same render. Record the native position *before*
      // each assignment as well as the mutation microtask and next paint.
      await page.evaluate(() => {
        const timeline = document.getElementById("chat-timeline")!;
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
        const samples: Array<{ phase: string; top: number; range: number }> = [];
        const read = (phase: string) => samples.push({ phase, top: descriptor.get!.call(timeline), range: timeline.scrollHeight - timeline.clientHeight });
        Object.assign(window, { pendingCloseSamples: samples });
        Object.defineProperty(timeline, "scrollTop", { configurable: true, get() { return descriptor.get!.call(this); }, set(top) {
          read("before-position-write"); descriptor.set!.call(this, top);
        } });
        Object.assign(window, { pendingCloseDone: new Promise<void>(resolve => {
          const observer = new MutationObserver(() => {
            if (document.getElementById("chat-queue")!.dataset.expanded === "false") {
              read("mutation"); observer.disconnect();
              requestAnimationFrame(() => { read("frame"); delete (timeline as unknown as { scrollTop?: number }).scrollTop; resolve(); });
            }
          });
          observer.observe(document.getElementById("chat-queue")!, { attributes: true, attributeFilter: ["data-expanded"] });
        }) });
      });
      await pending.tap(); await expect(pending).toHaveAttribute("aria-expanded", "false");
      await page.evaluate(() => (window as unknown as { pendingCloseDone: Promise<void> }).pendingCloseDone);
      const pendingClose = await page.evaluate(() => (window as unknown as { pendingCloseSamples: Array<{ phase: string; top: number; range: number }> }).pendingCloseSamples);
      await saveEvidence(info, "pending-close-geometry.json", JSON.stringify({ before, samples: pendingClose }, null, 2));
      expect(pendingClose.some(sample => sample.phase === "mutation")).toBe(true);
      expect(pendingClose.some(sample => sample.phase === "frame")).toBe(true);
      for (const sample of pendingClose) {
        expect(sample.range).toBeGreaterThanOrEqual(before["chat-timeline"]!);
        expect(sample.top).toBe(before["chat-timeline"]);
      }
      await pending.tap(); await expect(pending).toHaveAttribute("aria-expanded", "true");
      await expect.poll(offsets).toEqual(before);
      await workers.tap(); await expect(page.locator("#chat-compact-workers")).not.toHaveAttribute("open");
      await workers.tap(); await expect(page.locator("#chat-compact-workers")).toHaveAttribute("open", "");
      await expect.poll(offsets).toEqual(before);

      // Read the native [open] mutation in its microtask, before the deferred
      // `toggle` handler can remeasure allocation or restore a clamped anchor.
      // Pending is long enough to reclaim the closed card's entire share.
      const nativeBefore = await page.evaluate(() => {
        const timeline = document.getElementById("chat-timeline")!;
        timeline.scrollTop = Math.min(60, timeline.scrollHeight - timeline.clientHeight);
        const read = () => ({ top: timeline.scrollTop, range: timeline.scrollHeight - timeline.clientHeight,
          dock: document.getElementById("chat-work-dock")!.getBoundingClientRect().height,
          pending: document.getElementById("chat-queue")!.getBoundingClientRect().height });
        const samples: ReturnType<typeof read>[] = [];
        Object.assign(window, { nativeCloseGeometry: samples });
        const observer = new MutationObserver(() => {
          if (!document.querySelector<HTMLDetailsElement>("#chat-compact-workers")!.open) {
            samples.push(read()); observer.disconnect();
          }
        });
        observer.observe(document.getElementById("chat-compact-workers")!, { attributes: true, attributeFilter: ["open"] });
        return read();
      });
      expect(nativeBefore.top).toBeGreaterThan(0);
      await workers.tap();
      await expect(page.locator("#chat-compact-workers")).not.toHaveAttribute("open");
      const nativeClose = await page.evaluate(() => (window as unknown as { nativeCloseGeometry: typeof nativeBefore[] }).nativeCloseGeometry);
      await saveEvidence(info, "native-close-geometry.json", JSON.stringify({ before: nativeBefore, samples: nativeClose }, null, 2));
      expect(nativeClose).toHaveLength(1);
      expect(nativeClose[0]!.range).toBeGreaterThanOrEqual(nativeBefore.top);
      expect(nativeClose[0]!.top).toBe(nativeBefore.top);
      expect(nativeClose[0]!.dock).toBeCloseTo(nativeBefore.dock, 0);
      expect(nativeClose[0]!.pending).toBeGreaterThan(nativeBefore.pending);
      await expect.poll(() => page.locator("#chat-timeline").evaluate(n => n.scrollTop)).toBe(nativeBefore.top);
      await workers.tap();
      await expect(page.locator("#chat-compact-workers")).toHaveAttribute("open", "");

      await page.getByRole("button", { name: "New conversation", exact: true }).tap();
      await expect(page.locator("#chat-conversation-select")).not.toHaveValue(conversationId);
      await page.locator("#chat-input").fill("A separate conversation");
      await page.locator("#chat-send").tap();
      await expect(page.locator("#chat-stop")).toBeEnabled();
      await page.locator("#chat-input").fill("Separate pending entry");
      const separate = page.waitForResponse(r => r.url().endsWith("/prompts") && r.request().method() === "POST");
      await page.locator("#chat-input").press("Alt+Enter"); await separate;
      await pending.tap();
      await expect.poll(() => page.locator("#chat-queue-content").evaluate(n => n.scrollTop)).toBe(0);
      await page.locator("#chat-conversation-select").selectOption(conversationId);
      await expect(page.locator(".chat-queued-message")).toHaveCount(10);
      await expect(pending).toHaveAttribute("aria-expanded", "true");
      await expect.poll(() => page.locator("#chat-queue-content").evaluate(n => n.scrollTop)).toBe(140);

      if (enlarged) await page.addStyleTag({ content: "html { font-size: 200% !important }" });
      await page.setViewportSize({ width: 844, height: 390 });
      await page.evaluate(() => { Object.assign(window.visualViewport!, { width: 844, height: 230 }); window.visualViewport!.dispatchEvent(new Event("resize")); });
      await expectWorkLayoutReady(page);
      await saveEvidence(info, "short-minimum-geometry.json", JSON.stringify(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#chat-surface > *, #chat-compact-workers > summary, #chat-compact-workers-items, #chat-queue, #chat-queue-content, #chat-composer > *")].map(n => ({ id: n.id, tag: n.tagName, box: n.getBoundingClientRect().toJSON(), style: n.getAttribute("style"), min: getComputedStyle(n).minHeight, max: getComputedStyle(n).maxHeight, gap: getComputedStyle(n).rowGap, scrollHeight: n.scrollHeight }))), null, 2));
      await expectWorkControlVisible(workers); await expectWorkControlVisible(pending);
      // Native header activation, not action.focus(), must lend this pane a
      // whole action row even when the other expanded body consumes the band.
      await pending.tap(); await expect(pending).toHaveAttribute("aria-expanded", "false");
      await pending.tap(); await expect(pending).toHaveAttribute("aria-expanded", "true");
      await expect.poll(() => page.locator("#chat-queue-content").evaluate(n => n.clientHeight)).toBeGreaterThanOrEqual(await page.locator("[data-queue-remove]").first().evaluate(n => n.getBoundingClientRect().height));
      await page.locator("#chat-queue-content").evaluate(n => n.scrollTop = n.scrollHeight);
      const remove = page.locator("[data-queue-remove]").last();
      await expectWorkControlVisible(remove);
      const removal = page.waitForResponse(r => r.request().method() === "DELETE" && r.url().includes("/queue/"));
      await remove.tap(); expect((await removal).ok()).toBe(true);
      await expect(page.locator(".chat-queued-message")).toHaveCount(9);
      await workers.tap(); await workers.tap();
      await page.locator("#chat-compact-workers-items").evaluate(n => n.scrollTop = 0);
      const stop = page.locator("#chat-compact-workers [data-stop-task]").first();
      await expectWorkControlVisible(stop);
      await expectWorkControlVisible(workers); await expectWorkControlVisible(pending);
      await expectWorkControlVisible(page.locator("#chat-configuration-trigger"));
      await expectWorkControlVisible(page.locator("#chat-attach"));
      await expectWorkControlVisible(page.locator("#chat-send"));
      await expectWorkControlVisible(page.locator("#chat-stop"));
      await page.locator("#chat-stop").tap();
      await expect(page.getByRole("dialog", { name: "Stop parent?" })).toBeVisible();
      await page.getByRole("button", { name: "Cancel", exact: true }).tap();
      await expect(page.locator("#chat-stop")).toBeEnabled();
      await saveEvidence(info, "interaction-geometry.json", JSON.stringify(await page.locator("#chat-work-dock").evaluate(n => ({ style: n.getAttribute("style"), active: n.getAttribute("data-work-active"), children: [...n.children].map(c => ({ id: c.id, box: c.getBoundingClientRect().toJSON() })) })), null, 2));
      await captureScreenshot(page, info, `header-actions-${engine}-${enlarged ? 200 : 100}`);
    } finally { await page.close(); }
  });
}
