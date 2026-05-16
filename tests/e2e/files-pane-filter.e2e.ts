// Behaviors specific to the Files-pane `All ↔ Changed` filter chip. Tests
// boot git-backed sessions because the chip's "Changed" state is built from
// review-load, which only reports paths in a git context.

import { expect, test, type Page } from "@playwright/test";

import { treeRow } from "./tree-helpers";

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

async function bootSession(
  page: Page,
  request: { post: (path: string, init?: { data: unknown }) => Promise<unknown> },
  body: Record<string, unknown> = {},
): Promise<void> {
  await request.post("/__e2e/reset", { data: body });
  await page.goto("/");
  await page.evaluate(() => {
    try {
      window.localStorage.clear();
    } catch {
      // best-effort
    }
  });
  await page.reload();
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator("#document-count")).not.toHaveText("0 files", { timeout: 5_000 });
}

test("chip defaults to Changed in Review and All in Author", async ({ page, request }) => {
  await bootSession(page, request, { git: true, startupMode: "review" });
  await expect(page.locator("#files-pane-filter-changed")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#files-pane-filter-all")).toHaveAttribute("aria-checked", "false");

  await bootSession(page, request, { git: true, startupMode: "author" });
  await expect(page.locator("#files-pane-filter-all")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#files-pane-filter-changed")).toHaveAttribute("aria-checked", "false");
});

test("chip state persists per Mode across reloads independently", async ({ page, request }) => {
  await bootSession(page, request, { git: true, startupMode: "author" });
  // Author starts at All — flip to Changed and persist.
  await page.locator("#files-pane-filter-changed").click();
  await expect(page.locator("#files-pane-filter-changed")).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");
  await expect(page.locator("#files-pane-filter-changed")).toHaveAttribute("aria-checked", "true");

  // Switch to Review (default Changed); flip it to All and persist.
  await page.locator("#mode-review").click();
  await expect(page.locator("#files-pane-filter-all")).toHaveAttribute("aria-checked", "false");
  await page.locator("#files-pane-filter-all").click();
  await expect(page.locator("#files-pane-filter-all")).toHaveAttribute("aria-checked", "true");

  // Back to Author — chip reads Changed (its persisted state), not Review's All.
  await page.locator("#mode-author").click();
  await expect(page.locator("#files-pane-filter-changed")).toHaveAttribute("aria-checked", "true");

  // Back to Review — chip reads All (its persisted state), not Author's Changed.
  await page.locator("#mode-review").click();
  await expect(page.locator("#files-pane-filter-all")).toHaveAttribute("aria-checked", "true");
});

test("under filter Changed only change-set rows and their ancestors are present", async ({
  page,
  request,
}) => {
  await bootSession(page, request, {
    git: true,
    startupMode: "review",
    dirty: {
      // Two changes: one nested, one untracked at the root.
      "guides/setup.md": "# Setup\n\nEdited for review.\n",
      "a-untracked-scratch.md": "# scratch\n",
    },
  });
  // Chip should already be on Changed (Review default).
  await expect(page.locator("#files-pane-filter-changed")).toHaveAttribute("aria-checked", "true");

  // The two change-set leaves are present in the tree, plus the `guides/`
  // ancestor (auto-expanded).
  await expect(treeRow(page, "a-untracked-scratch.md")).toBeAttached();
  await expect(treeRow(page, "guides/setup.md")).toBeAttached();
  await expect(treeRow(page, "guides/")).toBeAttached();
  await expect(treeRow(page, "guides/")).toHaveAttribute("aria-expanded", "true");

  // A file we did NOT touch must not be in the tree.
  await expect(treeRow(page, "diagram.md")).toHaveCount(0);

  // Toggle to All — the previously-hidden row reappears.
  await page.locator("#files-pane-filter-all").click();
  await expect(treeRow(page, "diagram.md")).toBeAttached();
});

test("empty state names the review base when no changes are present under Changed", async ({
  page,
  request,
}) => {
  await bootSession(page, request, {
    git: true,
    startupMode: "review",
    // Pin the review base to HEAD so the diff is empty (the e2e git fixture
    // is otherwise a feature branch with 13+ commits ahead of main).
    uatuConfig: { review: { baseRef: "HEAD" } },
  });
  await expect(page.locator("#files-pane-filter-changed")).toHaveAttribute("aria-checked", "true");
  // Tree is hidden; the empty-state message names a base.
  await expect(page.locator("#tree")).toBeHidden();
  await expect(page.locator("#tree-empty-message")).toBeVisible();
  await expect(page.locator("#tree-empty-message")).toContainText(/No changes vs /);

  // Toggle to All — empty state disappears, tree returns.
  await page.locator("#files-pane-filter-all").click();
  await expect(page.locator("#tree")).toBeVisible();
  await expect(page.locator("#tree-empty-message")).toBeHidden();
});

test("empty state explains unavailability in non-git contexts", async ({ page, request }) => {
  await bootSession(page, request, { nonGit: true });
  // Author defaults to All — flip to Changed to surface the empty-state copy.
  await page.locator("#files-pane-filter-changed").click();
  await expect(page.locator("#tree-empty-message")).toContainText(
    "Changed filter is unavailable",
  );
});

test("an active document outside the change set is revealed with a visual cue under Changed", async ({
  page,
  request,
}) => {
  // Setup: a tracked file `feature.md` is dirty (in the change set). A
  // separate file `guides/setup.md` is NOT touched (NOT in the change set).
  await bootSession(page, request, {
    git: true,
    startupMode: "author",
    dirty: { "feature.md": "# Feature\n\nEdited for review.\n" },
  });

  // User is on All; navigates to the unrelated file, then toggles Changed.
  // (Manual navigation turns Follow off — exactly the scenario where the
  // active doc can sit outside the filter set after toggling.)
  await page.locator("#files-pane-filter-all").click();
  const setupRow = treeRow(page, "guides/setup.md");
  // setup.md lives under guides/ — expand it first if needed (treeRow doesn't
  // expand ancestors, that's clickTreeFile's job).
  const guidesFolder = treeRow(page, "guides/");
  await expect(guidesFolder).toBeVisible();
  if ((await guidesFolder.getAttribute("aria-expanded")) === "false") {
    await guidesFolder.click();
  }
  await expect(setupRow).toBeVisible();
  await setupRow.click();
  await expect(page.locator("#preview-path")).toHaveText("guides/setup.md");

  // Toggle to Changed — guides/setup.md is NOT in the change set, so the
  // reveal-on-follow path includes it as a temporary override.
  await page.locator("#files-pane-filter-changed").click();
  await expect(page.locator("#files-pane-filter-changed")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  const revealedRow = treeRow(page, "guides/setup.md");
  await expect(revealedRow).toBeAttached();
  await expect(revealedRow).toHaveAttribute("data-uatu-filter-reveal", "true");
  // The chip stays on Changed — the reveal does not flip the filter off.
  await expect(page.locator("#files-pane-filter-changed")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("All → Changed → All restores manually-expanded directories", async ({ page, request }) => {
  await bootSession(page, request, {
    git: true,
    startupMode: "author",
    dirty: { "feature.md": "# Feature\n\nEdited.\n" },
  });

  // User expands `guides/` while in All mode.
  const guidesFolder = treeRow(page, "guides/");
  await expect(guidesFolder).toBeVisible();
  await expect(guidesFolder).toHaveAttribute("aria-expanded", "false");
  await guidesFolder.click();
  await expect(guidesFolder).toHaveAttribute("aria-expanded", "true");

  // Toggle to Changed — only the change-set entries are visible.
  await page.locator("#files-pane-filter-changed").click();
  await expect(treeRow(page, "feature.md")).toBeAttached();

  // Toggle back to All — `guides/` is still expanded.
  await page.locator("#files-pane-filter-all").click();
  await expect(treeRow(page, "guides/")).toHaveAttribute("aria-expanded", "true");
});

test("file count uses `N of M files` form under filter Changed", async ({ page, request }) => {
  await bootSession(page, request, {
    git: true,
    startupMode: "review",
    dirty: {
      "a-untracked.md": "# untracked\n",
      "guides/setup.md": "# Setup\n\nEdited.\n",
    },
  });

  // Chip on Changed (Review default). The count uses the N-of-M form.
  const countText = page.locator("#document-count");
  await expect(countText).toContainText(/^\d+ of \d+ files/);

  // Toggle to All — count returns to the bare `N files` form.
  await page.locator("#files-pane-filter-all").click();
  await expect(countText).toHaveText(/^\d+ files( · \d+ binary)?$/);
});

test("under Changed filter gitignored files are not rendered", async ({ page, request }) => {
  // `respectGitignore: false` keeps the gitignored file in the watched tree
  // (otherwise the tree walker would exclude it before the filter ran, which
  // wouldn't tell us anything about the filter's own behavior). The chip-
  // driven exclusion under Changed is what this test pins.
  await bootSession(page, request, {
    git: true,
    startupMode: "review",
    respectGitignore: false,
    extras: { ".gitignore": "ignored-by-git.md\n" },
    dirty: {
      "ignored-by-git.md": "# I should not appear under Changed\n",
      // A real change so the filter has SOMETHING to show, keeping us off
      // the empty-state path (which would also produce `toHaveCount(0)`).
      "feature.md": "# Feature\n\nEdited.\n",
    },
  });
  await expect(page.locator("#files-pane-filter-changed")).toHaveAttribute("aria-checked", "true");

  await expect(treeRow(page, "feature.md")).toBeAttached();
  await expect(treeRow(page, "ignored-by-git.md")).toHaveCount(0);
});
