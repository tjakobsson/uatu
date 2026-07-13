import { expect, test } from "./fixtures";
import { promises as fs } from "node:fs";

import { workspacePath } from "./config";
import { revealTreeRow, treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

const strip = (page: import("@playwright/test").Page) => page.locator("#file-facts-strip");

test("facts strip is hidden in Rendered view and appears with git facts in Source view", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.reload();
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  // Rendered view (markdown default): no strip.
  await expect(page.locator("#view-rendered")).toHaveAttribute("aria-checked", "true");
  await expect(strip(page)).toBeHidden();

  // Source view: author, commit sha, line count, byte size.
  await page.locator("#view-source").click();
  await expect(strip(page)).toBeVisible();
  await expect(strip(page)).toContainText("Uatu Test");
  await expect(strip(page)).toContainText("lines");
  await expect(strip(page).locator(".file-facts-sha")).toHaveText(/^[0-9a-f]{7,}$/);
  // Clean committed file — no uncommitted marker.
  await expect(strip(page)).not.toContainText("uncommitted");

  // Back to Rendered: the strip collapses again.
  await page.locator("#view-rendered").click();
  await expect(strip(page)).toBeHidden();
});

test("Diff view strip shows the compare base and addition/deletion counts", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      dirty: {
        "feature.md": "# Feature\n\nCommitted branch change.\n\nAdded review-time edit.\n",
      },
    },
  });
  await page.reload();
  await revealTreeRow(page, "feature.md");
  await treeRow(page, "feature.md").click();
  await expect(page.locator("#preview-path")).toHaveText("feature.md");

  await page.locator("#view-diff").click();
  await expect(page.locator(".uatu-diff-host")).toBeVisible();
  await expect(strip(page)).toBeVisible();
  await expect(strip(page)).toContainText("vs ");
  await expect(strip(page).locator(".file-facts-added")).toHaveText(/^\+\d+$/);
  await expect(strip(page).locator(".file-facts-removed")).toHaveText(/^−\d+$/);
});

test("an on-disk edit flips the freshness segment to uncommitted and pulses the strip", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.reload();
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  await page.locator("#view-source").click();
  await expect(strip(page)).toBeVisible();
  await expect(strip(page)).not.toContainText("uncommitted");

  await fs.writeFile(workspacePath("README.md"), "# Uatu\n\nEdited on disk by Playwright.\n", "utf8");

  // The in-place reload re-renders the strip with the dirty freshness and
  // lights the update signal on the strip container.
  await expect(strip(page)).toContainText("modified just now");
  await expect(strip(page)).toContainText("uncommitted");
  await expect(strip(page)).toHaveClass(/is-updated/);

  // Trailing edge: with no further events the signal settles.
  await expect(strip(page)).not.toHaveClass(/is-updated/, { timeout: 10_000 });
});

test("Rendered view shows a transient Updated chip when the active file changes on disk", async ({ page }) => {
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#view-rendered")).toHaveAttribute("aria-checked", "true");
  const chip = page.locator("#preview-updated");
  await expect(chip).toBeHidden();

  await fs.writeFile(workspacePath("README.md"), "# Uatu\n\nRendered-view edit marker.\n", "utf8");

  await expect(chip).toBeVisible();
  await expect(chip).toHaveText("Updated");
  // ...and it clears itself once the write burst is over.
  await expect(chip).toBeHidden({ timeout: 10_000 });
});
