import { expect, test } from "./fixtures";
import { promises as fs } from "node:fs";

import { workspacePath } from "./config";
import { treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("View chooser shows three segments for Markdown / AsciiDoc and two for source files", async ({ page }) => {
  // README.md is markdown — all three segments visible.
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeVisible();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();

  // Switch to a code/text file. The chooser stays visible but Rendered is
  // hidden (no separate rendered representation for source files).
  await fs.writeFile(workspacePath("settings.json"), "{\"key\": \"value\"}\n", "utf8");
  const codeFile = treeRow(page, "settings.json");
  await expect(codeFile).toBeVisible();
  await codeFile.click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeHidden();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();

  // Back to README.md — all three segments visible again.
  await treeRow(page, "README.md").click();
  await expect(page.locator("#view-rendered")).toBeVisible();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();
});

test("View-mode preference persists across reload", async ({ page }) => {
  // Default is Rendered.
  await expect(page.locator("#view-rendered")).toHaveAttribute("aria-checked", "true");
  await page.locator("#view-source").click();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");

  await page.reload();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("pre.uatu-source-pre")).toBeVisible();
});

test("Layout chooser is visible for Markdown / AsciiDoc and hidden for source files", async ({ page }) => {
  // README.md is markdown — chooser is visible alongside the view toggle.
  await expect(page.locator(".uatu-layout-toolbar")).toBeVisible();

  // Switch to a code/text file: the layout chooser hides (split layouts
  // pair Source + Rendered, and source files have no separate Rendered).
  // The view chooser stays visible since the Diff segment introduced the
  // Source / Diff chooser for text files.
  await fs.writeFile(workspacePath("split-chooser.json"), "{\"key\": \"value\"}\n", "utf8");
  const codeFile = treeRow(page, "split-chooser.json");
  await expect(codeFile).toBeVisible();
  await codeFile.click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeHidden();
  await expect(page.locator(".uatu-layout-toolbar")).toBeHidden();

  // Back to README.md — both controls return.
  await treeRow(page, "README.md").click();
  await expect(page.locator(".uatu-layout-toolbar")).toBeVisible();
});

test("Side-by-side layout renders Source left, Rendered right, with both visible", async ({ page }) => {
  // Default is single layout; activate side-by-side.
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-h']")).toHaveAttribute("aria-checked", "true");

  // Two panes plus a resizer between them.
  await expect(page.locator("#preview.is-split.is-split-h")).toBeVisible();
  await expect(page.locator("#preview .preview-pane-source")).toBeVisible();
  await expect(page.locator("#preview .preview-pane-rendered")).toBeVisible();
  await expect(page.locator("#preview .preview-split-resizer")).toBeVisible();

  // Source pane carries the distinguishing whole-file <pre> class used by the
  // Selection Inspector, mirroring single Source view.
  await expect(page.locator("#preview .preview-pane-source pre.uatu-source-pre")).toBeVisible();

  // The view chooser stays visible in split so Diff remains reachable —
  // Diff replaces both panes and would be unreachable otherwise. Clicking
  // Source or Rendered in split is a no-op visually (the persisted
  // preference updates for the next return to single).
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();
});

test("Stacked layout renders Source on top, Rendered below", async ({ page }) => {
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-v']").click();
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-v']")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#preview.is-split.is-split-v")).toBeVisible();

  // DOM order: source pane then resizer then rendered pane.
  const order = await page.evaluate(() => {
    const children = Array.from(document.querySelectorAll<HTMLElement>("#preview > *"));
    return children.map(child => {
      if (child.classList.contains("preview-pane-source")) return "source";
      if (child.classList.contains("preview-split-resizer")) return "resizer";
      if (child.classList.contains("preview-pane-rendered")) return "rendered";
      return child.className;
    });
  });
  expect(order).toEqual(["source", "resizer", "rendered"]);
});

test("Layout preference persists across reload and across documents", async ({ page }) => {
  // Default is single.
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='single']")).toHaveAttribute("aria-checked", "true");

  // Activate side-by-side, then open another markdown doc — layout sticks.
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator("#preview.is-split-h")).toBeVisible();
  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await expect(page.locator("#preview.is-split-h")).toBeVisible();

  // Reload — preference survives.
  await page.reload();
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-h']")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#preview.is-split-h")).toBeVisible();
});

test("Switching to single layout preserves the Source / Rendered preference", async ({ page }) => {
  // Set Source as the active view-mode preference.
  await page.locator("#view-source").click();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");

  // Enter side-by-side; the chooser stays visible (so Diff stays
  // reachable) and the persisted Source preference is preserved.
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");

  // Return to single — the preference must still be Source.
  await page.locator(".uatu-layout-toolbar [data-layout-value='single']").click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");
  // And the body is in source view, not rendered.
  await expect(page.locator("#preview > pre.uatu-source-pre")).toBeVisible();
});

test("Dragging the split resizer reallocates space between panes", async ({ page }) => {
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator("#preview.is-split-h")).toBeVisible();

  // Measure the source pane's initial width, then drag the resizer right.
  const sourcePane = page.locator("#preview .preview-pane-source");
  const initialBox = await sourcePane.boundingBox();
  expect(initialBox).not.toBeNull();
  const resizer = page.locator("#preview .preview-split-resizer");
  const resizerBox = await resizer.boundingBox();
  expect(resizerBox).not.toBeNull();
  if (!initialBox || !resizerBox) return;

  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x + resizerBox.width / 2 + 80, resizerBox.y + resizerBox.height / 2, {
    steps: 8,
  });
  await page.mouse.up();

  const finalBox = await sourcePane.boundingBox();
  expect(finalBox).not.toBeNull();
  if (!finalBox) return;
  // Source pane has grown by approximately the drag distance (allowing some
  // tolerance for clamping and rounding).
  expect(finalBox.width).toBeGreaterThan(initialBox.width + 30);
});

test("Dragging the stacked split resizer reallocates vertical space", async ({ page }) => {
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-v']").click();
  await expect(page.locator("#preview.is-split-v")).toBeVisible();

  const sourcePane = page.locator("#preview .preview-pane-source");
  const initialBox = await sourcePane.boundingBox();
  expect(initialBox).not.toBeNull();
  const resizer = page.locator("#preview .preview-split-resizer");
  const resizerBox = await resizer.boundingBox();
  expect(resizerBox).not.toBeNull();
  if (!initialBox || !resizerBox) return;

  // Source pane must actually occupy a meaningful share of the preview body
  // up front (regression guard: in stacked mode the pane previously collapsed
  // to content-height because the container had no resolved height).
  expect(initialBox.height).toBeGreaterThan(100);

  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2 + 80, {
    steps: 8,
  });
  await page.mouse.up();

  const finalBox = await sourcePane.boundingBox();
  expect(finalBox).not.toBeNull();
  if (!finalBox) return;
  // Source pane has grown vertically by approximately the drag distance.
  expect(finalBox.height).toBeGreaterThan(initialBox.height + 30);
});
