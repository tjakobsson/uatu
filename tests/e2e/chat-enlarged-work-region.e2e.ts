import { test, expect } from "./fixtures";
import { expectWorkControlVisible, expectWorkLayoutReady } from "./work-panel-assertions";
import { saveEvidence } from "./evidence";

for (const geometry of [
  { mode: "desktop", width: 1100, height: 700, band: 700 },
  { mode: "desktop", width: 1440, height: 480, band: 480 },
  { mode: "touch", width: 844, height: 390, band: 230 },
  { mode: "touch", width: 390, height: 844, band: 200 },
] as const) test(`enlarged work region retains native access: ${geometry.mode} ${geometry.width} band ${geometry.band}`, async ({ browser, request, baseURL }, info) => {
  const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 }, hasTouch: geometry.mode === "touch", isMobile: geometry.mode === "touch", reducedMotion: "reduce" });
  try {
    await page.addInitScript(mode => {
      localStorage.setItem("uatu:presentation:v1:%2F:uatu:ui-mode", mode);
      localStorage.setItem("uatu:presentation:v1:%2F:uatu:chat-panel", JSON.stringify({ open: true, fraction: .8 }));
      Object.defineProperty(window, "visualViewport", { configurable: true, value: Object.assign(new EventTarget(), { width: 1440, height: 1000, offsetTop: 0, offsetLeft: 0, scale: 1 }) });
    }, geometry.mode);
    await request.post("/__e2e/reset");
    await request.post("/__e2e/chat", { data: { action: "agents", stack: "opencode-v2", backgroundPreview: true } });
    const { token } = await request.get("/__e2e/terminal-token").then(r => r.json());
    await page.goto(`/?t=${encodeURIComponent(token)}`);
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
    if (geometry.mode === "touch") await page.locator("#touch-tab-chat").click();
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect(page.locator("#chat-conversation-select")).not.toHaveValue("");
    await page.locator("#chat-input").fill("Enlarged region regression");
    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-stop")).toBeEnabled();
    const conversationId = await page.locator("#chat-conversation-select").inputValue();
    for (let i = 0; i < 20; i++) {
      const { childId } = await request.post("/__e2e/chat", { data: { action: "opencode", op: "launchWorker", conversationId } }).then(r => r.json());
      if (i >= 16) await request.post("/__e2e/chat", { data: { action: "opencode", op: "settleWorker", childId, workerState: "completed" } });
    }
    for (let i = 0; i < 20; i++) {
      await page.locator("#chat-input").fill(`Pending ${i}`);
      const accepted = page.waitForResponse(r => r.url().endsWith("/prompts") && r.request().method() === "POST");
      await page.locator("#chat-input").press("Alt+Enter"); await accepted;
    }
    await expect(page.locator(".chat-queued-message")).toHaveCount(20);
    if (geometry.mode === "touch") {
      await page.locator("#chat-compact-workers > summary").click();
      await page.locator("[data-pending-toggle]").click();
    }
    await expect(page.locator("#chat-compact-workers")).toHaveAttribute("open");
    await expect(page.locator("[data-pending-toggle]")).toHaveAttribute("aria-expanded", "true");
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    await page.evaluate(g => {
      document.documentElement.style.fontSize = "200%";
      Object.assign(window.visualViewport!, { width: g.width, height: g.band });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    }, geometry);
    await expectWorkLayoutReady(page);
    if (geometry.mode === "desktop") await page.locator("#chat-work-toggle").click();
    const dock = page.locator("#chat-work-dock");
    // Only physically impossible geometry uses native outer scrolling. This
    // never focuses an action to rescue a clipped pane or enlarges inline work.
    const outer = geometry.mode === "touch" ? page.locator("#chat-surface") : dock;
    const nativeReveal = async (selector: string) => {
      await outer.evaluate((n, selector) => {
        const target = document.querySelector(selector)!;
        const box = target.getBoundingClientRect(), frame = n.getBoundingClientRect();
        if (box.top < frame.top) n.scrollTop += box.top - frame.top;
        else if (box.bottom > frame.bottom) n.scrollTop += box.bottom - frame.bottom;
      }, selector);
    };
    for (const selector of ["#chat-compact-workers > summary", "[data-pending-toggle]"]) {
      await nativeReveal(selector);
      await expectWorkControlVisible(page.locator(selector));
    }
    await page.locator("[data-pending-toggle]").click();
    await expect(page.locator("[data-pending-toggle]")).toHaveAttribute("aria-expanded", "false");
    await page.locator("[data-pending-toggle]").click();
    await expect(page.locator("[data-pending-toggle]")).toHaveAttribute("aria-expanded", "true");
    await expectWorkLayoutReady(page);
    await page.locator(".chat-queue-content").evaluate(n => n.scrollTop = n.scrollHeight);
    await nativeReveal(".chat-queued-message:last-child [data-queue-remove]");
    const remove = page.locator("[data-queue-remove]").last();
    await expectWorkControlVisible(remove);
    await remove.click();
    await expect(page.locator(".chat-queued-message")).toHaveCount(19);
    if (geometry.mode === "touch" && geometry.band === 200) await page.locator("#chat-input").fill("Preserve native focus reveal");
    for (const id of ["chat-send", "chat-stop"]) {
      await nativeReveal(`#${id}`);
      await expectWorkControlVisible(page.locator(`#${id}`));
    }
    if (geometry.mode === "touch" && geometry.band === 200) {
      // Drive the controller's 250ms settled resync and following frames
      // deterministically; an already-correct offset alone cannot prove that
      // the delayed pass preserved it.
      await page.clock.install();
      const surface = page.locator("#chat-surface");
      const evidence: unknown[] = [];
      const record = async (event: string) => evidence.push(await surface.evaluate((n, event) => ({ event, scrollTop: n.scrollTop, overflow: n.hasAttribute("data-work-overflow"), band: window.visualViewport!.height, focused: document.activeElement?.id, controls: ["chat-send", "chat-stop"].map(id => ({ id, box: document.getElementById(id)!.getBoundingClientRect().toJSON() })) }), event));
      await expect(surface).toHaveAttribute("data-work-overflow", "");
      const visibleOffset = await surface.evaluate(n => n.scrollTop);
      expect(visibleOffset).toBeGreaterThan(0);
      // Exercise the real viewport controller, including its immediate/frame/
      // settled foreground passes, without changing the visual band.
      for (const event of ["visual-resize", "visual-scroll", "resize", "focus", "pageshow", "visibilitychange", "orientationchange"]) {
        await page.evaluate(event => {
          if (event.startsWith("visual-")) window.visualViewport!.dispatchEvent(new Event(event.slice(7)));
          else if (event === "visibilitychange") document.dispatchEvent(new Event(event));
          else window.dispatchEvent(new Event(event));
        }, event);
        await page.clock.runFor(300);
        await expectWorkLayoutReady(page);
        expect(await surface.evaluate(n => n.scrollTop), event).toBe(visibleOffset);
        await expectWorkControlVisible(page.locator("#chat-send"));
        await expectWorkControlVisible(page.locator("#chat-stop"));
        await record(event);
      }
      // Native focus reveal/Tab must also survive a subsequent viewport pass.
      await page.locator("#chat-configuration-trigger").focus();
      const visited = new Set<string>();
      for (let i = 0; i < 8 && visited.size < 2; i++) {
        await page.keyboard.press("Tab");
        const id = await page.evaluate(() => document.activeElement?.id);
        if (id !== "chat-send" && id !== "chat-stop") continue;
        visited.add(id);
        await expectWorkControlVisible(page.locator(`#${id}`));
        const offset = await surface.evaluate(n => n.scrollTop);
        for (let resize = 0; resize < 2; resize++) {
          await page.evaluate(() => window.visualViewport!.dispatchEvent(new Event("resize")));
          await page.clock.runFor(300);
          await expectWorkLayoutReady(page);
          await expect(page.locator(`#${id}`)).toBeFocused();
          await expectWorkControlVisible(page.locator(`#${id}`));
          expect(await surface.evaluate(n => n.scrollTop)).toBe(offset);
          await record(`native-tab-${id}-resize-${resize}`);
        }
      }
      expect([...visited].sort()).toEqual(["chat-send", "chat-stop"]);
      await page.locator("#chat-stop").evaluate(n => n.scrollIntoView({ block: "nearest" }));
      const offset = await surface.evaluate(n => n.scrollTop);
      await page.evaluate(() => window.dispatchEvent(new Event("resize")));
      await page.clock.runFor(300);
      await expectWorkLayoutReady(page);
      expect(await surface.evaluate(n => n.scrollTop)).toBe(offset);
      await expectWorkControlVisible(page.locator("#chat-stop"));
      await record("scrollIntoView-resize");
      // The exception ends when the keyboard band can fit the actual minima.
      await page.evaluate(() => { Object.assign(window.visualViewport!, { height: 844 }); window.visualViewport!.dispatchEvent(new Event("resize")); });
      await expect(surface).not.toHaveAttribute("data-work-overflow");
      await expect.poll(() => surface.evaluate(n => n.scrollTop)).toBe(0);
      await record("exception-ended");
      await saveEvidence(info, "physical-minimum-resync.json", JSON.stringify(evidence, null, 2));
    }
    expect(await page.locator("html").evaluate(n => getComputedStyle(n).fontSize)).toBe("32px");
  } finally { await page.close(); }
});
