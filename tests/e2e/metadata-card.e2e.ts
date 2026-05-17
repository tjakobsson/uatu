import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";

import { workspacePath } from "./config";
import { clickTreeFile, treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("metadata card surfaces YAML frontmatter above the body", async ({ page }) => {
  await clickTreeFile(page, "metadata/markdown-yaml.md");
  await expect(page.locator("#preview-path")).toHaveText("metadata/markdown-yaml.md");
  const card = page.locator("#preview .metadata-card");
  await expect(card).toBeVisible();
  // The card is a collapsed disclosure by default. Open it to inspect rows.
  await expect(card).not.toHaveAttribute("open", "");
  await card.locator(".metadata-card-summary").click();
  await expect(card).toHaveAttribute("open", "");
  // Curated rows render in a stable order, then extras follow.
  const labels = card.locator(".metadata-card-row .metadata-card-label");
  await expect(labels).toHaveText([
    "Title",
    "Author",
    "Date",
    "Description",
    "Tags",
    "Status",
    "slug",
  ]);
  // The body's first heading still renders below the card.
  const cardBox = await card.boundingBox();
  const heading = page.locator("#preview h1").first();
  const headingBox = await heading.boundingBox();
  expect(cardBox).toBeTruthy();
  expect(headingBox).toBeTruthy();
  expect(headingBox!.y).toBeGreaterThan(cardBox!.y);
  // The leading `---` MUST NOT survive as a thematic break.
  await expect(page.locator("#preview hr")).toHaveCount(0);
});

test("metadata card open/closed state persists across documents", async ({ page }) => {
  await clickTreeFile(page, "metadata/markdown-yaml.md");
  await expect(page.locator("#preview-path")).toHaveText("metadata/markdown-yaml.md");

  // Open it on the first doc.
  const firstCard = page.locator("#preview .metadata-card");
  await expect(firstCard).not.toHaveAttribute("open", "");
  await firstCard.locator(".metadata-card-summary").click();
  await expect(firstCard).toHaveAttribute("open", "");

  // Navigate to another metadata-bearing doc — the card should still be open.
  await clickTreeFile(page, "metadata/asciidoc-attrs.adoc");
  await expect(page.locator("#preview-path")).toHaveText("metadata/asciidoc-attrs.adoc");
  const secondCard = page.locator("#preview .metadata-card");
  await expect(secondCard).toHaveAttribute("open", "");

  // Close it on the second doc, then go back — should now be closed everywhere.
  await secondCard.locator(".metadata-card-summary").click();
  await expect(secondCard).not.toHaveAttribute("open", "");

  await clickTreeFile(page, "metadata/markdown-yaml.md");
  await expect(page.locator("#preview-path")).toHaveText("metadata/markdown-yaml.md");
  await expect(page.locator("#preview .metadata-card")).not.toHaveAttribute("open", "");
});

test("a Markdown file with no frontmatter shows no metadata card", async ({ page }) => {
  await clickTreeFile(page, "metadata/markdown-empty.md");
  await expect(page.locator("#preview-path")).toHaveText("metadata/markdown-empty.md");
  await expect(page.locator("#preview .metadata-card")).toHaveCount(0);
});

test("metadata values containing <script> are rendered as escaped text, not executed", async ({ page }) => {
  // Build the fixture in-place so the assertion is wholly self-contained and
  // does not require a hostile fixture to live in the repo permanently.
  const hostile = `---\ntitle: Safe Title\ndescription: '<script>window.__pwned = true</script>'\n---\n\n# Body\n`;
  await fs.writeFile(workspacePath("metadata", "hostile.md"), hostile, "utf8");
  await clickTreeFile(page, "metadata/hostile.md");
  await expect(page.locator("#preview-path")).toHaveText("metadata/hostile.md");
  // The card renders, the description text is visible as escaped characters,
  // but the script never executes.
  const card = page.locator("#preview .metadata-card");
  await expect(card).toBeVisible();
  await card.locator(".metadata-card-summary").click();
  await expect(card.locator(".metadata-card-body")).toContainText("<script>");
  await expect(card.locator("script")).toHaveCount(0);
  const pwned = await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned === true);
  expect(pwned).toBe(false);
});
