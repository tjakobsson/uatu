import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";

import { workspacePath } from "./config";
import { treeRow } from "./tree-helpers";
import { standardBeforeEach, sidebarPanesFitVisibleHeight } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("Author Mode sidebar shows Change Overview and Files only; Review Mode adds Git Log", async ({ page }) => {
  // Default Mode is Author — Git Log is intentionally hidden because past
  // commits aren't an Author concern.
  await expect(page.locator('[data-pane-id="change-overview"]')).toBeVisible();
  await expect(page.locator('[data-pane-id="files"]')).toBeVisible();
  await expect(page.locator('[data-pane-id="git-log"]')).toBeHidden();
  await expect(page.locator('[data-pane-id="files"] #tree')).toBeVisible();
  await expect.poll(sidebarPanesFitVisibleHeight(page)).toBe(true);
  await expect(page.locator(".sidebar-body")).toHaveCSS("overflow-y", "hidden");

  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");

  // Switch to Review — Git Log should appear, with Files getting the spare height.
  await page.locator("#mode-review").click();
  await expect(page.locator('[data-pane-id="git-log"]')).toBeVisible();
  // The Selection Inspector pane is also Review-only and competes for vertical
  // space at the e2e viewport size; hide it for the height comparison so this
  // test stays focused on the Files-vs-GitLog grow-target relationship.
  await page
    .locator('[data-pane-id="selection-inspector"]')
    .getByRole("button", { name: "Hide Selection Inspector" })
    .click();
  await expect(page.locator('[data-pane-id="selection-inspector"]')).toBeHidden();
  const filesHeight = (await page.locator('[data-pane-id="files"]').boundingBox())?.height ?? 0;
  const gitLogHeight = (await page.locator('[data-pane-id="git-log"]').boundingBox())?.height ?? 0;
  expect(filesHeight).toBeGreaterThan(gitLogHeight);
});

test("default Mode is Author with the forecast headline label", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.goto("/");
  await expect(page.locator("#mode-author")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#follow-toggle")).toBeEnabled();
  const overview = page.locator("#change-overview");
  await expect(overview.locator(".burden-headline")).toHaveText("Reviewer burden forecast");
});

test("Mode persists across reload via localStorage", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.goto("/");
  await page.locator("#mode-review").click();
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#mode-author")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#follow-toggle")).toBeHidden();
  const overview = page.locator("#change-overview");
  await expect(overview.locator(".burden-headline")).toHaveText("Change review burden");
});

test("switching Author -> Review hides Follow; the Author Follow choice round-trips back", async ({ page }) => {
  // Baseline: Follow is OFF in Author (beforeEach clicked README manually,
  // which disables Follow). Round-trip should preserve that state.
  await page.locator("#mode-review").click();
  await expect(page.locator("#follow-toggle")).toBeHidden();
  await page.locator("#mode-author").click();
  await expect(page.locator("#follow-toggle")).toBeVisible();
  await expect(page.locator("#follow-toggle")).toBeEnabled();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("Follow ON in Author round-trips through Review and is restored on return", async ({ page }) => {
  // Turn Follow on while in Author.
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");

  // Peek into Review — chip is hidden, but the Author preference is snapshotted.
  await page.locator("#mode-review").click();
  await expect(page.locator("#follow-toggle")).toBeHidden();

  // Back to Author: Follow is automatically restored to ON (the user does
  // not have to click again every time they peek into Review).
  await page.locator("#mode-author").click();
  await expect(page.locator("#follow-toggle")).toBeVisible();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
});

test("CLI --mode=review boots in Review with Follow hidden", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { startupMode: "review", git: true } });
  await page.goto("/");
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#follow-toggle")).toBeHidden();
  const overview = page.locator("#change-overview");
  await expect(overview.locator(".burden-headline")).toHaveText("Change review burden");
});

test("CLI --mode flag overrides persisted preference at startup", async ({ page, request }) => {
  // First boot: persist Review.
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.goto("/");
  await page.locator("#mode-review").click();
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "true");
  // Second boot with CLI override to author — must win at startup.
  await request.post("/__e2e/reset", { data: { startupMode: "author", git: true } });
  await page.reload();
  await expect(page.locator("#mode-author")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#mode-review")).toHaveAttribute("aria-checked", "false");
});

test("Review mode does not switch active preview when a different file changes", async ({ page }) => {
  await page.locator("#mode-review").click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nReview suppresses switching.\n", "utf8");
  // Wait long enough that any auto-switch would have landed (debounced to ~150ms server-side).
  await page.waitForTimeout(700);
  await expect(page.locator("#preview-path")).toHaveText("README.md");
});

