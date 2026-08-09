import { expect, test } from "./fixtures";

import { revealTreeRow, treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("compare-target toggle switches the compare lens and persists across reload", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      // A worktree edit to a committed file so `last-commit` has exactly one
      // change while `base` also carries the whole feature branch.
      dirty: { "README.md": "# Changed in the worktree\n" },
    },
  });
  await page.goto("/");

  const control = page.locator("#change-overview .compare-target-control");
  await expect(control).toBeVisible();
  const baseButton = control.locator('button[data-compare-target="base"]');
  const lastButton = control.locator('button[data-compare-target="last-commit"]');

  // Default lens is the reviewer's view (the product's hero).
  await expect(baseButton).toHaveAttribute("aria-pressed", "true");
  await expect(lastButton).toHaveAttribute("aria-pressed", "false");

  const anchor = page.locator("#change-overview .compare-anchor").first();
  await expect(anchor).toContainText("vs main");

  // Base lens: the committed branch file carries a change annotation.
  await revealTreeRow(page, "feature.md");
  await expect(treeRow(page, "feature.md")).toHaveAttribute("data-item-git-status", "added");

  // Switch to the working view.
  await lastButton.click();
  await expect(lastButton).toHaveAttribute("aria-pressed", "true");
  await expect(baseButton).toHaveAttribute("aria-pressed", "false");
  // Anchor follows the resolved ref precisely.
  await expect(anchor).toContainText("vs HEAD");
  // Change data recomputes: only the README worktree edit remains vs HEAD, so
  // the committed branch file loses its annotation.
  await expect(treeRow(page, "feature.md")).not.toHaveAttribute("data-item-git-status", "added");

  // Selection persists across a reload.
  await page.reload();
  await expect(
    page.locator('#change-overview button[data-compare-target="last-commit"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#change-overview .compare-anchor").first()).toContainText("vs HEAD");
});

test("Diff view follows the compare target coherently with the overview", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.goto("/");

  // feature.md is committed on the feature branch but has no uncommitted edit.
  await revealTreeRow(page, "feature.md");
  await treeRow(page, "feature.md").click();
  await expect(page.locator("#preview-path")).toHaveText("feature.md");

  await page.locator("#view-diff").click();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");

  const diffHost = page.locator(".uatu-diff-host");
  await expect(diffHost).toBeVisible();
  // Base lens: the committed-since-base file shows a real diff, not an
  // "unchanged" state card.
  await expect(diffHost).not.toContainText("No changes against");

  // Switch the global compare target to last-commit while the file is open in
  // Diff view. feature.md has no uncommitted change, so vs HEAD it is
  // unchanged — the Diff view must agree with the overview's lens.
  await page.locator('#change-overview button[data-compare-target="last-commit"]').click();
  await expect(diffHost).toContainText("No changes against HEAD");
});

test("reloading with last-commit + Diff view persisted shows the last-commit diff, not base", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.goto("/");

  await revealTreeRow(page, "feature.md");
  await treeRow(page, "feature.md").click();
  await expect(page.locator("#preview-path")).toHaveText("feature.md");
  await page.locator("#view-diff").click();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");

  // Persist last-commit (and the Diff view) for the reload.
  await page.locator('#change-overview button[data-compare-target="last-commit"]').click();
  await expect(page.locator(".uatu-diff-host")).toContainText("No changes against HEAD");

  // Reload: the server session resets to the default `base`, so boot must flip
  // the target back to last-commit BEFORE fetching the persisted Diff view —
  // otherwise the base diff is fetched, cached, and never refreshed (the SSE
  // rebroadcast is a no-op because the client already reads last-commit).
  await page.reload();
  await expect(
    page.locator('#change-overview button[data-compare-target="last-commit"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#preview-path")).toHaveText("feature.md");
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".uatu-diff-host")).toContainText("No changes against HEAD");
});
