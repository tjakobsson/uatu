import { expect, test } from "./fixtures";

import { treeRow } from "./tree-helpers";
import { showGitLogPane, standardBeforeEach } from "./fixtures";
import { captureScreenshot } from "./evidence";

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

  await showGitLogPane(page);
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
  await showGitLogPane(page);
  await expect(page.locator("#git-log")).toContainText("add feature doc");
});

test("Git Log rows and the commit preview show the commit's age from its commit time", async ({ page, request }, testInfo) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.goto("/");
  await showGitLogPane(page);
  const gitLog = page.locator("#git-log");
  const row = gitLog.locator(".commit-log a", { hasText: "add feature doc" });
  const age = row.locator("time.commit-age");
  await expect(age).toHaveAttribute("data-committed-at", /^\d+$/);
  await expect(age).toHaveText(/^\d+ (second|minute)s? ago$/);
  const committedAt = Number(await age.getAttribute("data-committed-at"));
  expect(new Date(await age.getAttribute("datetime") ?? "").getTime()).toBe(committedAt);
  await captureScreenshot(page, testInfo, "git-log-commit-age");

  await row.click();
  const previewAge = page.locator(".commit-preview header time.commit-age");
  await expect(previewAge).toHaveAttribute("data-committed-at", String(committedAt));
  await expect(previewAge).toHaveText(/^\d+ (second|minute)s? ago$/);
  await captureScreenshot(page, testInfo, "commit-preview-age");
});

test("commit ages advance in place without asking the server", async ({ page, request }, testInfo) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.clock.install();
  await page.goto("/");
  await showGitLogPane(page);
  const row = page.locator("#git-log .commit-log a", { hasText: "add feature doc" });
  const age = row.locator("time.commit-age");
  await expect(age).toHaveText(/^\d+ (second|minute)s? ago$/);
  await row.focus();
  await row.evaluate(element => { (window as unknown as { __ageRow?: Element }).__ageRow = element; });

  const repositoryReads: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/api/state") || url.pathname.includes("/api/repositories")) repositoryReads.push(url.pathname);
  });
  await page.clock.runFor("20:00");

  await expect(age).toHaveText(/^(19|20) minutes ago$/);
  await captureScreenshot(page, testInfo, "git-log-age-after-20-minutes");
  // Same element, still focused: the row was not rebuilt.
  expect(await row.evaluate(element => element === (window as unknown as { __ageRow?: Element }).__ageRow && document.activeElement === element)).toBe(true);
  expect(repositoryReads).toEqual([]);
});

test("commit ages pause while the page is hidden and catch up when it returns", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.clock.install();
  await page.goto("/");
  await showGitLogPane(page);
  const age = page.locator("#git-log .commit-log a", { hasText: "add feature doc" }).locator("time.commit-age");
  await expect(age).toHaveText(/^\d+ (second|minute)s? ago$/);
  const setHidden = (hidden: boolean) => page.evaluate(value => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (value ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

  await setHidden(true);
  const before = await age.textContent();
  await page.clock.runFor("20:00");
  expect(await age.textContent()).toBe(before);

  await setHidden(false);
  await expect(age).toHaveText(/^(19|20) minutes ago$/);
});
