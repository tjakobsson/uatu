import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { promises as fs } from "node:fs";

import { workspacePath } from "./config";
import { openTreeFile, treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";
import { naturalWidth, recordDocumentFrames, waitForAppliedDocumentFrame } from "./sync-helpers";

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

test("follow mode switches the preview to a changed image", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "hero.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>` } },
  });
  await page.goto("/");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await turnFollowOn(page);

  await fs.writeFile(
    workspacePath("hero.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48"/></svg>`,
    "utf8",
  );

  await expect(page.locator("#preview-path")).toHaveText("hero.svg");
  await expect.poll(() => naturalWidth(page, "#preview .image-preview img")).toBe(48);
  expect(await page.evaluate(() => window.location.pathname)).toBe("/hero.svg");
});

test("follow mode stays on a document whose embedded image changed and refreshes it in place", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        "hero.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>`,
        // README stays the newest document, so Follow's catch-up keeps it.
        "README.md": `# Uatu\n\n<img src="./hero.svg" alt="hero" />\n`,
      },
    },
  });
  await page.goto("/");
  await turnFollowOn(page);
  const selector = '#preview img[alt="hero"]';
  await expect.poll(() => naturalWidth(page, selector)).toBe(16);
  // Neither switched nor reloaded: the marked heading must survive.
  await page.locator("#preview h1").evaluate(el => { el.dataset.e2eMounted = "1"; });

  await fs.writeFile(
    workspacePath("hero.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48"/></svg>`,
    "utf8",
  );

  // The new bytes are on screen, so the change has been applied — and the
  // preview, URL, and Follow are still where they were.
  await expect.poll(() => naturalWidth(page, selector)).toBe(48);
  await waitForAppliedDocumentFrame(page, { changed: "hero.svg" });
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  expect(await page.evaluate(() => window.location.pathname)).toBe("/README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#preview h1")).toHaveAttribute("data-e2e-mounted", "1");
});

test("follow mode ignores a change to a binary the preview cannot show", async ({ page }) => {
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await turnFollowOn(page);

  await fs.writeFile(workspacePath("bundle.zip"), "PK\u0003\u0004\u0000archive", "utf8");
  // The archive has reached the page — only then does "still README" mean
  // Follow passed over it rather than that the event had not arrived yet.
  await waitForAppliedDocumentFrame(page, { includes: "bundle.zip" });

  expect(await page.evaluate(() => window.location.pathname)).toBe("/README.md");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
});

// Rule A turns Follow off on the first click into the tree, so the reliable
// starting point is "pinned by a click", then the chip turns it back on.
async function turnFollowOn(page: Page): Promise<void> {
  await openTreeFile(page, "diagram.md");
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await openTreeFile(page, "README.md");
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#follow-toggle").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "true");
  // The chip's catch-up may land on the newest document; the tests below
  // assert against README, so pin the starting point there.
  await expect(page.locator("#preview-path")).toHaveText("README.md");
}

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
