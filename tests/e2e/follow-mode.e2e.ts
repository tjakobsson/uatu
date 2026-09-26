import { expect, test } from "./fixtures";
import { promises as fs } from "node:fs";

import { workspacePath } from "./config";
import { openTreeFile, treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";
import { recordDocumentFrames, waitForAppliedDocumentFrame } from "./sync-helpers";

test.beforeEach(async ({ page, request }) => {
  await recordDocumentFrames(page);
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("manual selection disables follow mode and keeps the current preview pinned", async ({ page }) => {
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nChanged while pinned.\n", "utf8");
  // The change has reached the page — only then does "still README" mean
  // follow stayed off rather than that the event had not arrived yet.
  await waitForAppliedDocumentFrame(page, { changed: "guides/setup.md" });

  // Selection moves synchronously with a frame (the URL follows it at once);
  // the preview path would only follow after a document load.
  expect(await page.evaluate(() => window.location.pathname)).toBe("/README.md");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#preview-title")).toHaveText("Uatu");
});

test("follow mode switches to the latest changed markdown file", async ({ page }) => {
  const marker = `Changed by Playwright ${Date.now()}`;
  const relativePath = "guides/setup.md";

  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");

  await fs.writeFile(workspacePath(relativePath), `# Setup\n\n${marker}\n`, "utf8");

  await expect(page.locator("#preview-path")).toHaveText(relativePath);
  await expect(page.locator("#preview")).toContainText(marker);
});

test("follow mode switches the preview when a non-Markdown text file changes", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "config.yaml": "key: original\n" } },
  });
  await page.goto("/");
  // Click a non-README file then README — this both demonstrates manual
  // navigation AND guarantees follow is off (manual selection disables it).
  // Without the intermediate click, clicking the already-selected README
  // is a no-op for the library's selection state, so the boot-time
  // follow=true wouldn't be disabled and the next follow-toggle click
  // would flip true→false instead of false→true.
  await openTreeFile(page, "diagram.md");
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await openTreeFile(page, "README.md");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");

  await fs.writeFile(workspacePath("config.yaml"), "key: changed\nport: 9999\n", "utf8");

  await expect(page.locator("#preview-path")).toHaveText("config.yaml");
  await expect(page.locator('#preview pre code.hljs.language-yaml')).toBeVisible();
});

test("enabling follow jumps to the most recently modified file", async ({ page }) => {
  // beforeEach lands on README.md (its mtime is bumped 10s into the future by
  // resetE2EWorkspace, so it's the current default selection). Make setup.md
  // strictly newer so the catch-up has an unambiguous target.
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  await fs.writeFile(workspacePath("guides", "setup.md"), "# Setup\n\nFreshly touched.\n", "utf8");
  const fresher = new Date(Date.now() + 30_000);
  await fs.utimes(workspacePath("guides", "setup.md"), fresher, fresher);

  // The catch-up below reads the page's own index, so the bumped mtime must
  // have reached it: wait until the page has applied a frame naming setup.md
  // the newest document.
  await waitForAppliedDocumentFrame(page, { defaultPath: "guides/setup.md" });

  // Manually re-select README to ensure follow is OFF and selection is README.
  await openTreeFile(page, "README.md");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  // Enable follow — preview must catch up to setup.md.
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");
});
