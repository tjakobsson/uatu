import { expect, test } from "./fixtures";
import { promises as fs } from "node:fs";

import { workspacePath } from "./config";
import { revealTreeRow, treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

// ⇧⌘F: content search across the watched roots. The matching and summary
// wording are unit-tested in `src/server/search.test.ts` and
// `src/sidebar/search-model.test.ts`; what needs a real browser is the
// streaming NDJSON consumption, the pane wiring, and the open-and-jump
// landing rule.

const SEARCH = "ControlOrMeta+Shift+f";

const FIXTURES = {
  "alpha.md": [
    "# Alpha",
    "",
    "The compare-target appears here in prose. CaseProbe sits here too.",
    "",
    "See [the docs](https://example.com/hidden-token) for more.",
  ].join("\n"),
  "beta.md": ["# Beta", "", "compare-target again, twice: compare-target."].join("\n"),
};

async function openSearch(page: import("@playwright/test").Page) {
  await page.keyboard.press(SEARCH);
  await expect(page.locator("#search-query")).toBeVisible();
}

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
  await request.post("/__e2e/reset", { data: { extras: FIXTURES } });
  await page.goto("/");
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("finds matches across files, grouped, with counts", async ({ page }) => {
  await openSearch(page);
  await page.locator("#search-query").fill("compare-target");

  await expect(page.locator("#search-summary")).toHaveText("3 results · 2 files", {
    timeout: 10_000,
  });
  await expect(page.locator(".search-file")).toHaveCount(2);
  await expect(page.locator(".search-hit")).toHaveCount(3);

  // Each row carries its line number and highlights the matched span.
  await expect(page.locator(".search-hit").first().locator(".search-hit-line")).toHaveText("3");
  await expect(page.locator(".search-hit").first().locator("mark")).toHaveText("compare-target");
});

test("the pane is revealed by the shortcut even when hidden", async ({ page }) => {
  // Search defaults to hidden — it is opened on demand.
  await expect(page.locator("#search-query")).toBeHidden();
  await openSearch(page);
  await expect(page.locator('.sidebar-pane[data-pane-id="search"]')).toBeVisible();
  // Revealing search must not disturb the panes the user already arranged.
  await expect(page.locator('.sidebar-pane[data-pane-id="files"]')).toBeVisible();
});

test("a short query invites a longer one instead of searching", async ({ page }) => {
  await openSearch(page);
  await page.locator("#search-query").fill("c");
  await expect(page.locator("#search-summary")).toHaveText(/Type 2\+/);
  await expect(page.locator(".search-hit")).toHaveCount(0);
});

test("a query with no matches reports it", async ({ page }) => {
  await openSearch(page);
  await page.locator("#search-query").fill("zzznotpresentzzz");
  await expect(page.locator("#search-summary")).toHaveText("No results", { timeout: 10_000 });
});

test("an invalid regular expression is reported, not thrown", async ({ page }) => {
  await openSearch(page);
  await page.locator("#search-regex").click();
  await page.locator("#search-query").fill("(unterminated");
  await expect(page.locator("#search-summary")).toHaveText("Invalid pattern", { timeout: 10_000 });
  await expect(page.locator("#search-query")).toHaveValue("(unterminated");
});

test("match options narrow the result set", async ({ page }) => {
  // A token unique to these fixtures — the shared workspace must not be able
  // to contribute matches and blur the assertion.
  await openSearch(page);
  await page.locator("#search-query").fill("caseprobe");
  await expect(page.locator("#search-summary")).toHaveText("1 result · 1 file", {
    timeout: 10_000,
  });

  // The file says "CaseProbe"; the query is lowercase.
  await page.locator("#search-case").click();
  await expect(page.locator("#search-summary")).toHaveText("No results", { timeout: 10_000 });
});

test("activating a prose match opens the document and highlights it", async ({ page }) => {
  await openSearch(page);
  await page.locator("#search-query").fill("compare-target");
  await expect(page.locator(".search-hit").first()).toBeVisible({ timeout: 10_000 });

  await page.locator(".search-hit").first().click();
  await expect(page.locator("#preview-path")).toHaveText("alpha.md");

  // Painted through the same highlight registry the find bar uses.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const registry = (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights;
        return registry.get("uatu-find-current")?.size ?? 0;
      }),
    )
    .toBe(1);
});