test("Review mode allows manual file selection from the Files pane", async ({ page }) => {
  await page.locator("#mode-review").click();
  // Review's chip defaults to Changed; this fixture has no git and no
  // changes, so we toggle to All to keep the target file visible.
  await page.locator("#files-pane-filter-all").click();
  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
});

test("Review mode shows a stale-content hint when the active file changes on disk", async ({ page }) => {
  await page.locator("#mode-review").click();
  // Capture the rendered title BEFORE the disk change so we can prove the
  // preview did not auto-re-render.
  const titleBefore = await page.locator("#preview h1, #preview h2, #preview h3").first().textContent();
  await fs.writeFile(workspacePath("README.md"), "# Renamed Heading\n\nNew content.\n", "utf8");
  await expect(page.locator("#stale-hint")).toBeVisible();
  await expect(page.locator("#stale-hint")).toHaveClass(/is-changed/);
  await expect(page.locator("#stale-hint-message")).toHaveText("This file has changed on disk.");
  await expect(page.locator("#stale-hint-action")).toHaveText("Refresh");
  // Stale content still showing.
  const titleStillStale = await page.locator("#preview h1, #preview h2, #preview h3").first().textContent();
  expect(titleStillStale).toBe(titleBefore);
  // Refresh acts on the hint.
  await page.locator("#stale-hint-action").click();
  await expect(page.locator("#stale-hint")).toBeHidden();
  await expect(page.locator("#preview h1").first()).toHaveText("Renamed Heading");
});

test("Review hint coalesces multiple changes and clears on manual navigation", async ({ page }) => {
  await page.locator("#mode-review").click();
  // Toggle the Changed filter off so `diagram.md` is reachable for the
  // manual-navigation clear step below (this fixture is non-git, so the
  // chip would otherwise sit in the "filter unavailable" empty state).
  await page.locator("#files-pane-filter-all").click();
  await fs.writeFile(workspacePath("README.md"), "# First Edit\n\n.\n", "utf8");
  await expect(page.locator("#stale-hint")).toBeVisible();
  await fs.writeFile(workspacePath("README.md"), "# Second Edit\n\n.\n", "utf8");
  await fs.writeFile(workspacePath("README.md"), "# Third Edit\n\n.\n", "utf8");
  // Still exactly one hint visible.
  await expect(page.locator("#stale-hint")).toHaveCount(1);
  await expect(page.locator("#stale-hint")).toBeVisible();
  // Manual navigation clears the hint.
  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#stale-hint")).toBeHidden();
});

test("Switching to Author clears the hint and re-renders to current on-disk content", async ({ page }) => {
  await page.locator("#mode-review").click();
  await fs.writeFile(workspacePath("README.md"), "# Mode Switch Refresh\n\n.\n", "utf8");
  await expect(page.locator("#stale-hint")).toBeVisible();
  await page.locator("#mode-author").click();
  await expect(page.locator("#stale-hint")).toBeHidden();
  await expect(page.locator("#preview h1").first()).toHaveText("Mode Switch Refresh");
});

test("Stale hint never appears in Author mode", async ({ page }) => {
  // Default test setup leaves us in Author. Modify the active file.
  await fs.writeFile(workspacePath("README.md"), "# Author Inline Refresh\n\n.\n", "utf8");
  // Wait for the in-place refresh path to land.
  await expect(page.locator("#preview h1").first()).toHaveText("Author Inline Refresh");
  await expect(page.locator("#stale-hint")).toBeHidden();
});

test("Active file deleted on disk in Review shows the deleted hint variant", async ({ page }) => {
  await page.locator("#mode-review").click();
  // Capture pre-deletion content marker.
  const before = await page.locator("#preview h1").first().textContent();
  await fs.unlink(workspacePath("README.md"));
  await expect(page.locator("#stale-hint")).toBeVisible();
  await expect(page.locator("#stale-hint")).toHaveClass(/is-deleted/);
  await expect(page.locator("#stale-hint-message")).toHaveText("This file no longer exists on disk.");
  await expect(page.locator("#stale-hint-action")).toHaveText("Close");
  // Stale rendered content is still visible until the user acts.
  const stillVisible = await page.locator("#preview h1").first().textContent();
  expect(stillVisible).toBe(before);
});

