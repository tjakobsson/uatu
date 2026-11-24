// The checked-out branch's pull request as the compare base
// (add-github-pr-review D7/D8), on the real service over the transport fake
// (`github: "transport"`, tests/fixtures/github-fake.ts). `/__e2e/github`
// makes fixture pull request #42 the workspace's own: the checkout moves to
// its head branch `feature/login` at HEAD and a local bare remote stands in
// for GitHub's Git side. `feature.md` is committed on the branch
// (initE2EGitRepository), so it is #42's changed file.
//
// - Change Overview's Base row names `#42's base`; a base that isn't exact
//   here (`stale`, `missing`) adds a note with `Fetch #42's refs`.
// - feature.md's Diff mounts #42's Files changed inline when the checkout's
//   diff is provably #42's; otherwise a note says why commenting isn't
//   offered (`local-changes`, `last-commit`).

import { promises as fs } from "node:fs";

import type { Page } from "@playwright/test";

import { workspacePath } from "./config";
import { captureScreenshot } from "./evidence";
import { expect, standardBeforeEach, test } from "./fixtures";
import { ownPullRequest, pushPullRequestHead, refreshPullRequest } from "./pull-request-helpers";
import { openTreeFile, revealTreeRow } from "./tree-helpers";

const baseRow = (page: Page) => page.locator("#change-overview dl > div", { has: page.locator("dt", { hasText: /^Base$/ }) }).locator("dd");
const note = (page: Page) => page.locator("#change-overview .pr-base-note");

async function openFeatureDiff(page: Page, file = "feature.md"): Promise<void> {
  await revealTreeRow(page, file);
  await openTreeFile(page, file);
  await expect(page.locator("#preview-path")).toHaveText(file);
  const diff = page.locator("#view-diff");
  if (await diff.getAttribute("aria-checked") !== "true") await diff.click();
  await expect(diff).toHaveAttribute("aria-checked", "true");
}

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("an exact base: the Base row names #42's base, and feature.md's Diff is #42's Files changed until it's edited", async ({ page, request }, testInfo) => {
  await ownPullRequest(page, request, { base: "exact" });
  await expect(baseRow(page)).toContainText("origin/main (#42's base)");
  await expect(baseRow(page)).not.toContainText("may be out of date");
  await expect(baseRow(page)).toHaveText(/ · [0-9a-f]{7}$/);
  await expect(note(page)).toHaveCount(0);

  await openFeatureDiff(page);
  const inline = page.locator(".uatu-diff-host section.uatu-diff-pr-review");
  await expect(inline).toBeVisible();
  await expect(inline.locator('[data-file-path="feature.md"]')).toBeVisible();
  await expect(inline.locator("[data-file-comment]").first()).toBeVisible();
  await expect(page.locator(".uatu-diff-review")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "pr-base-exact-document-diff");

  // A local edit moves the file's lines off GitHub's: the local diff with a
  // note instead.
  await fs.writeFile(workspacePath("feature.md"), "# Feature\n\nCommitted branch change.\n\nA local edit.\n", "utf8");
  const local = page.locator('.uatu-diff-review[data-diff-review-reason="local-changes"]');
  await expect(local).toBeVisible();
  await expect(local).toContainText("This file has local changes");
  await expect(page.locator("section.uatu-diff-pr-review")).toHaveCount(0);
  await expect(local.locator("[data-diff-review-fetch]")).toHaveCount(0);
});

test("a stale base: the note says it may be out of date, and Fetch makes the base and feature.md's Diff exact", async ({ page, request }, testInfo) => {
  await ownPullRequest(page, request, { base: "stale" });
  await expect(baseRow(page)).toContainText("origin/main (#42's base, may be out of date)");
  const stale = page.locator('#change-overview .pr-base-note[data-pr-base-state="stale"]');
  await expect(stale).toContainText("may be out of date");
  // feature.md's Diff isn't provably #42's: the local diff, with the fetch.
  await openFeatureDiff(page);
  const inexact = page.locator('.uatu-diff-review[data-diff-review-reason="base-inexact"]');
  await expect(inexact).toContainText("exact base commit isn't here");
  await expect(inexact.locator("[data-diff-review-fetch]")).toBeVisible();
  await captureScreenshot(page, testInfo, "pr-base-stale-fetch");

  await stale.locator("[data-pr-base-fetch]").click();
  await expect(note(page)).toHaveCount(0);
  await expect(baseRow(page)).toContainText("origin/main (#42's base)");
  await expect(baseRow(page)).not.toContainText("may be out of date");
  // The Diff follows the fetched base: #42's Files changed inline.
  await expect(page.locator(".uatu-diff-host section.uatu-diff-pr-review")).toBeVisible();
  await expect(page.locator(".uatu-diff-review")).toHaveCount(0);
});

