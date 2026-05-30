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

test("Wrap toggle is hidden in Rendered, visible in Source, and persists across reload", async ({
  page,
}) => {
  // README.md opens in Rendered view — wrap is meaningless there.
  await expect(page.locator("#view-rendered")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#wrap-control")).toBeHidden();

  // Source view surfaces the toggle, default off.
  await page.locator("#view-source").click();
  await expect(page.locator("#wrap-control")).toBeVisible();
  await expect(page.locator("#wrap-toggle")).toHaveAttribute("aria-pressed", "false");

  // Turn it on; the whole-file source <pre> gains the wrap class.
  await page.locator("#wrap-toggle").click();
  await expect(page.locator("#wrap-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("pre.uatu-source-pre.is-wrapped")).toBeVisible();

  // Back to Rendered: toggle hides again (preference retained).
  await page.locator("#view-rendered").click();
  await expect(page.locator("#wrap-control")).toBeHidden();

  // Reload: preference persisted. Returning to Source shows it pressed and
  // the source block wrapped without re-toggling.
  await page.reload();
  await page.locator("#view-source").click();
  await expect(page.locator("#wrap-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("pre.uatu-source-pre.is-wrapped")).toBeVisible();
});

test("single Wrap preference spans Source and Diff", async ({ page, request }) => {
  // Git workspace so feature.md has a real diff.
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      dirty: { "feature.md": "# Feature\n\nCommitted branch change.\n\nAdded review-time edit.\n" },
    },
  });
  await page.reload();
  await revealTreeRow(page, "feature.md");
  await treeRow(page, "feature.md").click();

  // Enable wrap in Source view.
  await page.locator("#view-source").click();
  await page.locator("#wrap-toggle").click();
  await expect(page.locator("#wrap-toggle")).toHaveAttribute("aria-pressed", "true");

  // Switch to Diff: the same global preference is reflected — toggle still
  // visible and still pressed, no second opt-in.
  await page.locator("#view-diff").click();
  await expect(page.locator("#wrap-control")).toBeVisible();
  await expect(page.locator("#wrap-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".uatu-diff-host")).toBeVisible();
});

test("Source wrap keeps line numbers truthful (one number per logical line)", async ({ page }) => {
  // A short line, a very long line (will wrap to several rows), a short line.
  const longLine = "x".repeat(400);
  await fs.writeFile(workspacePath("wrap-fixture.txt"), `short one\n${longLine}\nshort three\n`, "utf8");
  await revealTreeRow(page, "wrap-fixture.txt");
  await treeRow(page, "wrap-fixture.txt").click();

  // Text files render as Source directly.
  const lines = page.locator("pre.uatu-source-pre .uatu-cl");
  await expect(lines).toHaveCount(3);
  // Numbers are sequential and tied to logical lines, not visual rows.
  await expect(lines.nth(0)).toHaveAttribute("data-ln", "1");
  await expect(lines.nth(1)).toHaveAttribute("data-ln", "2");
  await expect(lines.nth(2)).toHaveAttribute("data-ln", "3");

  // Turn wrap on.
  await page.locator("#wrap-toggle").click();
  await expect(page.locator("pre.uatu-source-pre.is-wrapped")).toBeVisible();

  // Still exactly three numbered lines (the long line did NOT get renumbered
  // per visual row), and its block is now taller than a short line — i.e. it
  // wrapped across multiple rows while keeping a single number.
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(2)).toHaveAttribute("data-ln", "3");
  const shortBox = await lines.nth(0).boundingBox();
  const longBox = await lines.nth(1).boundingBox();
  expect(shortBox).not.toBeNull();
  expect(longBox).not.toBeNull();
  expect(longBox!.height).toBeGreaterThan((shortBox!.height ?? 0) * 1.8);

  // Copy excludes the (CSS-generated) line numbers: the source text is intact.
  const codeText = await page.locator("pre.uatu-source-pre code").evaluate(el => el.textContent ?? "");
  expect(codeText).toBe(`short one\n${longLine}\nshort three\n`);
});

test("Diff wrap toggles in place with no new diff fetch", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      dirty: {
        "feature.md": `# Feature\n\n${"verylongtoken".repeat(40)}\n`,
      },
    },
  });
  await page.reload();
  await revealTreeRow(page, "feature.md");
  await treeRow(page, "feature.md").click();
  await page.locator("#view-diff").click();
  await expect(page.locator(".uatu-diff-host")).toBeVisible();

  // Count diff fetches from here on; toggling wrap must re-render from cache.
  let diffFetches = 0;
  page.on("request", req => {
    if (req.url().includes("/api/document/diff")) diffFetches += 1;
  });

  await page.locator("#wrap-toggle").click();
  await expect(page.locator("#wrap-toggle")).toHaveAttribute("aria-pressed", "true");
  // The host is still mounted (re-rendered in place).
  await expect(page.locator(".uatu-diff-host")).toBeVisible();
  // Give any (unexpected) network a chance to fire before asserting none did.
  await page.waitForTimeout(200);
  expect(diffFetches).toBe(0);
});
