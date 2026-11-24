// Pull request review, end to end on the in-memory GitHub fake (the e2e
// server's reset with `github: true`; src/github/fake.ts): open the branch's
// pull request, post a conversation comment, add a line comment in Files
// changed, and submit the review; then every line kind, a reply, deleting a
// pending comment, Escape and discard confirmations with focus return,
// drafts across reload, Ctrl+Enter, unsent drafts in Finish review, Resolve
// with Undo, Jump to file and the head-moved refusal. The real `gh api`
// service runs over the transport fake (tests/fixtures/github-fake.ts) where
// a test says so.

import { captureScreenshot } from "./evidence";
import { expect, standardBeforeEach, test } from "./fixtures";
import {
  addPendingComment,
  focusedElement,
  inlineComposer,
  lineNumber,
  openPullRequest,
  ownPullRequest,
  pinnedFileHeadersAt,
  previewScrollHeight,
  pushPullRequestHead,
  reviewButton,
  reviewDialog,
  signIn,
} from "./pull-request-helpers";

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

// Inline review in Files changed and the review dialog, driven with real
// clicks and keys on the fake (task 6.2 and 6.3's e2e matrix). #642's
// docs/pr-review.md has every line kind: line 1 is context, line 3 was
// removed and line 4 added.
test.describe("inline review", () => {
  test.beforeEach(async ({ page, request }) => {
    await signIn(page, request);
  });

  test("a comment on an added, a removed and a context line each joins the pending review on its side", async ({ page }) => {
    await openPullRequest(page, "pr=642&tab=files");
    const kinds = [
      { line: 4, kind: "addition", value: "RIGHT:4", card: "Line 4 (new) · your pending comment" },
      { line: 3, kind: "deletion", value: "LEFT:3", card: "Line 3 (old) · your pending comment" },
      { line: 1, kind: "context", value: "RIGHT:1", card: "Line 1 (new) · your pending comment" },
    ] as const;
    for (const { line, kind, value, card } of kinds) {
      await lineNumber(page, "docs/pr-review.md", line, kind).click();
      const composer = inlineComposer(page);
      await expect(composer.locator("[data-composer-line]")).toHaveValue(value);
      // The composer takes the keyboard at once.
      await expect(composer.locator("textarea")).toBeFocused();
      await page.keyboard.type(`A note on the ${kind} line.`);
      await composer.getByRole("button", { name: "Add to review" }).click();
      const pending = page.locator(".pr-thread.is-pending", { hasText: `A note on the ${kind} line.` });
      await expect(pending).toContainText(card);
      await expect(pending.locator(".gh-pill")).toHaveText("Pending");
    }
    await expect(reviewButton(page)).toHaveAccessibleName("Finish review (3)");
    await expect(page.locator("#pr-panel-files [data-pr-review-bar]")).toContainText("3 pending comments on #642");
    await reviewButton(page).click();
    await expect(reviewDialog(page).locator(".gh-pending-list li")).toHaveCount(3);
  });

  test("Comment on a line opens on its line picker; Escape returns focus to the button, or to the line the picker moved it to", async ({ page }) => {
    await openPullRequest(page, "pr=642&tab=files");
    const comment = page.locator('.pr-file[data-file-path="docs/hub.md"] [data-file-comment]');
    await expect(comment).toHaveAccessibleName("Comment on a line in docs/hub.md");
    await comment.click();
    const picker = inlineComposer(page).locator("[data-composer-line]");
    await expect(picker).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(inlineComposer(page)).toHaveCount(0);
    await expect(comment).toBeFocused();

    await comment.click();
    await expect(picker).toBeFocused();
    await picker.selectOption("RIGHT:12");
    await expect(picker).toHaveValue("RIGHT:12");
    await expect(picker).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(inlineComposer(page)).toHaveCount(0);
    await expect.poll(async () => (await focusedElement(page)).label).toBe("Comment on docs/hub.md line 12");
  });

  test("Escape on a composer with text asks first; Discard draft closes it and focus returns to its line number", async ({ page }) => {
    await openPullRequest(page, "pr=642&tab=files");
    const number = lineNumber(page, "docs/pr-review.md", 9);
    await number.click();
    const composer = inlineComposer(page);
    await composer.locator("textarea").fill("A draft to throw away.");
    await composer.getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Escape");
    const ask = page.locator('dialog[open][aria-label="Discard draft"]');
    await expect(ask).toBeVisible();
    // Keeping the draft changes nothing.
    await ask.getByRole("button", { name: "Keep editing" }).click();
    await expect(composer.locator("textarea")).toHaveValue("A draft to throw away.");
    await composer.getByRole("button", { name: "Cancel" }).click();
    await page.locator('dialog[open][aria-label="Discard draft"] [data-dialog-confirm]').click();
    await expect(inlineComposer(page)).toHaveCount(0);
    await expect.poll(async () => (await focusedElement(page)).label).toBe("Comment on docs/pr-review.md line 9");
  });

  test("Ctrl+Enter adds a line comment, posts a conversation comment, and saves an edit in Finish review", async ({ page }) => {
    await openPullRequest(page, "pr=642&tab=files");
    await lineNumber(page, "docs/pr-review.md", 10).click();
    await page.keyboard.type("Added with the keyboard.");
    await page.keyboard.press("Control+Enter");
    const pending = page.locator(".pr-thread.is-pending", { hasText: "Added with the keyboard." });
    await expect(pending).toBeVisible();
    await expect(pending).toBeFocused();

    await reviewButton(page).click();
    const dialog = reviewDialog(page);
    await dialog.locator("[data-pending-edit]").click();
    const edit = dialog.locator("[data-pending-text]");
    await expect(edit).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.type(" (edited)");
    await page.keyboard.press("Control+Enter");
    await expect(edit).toHaveCount(0);
    await expect(dialog.locator(".gh-pending-body")).toHaveText("Added with the keyboard. (edited)");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await page.locator("#pr-tab-conversation").click();
    const composer = page.locator("#pr-panel-conversation [data-pr-composer] textarea");
    await composer.fill("Posted with the keyboard.");
    await composer.press("Control+Enter");
    await expect(page.locator("#pr-panel-conversation .pr-event", { hasText: "Posted with the keyboard." })).toBeVisible();
    await expect(composer).toHaveValue("");
  });

  test("a reply joins the pending review; Edit saves it, Discard asks first and removes it", async ({ page }) => {
    await openPullRequest(page, "pr=642&tab=files");
    const thread = page.locator('#pr-panel-files [data-thread-id="thread-checks-source"]');
    await thread.locator("[data-thread-reply-open]").click();
    const reply = thread.locator("textarea");
    await expect(reply).toBeFocused();
    await page.keyboard.type("A pending reply.");
    await thread.getByRole("button", { name: "Add reply to review" }).click();
    const pendingReply = thread.locator(".pr-pending-reply");
    await expect(pendingReply).toContainText("A pending reply.");
    await expect(reviewButton(page)).toHaveAccessibleName("Finish review (1)");

    await pendingReply.locator("[data-pending-edit]").click();
    await expect(pendingReply.locator("textarea")).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.type(" Edited.");
    await page.keyboard.press("Control+Enter");
    await expect(pendingReply.locator(".pr-thread-comment-body")).toHaveText("A pending reply. Edited.");

    await pendingReply.locator("[data-pending-discard]").click();
    const ask = page.locator('dialog[open][aria-label="Discard pending comment"]');
    await expect(ask).toBeVisible();
    await ask.locator("[data-dialog-confirm]").click();
    await expect(thread.locator(".pr-pending-reply")).toHaveCount(0);
    await expect(page.locator("#pr-view-review [data-review-finish]")).toHaveCount(0);
  });

  test("deleting a pending comment asks first; keeping it changes nothing", async ({ page }) => {
    await page.goto("/");
    await addPendingComment(page, 642, "docs/pr-review.md", 9, "RIGHT", "A comment to delete.");
    await openPullRequest(page, "pr=642&tab=files");
    const card = page.locator(".pr-thread.is-pending", { hasText: "A comment to delete." });
    await card.getByRole("button", { name: "Discard pending comment on docs/pr-review.md:9" }).click();
    const ask = page.locator('dialog[open][aria-label="Discard pending comment"]');
    await ask.locator("[data-dialog-cancel]").click();
    await expect(ask).toBeHidden();
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: "Discard pending comment on docs/pr-review.md:9" })).toBeFocused();
    await card.getByRole("button", { name: "Discard pending comment on docs/pr-review.md:9" }).click();
    await page.locator('dialog[open][aria-label="Discard pending comment"] [data-dialog-confirm]').click();
    await expect(page.locator(".pr-thread.is-pending")).toHaveCount(0);
    await expect(reviewButton(page)).toHaveAccessibleName("Review");
  });

  test("unsent drafts survive a reload: the conversation composer and a line's composer", async ({ page }) => {
    await openPullRequest(page, "pr=642");
    const conversationComposer = page.locator("#pr-panel-conversation [data-pr-composer] textarea");
    await conversationComposer.fill("A conversation draft kept across reload.");
    await page.locator("#pr-tab-files").click();
    await lineNumber(page, "docs/pr-review.md", 9).click();
    await inlineComposer(page).locator("textarea").fill("A line draft kept across reload.");
    await page.reload();
    await expect(page.locator("#pr-panel-files diffs-container").first()).toBeVisible();
    const restored = inlineComposer(page);
    await expect(restored.locator("textarea")).toHaveValue("A line draft kept across reload.");
    await expect(restored.locator("[data-composer-line]")).toHaveValue("RIGHT:9");
    await page.locator("#pr-tab-conversation").click();
    await expect(conversationComposer).toHaveValue("A conversation draft kept across reload.");
    // A posted comment's draft goes with it.
    await conversationComposer.press("Control+Enter");
    await expect(page.locator("#pr-panel-conversation .pr-event", { hasText: "A conversation draft kept across reload." })).toBeVisible();
    await page.reload();
    await expect(page.locator("#pr-panel-conversation [data-pr-composer] textarea")).toHaveValue("");
  });

  test("Finish review with an unsent draft: Add it to the review, or Leave it as a draft and keep the composer", async ({ page }) => {
    await page.goto("/");
    await addPendingComment(page, 642, "docs/pr-review.md", 1);
    await openPullRequest(page, "pr=642&tab=files");
    await lineNumber(page, "docs/pr-review.md", 14).click();
    await inlineComposer(page).locator("textarea").fill("An unsent line draft.");
    await reviewButton(page).click();
    const dialog = reviewDialog(page);
    await expect(dialog.locator("[data-unsent-add]")).toHaveText("Add it to the review");
    // Focus starts on the summary, never on Submit.
    await expect(dialog.locator("#gh-review-summary")).toBeFocused();
    await dialog.locator("[data-unsent-add]").click();
    await expect(dialog.locator("[data-unsent-add]")).toHaveCount(0);
    await expect(dialog.locator("#gh-review-summary")).toBeFocused();
    await expect(dialog.locator(".gh-pending-list li")).toHaveCount(2);
    await expect(dialog.locator(".gh-pending-list")).toContainText("An unsent line draft.");
    // The dialog's title stays in view after the notice goes.
    await expect(dialog.locator(".gh-dialog-title")).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(inlineComposer(page)).toHaveCount(0);

    await lineNumber(page, "docs/pr-review.md", 12).click();
    await inlineComposer(page).locator("textarea").fill("Keep me as a draft.");
    await reviewButton(page).click();
    await dialog.locator("[data-unsent-leave]").click();
    await expect(dialog.locator("[data-unsent-left]")).toBeVisible();
    await dialog.locator('input[value="COMMENT"]').check();
    await expect(dialog.locator("[data-review-submit]")).toBeEnabled();
    await dialog.locator("[data-review-submit]").click();
    await expect(dialog).toBeHidden();
    // The two pending comments are published; the draft stays unsent.
    await expect(inlineComposer(page).locator("textarea")).toHaveValue("Keep me as a draft.");
    await expect(page.locator(".pr-thread.is-pending")).toHaveCount(0);
  });

  test("the one Review button: no verdict chosen, submit labels follow the verdict, Add line comments comes back to a composer", async ({ page }) => {
    await openPullRequest(page, "pr=642");
    await expect(reviewButton(page)).toHaveAccessibleName("Review");
    await reviewButton(page).click();
    const dialog = reviewDialog(page);
    await expect(dialog.locator("input[name=gh-review-event]:checked")).toHaveCount(0);
    await dialog.locator("#gh-review-summary").fill("Looks close; two notes.");
    const submit = dialog.locator("[data-review-submit]");
    for (const [verdict, label] of [["APPROVE", "Publish approval"], ["REQUEST_CHANGES", "Request changes"], ["COMMENT", "Post comment review"]] as const) {
      await dialog.locator(`input[value="${verdict}"]`).check();
      await expect(submit).toHaveText(label);
    }
    await dialog.locator("[data-review-add-lines]").click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("files");
    const composer = inlineComposer(page);
    await expect(composer.locator("textarea")).toBeFocused();
    await page.keyboard.type("Typed straight into the composer.");
    await page.keyboard.press("Shift+Tab");
    await expect(composer.locator("[data-composer-line]")).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".pr-thread.is-pending", { hasText: "Typed straight into the composer." })).toBeVisible();
    // Reopened: the summary and the verdict are kept, the comment listed.
    await reviewButton(page).click();
    await expect(dialog.locator("#gh-review-summary")).toHaveValue("Looks close; two notes.");
    await expect(dialog.locator('input[value="COMMENT"]')).toBeChecked();
    await expect(dialog.locator(".gh-pending-list li")).toHaveCount(1);
  });

  test("the summary's guidance follows the verdict: required for Request changes, optional otherwise", async ({ page }) => {
    await page.goto("/");
    await addPendingComment(page, 642, "docs/pr-review.md", 1);
    await openPullRequest(page, "pr=642");
    await reviewButton(page).click();
    const dialog = reviewDialog(page);
    const label = dialog.locator("label[for=gh-review-summary]");
    const submit = dialog.locator("[data-review-submit]");
    await dialog.locator('input[value="REQUEST_CHANGES"]').check();
    await expect(label).toContainText("required");
    await expect(submit).toBeDisabled();
    await expect(dialog.locator("[data-submit-reason]")).not.toBeEmpty();
    for (const verdict of ["APPROVE", "COMMENT"]) {
      await dialog.locator(`input[value="${verdict}"]`).check();
      await expect(label).toContainText("optional");
      await expect(submit).toBeEnabled();
    }
  });

  test("after submitting from the header's Finish, focus is on the tabs row, the outcome is announced, and the page stays put", async ({ page }) => {
    await page.goto("/");
    await addPendingComment(page, 642, "docs/pr-review.md", 1);
    await openPullRequest(page, "pr=642&tab=files");
    await page.evaluate(() => window.scrollTo(0, 600));
    const before = await page.evaluate(() => window.scrollY);
    await reviewButton(page).click();
    const dialog = reviewDialog(page);
    await dialog.locator('input[value="COMMENT"]').check();
    await dialog.locator("[data-review-submit]").click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-pr-live="status"]')).toHaveText(/^Review submitted/);
    await expect.poll(async () => (await focusedElement(page)).inside(".preview-toolbar")).toBe(true);
    expect(Math.abs(await page.evaluate(() => window.scrollY) - before)).toBeLessThanOrEqual(120);
    // The toast is never focused, and goes on its own.
    await expect(page.locator(".pr-toast")).not.toBeFocused();
    await expect(page.locator(".pr-toast")).toHaveCount(0, { timeout: 10_000 });
  });

  test("Resolve offers Undo in the folded footer; Undo unresolves it, and once the window passes it reads Unresolve", async ({ page }) => {
    test.setTimeout(45_000);
    await openPullRequest(page, "pr=642&tab=files");
    const thread = page.locator('#pr-panel-files [data-thread-id="thread-checks-source"]');
    const resolve = thread.locator('[data-thread-resolve="true"]');
    await expect(resolve).toHaveAccessibleName(/^Resolve conversation on docs\/pr-review\.md/);
    await resolve.click();
    const footer = thread.locator(".pr-thread-footer");
    await expect(footer).toContainText("Resolved on GitHub just now.");
    const undo = thread.locator('[data-thread-resolve="false"]');
    await expect(undo).toHaveText("Undo");
    await expect(undo).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(thread).not.toHaveClass(/is-resolved/);
    await expect(thread.locator('[data-thread-resolve="true"]')).toBeFocused();

    await thread.locator('[data-thread-resolve="true"]').click();
    await expect(footer).toContainText("Resolved on GitHub just now.");
    // The Undo window (8 s) passes: the footer settles on Unresolve, and focus
    // stays on the button.
    await expect(footer).toContainText("Conversation resolved.", { timeout: 15_000 });
    await expect(thread.locator('[data-thread-resolve="false"]')).toHaveText("Unresolve");
    await expect(thread.locator('[data-thread-resolve="false"]')).toBeFocused();
  });

  test("Jump to file: named with its count, the filter takes the keyboard, and Enter opens the file with file= in the URL", async ({ page }) => {
    await openPullRequest(page, "pr=642&tab=files");
    const jump = page.locator("#pr-view-jump");
    await expect(jump).toHaveAccessibleName("Jump to file (9 files)");
    await jump.click();
    const filter = page.locator(".pr-jump-dialog [data-jump-filter]");
    await expect(filter).toBeFocused();
    await filter.fill("src");
    await page.keyboard.press("ArrowDown");
    const first = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.jumpPath);
    await page.keyboard.press("ArrowDown");
    const second = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.jumpPath);
    expect(first).toMatch(/^src\//);
    expect(second).toMatch(/^src\//);
    expect(second).not.toBe(first);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(filter).toBeFocused();
    await filter.fill("nothing-matches");
    await expect(page.locator(".pr-jump-dialog [data-jump-empty]")).toBeVisible();
    await filter.fill("pr-view");
    await expect(page.locator(".pr-jump-dialog [data-jump-row]:not([hidden])")).toHaveCount(1);
    await filter.press("Enter");
    await expect(page.locator(".pr-jump-dialog")).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get("file")).toBe("src/preview/pr-view.ts");
    await expect.poll(async () => (await focusedElement(page)).inside('[data-file-path="src/preview/pr-view.ts"]')).toBe(true);
    await expect(page.locator('.pr-file[data-file-path="src/preview/pr-view.ts"] .pr-file-header')).toBeInViewport();
  });

  test("one file header is pinned at a time while Files changed scrolls, under the header and the review bar, never over them", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/");
    await addPendingComment(page, 642, "docs/pr-review.md", 1);
    await openPullRequest(page, "pr=642&tab=files");
    const total = await previewScrollHeight(page);
    const problems: string[] = [];
    let sawPinned = false;
    for (let y = 0; y < total; y += 97) {
      const at = await pinnedFileHeadersAt(page, y);
      if (at.pinned.length > 1) problems.push(`scroll ${at.scroll}: ${at.pinned.join(", ")} pinned at once`);
      if (at.pinned.length === 1) sawPinned = true;
      if (at.over.length) problems.push(`scroll ${at.scroll}: painted over the header at ${at.over.slice(0, 3).join("; ")}`);
    }
    expect(problems).toEqual([]);
    expect(sawPinned).toBe(true);
  });

  test("the conversation composer says it posts immediately, and Preview past the length limit says so without rendering", async ({ page }) => {
    await openPullRequest(page, "pr=642");
    const composer = page.locator("#pr-panel-conversation [data-pr-composer]");
    await expect(composer.locator("textarea")).toHaveAttribute("placeholder", /posts immediately/);
    let renders = 0;
    page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/api/github/markdown")) renders += 1; });
    await composer.locator("textarea").fill("x".repeat(65_540));
    await composer.getByRole("tab", { name: "Preview comment" }).click();
    await expect(composer.locator(".pr-composer-preview")).toHaveText(/^Too long/);
    expect(renders).toBe(0);
  });
});

// A line comment refused because GitHub's head moved after the diff was
// read (the real service over the transport fake, #42 the workspace's own):
// the refusal says so and the draft stays in its composer.
test("the head-moved refusal keeps the line's draft", async ({ page, request }) => {
  await ownPullRequest(page, request);
  await openPullRequest(page, "pr=42&tab=files");
  await page.locator('.pr-file[data-file-path="feature.md"]').getByRole("button", { name: /^Comment on feature\.md line 3$/ }).click();
  const composer = inlineComposer(page);
  await composer.locator("textarea").fill("Written before the head moved.");
  await pushPullRequestHead(request, { "feature.md": "# Feature\n\nCommitted branch change.\n\nMore work on GitHub.\n" });
  await composer.getByRole("button", { name: "Add to review" }).click();
  await expect(composer).toContainText(/changed since this diff was loaded|new commits|moved/i);
  await expect(composer.locator("textarea")).toHaveValue("Written before the head moved.");
  await expect(page.locator(".pr-thread.is-pending")).toHaveCount(0);
});
