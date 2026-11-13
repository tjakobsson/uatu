import { test, expect } from "./fixtures";
import { enlargedPendingFixture } from "./enlarged-pending-fixture";
import { captureScreenshot, saveEvidence } from "./evidence";

test.use({ isMobile: true, hasTouch: true });

for (const theme of ["light", "dark"] as const) {
  test(`enlarged replacement warning remains whole in a short touch viewport: ${theme}`, async ({ page, request }, info) => {
    await enlargedPendingFixture(page, request, 320, theme);
    await page.locator("#chat-input").fill("Pause this steer with the replacement");
    const accepted = page.waitForResponse(response => response.url().endsWith("/prompts"));
    await page.locator("#chat-input").press("Control+Enter");
    expect((await accepted).ok()).toBe(true);
    const reverted = page.waitForResponse(response => response.url().endsWith("/revert"));
    await page.locator("#chat-items").getByRole("button", { name: "Revert message", exact: true }).last().click();
    expect((await reverted).ok()).toBe(true);
    await page.setViewportSize({ width: 320, height: 568 });
    const warning = page.locator("#chat-queue-note");
    await expect(warning).toContainText("delivered together with your replacement");
    await expect(page.locator("#chat-surface")).toHaveAttribute("data-work-overflow", "");
    await expect.poll(() => warning.evaluate(node => node.parentElement!.clientHeight >= node.getBoundingClientRect().height + 8)).toBe(true);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Native scrolling crosses both the Pending pane and the short surface;
    // centering avoids integer nearest-edge rounding hiding a fractional line.
    await warning.evaluate(node => node.scrollIntoView({ block: "center" }));
    await saveEvidence(info, "warning-geometry.json", JSON.stringify(await warning.evaluate(node => {
      const ancestors = [];
      for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent);
        ancestors.push({ id: parent.id || parent.tagName, box: parent.getBoundingClientRect().toJSON(), scroll: parent.scrollTop, width: parent.clientWidth, height: parent.clientHeight, overflow: css.overflow, style: parent.getAttribute("style") });
      }
      return ancestors;
    }), null, 2));
    await expect(warning).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#chat-queue")).toHaveClass(/has-more-below/);
    const paint = await warning.evaluate(node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const queue = node.closest<HTMLElement>(".chat-queue")!;
      const fade = getComputedStyle(queue, "::after");
      const fadeHeight = queue.classList.contains("has-more-below") ? parseFloat(fade.height) || 0 : 0;
      const clearBottom = queue.getBoundingClientRect().bottom - fadeHeight;
      const glyphs = [...range.getClientRects()];
      return { fadeHeight, clearBottom, lastGlyphBottom: Math.max(...glyphs.map(box => box.bottom)),
        hit: glyphs.every(box => node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))) };
    });
    await saveEvidence(info, "warning-paint-clearance.json", JSON.stringify(paint, null, 2));
    expect(paint.fadeHeight).toBe(32);
    expect(paint.lastGlyphBottom + 4).toBeLessThanOrEqual(paint.clearBottom);
    expect(paint.hit).toBe(true);
    await captureScreenshot(page, info, "warning-fade-clearance");
    const batch = page.getByRole("button", { name: "Send 1 paused steer now", exact: true });
    await batch.scrollIntoViewIfNeeded();
    expect(await batch.evaluate(node => {
      const box = node.getBoundingClientRect();
      return box.height >= 44 && node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    await page.locator("#chat-input").scrollIntoViewIfNeeded();
    await expect(page.locator("#chat-input")).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#chat-queue .chat-queued-message")).toHaveCount(4);
  });
}
