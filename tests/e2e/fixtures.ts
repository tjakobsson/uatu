// Shared Playwright setup and helpers used by every feature-specific e2e
// file. Splitting the legacy `uatu.e2e.ts` monolith into per-feature files
// would otherwise mean copy-pasting this boot sequence 15 times.

import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { treeRow } from "./tree-helpers";

// Standard per-test boot used by the vast majority of feature suites:
// reset the workspace, clear browser-side persisted preferences, wait for
// the tree to mount, and establish a clean baseline (README.md selected
// with follow disabled).
//
// Tests that need a *different* startup posture (e.g. CLI `--mode=review`
// boot, or a custom workspace prep before the first navigation) MUST NOT
// call this helper — they manage their own beforeEach.
export async function standardBeforeEach(page: Page, request: APIRequestContext): Promise<void> {
  await request.post("/__e2e/reset");
  await page.goto("/");
  // Clear browser-side persisted preferences so a prior test cannot leak
  // state into this one. localStorage persists across tests within the same
  // Playwright worker; the workspace reset above does not touch the browser.
  await page.evaluate(() => {
    try {
      window.localStorage.clear();
    } catch {
      // best-effort
    }
  });
  await page.reload();
  // Tree rows are rendered inside `@pierre/trees`' shadow DOM with
  // `role="treeitem"` and `data-item-path` — Playwright pierces the shadow
  // root automatically when given a CSS selector, so `treeRow(...)` is the
  // reliable readiness signal for "the tree is mounted with content."
  await expect(treeRow(page, "README.md")).toBeVisible();
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator("#document-count")).toHaveText("16 files");
  await waitForPreviewToSettle(page);
  // Establish a clean baseline: manual selection of README.md with follow
  // disabled. Click a non-README file first so the second click into README
  // actually fires the library's onSelectionChange (the library de-dupes
  // clicks on the already-selected row, which would otherwise leave the
  // boot-time follow=true state untouched).
  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await treeRow(page, "README.md").click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
}

export async function waitForPreviewToSettle(page: Page): Promise<void> {
  let previousPath = "";

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const currentPath = (await page.locator("#preview-path").textContent())?.trim() ?? "";
    if (currentPath.length > 0 && currentPath === previousPath) {
      await page.waitForTimeout(300);

      const settledPath = (await page.locator("#preview-path").textContent())?.trim() ?? "";
      if (settledPath === currentPath) {
        return;
      }
    }

    previousPath = currentPath;
    await page.waitForTimeout(150);
  }
}

export function sidebarPanesFitVisibleHeight(page: Page): () => Promise<boolean> {
  return async () =>
    page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(".sidebar-body");
      const panes = Array.from(document.querySelectorAll<HTMLElement>(".sidebar-pane:not([hidden])"));
      if (!body || panes.length === 0) {
        return false;
      }
      const bodyBox = body.getBoundingClientRect();
      const lastPaneBox = panes.at(-1)?.getBoundingClientRect();
      return Boolean(lastPaneBox && lastPaneBox.bottom <= bodyBox.bottom + 1);
    });
}
