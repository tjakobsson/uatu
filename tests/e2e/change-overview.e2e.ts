import { showGitLogPane, expect, test } from "./fixtures";

import { revealTreeRow, treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("Change Overview and Git Log render git-backed change context", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      dirty: {
        "src/auth/session.ts": "export const changed = true;\n",
      },
    },
  });
  await page.goto("/");

  const overview = page.locator("#change-overview");
  await expect(overview).toContainText("feature/review-load");
  await expect(overview).toContainText("dirty");
  // The resolved base evidence line and the precise compare anchor.
  await expect(overview).toContainText("fallback base");
  await expect(overview.locator(".compare-anchor").first()).toHaveText("vs main");
  // No raw mechanical statistics in the sidebar.
  await expect(overview).not.toContainText("Changed files");
  await expect(overview).not.toContainText("Touched lines");
  await expect(overview).not.toContainText("Diff hunks");
  await expect(overview).not.toContainText("Directory spread");
  // No review-burden concepts exist.
  await expect(overview).not.toContainText("Review burden");

  await showGitLogPane(page);
  const gitLog = page.locator("#git-log");
  await expect(gitLog).toContainText("add feature doc");
  await expect(gitLog.locator(".commit-log code").first()).toHaveText(/[0-9a-f]{7,12}/);
  await expect(page.locator("#git-log-limit")).toHaveValue("25");
  await page.locator("#git-log-limit").selectOption("10");
  await expect(gitLog.locator(".commit-log a")).toHaveCount(10);
  await expect(gitLog).toHaveCSS("overflow-y", "auto");

  const featureCommit = gitLog.locator(".commit-log a", { hasText: "add feature doc" });
  await page.locator("#git-log-limit").selectOption("25");
  await expect(featureCommit).toHaveAttribute("href", /^\/\?repository=.+&commit=[0-9a-f]{7,12}$/);
  await featureCommit.click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => new URL(page.url()).searchParams.has("commit")).toBe(true);
  await expect(page.locator("#preview-title")).toHaveText("add feature doc");
  await expect(page.locator("#preview")).toContainText("Full commit message body for review-load hover.");
});

test("tree distinguishes untracked rows from added rows via git-status annotations", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      // Create one fresh path not present in the committed fixture — it ends
      // up untracked. `feature.md` is committed on `feature/review-load`,
      // so it is the natural foil: same workspace, distinct git category.
      dirty: {
        "a-untracked-scratch.md": "# Untracked scratch\n",
      },
    },
  });
  await page.goto("/");

  // The library virtualizes rows and auto-scrolls to the initial selection on
  // mount (README, alphabetically near the bottom). Reveal both targets so
  // their rows are in the DOM before the attribute assertions run.
  await revealTreeRow(page, "a-untracked-scratch.md");
  const untrackedRow = treeRow(page, "a-untracked-scratch.md");
  await expect(untrackedRow).toHaveAttribute("data-item-git-status", "untracked");

  await revealTreeRow(page, "feature.md");
  const addedRow = treeRow(page, "feature.md");
  await expect(addedRow).toHaveAttribute("data-item-git-status", "added");
});

test("Change Overview renders an untracked categorical indicator when untracked files are present", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      dirty: {
        "a-untracked-scratch.md": "# Untracked scratch\n",
      },
    },
  });
  await page.goto("/");

  const indicator = page.locator("#change-overview [data-untracked-indicator]");
  await expect(indicator).toBeVisible();
  await expect(indicator).toContainText("untracked");
});

test("Change Overview omits the untracked indicator when no untracked files are present", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      // No `dirty` writes — every file in the workspace is either committed
      // (initial fixture, history-N.md, feature.md) or staged-but-not-committed
      // via the test fixture's git init. No path remains untracked.
    },
  });
  await page.goto("/");

  // The pane has rendered before we can assert absence: wait for the repo
  // facts to mount so we know `renderChangeOverview` has fired.
  await expect(page.locator("#change-overview .repo-facts")).toBeVisible();
  await expect(page.locator("#change-overview [data-untracked-indicator]")).toHaveCount(0);
});

test("Tree annotates gitignored files with the 'ignored' status (distinct from untracked)", async ({ page, request }) => {
  // The realistic scenario this addresses is files matched by the user's
  // *global* git excludesFile (e.g. `.claude/settings.local.json`) — uatu's
  // tree shows them because uatu only respects repo-local `.gitignore`, but
  // git refuses to track them. We can't write to the user's global config
  // from a test, so we simulate the equivalent by writing a repo-local
  // `.gitignore` and disabling uatu's gitignore respect for this session:
  // git's `--ignored --exclude-standard` still finds the file, uatu's tree
  // still shows it, and the annotation closes the gap.
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      respectGitignore: false,
      extras: {
        ".gitignore": "a-local-only.json\n",
      },
      dirty: {
        "a-local-only.json": "{}\n",
      },
    },
  });
  await page.goto("/");

  // Reveal the row first — the library virtualizes off-screen rows, and
  // `a-local-only.json` sits at the top of the tree, outside the initial
  // viewport (which auto-scrolls to the selected README near the bottom).
  await revealTreeRow(page, "a-local-only.json");
  const row = treeRow(page, "a-local-only.json");
  await expect(row).toHaveAttribute("data-item-git-status", "ignored");
});

test("Change Overview displays non-git and invalid settings fallback states", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { nonGit: true } });
  await page.goto("/");
  await expect(page.locator("#change-overview")).toContainText("No git repository is available");

  await request.post("/__e2e/reset", {
    data: {
      git: true,
      extras: { ".uatu.json": "{ nope" },
      dirty: { "README.md": "# Changed\n" },
    },
  });
  await page.goto("/");
  await expect(page.locator("#change-overview")).toContainText("Invalid .uatu.json");
  // The warning does not suppress the available repository data.
  await expect(page.locator("#change-overview")).toContainText("feature/review-load");
});

test("sidebar counter shows the binary subcount when binary files are present", async ({ page, request }) => {
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const pngBytes = Buffer.from(pngBase64, "base64").toString("latin1");
  await request.post("/__e2e/reset", {
    data: { extras: { "logo.png": pngBytes } },
  });
  await page.goto("/");
  await expect(page.locator("#document-count")).toHaveText("19 files · 1 binary");
});
