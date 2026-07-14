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

test("facts strip remains visible across Rendered, Source, and split layouts", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.reload();
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  // Rendered view (markdown default): repository facts frame the reading view.
  await expect(page.locator("#view-rendered")).toHaveAttribute("aria-checked", "true");
  await expect(strip(page)).toBeVisible();
  await expect(strip(page)).toContainText("Uatu Test");
  await expect(strip(page).locator(".file-facts-sha")).toHaveText(/^[0-9a-f]{7,}$/);

  // Source uses the same document facts presentation.
  await page.locator("#view-source").click();
  await expect(strip(page)).toBeVisible();
  await expect(strip(page)).toContainText("Uatu Test");
  await expect(strip(page)).toContainText("lines");
  await expect(strip(page).locator(".file-facts-sha")).toHaveText(/^[0-9a-f]{7,}$/);
  // Clean committed file — no uncommitted marker.
  await expect(strip(page)).not.toContainText("uncommitted");

  // Back to Rendered: the strip remains in shared preview chrome.
  await page.locator("#view-rendered").click();
  await expect(strip(page)).toBeVisible();

  // Split layout still has one shared strip, never one copy per pane.
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator("#preview.is-split.is-split-h")).toBeVisible();
  await expect(strip(page)).toBeVisible();
  await expect(page.locator("#file-facts-strip")).toHaveCount(1);
  await expect(page.locator("#preview .file-facts-strip")).toHaveCount(0);
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

test("source-forced text files pulse the strip, not the Rendered chip, on file events", async ({ page, request }) => {
  // `extras` land before git init, so config.yaml is part of the initial
  // commit — the strip starts clean and the file event below dirties it.
  await request.post("/__e2e/reset", {
    data: { git: true, extras: { "config.yaml": "key: value\nport: 8080\n" } },
  });
  await page.reload();
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  // Select a text file while the persisted viewMode is still "rendered":
  // the server forces Source rendering, so the strip is the visible signal
  // surface even though appState.viewMode never changed.
  await revealTreeRow(page, "config.yaml");
  await treeRow(page, "config.yaml").click();
  await expect(page.locator("#preview-path")).toHaveText("config.yaml");
  await expect(strip(page)).toBeVisible();

  await fs.writeFile(workspacePath("config.yaml"), "key: edited\nport: 4242\n", "utf8");

  await expect(strip(page)).toHaveClass(/is-updated/);
  await expect(page.locator("#preview-updated")).toBeHidden();
  await expect(strip(page)).not.toHaveClass(/is-updated/, { timeout: 10_000 });
});

test("Rendered view refreshes and pulses its facts strip when the active file changes", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.reload();
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#view-rendered")).toHaveAttribute("aria-checked", "true");
  const chip = page.locator("#preview-updated");
  await expect(strip(page)).toBeVisible();
  await expect(strip(page)).not.toContainText("uncommitted");
  await expect(chip).toBeHidden();

  await fs.writeFile(workspacePath("README.md"), "# Uatu\n\nRendered-view edit marker.\n", "utf8");

  await expect(strip(page)).toContainText("modified just now");
  await expect(strip(page)).toContainText("uncommitted");
  await expect(strip(page)).toHaveClass(/is-updated/);
  await expect(chip).toBeHidden();
  await expect(strip(page)).not.toHaveClass(/is-updated/, { timeout: 10_000 });
});
