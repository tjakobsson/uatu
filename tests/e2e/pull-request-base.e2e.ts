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

import type { APIRequestContext, Page } from "@playwright/test";

import { workspacePath } from "./config";
import { expect, standardBeforeEach, test } from "./fixtures";
import { openTreeFile, revealTreeRow } from "./tree-helpers";

async function ownPullRequest(page: Page, request: APIRequestContext, base: "exact" | "stale" | "missing"): Promise<void> {
  await request.post("/__e2e/reset", { data: { git: true, github: "transport" } });
  const response = await request.post("/__e2e/github", { data: { action: "own-pull-request", files: ["feature.md"], base } });
  expect(response.ok()).toBe(true);
  // Writes (the fetch) carry the workspace credential, as a session URL
  // printed by the CLI does. Loading the page asks for the GitHub summary,
  // which sets the base and collects Git data again.
  const { token } = await request.get("/__e2e/terminal-token").then(answer => answer.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await page.goto("/");
}

const baseRow = (page: Page) => page.locator("#change-overview dl > div", { has: page.locator("dt", { hasText: /^Base$/ }) }).locator("dd");
const note = (page: Page) => page.locator("#change-overview .pr-base-note");

async function openFeatureDiff(page: Page): Promise<void> {
  await revealTreeRow(page, "feature.md");
  await openTreeFile(page, "feature.md");
  await expect(page.locator("#preview-path")).toHaveText("feature.md");
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

test("an exact base: the Base row names #42's base, and feature.md's Diff is #42's Files changed until it's edited", async ({ page, request }) => {
  await ownPullRequest(page, request, "exact");
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

  // A local edit moves the file's lines off GitHub's: the local diff with a
  // note instead.
  await fs.writeFile(workspacePath("feature.md"), "# Feature\n\nCommitted branch change.\n\nA local edit.\n", "utf8");
  const local = page.locator('.uatu-diff-review[data-diff-review-reason="local-changes"]');
  await expect(local).toBeVisible();
  await expect(local).toContainText("This file has local changes");
  await expect(page.locator("section.uatu-diff-pr-review")).toHaveCount(0);
  await expect(local.locator("[data-diff-review-fetch]")).toHaveCount(0);
});

test("a stale base: the note says it may be out of date, and Fetch makes the base and feature.md's Diff exact", async ({ page, request }) => {
  await ownPullRequest(page, request, "stale");
  await expect(baseRow(page)).toContainText("origin/main (#42's base, may be out of date)");
  const stale = page.locator('#change-overview .pr-base-note[data-pr-base-state="stale"]');
  await expect(stale).toContainText("may be out of date");
  // feature.md's Diff isn't provably #42's: the local diff, with the fetch.
  await openFeatureDiff(page);
  const inexact = page.locator('.uatu-diff-review[data-diff-review-reason="base-inexact"]');
  await expect(inexact).toContainText("exact base commit isn't here");
  await expect(inexact.locator("[data-diff-review-fetch]")).toBeVisible();

  await stale.locator("[data-pr-base-fetch]").click();
  await expect(note(page)).toHaveCount(0);
  await expect(baseRow(page)).toContainText("origin/main (#42's base)");
  await expect(baseRow(page)).not.toContainText("may be out of date");
  // The Diff follows the fetched base: #42's Files changed inline.
  await expect(page.locator(".uatu-diff-host section.uatu-diff-pr-review")).toBeVisible();
  await expect(page.locator(".uatu-diff-review")).toHaveCount(0);
});

test("a missing base: the note says #42's base isn't available locally", async ({ page, request }) => {
  await ownPullRequest(page, request, "missing");
  const missing = page.locator('#change-overview .pr-base-note[data-pr-base-state="missing"]');
  await expect(missing).toContainText("#42's base, origin/release/9.9, isn't available locally, so changes are measured from main instead.");
  await expect(missing.locator("[data-pr-base-fetch]")).toHaveText("Fetch #42's refs");
});

test("Since last commit: an edited feature.md's Diff says it compares against the last commit", async ({ page, request }) => {
  await ownPullRequest(page, request, "exact");
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