test("Mode visual differentiation: segment glyphs, connection indicator, and preview frame all reflect Mode", async ({ page }) => {
  const connectionState = page.locator("#connection-state");
  const connectionLabel = connectionState.locator(".connection-label");
  const previewShell = page.locator(".preview-shell");
  const indicatorDot = connectionState.locator(".indicator-dot");

  // Author baseline: indicator is visible and reads "Connected".
  await expect(connectionState).toBeVisible();
  await expect(connectionLabel).toHaveText("Connected");
  await expect(connectionState).toHaveAttribute("title", "Connected to the uatu backend");
  await expect(previewShell).not.toHaveClass(/is-mode-review/);

  // Both segments expose a glyph regardless of which is active.
  await expect(page.locator("#mode-author .mode-glyph")).toHaveCount(1);
  await expect(page.locator("#mode-review .mode-glyph")).toHaveCount(1);

  // Author live dot is animated (pulsing).
  const authorDotAnim = await indicatorDot.evaluate((el) =>
    getComputedStyle(el).animationName,
  );
  expect(authorDotAnim).not.toBe("none");

  // Switch to Review: the indicator stays visible with the same "Connected"
  // copy and the same animated dot — the connection indicator is purely a
  // backend-reachability status and does not vary with Mode. The Review
  // preview-shell class still applies so other Review-only styling can hook
  // off it.
  await page.locator("#mode-review").click();
  await expect(connectionState).toBeVisible();
  await expect(connectionLabel).toHaveText("Connected");
  await expect(previewShell).toHaveClass(/is-mode-review/);

  const reviewDotAnim = await indicatorDot.evaluate((el) =>
    getComputedStyle(el).animationName,
  );
  expect(reviewDotAnim).not.toBe("none");

  // Switch back to Author and confirm the indicator is unchanged.
  await page.locator("#mode-author").click();
  await expect(connectionState).toBeVisible();
  await expect(connectionLabel).toHaveText("Connected");
  await expect(previewShell).not.toHaveClass(/is-mode-review/);
});

test("Score number and level are identical across Mode switches; only the headline label differs", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.goto("/");
  const overview = page.locator("#change-overview");
  const meter = overview.locator(".burden-meter").first();
  const headline = meter.locator(".burden-headline");
  const level = meter.locator(".burden-level");
  const score = meter.locator("strong");

  await expect(headline).toHaveText("Reviewer burden forecast");
  const authorLevel = await level.textContent();
  const authorScore = await score.textContent();
  const meterClassAuthor = await meter.getAttribute("class");

  await page.locator("#mode-review").click();
  await expect(headline).toHaveText("Change review burden");
  expect(await level.textContent()).toBe(authorLevel);
  expect(await score.textContent()).toBe(authorScore);
  expect(await meter.getAttribute("class")).toBe(meterClassAuthor);
});

test("Mode toggle is rendered in the sidebar, not the preview toolbar", async ({ page }) => {
  // Sidebar contains it.
  await expect(page.locator(".sidebar-mode-row #mode-control")).toBeVisible();
  // Preview toolbar does not.
  await expect(page.locator(".preview-toolbar #mode-control")).toHaveCount(0);
});

test("Pin UI affordance is removed", async ({ page }) => {
  await expect(page.locator("#pin-toggle")).toHaveCount(0);
});

// Removed: All/Changed view toggle and its per-Mode persistence — retired in
// replace-tree-with-pierre. Changed-file state is now an ambient git-status
// row annotation on the single tree (see @pierre/trees `setGitStatus`).
// A replacement test for the annotation rendering is on the followup E2E
// sweep (tasks.md task 9.1).

test("Per-mode pane state: hiding Change Overview in Author does not hide it in Review", async ({ page }) => {
  // Hide Change Overview while in Author.
  await page.locator('[data-pane-id="change-overview"]').getByRole("button", { name: "Hide Change Overview" }).click();
  await expect(page.locator('[data-pane-id="change-overview"]')).toBeHidden();
  // Switch to Review — Change Overview should still be visible (separate pane state).
  await page.locator("#mode-review").click();
  await expect(page.locator('[data-pane-id="change-overview"]')).toBeVisible();
  // Switch back to Author — still hidden.
  await page.locator("#mode-author").click();
  await expect(page.locator('[data-pane-id="change-overview"]')).toBeHidden();
});

test("Panels-restore menu does not list Git Log in Author Mode", async ({ page }) => {
  await page.locator("#panels-toggle").click();
  await expect(page.locator('#panels-menu label:has-text("Change Overview")')).toBeVisible();
  await expect(page.locator('#panels-menu label:has-text("Files")')).toBeVisible();
  await expect(page.locator('#panels-menu label:has-text("Git Log")')).toHaveCount(0);
  // Close menu, switch to Review — Git Log appears.
  await page.locator("#panels-toggle").click();
  await page.locator("#mode-review").click();
  await page.locator("#panels-toggle").click();
  await expect(page.locator('#panels-menu label:has-text("Git Log")')).toBeVisible();
});
