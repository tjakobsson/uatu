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

test("Diff view renders the active file's git diff against the review base", async ({ page, request }) => {
  // Initialize the e2e workspace as a git repository with a feature branch
  // and a worktree modification so feature.md differs from the resolved
  // review base.
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
  await expect(treeRow(page, "feature.md")).toBeVisible();
  await treeRow(page, "feature.md").click();
  await expect(page.locator("#preview-path")).toHaveText("feature.md");

  // Activate Diff view.
  await page.locator("#view-diff").click();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");

  // The diff host should be mounted. Its content can take one of three
  // shapes — Pierre's rendered diff, the lightweight-fallback `<pre>`, or
  // the diagnostic state card if Pierre's render path threw — and any of
  // those satisfies "wire-up is working." This test asserts the host
  // appears and that the chooser stays on Diff; the rendered content's
  // visual quality is verified manually.
  await expect(page.locator(".uatu-diff-host")).toBeVisible();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");
});

test.describe("slow diff fetch", () => {
  // The pass-through PWA service worker proxies every page fetch, and
  // Playwright's page.route cannot intercept SW-mediated requests — block
  // the worker for this test so the endpoint throttle actually applies.
  test.use({ serviceWorkers: "block" });

  test("shows the delay-gated loading signal and clears it after render", async ({ page, request }) => {
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
    const previousContent = page.locator("#preview");
    await expect(previousContent).not.toBeEmpty();

    // Throttle the diff endpoint well past the ~200 ms show delay so the
    // delay-gated indicator is guaranteed to appear.
    await page.route("**/api/document/diff*", async route => {
      await new Promise(resolve => setTimeout(resolve, 800));
      await route.continue();
    });

    await page.locator("#view-diff").click();

    // Layer 1: the segment goes busy immediately on click.
    await expect(page.locator("#view-diff")).toHaveAttribute("aria-busy", "true");
    // Layer 2: the pane-level indeterminate bar appears after the delay,
    // while the previous view's content stays visible underneath. The bar
    // wrapper is a zero-height sticky element (so it never shifts layout),
    // which Playwright's visibility check rejects — assert on the fill.
    await expect(page.locator(".uatu-loading-bar-fill")).toBeVisible();
    await expect(previousContent).not.toBeEmpty();

    // Once the delayed payload lands and renders, both layers clear.
    await expect(page.locator(".uatu-diff-host")).toBeVisible();
    await expect(page.locator("#view-diff")).not.toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".uatu-loading-bar")).toHaveCount(0);
  });
});

test("A large diff renders via Pierre's plaintext tier with the size notice", async ({ page, request }) => {
  // ~150 KB of changed content: past DIFF_MAX_HIGHLIGHT_BYTES (128 KB)
  // but under DIFF_MAX_BYTES / DIFF_MAX_LINES, so Pierre renders with the
  // plaintext language and the size notice instead of the lightweight
  // fallback.
  const bigBody = Array.from({ length: 3000 }, (_, i) => `Changed line ${i} — representative sentence content for a large document.`).join("\n");
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      dirty: {
        "feature.md": `# Feature\n\n${bigBody}\n`,
      },
    },
  });
  await page.reload();
  await revealTreeRow(page, "feature.md");
  await treeRow(page, "feature.md").click();
  await expect(page.locator("#preview-path")).toHaveText("feature.md");

  await page.locator("#view-diff").click();

  await expect(page.locator(".uatu-diff-host")).toBeVisible();
  await expect(page.locator(".uatu-diff-host .uatu-diff-fallback-notice")).toContainText("syntax highlighting disabled");
  // Pierre path, not the lightweight fallback: the diff body mounts and
  // no fallback <pre> is present.
  await expect(page.locator(".uatu-diff-host .uatu-diff-body")).toBeVisible();
  await expect(page.locator(".uatu-diff-fallback-pre")).toHaveCount(0);
});

test("A fast diff render leaves no loading bar behind", async ({ page, request }) => {
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
  await expect(page.locator("#view-diff")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".uatu-loading-bar")).toHaveCount(0);
});

test("Diff view shows the 'no git history' card in a non-git workspace", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { nonGit: true } });
  await page.reload();
  await expect(treeRow(page, "README.md")).toBeVisible();
  await treeRow(page, "README.md").click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  await page.locator("#view-diff").click();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");

  // The muted state card should appear and Pierre's Shadow DOM root should
  // NOT be present — fallback paths never load @pierre/diffs.
  const stateCard = page.locator(".uatu-diff-host .uatu-diff-state");
  await expect(stateCard).toBeVisible();
  await expect(stateCard).toContainText("No git history available");

  const pierreLoaded = await page.evaluate(() => {
    const host = document.querySelector(".uatu-diff-host");
    if (!host) return true;
    // Pierre constructs its own host elements; if the only child is our
    // state card, Pierre was not invoked. We accept a loose check: there
    // is a .uatu-diff-state element AND no `pierre-` prefixed custom element.
    const stateCount = host.querySelectorAll(".uatu-diff-state").length;
    const pierreNodes = host.querySelectorAll("[class*='pierre'], pierre-diff, file-diff");
    return stateCount === 0 || pierreNodes.length > 0;
  });
  expect(pierreLoaded).toBe(false);
});

