import type { APIRequestContext, Page } from "@playwright/test";
import type { ChatModel } from "../../src/chat/types";
import { expect, test as base } from "./fixtures";
import { attachPageDiagnosticsOnFailure, withEngineBrowsers } from "./page-diagnostics";
import { captureScreenshot, saveEvidence } from "./evidence";

const test = withEngineBrowsers(base);
attachPageDiagnosticsOnFailure(test);

async function bootPicker(page: Page, request: APIRequestContext, count: number) {
  expect((await request.post("/__e2e/reset")).ok()).toBe(true);
  const models: ChatModel[] = Array.from({ length: count }, (_, index) => ({
    selection: { providerId: "fixture", modelId: `model-${index + 1}` },
    provider: "Fixture Provider", name: `Model ${index + 1}`, variants: ["high"],
  }));
  for (const data of [
    { action: "models", models },
    { action: "seed", title: "Mobile model choices", items: [], configuration: { model: models[0]!.selection, mode: "build" } },
  ]) expect((await request.post("/__e2e/chat", { data })).ok()).toBe(true);
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json());
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "touch");
  await page.locator("#touch-tab-chat").tap();
  await expect(page.locator("#chat-state")).not.toContainText("Loading chat");
  await expect(page.locator("#chat-configuration-trigger")).toContainText("Model 1");
}

async function pickerGeometry(page: Page) {
  return page.evaluate(() => {
    const rect = (element: Element) => element.getBoundingClientRect().toJSON();
    const rows = [...document.querySelectorAll<HTMLButtonElement>(".chat-configuration-model")].map(row => {
      const box = row.getBoundingClientRect();
      let top = window.visualViewport?.offsetTop ?? 0;
      let bottom = top + (window.visualViewport?.height ?? innerHeight);
      let left = 0, right = innerWidth;
      for (let parent = row.parentElement; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
          top = Math.max(top, bounds.top + parent.clientTop);
          bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
        }
        if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
          left = Math.max(left, bounds.left + parent.clientLeft);
          right = Math.min(right, bounds.left + parent.clientLeft + parent.clientWidth);
        }
      }
      const hit = (x: number, y: number) => row.contains(document.elementFromPoint(x, y));
      const complete = !row.disabled && box.height >= 44 && box.top >= top - 1 && box.bottom <= bottom + 1
        && box.left >= left - 1 && box.right <= right + 1
        && hit(box.x + box.width / 2, box.top + 2) && hit(box.x + box.width / 2, box.bottom - 2);
      return { name: row.querySelector(".chat-configuration-model-name")?.textContent, box: rect(row), clip: { top, bottom, left, right }, complete };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight, visualHeight: window.visualViewport?.height },
      parts: Object.fromEntries([".chat-configuration-sheet", "#chat-configuration-models-section", "#chat-configuration-search", "#chat-configuration-result-status", "#chat-configuration-models", ".chat-configuration-footer"].map(selector => {
        const node = document.querySelector<HTMLElement>(selector)!;
        return [selector, { box: rect(node), clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop }];
      })),
      rows,
      completeRows: rows.filter(row => row.complete).length,
    };
  });
}

for (const engine of ["chromium", "webkit"] as const) test.describe(`mobile model list clipping ${engine}`, () => {
  test.use({ page: async ({ launchBrowser, baseURL }, use) => {
    const browser = await launchBrowser(engine);
    const page = await browser.newPage({
      baseURL, viewport: { width: 393, height: 704 }, screen: { width: 393, height: 852 },
      hasTouch: true, isMobile: true, deviceScaleFactor: 3, reducedMotion: "reduce",
    });
    await use(page);
    await browser.close();
  } });

  test("shows whole model rows at 704px and 360px heights and lets touch users scroll and select", async ({ page, request }, info) => {
    await bootPicker(page, request, 2);

    // First check browser-chrome height, then a keyboard-sized visible area.
    // Both are native viewport resizes, without CSS or viewport API mocks.
    await page.locator("#chat-configuration-trigger").tap();
    await expect(page.locator("#chat-configuration-dialog")).toBeVisible();
    await expect(page.locator("#chat-configuration-result-status")).toHaveText("2 models");
    await expect(page.locator(".chat-configuration-model")).toHaveCount(2);
    await page.evaluate(() => document.fonts.ready);
    const roomy = await pickerGeometry(page);
    await saveEvidence(info, "picker-roomy.json", JSON.stringify(roomy, null, 2));
    await captureScreenshot(page, info, "picker-roomy");
    expect.soft(roomy.completeRows, "at least two complete, hit-testable 44px model rows at browser-chrome height").toBeGreaterThanOrEqual(2);
    await page.locator("#chat-configuration-done").tap();

    await page.setViewportSize({ width: 393, height: 360 });
    await page.locator("#chat-configuration-trigger").tap();
    await expect(page.locator("#chat-configuration-dialog")).toBeVisible();
    await captureScreenshot(page, info, "picker-initial");
    const initial = await pickerGeometry(page);
    await saveEvidence(info, "picker-initial.json", JSON.stringify(initial, null, 2));
    // Even when height is reduced, at least one complete touch row must fit;
    // a partially painted first model is not a fully readable choice.
    expect.soft(initial.completeRows, "at least one complete, hit-testable 44px model row above the fixed footer at reduced height").toBeGreaterThanOrEqual(1);

    const last = page.locator(".chat-configuration-model").last();
    await last.scrollIntoViewIfNeeded();
    const scrolled = await pickerGeometry(page);
    await saveEvidence(info, "picker-scrolled.json", JSON.stringify(scrolled, null, 2));
    await captureScreenshot(page, info, "picker-scrolled");
    expect.soft(scrolled.rows.at(-1)!.complete, "the last model is fully exposed after scrolling").toBe(true);
    expect.soft(scrolled.parts["#chat-configuration-models"]!.scrollTop, "the model list actually scrolls").toBeGreaterThan(0);
    await last.tap();
    await expect(last).toHaveAttribute("aria-pressed", "true");
    await page.locator("#chat-configuration-done").tap();
    await expect(page.locator("#chat-configuration-dialog")).toBeHidden();
    await expect(page.locator("#chat-configuration-trigger")).toContainText("Model 2");
  });

  test("recovers complete model rows when the visible viewport expands with the picker open", async ({ page, request }, info) => {
    await bootPicker(page, request, 8);
    await page.locator("#chat-configuration-trigger").tap();
    await expect(page.locator("#chat-configuration-done")).toBeFocused();
    await page.setViewportSize({ width: 393, height: 360 });
    await expect.poll(() => page.locator("#chat-surface").evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(360);
    await captureScreenshot(page, info, "lifecycle-short");
    await page.setViewportSize({ width: 393, height: 704 });
    await expect.poll(() => page.locator("#chat-surface").evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(640);
    await captureScreenshot(page, info, "lifecycle-expanded");
    const expanded = await pickerGeometry(page);
    await saveEvidence(info, "lifecycle-expanded.json", JSON.stringify(expanded, null, 2));
    expect.soft(expanded.completeRows, "the restored portrait height must expose multiple complete models, not retain the short-height list").toBeGreaterThanOrEqual(3);
    const last = page.locator(".chat-configuration-model").last();
    await last.scrollIntoViewIfNeeded();
    expect((await pickerGeometry(page)).rows.at(-1)!.complete, "the last model is fully readable after the viewport expands").toBe(true);
    await last.tap();
    await page.locator("#chat-configuration-done").tap();
    await expect(page.locator("#chat-configuration-dialog")).toBeHidden();
    await expect(page.locator("#chat-configuration-trigger")).toContainText("Model 8");
  });
});
