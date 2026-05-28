import { expect, test } from "./fixtures";

import { treeRow } from "./tree-helpers";
import { standardBeforeEach, sidebarPanesFitVisibleHeight } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("tree rows render a file-type icon via the library's built-in icon set", async ({ page }) => {
  // The library renders icons as inline SVG inside each row. We just assert
  // that one is present on a Markdown row — the exact sprite is an internal
  // contract we don't pin here.
  await expect(treeRow(page, "README.md").locator("svg")).not.toHaveCount(0);
});

test("sidebar collapse preference persists across reloads", async ({ page }) => {
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-sidebar-collapsed/);

  await page.locator("#sidebar-collapse").click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/);
  await expect(page.locator("#sidebar-expand")).toBeVisible();

  await page.reload();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/);

  await page.locator("#sidebar-expand").click();
  await expect(page.locator(".app-shell")).not.toHaveClass(/is-sidebar-collapsed/);
});

test("sidebar panes can be hidden, restored, resized, and survive whole-sidebar collapse", async ({ page }) => {
  const overviewPane = page.locator('[data-pane-id="change-overview"]');
  await expect(overviewPane).toBeVisible();

  await overviewPane.getByRole("button", { name: "Hide Change Overview" }).click();
  await expect(overviewPane).toBeHidden();

  await page.locator("#panels-toggle").click();
  await page.locator('#panels-menu label:has-text("Change Overview") input').check();
  await expect(overviewPane).toBeVisible();

  const before = (await overviewPane.boundingBox())?.height ?? 0;
  const resizer = page.locator('[data-pane-resizer="change-overview"]');
  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move((box?.x ?? 0) + 4, (box?.y ?? 0) + 3);
  await page.mouse.down();
  await page.mouse.move((box?.x ?? 0) + 4, (box?.y ?? 0) + 45);
  await page.mouse.up();
  const after = (await overviewPane.boundingBox())?.height ?? 0;
  expect(after).toBeGreaterThan(before + 20);
  await expect.poll(sidebarPanesFitVisibleHeight(page)).toBe(true);

  await page.locator("#sidebar-collapse").click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/);
  await page.locator("#sidebar-expand").click();
  await expect(overviewPane).toBeVisible();

  const sidebarBefore = (await page.locator(".sidebar").boundingBox())?.width ?? 0;
  const sidebarResizerBox = await page.locator("#sidebar-resizer").boundingBox();
  expect(sidebarResizerBox).not.toBeNull();
  await page.mouse.move((sidebarResizerBox?.x ?? 0) + 3, (sidebarResizerBox?.y ?? 0) + 20);
  await page.mouse.down();
  await page.mouse.move((sidebarResizerBox?.x ?? 0) + 85, (sidebarResizerBox?.y ?? 0) + 20);
  await page.mouse.up();
  const sidebarAfter = (await page.locator(".sidebar").boundingBox())?.width ?? 0;
  expect(sidebarAfter).toBeGreaterThan(sidebarBefore + 50);

  await page.reload();
  await expect(overviewPane).toBeVisible();
  const reloaded = (await overviewPane.boundingBox())?.height ?? 0;
  expect(reloaded).toBeGreaterThan(before + 20);
  const sidebarReloaded = (await page.locator(".sidebar").boundingBox())?.width ?? 0;
  expect(sidebarReloaded).toBeGreaterThan(sidebarBefore + 50);
});

test("Files-pane header title does not visually overlap the file count", async ({ page }) => {
  // Wait until the document-count text reflects real workspace contents so
  // the assertion exercises a populated header (the "65 files · 5 binary"
  // shape from the bug report) rather than the empty-tree shape.
  const documentCount = page.locator("#document-count");
  await expect(documentCount).not.toHaveText(/^0 files$/);

  const filesPane = page.locator('[data-pane-id="files"]');
  const title = filesPane.locator(".pane-header h2");
  const count = filesPane.locator("#document-count");

  // At the default sidebar width, the title's right edge must clear the
  // count's left edge with at least a 4px gap (the CSS gap is 0.5rem ≈ 8px;
  // 4px gives subpixel tolerance without admitting overlap).
  const titleRectDefault = await title.boundingBox();
  const countRectDefault = await count.boundingBox();
  expect(titleRectDefault).not.toBeNull();
  expect(countRectDefault).not.toBeNull();
  expect(titleRectDefault!.x + titleRectDefault!.width + 4).toBeLessThanOrEqual(countRectDefault!.x);

  // At the minimum supported sidebar width (320px) the title may have
  // ellipsised — but the rects MUST NOT overlap.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--sidebar-width", "320px");
  });
  // Give layout one frame to settle after the custom-property write.
  await page.waitForFunction(() => {
    return getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width").trim() === "320px";
  });
  const titleRectMin = await title.boundingBox();
  const countRectMin = await count.boundingBox();
  expect(titleRectMin).not.toBeNull();
  expect(countRectMin).not.toBeNull();
  expect(titleRectMin!.x + titleRectMin!.width + 4).toBeLessThanOrEqual(countRectMin!.x);
});
