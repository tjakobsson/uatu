// Shared Playwright helpers for asserting against the @pierre/trees-backed
// document tree. The library renders rows inside a shadow DOM with the
// custom element `<file-tree-container>` as the host. Playwright's CSS-based
// locators pierce open shadow roots automatically, so we can target the
// library's data-attribute API directly.
//
// Path conventions match the library's public identity:
//   - File rows:      data-item-path="src/index.ts"
//   - Directory rows: data-item-path="src/"   (note the trailing slash)
// In multi-root sessions, paths are prefixed with the watched-root label
// (e.g. "myproject/src/index.ts"). All helpers here take whatever path the
// caller has on hand and pass it through verbatim.

import { expect, type Locator, type Page } from "@playwright/test";

export function treeRow(page: Page, path: string): Locator {
  return page.locator(`[data-item-path="${escapeAttr(path)}"]`);
}

// Click a leaf file in the tree, first expanding any collapsed ancestor
// directories so the row is rendered. Use this instead of `treeRow(...).click()`
// when the path has parent directories — the library collapses directories by
// default, so a nested row may not be in the DOM until its ancestors expand.
export async function clickTreeFile(page: Page, path: string): Promise<void> {
  for (const ancestor of ancestorDirs(path)) {
    const handle = treeRow(page, ancestor);
    const expanded = await handle.getAttribute("aria-expanded").catch(() => null);
    if (expanded === "false") {
      await handle.click();
    }
  }
  const leaf = treeRow(page, path);
  await expect(leaf).toBeVisible();
  await leaf.click();
}

export function ancestorDirs(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return [];
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    out.push(`${parts.slice(0, i).join("/")}/`);
  }
  return out;
}

function escapeAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
