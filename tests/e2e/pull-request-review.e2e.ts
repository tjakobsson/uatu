// Pull request review, end to end on the in-memory GitHub fake (the e2e
// server's reset with `github: true`; src/github/fake.ts): open the branch's
// pull request, post a conversation comment, add a line comment in Files
// changed, and submit the review. The smoke test that keeps the PR surfaces
// covered in CI; the real `gh api` service is unit-tested against a fake
// transport (src/github/gh-service.test.ts).

import { captureScreenshot } from "./evidence";
import { expect, standardBeforeEach, test } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
  await request.post("/__e2e/reset", { data: { git: true, github: true } });
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("open a pull request, comment, add a line comment and submit the review", async ({ page, request }, testInfo) => {
  // Writes carry the workspace credential, as a session URL printed by the
  // CLI does.
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await page.goto("/?pr=642");
  const conversation = page.locator("#pr-panel-conversation");
  const composer = conversation.locator("[data-pr-composer]");
  await expect(composer.locator("textarea")).toBeVisible();

  // A conversation comment posts at once.
  await composer.locator("textarea").fill("Smoke test: conversation comment.");
  await composer.locator("[data-composer-submit]").click();
  await expect(conversation.getByText("Smoke test: conversation comment.")).toBeVisible();
  await expect(composer.locator("textarea")).toHaveValue("");

  // A line comment joins the pending review.
  await page.locator("#pr-tab-files").click();
  const files = page.locator("#pr-panel-files");
  await files.locator("[data-file-comment]").first().click();
  const inline = files.locator(".pr-composer-box").filter({ has: page.getByRole("button", { name: "Add to review" }) }).first();
  await expect(inline.locator("textarea")).toBeVisible();
  await inline.locator("textarea").fill("Smoke test: line comment.");
  await inline.getByRole("button", { name: "Add to review" }).click();
  await expect(files.getByText("Smoke test: line comment.")).toBeVisible();
  await captureScreenshot(page, testInfo, "pr-files-pending-comment");

  // Finish the review as a comment; the pending comment is published.
  const finish = page.locator("[data-review-finish]:visible").first();
  await expect(finish).toBeEnabled();
  await finish.click();
  const dialog = page.locator(".gh-dialog");
  await expect(dialog.locator(".gh-pending-list")).toContainText("Smoke test: line comment.");
  await captureScreenshot(page, testInfo, "pr-finish-review-dialog");
  await dialog.locator('input[value="COMMENT"]').check();
  await dialog.locator("[data-review-submit]").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-review-finish]:visible")).toHaveCount(0);

  await page.locator("#pr-tab-conversation").click();
  await expect(conversation.locator(".pr-review").last()).toContainText("octo-reviewer");
  await captureScreenshot(page, testInfo, "pr-conversation-after-review");
});

test("without a GitHub credential, the pull request view says how to connect", async ({ page, request }, testInfo) => {
  await request.post("/__e2e/reset", { data: { git: true, github: "no-credential" } });
  await page.goto("/?pr=642");
  const connect = page.locator("#preview .gh-connect").first();
  await expect(connect).toBeVisible();
  await expect(connect).toContainText("Connect GitHub to review pull requests here");
  await expect(page.locator("#pr-panel-conversation [data-pr-composer]")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "pr-no-credential");
});

test("without the reset's GitHub fake, the GitHub routes answer 404", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true } });
  await page.goto("/");
  const status = await page.evaluate(async () => (await fetch("/api/github/summary?repository=x")).status);
  expect(status).toBe(404);
});

// The real service and parsers over GitHub-shaped JSON (the transport-level
// fake): Files changed renders GitHub's patches, a patchless file says so,
// and a line comment on a patch joins the pending review.
test("the real service over the transport fake: patches, a line comment and a review", async ({ page, request }, testInfo) => {
  await request.post("/__e2e/reset", { data: { git: true, github: "transport" } });
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await page.goto("/?pr=42");
  const conversation = page.locator("#pr-panel-conversation");
  // The title is text, never markup; a file-level thread says so.
  await expect(page.getByText("Add login form <script>alert(1)</script>").first()).toBeVisible();
  await expect(conversation.locator(".pr-thread-summary", { hasText: "docs/login.md" }).first()).toContainText("file");
  // What GitHub's answer left out: a timeline entry beyond those read and
  // one of a kind uatu doesn't show, with the way to GitHub.
  const omitted = conversation.locator("[data-pr-omitted]");
  await expect(omitted).toContainText("2 more timeline entries on GitHub.");
  await expect(omitted.locator("a")).toHaveAttribute("href", "https://github.com/acme/widgets/pull/42");
  await omitted.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "pr-conversation-omitted");

  await page.locator("#pr-tab-files").click();
  const files = page.locator("#pr-panel-files");
  const login = files.locator('[data-file-path="src/login.ts"]');
  await expect(login.getByRole("button", { name: /Comment on src\/login\.ts line 12/ })).toBeVisible();
  await expect(files.locator('[data-file-path="images/flow.png"]')).toContainText("GitHub sends no diff for this file");

  await login.locator("[data-file-comment]").click();
  const inline = files.locator(".pr-composer-box").filter({ has: page.getByRole("button", { name: "Add to review" }) }).first();
  await inline.locator("textarea").fill("Transport smoke: line comment.");
  await inline.getByRole("button", { name: "Add to review" }).click();
  await expect(files.getByText("Transport smoke: line comment.")).toBeVisible();

  await page.locator("[data-review-finish]:visible").first().click();
  const dialog = page.locator(".gh-dialog");
  await dialog.locator('input[value="COMMENT"]').check();
  await dialog.locator("[data-review-submit]").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-review-finish]:visible")).toHaveCount(0);
});