test("a missing base: the note says #42's base isn't available locally", async ({ page, request }) => {
  await ownPullRequest(page, request, { base: "missing" });
  const missing = page.locator('#change-overview .pr-base-note[data-pr-base-state="missing"]');
  await expect(missing).toContainText("#42's base, origin/release/9.9, isn't available locally, so changes are measured from main instead.");
  await expect(missing.locator("[data-pr-base-fetch]")).toHaveText("Fetch #42's refs");
});

test("Since last commit: an edited feature.md's Diff says it compares against the last commit", async ({ page, request }) => {
  await ownPullRequest(page, request, { base: "exact" });
  await expect(baseRow(page)).toContainText("#42's base");
  // An unchanged file has no last-commit Diff to explain; an edited one has.
  await fs.writeFile(workspacePath("feature.md"), "# Feature\n\nCommitted branch change.\n\nA local edit.\n", "utf8");
  await page.locator('#change-overview button[data-compare-target="last-commit"]').click();
  await expect(page.locator("#change-overview .compare-anchor").first()).toContainText("vs HEAD");

  await openFeatureDiff(page);
  const lastCommit = page.locator('.uatu-diff-review[data-diff-review-reason="last-commit"]');
  await expect(lastCommit).toBeVisible();
  await expect(lastCommit).toContainText("compares against your last commit");
  await expect(lastCommit.locator("[data-diff-review-fetch]")).toHaveCount(0);
  await expect(page.locator("section.uatu-diff-pr-review")).toHaveCount(0);
});

test("GitHub's head moved on: feature.md's Diff says the checkout isn't at #42's head and lists its threads, the outdated one marked", async ({ page, request }, testInfo) => {
  await ownPullRequest(page, request, { base: "exact", threadPath: "feature.md" });
  await expect(baseRow(page)).toContainText("#42's base");
  const head = await pushPullRequestHead(request, { "feature.md": "# Feature\n\nCommitted branch change.\n\nMore work on GitHub.\n" });
  await refreshPullRequest(page);

  await openFeatureDiff(page);
  const mismatch = page.locator('.uatu-diff-review[data-diff-review-reason="head-mismatch"]');
  await expect(mismatch).toContainText(`not #42's head ${head.slice(0, 7)}, so line numbers may differ from GitHub's.`);
  await expect(page.locator("section.uatu-diff-pr-review")).toHaveCount(0);
  // The local diff stays under the note, with the fetch that brings the head.
  await expect(page.locator(".uatu-diff-host")).toBeVisible();
  await expect(mismatch.locator("[data-diff-review-fetch]")).toHaveText("Fetch #42's refs");
  // #42's line threads, read-only: a current one by its line, one on the
  // old side, and the outdated one marked, each opening in #42's Files
  // changed.
  await expect(mismatch.locator(".uatu-diff-review-count")).toHaveText("3 threads on this file");
  const threads = mismatch.locator(".uatu-diff-review-thread");
  await expect(threads.filter({ hasText: "Line 12" })).toHaveCount(1);
  await expect(threads.filter({ hasText: "Line 3 (old)" })).toHaveCount(1);
  await expect(threads.filter({ has: page.locator(".gh-pill", { hasText: "Outdated" }) })).toHaveCount(1);
  await expect(mismatch.locator("[data-diff-review-open]")).toHaveCount(4);
  await expect(mismatch.locator("[data-file-comment]")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "pr-document-diff-head-mismatch");

  // Its Files changed link opens #42 at that file.
  await mismatch.locator(".uatu-diff-review-why [data-diff-review-open]").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("pr")).toBe("42");
  await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("files");
});

test("a diff too large for Pierre: the lightweight render lists the threads instead of placing them", async ({ page, request }, testInfo) => {
  const big = `# Big\n\n${Array.from({ length: 5_200 }, (_, index) => `Line ${index + 1} of a long generated table.`).join("\n")}\n`;
  await ownPullRequest(page, request, { base: "exact", commit: { "big.md": big }, files: ["big.md"], threadPath: "big.md" });
  await expect(baseRow(page)).toContainText("#42's base");

  await openFeatureDiff(page, "big.md");
  const lightweight = page.locator('.uatu-diff-review[data-diff-review-reason="lightweight-render"]');
  await expect(lightweight).toContainText("This diff is too large to comment on inline.");
  await expect(lightweight).toContainText("Comment in #42's Files changed.");
  await expect(lightweight.locator(".uatu-diff-review-count")).toHaveText("3 threads on this file");
  await expect(lightweight.locator("[data-diff-review-fetch]")).toHaveCount(0);
  // The exact diff, but no inline review: the lightweight render has no
  // Pierre, so nothing is placed on its lines.
  await expect(page.locator("section.uatu-diff-pr-review")).toHaveCount(0);
  await expect(page.locator(".uatu-diff-host diffs-container")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "pr-document-diff-lightweight");
});
