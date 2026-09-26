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

// Reveal a path's row in the DOM by asking the library to scroll it into the
// virtualization window. As of `@pierre/trees` 1.0.0-beta.4 the tree
// auto-scrolls the initially-selected row into view on first mount, which
// pushes other rows out of the DOM. Call this before asserting on a specific
// row that may be off-screen. `focus: false` keeps the keyboard-focus state
// where it is — we only want the row in the DOM. Idempotent; no-op when the
// row is already in view or unknown to the library.
export async function revealTreeRow(page: Page, path: string): Promise<void> {
  await page.locator("#tree").evaluate((el, p) => {
    const tree = (el as unknown as {
      __pierreFileTree?: { scrollToPath: (p: string, opts: { focus: boolean }) => void };
    }).__pierreFileTree;
    tree?.scrollToPath(p, { focus: false });
  }, path);
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

// Resolves once the tree has not re-rendered for two consecutive animation
// frames: no mutation anywhere in the library's shadow root. A watcher frame
// can rebuild the rows (`resetPaths`), and a click that lands on a row being
// replaced goes nowhere.
export async function waitForTreeIdle(page: Page): Promise<void> {
  await expect.poll(
    () => page.locator("#tree").evaluate(host => new Promise<boolean>(resolve => {
      const root = host.shadowRoot;
      if (!root) {
        resolve(false);
        return;
      }
      let mutated = false;
      const observer = new MutationObserver(() => {
        mutated = true;
      });
      observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        observer.disconnect();
        resolve(!mutated);
      }));
    })),
    { message: "document tree idle (no re-render for two frames)" },
  ).toBe(true);
}

// Open a document from the tree and wait until the preview shows it. For a
// click whose POINT is the opened document, not the row's own state.
//
// Expands collapsed ancestors, brings the row into the virtualization window,
// waits for the tree to be idle, clicks, and asserts `#preview-path`. The row
// can still be replaced mid-rebuild under load — the click then lands on a
// detached row, or on whatever row moved under the pointer — so the click is
// retried until the row is selected (selection follows a landed click
// synchronously). It is never repeated once the row is selected: a slow
// document load is then waited for, not activated a second time.
export async function openTreeFile(
  page: Page,
  path: string,
  options: { previewPath?: string } = {},
): Promise<void> {
  const row = treeRow(page, path);
  let clicked = false;
  await expect(async () => {
    await expandTreeAncestors(page, path);
    await revealTreeRow(page, path);
    await expect(row).toBeVisible();
    await waitForTreeIdle(page);
    if (!clicked || (await row.getAttribute("aria-selected")) !== "true") {
      await row.click();
      clicked = true;
    }
    await expect(row).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
  }, `click ${path} in the tree until it is selected`).toPass({ timeout: 10_000 });
  await expect(page.locator("#preview-path")).toHaveText(options.previewPath ?? path);
}

async function expandTreeAncestors(page: Page, path: string): Promise<void> {
  for (const ancestor of ancestorDirs(path)) {
    const handle = treeRow(page, ancestor);
    const expanded = await handle.getAttribute("aria-expanded", { timeout: 2_000 }).catch(() => null);
    if (expanded === "false") {
      await handle.click();
      await expect(handle).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 });
    }
  }
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