// One line comment in #642's Files changed, held for the review.
async function addLineComment(page: import("@playwright/test").Page, text: string): Promise<void> {
  const { token } = await page.request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await page.goto("/?pr=642&tab=files");
  const files = page.locator("#pr-panel-files");
  await files.locator("[data-file-comment]").first().click();
  const inline = files.locator(".pr-composer-box").filter({ has: page.getByRole("button", { name: "Add to review" }) }).first();
  await inline.locator("textarea").fill(text);
  await inline.getByRole("button", { name: "Add to review" }).click();
  await expect(files.getByText(text)).toBeVisible();
}

test("Request changes needs a summary, then publishes the pending comment with it", async ({ page }) => {
  await addLineComment(page, "Rename this before merging.");
  await page.locator("[data-review-finish]:visible").first().click();
  const dialog = page.locator(".gh-dialog");
  await dialog.locator('input[value="REQUEST_CHANGES"]').check();
  // GitHub's rule: a change request carries a summary.
  await expect(dialog.locator("[data-review-submit]")).toBeDisabled();
  await dialog.locator("#gh-review-summary").fill("Two names to fix.");
  await expect(dialog.locator("[data-review-submit]")).toBeEnabled();
  await dialog.locator("[data-review-submit]").click();
  await expect(dialog).toBeHidden();
  await page.locator("#pr-tab-conversation").click();
  const review = page.locator("#pr-panel-conversation .pr-review").last();
  await expect(review).toContainText("octo-reviewer");
  await expect(review).toContainText("Changes requested");
  await expect(review).toContainText("Two names to fix.");
});

test("Discard review asks first, then removes the pending review", async ({ page }) => {
  await addLineComment(page, "A comment to throw away.");
  const discard = page.locator("[data-review-discard]:visible").first();
  await discard.click();
  const confirm = page.locator(".gh-dialog").filter({ hasText: "Discard your pending review?" });
  await expect(confirm).toBeVisible();
  // Keeping it changes nothing.
  await confirm.locator("[data-dialog-cancel]").click();
  await expect(page.locator("#pr-panel-files").getByText("A comment to throw away.")).toBeVisible();
  await discard.click();
  await page.locator(".gh-dialog [data-dialog-confirm]").click();
  await expect(page.locator("#pr-panel-files").getByText("A comment to throw away.")).toHaveCount(0);
  await expect(page.locator("[data-review-finish]:visible")).toHaveCount(0);
});

test("on the viewer's own pull request, Approve and Request changes are disabled", async ({ page, request }) => {
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  // #627 is octo-reviewer's, the fake's viewer.
  await page.goto("/?pr=627");
  await expect(page.locator("#pr-panel-conversation [data-pr-composer] textarea")).toBeVisible();
  await page.locator("[data-review-open]:visible, [data-review-finish]:visible").first().click();
  const dialog = page.locator(".gh-dialog");
  await expect(dialog.locator('input[value="APPROVE"]')).toBeDisabled();
  await expect(dialog.locator('input[value="REQUEST_CHANGES"]')).toBeDisabled();
  await expect(dialog.locator('input[value="COMMENT"]')).toBeEnabled();
  await expect(dialog).toContainText("You can't approve or request changes on your own pull request.");
});

test("rate-limited: the view keeps the last answer with its time, and sending waits", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true, github: "rate-limited" } });
  await page.goto("/?pr=642");
  const banner = page.locator("#preview [data-pr-banner]");
  await expect(banner).toContainText("GitHub rate limit reached");
  await expect(banner.locator("[data-pr-retry]")).toBeVisible();
  await expect(banner).toContainText("Comments and reviews are paused; drafts are kept.");
});

test("a merged pull request's readiness says so, with no merge link (the real service)", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true, github: "transport" } });
  await page.goto("/?pr=57");
  await expect(page.locator("#pr-panel-conversation .gh-state-merged").first()).toBeVisible();
  const box = page.locator("#pr-panel-conversation [data-pr-merge-box]");
  await expect(box).not.toContainText("Merge on GitHub");
  await expect(box).not.toContainText("Merging is blocked");
  // #42 is open and blocked: its reasons and a secondary View on GitHub.
  await page.goto("/?pr=42");
  const blocked = page.locator("#pr-panel-conversation [data-pr-merge-box]");
  await expect(blocked).toContainText("Merging is blocked");
  await expect(blocked).toContainText("Required check failing: lint.");
  await expect(blocked.getByRole("link", { name: /View on GitHub/ })).toHaveAttribute("href", "https://github.com/acme/widgets/pull/42");
});

test("Approve needs no summary and shows as an approval", async ({ page }) => {
  await addLineComment(page, "Looks right to me.");
  await page.locator("[data-review-finish]:visible").first().click();
  const dialog = page.locator(".gh-dialog");
  await dialog.locator('input[value="APPROVE"]').check();
  await expect(dialog.locator("[data-review-submit]")).toBeEnabled();
  await dialog.locator("[data-review-submit]").click();
  await expect(dialog).toBeHidden();
  await page.locator("#pr-tab-conversation").click();
  await expect(page.locator("#pr-panel-conversation .pr-review").last()).toContainText("Approved");
});
