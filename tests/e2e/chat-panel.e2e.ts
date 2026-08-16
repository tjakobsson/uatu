// The desktop chat panel itself (chat-side-panel change): the split's
// fraction persistence, collapse/reopen retention, the narrow-viewport
// guard, find-in-chat expansion, and the terminal-framing invariants.
// Conversation behavior inside the surface lives in chat.e2e.ts /
// chat-panels.e2e.ts; this file is about the panel as a layout citizen.

import type { APIRequestContext, Page } from "@playwright/test";

import { openChatPanel } from "./chat-helpers";
import { expect, test } from "./fixtures";

const FIND = "ControlOrMeta+f";

async function boot(page: Page, request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset");
  const token = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token.token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
}

function fractionOf(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.documentElement.style.getPropertyValue("--chat-fraction")));
}

test.describe("desktop chat panel layout", () => {
  test.beforeEach(async ({ page, request }) => boot(page, request));

  test("boots collapsed to the strip, and Preview and Chat are co-visible once opened", async ({ page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-chat-panel", "collapsed");
    await expect(page.locator("#chat-expand")).toBeVisible();
    await expect(page.locator("#chat-timeline")).toBeHidden();

    await openChatPanel(page);
    await expect(page.locator(".preview-shell")).toBeVisible();
    await expect(page.locator("#chat-timeline")).toBeVisible();
    // The retired segmented switch must not resurface.
    await expect(page.locator(".main-surface-switch")).toHaveCount(0);
  });

  test("the dragged split fraction survives collapse, reopen, and reload", async ({ page }) => {
    await openChatPanel(page);
    const row = await page.locator(".work-row").boundingBox();
    const divider = await page.locator("#chat-resizer").boundingBox();
    if (!row || !divider) throw new Error("split layout did not mount");
    const y = divider.y + divider.height / 2;
    await page.mouse.move(divider.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(row.x + row.width * 0.5, y, { steps: 6 });
    await page.mouse.up();
    const dragged = await fractionOf(page);
    expect(dragged).toBeGreaterThan(0.45);

    await page.locator("#chat-collapse").click();
    await expect(page.locator("html")).toHaveAttribute("data-chat-panel", "collapsed");
    await page.locator("#chat-expand").click();
    await expect(page.locator("html")).toHaveAttribute("data-chat-panel", "open");
    expect(await fractionOf(page)).toBeCloseTo(dragged, 5);

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-chat-panel", "open");
    expect(await fractionOf(page)).toBeCloseTo(dragged, 5);
  });

  test("a narrow viewport yields to Preview and restores the panel on growth", async ({ page }) => {
    await openChatPanel(page);
    await page.setViewportSize({ width: 880, height: 720 });
    await expect(page.locator("html")).toHaveAttribute("data-chat-panel", "collapsed");
    // The yield must not overwrite the preference: growing restores the panel.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator("html")).toHaveAttribute("data-chat-panel", "open");
  });

  test("find over chat expands a collapsed panel", async ({ page }) => {
    await openChatPanel(page);
    // Claim the chat surface, then collapse from its own header — the claim
    // survives the collapse, so the next find targets chat.
    await page.locator("#chat-timeline").click();
    await page.locator("#chat-collapse").click();
    await expect(page.locator("html")).toHaveAttribute("data-chat-panel", "collapsed");

    await page.keyboard.press(FIND);
    await expect(page.locator("html")).toHaveAttribute("data-chat-panel", "open");
    // `#find-bar` is the zero-height sticky wrapper — never "visible" in its
    // own right; the query input is the visible part (same as find.e2e.ts).
    await expect(page.locator("#find-query")).toBeVisible();
    await expect(page.locator("#find-query")).toBeFocused();
    await expect(page.locator("#chat-find-slot #find-bar")).toHaveCount(1);
  });

  test("the terminal keeps its edges: bottom spans both surfaces, right keeps the right edge", async ({ page }) => {
    await openChatPanel(page);
    await page.keyboard.press("Control+`");
    const terminal = page.locator("#terminal-panel");
    await expect(terminal).toBeVisible();

    // Bottom dock: a full-width strip beneath the Preview|Chat pair.
    const bottomBoxes = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return { chat: rect("#chat-surface"), terminal: rect("#terminal-panel"), row: rect(".work-row") };
    });
    expect(bottomBoxes.terminal.top).toBeGreaterThanOrEqual(bottomBoxes.row.bottom - 1);
    expect(bottomBoxes.terminal.right).toBeGreaterThan(bottomBoxes.chat.left);

    // Right dock: the terminal owns the rightmost pixels; Chat sits between
    // Preview and the terminal.
    await page.locator("#terminal-dock-toggle").click();
    await expect.poll(async () => (await page.evaluate(() => document.querySelector("#terminal-panel")?.getAttribute("data-dock")))).toBe("right");
    const rightBoxes = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return { preview: rect(".preview-shell"), chat: rect("#chat-surface"), terminal: rect("#terminal-panel"), width: window.innerWidth };
    });
    expect(rightBoxes.terminal.right).toBeGreaterThanOrEqual(rightBoxes.width - 1);
    expect(rightBoxes.chat.left).toBeGreaterThanOrEqual(rightBoxes.preview.right);
    expect(rightBoxes.terminal.left).toBeGreaterThanOrEqual(rightBoxes.chat.right);
  });
});
