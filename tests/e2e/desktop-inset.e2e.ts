// SPA side of the desktop titlebar-inset contract: when the wrapper stamps
// `uatu-desktop-host` + `--titlebar-inset` on <html>, the app's own chrome
// clears the covered strip while scrolled content flows beneath it; without
// the marker, layout is byte-identical to the plain browser. The Swift side
// (script injection, contentLayoutRect tracking) is verified manually in
// the app. Spec: openspec/changes/add-desktop-glass-titlebar/specs/.

import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import { treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

const INSET = 52;

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

async function applyInsetMarker(page: Page, inset: number): Promise<void> {
  await page.evaluate(px => {
    document.documentElement.classList.add("uatu-desktop-host");
    document.documentElement.style.setProperty("--titlebar-inset", `${px}px`);
  }, inset);
}

async function chromeTops(page: Page): Promise<{ sidebarHeader: number; previewHeader: number }> {
  return page.evaluate(() => ({
    sidebarHeader: document.querySelector(".sidebar-header")!.getBoundingClientRect().top,
    previewHeader: document.querySelector(".preview-header")!.getBoundingClientRect().top,
  }));
}

test("without the marker, layout matches the plain browser", async ({ page }) => {
  const before = await chromeTops(page);
  // Setting only the variable (no marker class) must change nothing.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--titlebar-inset", "52px");
  });
  const after = await chromeTops(page);
  expect(after).toEqual(before);
});

test("with the marker, chrome clears the covered strip and content scrolls beneath it", async ({ page, request }) => {
  const filler = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} provides scroll depth.`).join("\n\n");
  await request.post("/__e2e/reset", {
    data: { dirty: { "long-doc.md": `# Long Doc\n\n${filler}\n` } },
  });
  await page.reload();
  await treeRow(page, "long-doc.md").click();
  await expect(page.locator("#preview-title")).toHaveText("Long Doc");

  const baseline = await chromeTops(page);
  await applyInsetMarker(page, INSET);
  const inset = await chromeTops(page);

  // Every interactive chrome surface starts below the covered strip.
  expect(inset.sidebarHeader).toBeGreaterThanOrEqual(INSET);
  expect(inset.previewHeader).toBeGreaterThanOrEqual(INSET);
  expect(inset.sidebarHeader - baseline.sidebarHeader).toBeCloseTo(INSET, 0);
  expect(inset.previewHeader - baseline.previewHeader).toBeCloseTo(INSET, 0);

  // Scroll the document: the sticky header pins at the inset (not at 0),
  // and content passes above it into the covered strip, where the native
  // glass would sample it.
  await page.evaluate(() => {
    document.querySelector(".preview-shell")!.scrollTop = 600;
  });
  const scrolled = await page.evaluate(() => {
    const header = document.querySelector(".preview-header")!.getBoundingClientRect();
    const shell = document.querySelector(".preview-shell")!;
    // Any rendered content node drawn above the sticky header's top edge
    // proves content flows into the strip beneath the (native) chrome.
    const contentAbove = Array.from(document.querySelectorAll("#preview p")).some(
      p => p.getBoundingClientRect().top < header.top,
    );
    return { headerTop: header.top, scrollTop: shell.scrollTop, contentAbove };
  });
  expect(scrolled.scrollTop).toBe(600);
  expect(scrolled.headerTop).toBeCloseTo(INSET, 0);
  expect(scrolled.contentAbove).toBe(true);
});

test("the right-docked terminal clears the strip and caps the frost", async ({ page }) => {
  await page.locator("#terminal-toggle").click();
  await expect(page.locator("#terminal-panel")).toBeVisible();
  await page.locator("#terminal-dock-toggle").click();
  await expect(page.locator("#terminal-panel")).toHaveAttribute("data-dock", "right");

  await applyInsetMarker(page, INSET);

  const metrics = await page.evaluate(() => {
    const panel = document.querySelector("#terminal-panel")!.getBoundingClientRect();
    const frost = getComputedStyle(document.body, "::before");
    return {
      panelTop: panel.top,
      panelLeft: panel.left,
      frostRight: parseFloat(frost.right),
      innerWidth: window.innerWidth,
    };
  });
  // The panel's opaque surface starts below the covered strip. Margin, not
  // padding: a padded panel still paints its background into the strip.
  expect(metrics.panelTop).toBeGreaterThanOrEqual(INSET);
  // The frost stops at the panel's left edge instead of smearing its dark
  // surface into a gradient band across the covered strip.
  expect(metrics.innerWidth - metrics.frostRight).toBeLessThanOrEqual(metrics.panelLeft + 1);

  // The minimized rail is a fixed 36px strip; the cap follows it.
  await page.locator("#terminal-minimize").click();
  await expect(page.locator("#terminal-panel")).toHaveAttribute("data-display", "minimized");
  const minimizedRight = await page.evaluate(
    () => parseFloat(getComputedStyle(document.body, "::before").right),
  );
  expect(minimizedRight).toBeCloseTo(36, 0);
});

test("a live inset change (native tab bar) re-lays-out without reload", async ({ page }) => {
  await applyInsetMarker(page, INSET);
  const before = await chromeTops(page);
  // The wrapper pushes a new value into the same custom property.
  await applyInsetMarker(page, INSET + 24);
  const after = await chromeTops(page);
  expect(after.sidebarHeader - before.sidebarHeader).toBeCloseTo(24, 0);
  expect(after.previewHeader - before.previewHeader).toBeCloseTo(24, 0);
});
