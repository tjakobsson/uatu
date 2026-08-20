// The desktop chat panel itself (chat-side-panel change): the split's
// fraction persistence, collapse/reopen retention, the narrow-viewport
// guard, find-in-chat expansion, and the terminal-framing invariants.
// Conversation behavior inside the surface lives in chat.e2e.ts /
// chat-panels.e2e.ts; this file is about the panel as a layout citizen.

import type { APIRequestContext, Page } from "@playwright/test";

import { openChatConfiguration, openChatPanel } from "./chat-helpers";
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

  test("the composer rail keeps trailing geometry across widths and routine states", async ({ page, request }) => {
    await request.post("/__e2e/chat", { data: { action: "seed", title: "Rail geometry", items: [] } });
    await page.reload();
    await openChatPanel(page);
    await expect(page.locator("#chat-configuration-trigger")).toBeEnabled();
    const conversationId = await page.locator("#chat-conversation-select").inputValue();
    const measure = () => page.evaluate(() => {
      const rect = (selector: string) => {
        const value = document.querySelector(selector)!.getBoundingClientRect();
        return { top: value.top, left: value.left, right: value.right, width: value.width, height: value.height };
      };
      return { rail: rect(".chat-composer-actions"), trigger: rect("#chat-configuration-trigger"), status: rect("#chat-composer-status"), send: rect("#chat-send") };
    });

    for (const fraction of [0.28, 0.42, 0.6]) {
      await page.evaluate(value => document.documentElement.style.setProperty("--chat-fraction", String(value)), fraction);
      await page.waitForTimeout(350);
      const ready = await measure();
      expect(ready.trigger.top + ready.trigger.height / 2).toBeCloseTo(ready.status.top + ready.status.height / 2, 0);
      expect(ready.status.top + ready.status.height / 2).toBeCloseTo(ready.send.top + ready.send.height / 2, 0);
      expect(ready.send.right).toBeLessThanOrEqual(ready.rail.right + 1);
      for (const status of ["sending", "running", "failed", "idle"] as const) {
        await request.post("/__e2e/chat", { data: { action: "status", conversationId, status, ...(status === "failed" ? { message: "fixture failure" } : {}) } });
        await expect(page.locator("#chat-composer-status")).toHaveAttribute("aria-label", status === "running" ? "Working" : status === "idle" ? "Ready" : status[0]!.toUpperCase() + status.slice(1));
        const current = await measure();
        expect(current.status.width).toBeCloseTo(ready.status.width, 1);
        expect(current.status.left).toBeCloseTo(ready.status.left, 1);
        expect(current.send.left).toBeCloseTo(ready.send.left, 1);
      }
    }
    const withoutContext = await measure();
    await request.post("/__e2e/chat", { data: {
      action: "item", conversationId,
      item: { id: "usage:rail", type: "assistant_message", createdAt: 1, markdown: "", usage: { input: 50_000 }, model: { providerId: "anthropic", modelId: "claude-sonnet" } },
    } });
    await expect(page.locator("#chat-context-usage")).toBeVisible();
    const withContext = await measure();
    expect(withContext.rail.right - withContext.status.right).toBeCloseTo(withoutContext.rail.right - withoutContext.status.right, 1);
    expect(withContext.rail.right - withContext.send.right).toBeCloseTo(withoutContext.rail.right - withoutContext.send.right, 1);
    expect(withContext.send.left - withContext.status.right).toBeCloseTo(withoutContext.send.left - withoutContext.status.right, 1);
    await expect(page.locator("#chat-composer-error")).toContainText("fixture failure");
  });

  test("wide Chat shows mode and reasoning while the shorter desktop picker stays in bounds", async ({ page, request }) => {
    await request.post("/__e2e/chat", { data: {
      action: "seed", title: "Picker geometry", items: [],
      configuration: { model: { providerId: "anthropic", modelId: "claude-sonnet" }, mode: "build", variant: "high" },
    } });
    await page.reload();
    await openChatPanel(page);
    await expect(page.locator("#chat-configuration-details")).toBeVisible();
    await expect(page.locator("#chat-configuration-mode-summary")).toHaveText("Build");
    await expect(page.locator("#chat-configuration-variant-value")).toHaveText("High");
    await expect(page.locator("#chat-configuration-variant-summary svg")).toBeVisible();
    await page.evaluate(() => document.documentElement.style.setProperty("--chat-fraction", "0.28"));
    await page.waitForTimeout(350);
    await expect(page.locator("#chat-configuration-details")).toBeHidden();
    await page.evaluate(() => document.documentElement.style.setProperty("--chat-fraction", "0.45"));
    await page.waitForTimeout(350);
    await expect(page.locator("#chat-configuration-details")).toBeVisible();
    await openChatConfiguration(page);
    await expect(page.locator("#chat-configuration-search")).toBeFocused();
    await expect(page.locator("#chat-configuration-dialog")).toHaveAttribute("data-presentation", "desktop");
    const bounds = await page.evaluate(() => {
      const surface = document.querySelector("#chat-surface")!.getBoundingClientRect();
      const dialog = document.querySelector("#chat-configuration-dialog")!.getBoundingClientRect();
      return { surface: { left: surface.left, right: surface.right, top: surface.top, bottom: surface.bottom }, dialog: { left: dialog.left, right: dialog.right, top: dialog.top, bottom: dialog.bottom } };
    });
    expect(bounds.dialog.left).toBeGreaterThanOrEqual(bounds.surface.left);
    expect(bounds.dialog.right).toBeLessThanOrEqual(bounds.surface.right);
    expect(bounds.dialog.top).toBeGreaterThanOrEqual(bounds.surface.top);
    expect(bounds.dialog.bottom).toBeLessThanOrEqual(bounds.surface.bottom);
    expect(bounds.dialog.bottom - bounds.dialog.top).toBeLessThanOrEqual(482);
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-configuration-dialog")).toBeHidden();
    await expect(page.locator("#chat-configuration-trigger")).toBeFocused();
  });
});
