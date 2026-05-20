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

test("Change Overview and Git Log render git-backed review load with configured explanations", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      // Git Log is a Review-mode pane; boot in Review so this test can assert
      // against it.
      uatuConfig: {
        review: {
          baseRef: "main",
          thresholds: { medium: 8, high: 20 },
          riskAreas: [{ label: "Auth", paths: ["src/auth/**"], score: 12, perFile: 1, max: 20 }],
          supportAreas: [{ label: "Docs", paths: ["**/*.md"], score: -2, maxDiscount: 4 }],
          ignoreAreas: [{ label: "Generated", paths: ["dist/**"] }],
        },
      },
      dirty: {
        "src/auth/session.ts": "export const changed = true;\n",
        "dist/generated.js": "generated\n",
      },
    },
  });
  await page.goto("/");

  const overview = page.locator("#change-overview");
  await expect(overview).toContainText("feature/review-load");
  await expect(overview).toContainText("configured base");
  await expect(overview).toContainText("Review burden");
  await expect(overview).toContainText("Auth");
  await expect(overview).toContainText("Generated");
  await expect(overview).toContainText("src/auth/session.ts");
  await expect(overview).not.toContainText("Changed files");
  await expect(overview).not.toContainText("Touched lines");
  await expect(overview).not.toContainText("Diff hunks");
  await expect(overview).not.toContainText("Directory spread");

  await overview.locator("button[title='Show score explanation']").click();
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => new URL(page.url()).searchParams.has("reviewScore")).toBe(true);
  await expect(page.locator("#preview-title")).toHaveText("Review burden score");
  await expect(page.locator("#preview")).toContainText("additive review-burden index");
  await expect(page.locator("#preview")).toContainText("Mechanical Statistics");
  await expect(page.locator("#preview")).toContainText("Changed files");
  await expect(page.locator("#preview h2", { hasText: "Changed Files" })).toHaveCount(0);
  await expect(page.locator("#preview")).toContainText("High");
  await expect(page.locator(".score-preview-total")).toHaveCSS("background-color", "rgb(255, 241, 240)");
  await expect(page.locator(".score-preview dl .is-low")).toHaveCSS("background-color", "rgb(239, 250, 242)");
  await expect(page.locator(".score-preview dl .is-medium")).toHaveCSS("background-color", "rgb(255, 248, 220)");
  await expect(page.locator(".score-preview dl .is-high")).toHaveCSS("background-color", "rgb(255, 241, 240)");
  await expect(page.locator("#preview")).not.toContainText("Commits");
  const diffHunksHelp = page.locator(".score-term-help", { hasText: "?" }).filter({ has: page.locator(".score-term-tooltip", { hasText: "separate changed spots" }) });
  await diffHunksHelp.hover();
  await expect(diffHunksHelp.locator(".score-term-tooltip")).toBeVisible();
  const directorySpreadHelp = page.locator(".score-term-help", { has: page.locator(".score-term-tooltip", { hasText: "top-level parts of the project" }) });
  await directorySpreadHelp.hover();
  await expect(directorySpreadHelp.locator(".score-term-tooltip")).toBeVisible();
  const scoreUrl = page.url();
  await page.reload();
  await expect(page.locator("#preview-title")).toHaveText("Review burden score");
  expect(page.url()).toBe(scoreUrl);
  await fs.writeFile(workspacePath("README.md"), "# Uatu\n\nScore view should stay open.\n", "utf8");
  await expect(page.locator("#preview-title")).toHaveText("Review burden score");
  await expect.poll(() => new URL(page.url()).searchParams.has("reviewScore")).toBe(true);

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

  // The pane has rendered before we can assert absence: wait for the burden
  // meter to mount so we know `renderChangeOverview` has fired.
  await expect(page.locator("#change-overview .burden-meter")).toBeVisible();
  await expect(page.locator("#change-overview [data-untracked-indicator]")).toHaveCount(0);
});

test("Score-explanation preview breaks out the untracked subcount as a factual change-shape input", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      dirty: {
        "a-untracked-scratch.md": "# Untracked scratch\n",
      },
    },
  });
  await page.goto("/");

  await page.locator("#change-overview .burden-meter").first().click();
  await expect(page.locator("#preview-title")).toHaveText("Review burden score");

  // The new sub-driver lives inside the Mechanical Statistics block.
  const untrackedRow = page.locator(
    '#preview .score-preview-list li:has(strong:text-is("Untracked files"))',
  );
  await expect(untrackedRow).toBeVisible();
  await expect(untrackedRow).toContainText("1 file not yet in git");
  // The score contribution is presentation-only.
  await expect(untrackedRow.locator("code")).toHaveText("0");
});

test("Score-explanation preview omits the untracked row when no untracked files are present", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      // No dirty/untracked writes; the fixture's committed history exercises
      // the mechanical drivers without touching the untracked category.
    },
  });
  await page.goto("/");

  await page.locator("#change-overview .burden-meter").first().click();
  await expect(page.locator("#preview-title")).toHaveText("Review burden score");

  await expect(
    page.locator('#preview .score-preview-list li:has(strong:text-is("Untracked files"))'),
  ).toHaveCount(0);
});

test("Tree annotates ignoreAreas-matched untracked files with their git status (score policy is not a visibility policy)", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      uatuConfig: {
        review: {
          ignoreAreas: [{ label: "Scratch", paths: ["a-ignored-*.md"] }],
        },
      },
      dirty: {
        "a-ignored-scratch.md": "# Ignored untracked\n",
      },
    },
  });
  await page.goto("/");

  await revealTreeRow(page, "a-ignored-scratch.md");
  const row = treeRow(page, "a-ignored-scratch.md");
  await expect(row).toHaveAttribute("data-item-git-status", "untracked");
});

test("Change Overview untracked indicator renders even when every untracked file is ignored by score policy", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      uatuConfig: {
        review: {
          ignoreAreas: [{ label: "Scratch", paths: ["a-ignored-*.md"] }],
        },
      },
      dirty: {
        "a-ignored-scratch.md": "# Ignored untracked\n",
      },
    },
  });
  await page.goto("/");

  await expect(page.locator("#change-overview [data-untracked-indicator]")).toBeVisible();
  // Score-explanation preview, by contrast, MUST omit the untracked subcount —
  // ignored files do not contribute to the score, so the score-side breakdown
  // has nothing to report.
  await page.locator("#change-overview .burden-meter").first().click();
  await expect(page.locator("#preview-title")).toHaveText("Review burden score");
  await expect(
    page.locator('#preview .score-preview-list li:has(strong:text-is("Untracked files"))'),
  ).toHaveCount(0);
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
  await expect(page.locator("#change-overview")).toContainText("Review burden");
});

test("sidebar counter shows the binary subcount when binary files are present", async ({ page, request }) => {
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const pngBytes = Buffer.from(pngBase64, "base64").toString("latin1");
  await request.post("/__e2e/reset", {
    data: { extras: { "logo.png": pngBytes } },
  });
  await page.goto("/");
  await expect(page.locator("#document-count")).toHaveText("17 files · 1 binary");
});
