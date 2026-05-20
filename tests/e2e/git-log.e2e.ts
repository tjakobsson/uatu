import { expect, test } from "./fixtures";

import { treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("Git Log commit links support URL history and reloads", async ({ page, request }) => {
  // Git Log lives in the Review-mode pane catalog only.
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.goto("/");
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  const gitLog = page.locator("#git-log");
  await expect(gitLog).toContainText("add feature doc");
  const featureCommit = gitLog.locator(".commit-log a", { hasText: "add feature doc" });
  await expect(featureCommit).toHaveAttribute("href", /^\/\?repository=.+&commit=[0-9a-f]{7,12}$/);

  await featureCommit.click();
  await expect(page.locator("#preview-title")).toHaveText("add feature doc");
  await expect(page.locator("#preview")).toContainText("Full commit message body for review-load hover.");
  // Tree selection state moved into the @pierre/trees shadow DOM; behavior is
  // covered via the preview-path / URL assertions in this test instead.
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");
  const commitUrl = new URL(page.url());
  expect(commitUrl.pathname).toBe("/");
  expect(commitUrl.searchParams.get("repository")).toBeTruthy();
  expect(commitUrl.searchParams.get("commit")).toMatch(/^[0-9a-f]{7,12}$/);

  await page.goBack();
  await expect(page.locator("#preview-path")).toHaveText("README.md");

  // Follow is unavailable in Review (where Git Log lives) — that assertion
  // belongs in the Mode tests.

  await page.goForward();
  await expect(page.locator("#preview-title")).toHaveText("add feature doc");
  await expect(page.locator("#follow-toggle")).toHaveAttribute("aria-pressed", "false");

  await page.reload();
  await expect(page.locator("#preview-title")).toHaveText("add feature doc");
  await expect(page.locator("#preview")).toContainText("Full commit message body for review-load hover.");
  expect(page.url()).toBe(commitUrl.toString());

  await page.goto(`${commitUrl.pathname}${commitUrl.search}`);
  await expect(page.locator("#preview-title")).toHaveText("add feature doc");
  await expect(page.locator("#preview")).toContainText("Full commit message body for review-load hover.");
});

test("commit preview URLs show an unavailable state when data is missing", async ({ page, request }) => {
  // Git Log assertion only meaningful in Review.
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.goto("/?repository=missing-repo&commit=deadbeef");

  await expect(page.locator("#preview-title")).toHaveText("Commit preview unavailable");
  await expect(page.locator("#preview-path")).toContainText("Repository data is not available for commit deadbeef.");
  await expect(page.locator("#preview")).toHaveClass(/empty/);
  await expect(page.locator("#git-log")).toContainText("add feature doc");
});
