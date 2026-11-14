import { test as baseTest, expect } from "./fixtures";
import { withEngineBrowsers, attachPageDiagnosticsOnFailure } from "./page-diagnostics";
import { openChatPanel } from "./chat-helpers";
import { settleScroll } from "./chat-shell-helpers";

const test = withEngineBrowsers(baseTest);
attachPageDiagnosticsOnFailure(test);

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine}: request navigation interrupts active forward catch-up @perf`, async ({ launchBrowser, request, baseURL }, info) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 900 } });
    try {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await request.post("/__e2e/reset");
      const tail = "Transcript content below the pending request.\n\n".repeat(100);
      const seeded = await request.post("/__e2e/chat", { data: { action: "seed", title: "Request navigation", items: [
        { id: "navigation:lead", type: "assistant_message", createdAt: 1, markdown: "Context before the request." },
        { id: "permission:navigation", type: "permission", createdAt: 2, requestId: "navigation", action: "bash", resources: ["synthetic command"], status: "pending" },
        { id: "navigation:tail", type: "assistant_message", createdAt: 3, markdown: tail },
      ] } }).then(response => response.json());
      const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
      await page.goto(`/?t=${encodeURIComponent(token)}`);
      await openChatPanel(page);
      await page.locator("#chat-conversation-select").selectOption(seeded.conversation.id);
      const timeline = page.locator("#chat-timeline");
      const card = page.locator('[data-chat-item-id="permission:navigation"]');
      await expect.poll(() => timeline.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
      await settleScroll(timeline);
      await expect(page.locator("#chat-requests-jump")).toHaveAttribute("data-request-target", "permission:navigation");

      // Arm the public pill action before the update. Its scroll event invokes
      // the handler while forward catch-up is demonstrably unfinished, rather
      // than racing a remote click against the short animation deadline.
      await timeline.evaluate(node => {
        const state = { triggered: false, beforeTop: node.scrollTop, gap: 0, targetOffset: 0 };
        Object.assign(window, { __requestNavigationProbe: state });
        const navigate = () => {
          const target = node.querySelector<HTMLElement>('[data-chat-item-id="permission:navigation"]');
          const pill = document.querySelector<HTMLButtonElement>("#chat-requests-jump");
          if (!target || !pill || pill.dataset.requestTarget !== "permission:navigation") return;
          const band = node.getBoundingClientRect();
          const rect = target.getBoundingClientRect();
          const gap = node.scrollHeight - node.clientHeight - node.scrollTop;
          if (node.scrollTop <= state.beforeTop + 1 || gap <= 600 || rect.top <= band.bottom + 20) return;
          state.triggered = true;
          state.gap = gap;
          state.targetOffset = rect.top - band.top;
          node.removeEventListener("scroll", navigate);
          pill.click();
        };
        node.addEventListener("scroll", navigate, { passive: true });
      });
      await request.post("/__e2e/chat", { data: { action: "item", conversationId: seeded.conversation.id, item: {
        id: "navigation:lead", type: "assistant_message", createdAt: 1,
        markdown: "New streamed context before the request.\n\n".repeat(300),
      } } });
      const probe = () => page.evaluate(() => (window as unknown as {
        __requestNavigationProbe: { triggered: boolean; gap: number; targetOffset: number };
      }).__requestNavigationProbe);
      await expect.poll(async () => (await probe()).triggered).toBe(true);
      expect((await probe()).gap).toBeGreaterThan(600);
      await expect(card).toBeFocused();
      const placement = () => card.evaluate(node => {
        const band = document.getElementById("chat-timeline")!.getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        return { top: rect.top - band.top, bottom: rect.bottom - band.bottom };
      });
      await expect.poll(async () => (await placement()).top).toBeGreaterThanOrEqual(-1);
      await expect.poll(async () => (await placement()).bottom).toBeLessThanOrEqual(1);
      await settleScroll(timeline);
      const revealed = await placement();

      await request.post("/__e2e/chat", { data: { action: "item", conversationId: seeded.conversation.id, item: {
        id: "navigation:tail", type: "assistant_message", createdAt: 3, markdown: tail + "Later output after navigation.\n\n".repeat(30),
      } } });
      await expect(page.locator('[data-chat-item-id="navigation:tail"]')).toContainText("Later output after navigation.");
      await settleScroll(timeline);
      const retained = await placement();
      expect(retained.top).toBeGreaterThanOrEqual(-1);
      expect(retained.bottom).toBeLessThanOrEqual(1);
      expect(Math.abs(retained.top - revealed.top)).toBeLessThanOrEqual(2);
      await info.attach("request-navigation-geometry", { body: JSON.stringify({ probe: await probe(), revealed, retained }), contentType: "application/json" });
    } finally {
      await browser.close();
    }
  });
}
