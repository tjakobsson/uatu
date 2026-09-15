import type { Page } from "@playwright/test";

/** Time the real selector change, including its handler and snapshot fetch, through
 * the target row's DOM commit. Playwright actionability and protocol waits are
 * outside this clock. A unique row prevents a loading clear from counting as done.
 */
export async function armConversationCommit(page: Page, conversationId: string, itemId: string) {
  await page.evaluate(({ conversationId, itemId }) => {
    const select = document.querySelector<HTMLSelectElement>("#chat-conversation-select")!;
    const timeline = document.querySelector("#chat-timeline")!;
    const sample: { conversationId: string; itemId: string; startedAt?: number; committedAt?: number; milliseconds?: number } = { conversationId, itemId };
    const probe = (window as any).__shellProbe;
    probe.navigation = sample;
    let observer: MutationObserver;
    const changed = (event: Event) => {
      if (event.target !== select || select.value !== conversationId) return;
      sample.startedAt = performance.now();
      document.removeEventListener("change", changed, true);
      observer = new MutationObserver(() => {
        if (!timeline.querySelector(`[data-chat-item-id="${CSS.escape(itemId)}"]`)
          || document.querySelector(".chat-shell-window")) return;
        sample.committedAt = performance.now();
        sample.milliseconds = sample.committedAt - sample.startedAt!;
        observer.disconnect();
      });
      observer.observe(timeline, { childList: true, subtree: true });
    };
    document.addEventListener("change", changed, true);
    probe.stopNavigation = () => {
      document.removeEventListener("change", changed, true);
      observer?.disconnect();
    };
  }, { conversationId, itemId });
}

export const conversationCommit = (page: Page) => page.evaluate(() => (window as any).__shellProbe.navigation as {
  conversationId: string; itemId: string; startedAt?: number; committedAt?: number; milliseconds?: number;
});

export const stopConversationCommit = (page: Page) => page.evaluate(() => (window as any).__shellProbe.stopNavigation?.());