test("a match that exists only in source falls back to Source view", async ({ page }) => {
  // The link's URL is in the file but never rendered as text, so landing in
  // Rendered view would scroll to nothing.
  await openSearch(page);
  await page.locator("#search-query").fill("hidden-token");
  await expect(page.locator(".search-hit").first()).toBeVisible({ timeout: 10_000 });

  await page.locator(".search-hit").first().click();
  await expect(page.locator("#preview-path")).toHaveText("alpha.md");
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const registry = (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights;
        return registry.get("uatu-find-current")?.size ?? 0;
      }),
    )
    .toBe(1);
});

test("the second hit of a repeated string reveals that hit, not the first", async ({
  page,
  request,
}) => {
  // Every row for a repeated string used to reveal the first occurrence,
  // because the reveal searched by text alone. The row knows which occurrence
  // it is; landing on the wrong one is silent and easy to miss.
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        "repeats.md": ["# Repeats", "", "marker one", "", "marker two", "", "marker three"].join(
          "\n",
        ),
      },
    },
  });
  await page.reload();
  await openSearch(page);
  await page.locator("#search-query").fill("marker");
  await expect(page.locator(".search-hit")).toHaveCount(3, { timeout: 10_000 });

  // Occurrence index is carried on the row.
  await expect(page.locator(".search-hit").nth(2)).toHaveAttribute("data-occurrence", "2");

  await page.locator(".search-hit").nth(2).click();
  await expect(page.locator("#preview-path")).toHaveText("repeats.md");

  // The highlighted range must sit in the third paragraph, not the first.
  const revealed = await page.evaluate(() => {
    const registry = (CSS as unknown as {
      highlights: Map<string, Set<Range>>;
    }).highlights;
    const current = registry.get("uatu-find-current");
    const range = current ? [...current][0] : null;
    return range?.startContainer.textContent ?? null;
  });
  expect(revealed).toContain("three");
});

test("a widened result outside the scope still opens", async ({ page, request }) => {
  // "Search all roots" can surface documents the session scope excludes.
  // Opening one used to 404 into "Document unavailable", because /api/document
  // resolves against the scoped roots — the escape hatch showed results it
  // could not open.
  await revealTreeRow(page, "alpha.md");
  await treeRow(page, "alpha.md").click();
  await expect(page.locator("#preview-path")).toHaveText("alpha.md");

  const scoped = await request.post("/api/scope", {
    data: { scope: { kind: "file", documentId: workspacePath("alpha.md") } },
  });
  expect(scoped.ok()).toBe(true);
  await page.reload();

  await openSearch(page);
  await expect(page.locator("#search-scope")).toContainText("Scoped to one file", {
    timeout: 15_000,
  });
  await page.locator('[data-search-scope="all"]').click();
  await page.locator("#search-query").fill("compare-target");
  await expect(page.locator("#search-summary")).toHaveText("3 results · 2 files", {
    timeout: 15_000,
  });

  // beta.md is outside the scope; opening it must land on the document.
  const outside = page.locator(".search-file", { hasText: "beta.md" }).locator(".search-hit").first();
  await outside.click();
  await expect(page.locator("#preview-path")).toHaveText("beta.md");
  await expect(page.locator("#preview")).not.toContainText("unavailable");
});

test("arrow keys walk results and Enter opens the focused one", async ({ page }) => {
  await openSearch(page);
  await page.locator("#search-query").fill("compare-target");
  await expect(page.locator(".search-hit")).toHaveCount(3, { timeout: 10_000 });

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#preview-path")).not.toHaveText("README.md");
});

