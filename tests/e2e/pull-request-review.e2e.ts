// Pull request review, end to end on the in-memory GitHub fake (the e2e
// server's reset with `github: true`; src/github/fake.ts): open the branch's
// pull request, post a conversation comment, add a line comment in Files
// changed, and submit the review. The smoke test that keeps the PR surfaces
// covered in CI; the real `gh api` service is unit-tested against a fake
// transport (src/github/gh-service.test.ts).

import { expect, standardBeforeEach, test } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
  await request.post("/__e2e/reset", { data: { git: true, github: true } });
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("open a pull request, comment, add a line comment and submit the review", async ({ page, request }) => {
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

  // Finish the review as a comment; the pending comment is published.
  const finish = page.locator("[data-review-finish]:visible").first();
  await expect(finish).toBeEnabled();
  await finish.click();
  const dialog = page.locator(".gh-dialog");
  await expect(dialog.locator(".gh-pending-list")).toContainText("Smoke test: line comment.");
  await dialog.locator('input[value="COMMENT"]').check();
  await dialog.locator("[data-review-submit]").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-review-finish]:visible")).toHaveCount(0);

  await page.locator("#pr-tab-conversation").click();
  await expect(conversation.locator(".pr-review").last()).toContainText("octo-reviewer");
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
test("the real service over the transport fake: patches, a line comment and a review", async ({ page, request }) => {
  await request.post("/__e2e/reset", { data: { git: true, github: "transport" } });
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token)}`);
  await page.goto("/?pr=42");
  const conversation = page.locator("#pr-panel-conversation");
  // The title is text, never markup; a file-level thread says so.
  await expect(page.getByText("Add login form <script>alert(1)</script>").first()).toBeVisible();
  await expect(conversation.locator(".pr-thread-summary", { hasText: "docs/login.md" }).first()).toContainText("file");

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