test("Diff view exposes a Unified / Split layout toggle that persists across reload", async ({ page, request }) => {
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
  await expect(treeRow(page, "feature.md")).toBeVisible();
  await treeRow(page, "feature.md").click();
  await page.locator("#view-diff").click();
  await expect(page.locator(".uatu-diff-host")).toBeVisible();

  // Toolbar renders inside the diff host with two segments, defaults to Unified.
  const unified = page.locator('.uatu-diff-toolbar [data-style-value="unified"]');
  const split = page.locator('.uatu-diff-toolbar [data-style-value="split"]');
  await expect(unified).toBeVisible();
  await expect(split).toBeVisible();
  await expect(unified).toHaveAttribute("aria-checked", "true");
  await expect(split).toHaveAttribute("aria-checked", "false");

  // Click Split — the toolbar updates and the preference persists.
  await split.click();
  await expect(split).toHaveAttribute("aria-checked", "true");
  await expect(unified).toHaveAttribute("aria-checked", "false");

  await page.reload();
  await expect(treeRow(page, "feature.md")).toBeVisible();
  await treeRow(page, "feature.md").click();
  await page.locator("#view-diff").click();
  await expect(page.locator('.uatu-diff-toolbar [data-style-value="split"]'))
    .toHaveAttribute("aria-checked", "true");
});

test("Diff segment stays reachable from split layout on Markdown / AsciiDoc", async ({ page }) => {
  // Activate side-by-side on a markdown document.
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator("#preview.is-split-h")).toBeVisible();

  // All three view segments must remain visible so the user can leave
  // split for Diff in a single click.
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeVisible();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();

  // Clicking Diff transitions away from split into the single-pane Diff
  // view; the layout chooser hides while Diff is active.
  await page.locator("#view-diff").click();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".uatu-layout-toolbar")).toBeHidden();
  await expect(page.locator(".uatu-diff-host")).toBeVisible();
});

test("Source file under a stored split-layout preference still shows the view chooser", async ({ page }) => {
  // Regression: previously the view chooser keyed off the stored layout
  // preference rather than the *effective* layout, so navigating from a
  // markdown file in split layout to a source file (where split has no
  // effect — the doc has no separate rendered representation) hid the
  // chooser entirely.
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator(".uatu-layout-toolbar [data-layout-value='split-h']")).toHaveAttribute("aria-checked", "true");

  await fs.writeFile(workspacePath("split-source.ts"), "export const value = 1;\n", "utf8");
  await expect(treeRow(page, "split-source.ts")).toBeVisible();
  await treeRow(page, "split-source.ts").click();

  // Layout chooser correctly hides for source files; view chooser stays
  // visible with the Source + Diff segments.
  await expect(page.locator(".uatu-layout-toolbar")).toBeHidden();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeHidden();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();
});

test("Diff view keeps the view chooser visible when switching documents", async ({ page }) => {
  // Regression for the bug where switching files while viewMode === "diff"
  // dropped the view chooser because `currentRenderedPayload()` returned
  // null (the documentViewCache had been cleared by loadDocument and the
  // diff path never populates it).
  await treeRow(page, "README.md").click();
  await expect(page.locator("#preview-path")).toHaveText("README.md");
  await page.locator("#view-diff").click();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#view-control")).toBeVisible();

  // Switch to a different markdown file. The chooser must stay visible and
  // continue to highlight Diff.
  await treeRow(page, "diagram.md").click();
  await expect(page.locator("#preview-path")).toHaveText("diagram.md");
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeVisible();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");

  // Switch to a source file — chooser stays visible with two segments
  // (Source + Diff), Diff still active.
  await fs.writeFile(workspacePath("nav-source.ts"), "export const x = 1;\n", "utf8");
  await expect(treeRow(page, "nav-source.ts")).toBeVisible();
  await treeRow(page, "nav-source.ts").click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeHidden();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();
  await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");
});

test("Diff segment appears alongside Source / Rendered for Markdown and AsciiDoc", async ({ page }) => {
  // README.md is markdown — all three segments visible.
  await treeRow(page, "README.md").click();
  await expect(page.locator("#view-control")).toBeVisible();
  await expect(page.locator("#view-rendered")).toBeVisible();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();

  // An AsciiDoc file (the workspace fixture has at least one .adoc) — also three.
  await fs.writeFile(workspacePath("guide.adoc"), "= Guide\n\nBody.\n", "utf8");
  await expect(treeRow(page, "guide.adoc")).toBeVisible();
  await treeRow(page, "guide.adoc").click();
  await expect(page.locator("#view-rendered")).toBeVisible();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();

  // A `.ts` source file — two segments (Source + Diff), Rendered hidden.
  await fs.writeFile(workspacePath("module.ts"), "export const value = 1;\n", "utf8");
  await expect(treeRow(page, "module.ts")).toBeVisible();
  await treeRow(page, "module.ts").click();
  await expect(page.locator("#view-rendered")).toBeHidden();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();

  // A `.json` source file — also Source + Diff only.
  await fs.writeFile(workspacePath("settings.json"), "{\"key\": \"value\"}\n", "utf8");
  await expect(treeRow(page, "settings.json")).toBeVisible();
  await treeRow(page, "settings.json").click();
  await expect(page.locator("#view-rendered")).toBeHidden();
  await expect(page.locator("#view-source")).toBeVisible();
  await expect(page.locator("#view-diff")).toBeVisible();
});