test("ignored and binary files never appear in results", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        ".gitignore": "secret.md\n",
        "secret.md": "compare-target is in here too\n",
        "visible.md": "compare-target is here\n",
      },
      git: true,
    },
  });
  await page.reload();
  await openSearch(page);
  await page.locator("#search-query").fill("compare-target");
  await expect(page.locator(".search-file")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator(".search-file-path")).toContainText("visible.md");
});

test("results are marked stale when a watched file changes", async ({ page }) => {
  await openSearch(page);
  await page.locator("#search-query").fill("compare-target");
  await expect(page.locator(".search-hit")).toHaveCount(3, { timeout: 10_000 });

  await fs.writeFile(workspacePath("beta.md"), "# Beta\n\nrewritten\n", "utf8");

  // Marked, not silently re-run: rows must not jump under the reader.
  await expect(page.locator("#search-notice")).toContainText("changed since", { timeout: 10_000 });
  await expect(page.locator(".search-hit")).toHaveCount(3);
});

test("deleting a file with visible results marks them stale", async ({ page }) => {
  // Deletion broadcasts no changedId — there is no document to point at — so
  // the change-driven staleness path misses it and rows for a file that is
  // gone would keep looking current.
  await openSearch(page);
  await page.locator("#search-query").fill("compare-target");
  await expect(page.locator(".search-hit")).toHaveCount(3, { timeout: 10_000 });

  await fs.rm(workspacePath("beta.md"));

  await expect(page.locator("#search-notice")).toContainText("changed since", { timeout: 10_000 });
});

test.describe("global routing", () => {
  test("⇧⌘F opens project search even with the terminal active", async ({ page }) => {
    await page.locator("#terminal-toggle").click();
    await expect(page.locator("#terminal-panel")).toBeVisible();
    // Click the panes container rather than a fixed offset in the panel — the
    // header's controls move with the panel's width.
    // Wait for a pane to exist before clicking into it — on a cold start the
    // panel is visible before its first pane is mounted, and this test is
    // about the shortcut, not about how fast the terminal comes up.
    await expect(page.locator(".terminal-pane-host").first()).toBeVisible({ timeout: 15_000 });
    await page.locator(".terminal-pane-host").first().click({ position: { x: 10, y: 10 } });

    await openSearch(page);
    // Project search, not the terminal find bar.
    await expect(page.locator("#search-query")).toBeFocused();
    await expect(page.locator("#find-query")).toBeHidden();
  });

  test("⌘F and ⇧⌘F are different features", async ({ page }) => {
    await treeRow(page, "alpha.md").click();
    await page.locator("#preview").click({ position: { x: 10, y: 10 } });

    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.locator("#find-query")).toBeVisible();
    await expect(page.locator("#search-query")).toBeHidden();

    await page.keyboard.press("Escape");
    await openSearch(page);
    await expect(page.locator("#search-query")).toBeFocused();
  });
});

test("a scoped session searches only the scope until widened", async ({ page, request }) => {
  await revealTreeRow(page, "alpha.md");
  await treeRow(page, "alpha.md").click();
  await expect(page.locator("#preview-path")).toHaveText("alpha.md");

  // Scope the session to the open file.
  const scopeResponse = await request.post("/api/scope", {
    data: { scope: { kind: "file", documentId: workspacePath("alpha.md") } },
  });
  expect(scopeResponse.ok()).toBe(true);
  await page.reload();

  await openSearch(page);
  // The pane naming the scope proves the client has the scoped state; typing
  // before that would race the SSE snapshot on a cold start.
  await expect(page.locator("#search-scope")).toContainText("Scoped to one file", {
    timeout: 15_000,
  });

  await page.locator("#search-query").fill("compare-target");
  // Assert on the settled summary rather than a transient row count — the
  // sweep streams, so counts pass through intermediate values.
  await expect(page.locator("#search-summary")).toHaveText("1 result · 1 file", {
    timeout: 15_000,
  });

  // The escape hatch: a single-file scope would otherwise make search useless.
  await page.locator('[data-search-scope="all"]').click();
  await expect(page.locator("#search-summary")).toHaveText("3 results · 2 files", {
    timeout: 15_000,
  });
});
