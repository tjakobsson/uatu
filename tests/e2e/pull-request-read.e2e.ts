// Reading a pull request (add-github-pr-review tasks 2.6 and 7.2): the
// Pull request pane's summary and its Details cards, every non-ready state
// (no pull request, no credential, rate-limited, unavailable), an
// unresolvable URL, a long conversation, a hostile comment, direct URL
// arrival, Refresh, reload and Back/Forward, and a workspace with two Git
// repositories, in desktop and touch modes. Mostly on the in-memory GitHub
// fake (the e2e server's reset with `github: true` or a scenario name;
// src/github/fake.ts, seeds src/github/fake-data.ts, where #642 is the
// branch's pull request); the two-repository and head checks run the real
// service over the transport fake (tests/fixtures/github-fake.ts) with local
// bare remotes. Nothing reaches GitHub.

import type { Page } from "@playwright/test";

import { captureScreenshot } from "./evidence";
import { expect, test } from "./fixtures";
import {
  centreMiss,
  chooseScenario,
  expectTouchTarget,
  focusedElement,
  openPullRequest,
  openPullRequestPane,
  ownPullRequest,
  PORTRAIT,
  LANDSCAPE,
  postComment,
  repositoryId,
  resetGithub,
  resetTouchGithub,
  showTab,
} from "./pull-request-helpers";

const pane = (page: Page) => page.locator("#pull-request-pane");
const details = (page: Page) => page.locator("#pr-pane-details");
const detailsToggle = (page: Page) => page.locator("[data-pr-details-toggle]");
const conversation = (page: Page) => page.locator("#pr-panel-conversation");
const banner = (page: Page) => page.locator("#preview [data-pr-banner]");
const param = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the pane's summary: state, decision, title, checks and the first blocker, then Review and View on GitHub", async ({ page, request }, testInfo) => {
    await resetGithub(page, request);
    await page.goto("/");
    const header = page.locator('[data-pane-id="pull-request"] > .pane-header');
    await expect(header).toContainText("Pull request #642");
    await expect(pane(page).locator(".pr-pane-top")).toContainText("Open");
    await expect(pane(page).locator(".pr-pane-top")).toContainText("Review required");
    await expect(pane(page).locator(".pr-pane-title")).toHaveText("feat(preview): add GitHub PR review");
    const status = pane(page).locator(".pr-pane-status");
    await expect(status).toContainText("4 passed");
    await expect(status).toContainText("1 running");
    await expect(status).toContainText("Blocked: main requires 2 approving reviews. (+1 more)");
    await expect(pane(page).getByRole("button", { name: "Review", exact: true })).toBeVisible();
    // Blocked: the link out is the secondary View on GitHub, in a new tab.
    const github = pane(page).getByRole("link", { name: /View on GitHub/ });
    await expect(github).toHaveAttribute("href", "https://github.com/octo-org/uatu/pull/642");
    await expect(github).toHaveAttribute("target", "_blank");
    await expect(pane(page).getByText("Merge on GitHub")).toHaveCount(0);
    // Every action is inside the pane and takes its own click.
    for (const action of await pane(page).locator(".pr-pane-actions > *, .pr-pane-disclosure").all()) {
      expect(await centreMiss(action)).toBeNull();
    }
    await captureScreenshot(page, testInfo, "pr-read-pane-summary");
  });

  test("Details: one full-width row naming what it holds, four cards in a floating panel, and Escape closes it back onto the row", async ({ page, request }, testInfo) => {
    await resetGithub(page, request);
    await page.goto("/");
    const toggle = detailsToggle(page);
    await expect(toggle).toHaveAttribute("aria-controls", "pr-pane-details");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveText(/Details\s*Blockers, 5 checks, 2 reviewers/);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(details(page)).toBeVisible();
    const headings = details(page).locator(".pr-pane-section > .pr-pane-section-head > :first-child");
    await expect(headings).toHaveText(["Merge readiness", "Checks", "Reviewers", "Branch and stats"]);
    await expect(details(page).locator(".pr-pane-checks")).toContainText("e2e (leg 2)");
    await expect(details(page).locator(".pr-pane-reviewers")).toContainText("octo-maintainer");
    // The floating panel is whole inside the window and on top of the page.
    await expect(details(page)).toHaveClass(/is-floating/);
    await expect(details(page)).toBeInViewport({ ratio: 1 });
    expect(await centreMiss(details(page).locator(".pr-pane-readiness"))).toBeNull();
    await captureScreenshot(page, testInfo, "pr-read-pane-details");

    await page.keyboard.press("Escape");
    await expect(details(page)).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test("the pane's title opens the pull request view, named with its repository, ending in the merge box", async ({ page, request }) => {
    await resetGithub(page, request);
    await page.goto("/");
    await pane(page).locator(".pr-pane-title").click();
    await expect.poll(() => param(page, "pr")).toBe("642");
    await expect(page.locator("#preview-title")).toHaveText("feat(preview): add GitHub PR review");
    await expect(page.locator("#preview-path")).toHaveText("#642 · octo-org/uatu");
    await expect(page.locator("#pr-tab-conversation")).toHaveAttribute("aria-selected", "true");
    await expect(conversation(page)).toContainText("octo-author opened this pull request");
    // Readiness, read-only, at the end of Conversation.
    const box = conversation(page).locator("[data-pr-merge-box]");
    await expect(box).toContainText("Merging is blocked");
    await expect(box).toContainText("main requires 2 approving reviews.");
    await expect(box).toContainText("Waiting for required check: e2e (leg 2).");
    await expect(box.getByRole("link", { name: /View on GitHub/ })).toHaveAttribute("href", "https://github.com/octo-org/uatu/pull/642");
    await expect(box).toContainText("uatu doesn't merge");
  });

  test("a merge box names each blocker: a draft and a failing check, conflicts and requested changes", async ({ page, request }) => {
    await resetGithub(page, request);
    await openPullRequest(page, "pr=631");
    const draft = conversation(page).locator("[data-pr-merge-box]");
    await expect(draft).toContainText("Draft: mark it ready for review on GitHub first.");
    await expect(draft).toContainText("Required check failing: unit.");
    await openPullRequest(page, "pr=618");
    const conflicted = conversation(page).locator("[data-pr-merge-box]");
    await expect(conflicted).toContainText("Changes requested");
    await expect(conflicted).toContainText("Conflicts with main must be resolved.");
    await expect(conflicted).toContainText("Changes were requested; that reviewer must approve.");
  });

  test("a closed pull request (the real service): its state says so and its merge box offers no merge", async ({ page, request }) => {
    await resetGithub(page, request, "transport");
    await openPullRequest(page, "pr=41");
    await expect(pane(page).locator(".pr-pane-status")).toContainText("Closed without merging");
    const box = conversation(page).locator("[data-pr-merge-box]");
    await expect(box.getByRole("heading", { name: "Closed without merging" })).toBeVisible();
    await expect(box).not.toContainText("Merge on GitHub");
    await expect(box).not.toContainText("Merging is blocked");
    // Nothing to compose or review on a closed pull request.
    await expect(conversation(page)).toContainText("#41 is closed; new comments are closed here.");
    await expect(pane(page).getByRole("button", { name: "Review", exact: true })).toBeDisabled();
  });

  test("no pull request for the branch: the pane says so, with Browse pull requests… and Create on GitHub", async ({ page, request }) => {
    await resetGithub(page, request, "no-pull-request");
    await page.goto("/");
    const card = pane(page).locator(".gh-state-card");
    await expect(card.getByRole("heading", { name: "No pull request for feature/review-load" })).toBeVisible();
    await expect(card).toContainText("Nothing on octo-org/uatu has this branch as its head.");
    await expect(card.getByRole("link", { name: /Create on GitHub/ })).toHaveAttribute("href", "https://github.com/octo-org/uatu/compare/feature%2Freview-load?expand=1");
    // Browse opens the switcher at its Pull requests.
    await card.getByRole("button", { name: "Browse pull requests…" }).click();
    await expect(page.locator("#hub-menu")).toBeVisible();
    await expect(page.locator("#switcher-pull-requests [role=option]").first()).toBeVisible();
    await expect(page.locator("#switcher-pull-requests-heading")).toContainText("octo-org/uatu");
  });

  test("no credential: the pane and the view say how to connect, outside a Hub with gh auth login", async ({ page, request }, testInfo) => {
    await resetGithub(page, request, "no-credential");
    await page.goto("/");
    const connect = pane(page).locator(".gh-connect");
    await expect(connect.getByRole("heading", { name: "GitHub isn't connected for this workspace" })).toBeVisible();
    await expect(connect).toContainText("gh auth login");
    await openPullRequest(page, "pr=642").catch(() => undefined);
    await expect(page.locator("#preview-path")).toHaveText("#642 · GitHub not connected");
    const card = page.locator("#preview .gh-connect").first();
    await expect(card).toContainText("Connect GitHub to review pull requests here");
    await expect(card).toContainText("Outside a Hub, sign in with gh auth login and restart this session.");
    await expect(conversation(page).locator("[data-pr-composer]")).toHaveCount(0);
    await captureScreenshot(page, testInfo, "pr-read-no-credential");
  });

  test("rate-limited: the pane and the view keep the last answer with its time; Retry asks again and says the limit still holds", async ({ page, request }) => {
    await resetGithub(page, request, "rate-limited");
    await page.goto("/");
    const stale = pane(page).locator(".pr-pane-stale");
    await expect(stale).toContainText(/Rate-limited · sending paused · as of \d\d:\d\d/);
    await expect(pane(page).locator(".pr-pane")).toHaveClass(/is-stale/);
    await expect(pane(page).locator(".pr-pane-status")).toContainText(/Last known: blocked · as of \d\d:\d\d/);
    await openPullRequest(page, "pr=642");
    await expect(banner(page)).toContainText("GitHub rate limit reached.");
    await expect(banner(page)).toContainText(/Showing #642 as of \d\d:\d\d/);
    await expect(banner(page)).toContainText("Comments and reviews are paused; drafts are kept.");
    // The last answer stays on screen.
    await expect(conversation(page)).toContainText("octo-author opened this pull request");
    const retried = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/github/refresh"));
    await banner(page).getByRole("button", { name: "Retry" }).click();
    await retried;
    await expect(banner(page)).toContainText("GitHub rate limit reached.");
  });

  test("unavailable: the banner says GitHub couldn't be reached; once it answers, Retry clears the banner and the pane", async ({ page, request }) => {
    await resetGithub(page, request, "unavailable");
    await page.goto("/");
    await expect(pane(page).locator(".pr-pane-stale")).toContainText(/GitHub unreachable · sending paused · as of \d\d:\d\d/);
    await openPullRequest(page, "pr=642");
    await expect(banner(page)).toContainText("Couldn't reach GitHub.");
    await expect(banner(page)).toContainText("GitHub did not answer (connection timed out).");
    await chooseScenario(page, "ready");
    await page.goto("/?pr=642");
    await expect(banner(page)).toBeHidden();
    await expect(pane(page).locator(".pr-pane-stale")).toHaveCount(0);
    await expect(pane(page).locator(".pr-pane-status")).toContainText("Blocked: main requires 2 approving reviews.");
  });

  test("an unresolvable URL: a pull request that doesn't exist says so with Retry, and a malformed number opens the default document", async ({ page, request }, testInfo) => {
    await resetGithub(page, request);
    await page.goto("/?pr=999");
    await expect(page.locator("#preview-title")).toHaveText("Pull request #999");
    await expect(page.locator("#preview-path")).toHaveText(/^#999 · (octo-org\/uatu · )?unavailable$/);
    await expect(page.locator("#preview")).toContainText("Couldn't load this pull request");
    await expect(page.locator("#preview")).toContainText("Pull request #999 does not exist in octo-org/uatu.");
    await expect(page.locator("#preview").getByRole("button", { name: "Retry" })).toBeVisible();
    await captureScreenshot(page, testInfo, "pr-read-unresolvable");
    for (const bad of ["0", "abc", "-4"]) {
      await page.goto(`/?pr=${bad}`);
      await expect(page.locator("#preview-path")).toHaveText("README.md");
    }
  });

  test("a hostile comment renders as text: no script runs, no handler survives, no javascript: link", async ({ page, request }) => {
    await resetGithub(page, request);
    await page.goto("/");
    await postComment(page, 642, "Hostile <script>window.__pwned = 1</script><img src=x onerror=\"window.__pwned = 2\"> [link](javascript:window.__pwned=3)");
    await openPullRequest(page, "pr=642");
    const comment = conversation(page).locator(".pr-event", { hasText: "Hostile" });
    await expect(comment).toContainText("<script>window.__pwned = 1</script>");
    await expect(comment.locator("script, [onerror]")).toHaveCount(0);
    await expect(comment.locator('a[href^="javascript:"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned ?? null)).toBeNull();
  });

  test("a long conversation: every comment is listed in order and the composer stays at its end", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    await resetGithub(page, request);
    await page.goto("/");
    for (let index = 1; index <= 40; index += 1) await postComment(page, 642, `Long conversation comment ${index}.`);
    await openPullRequest(page, "pr=642");
    const comments = conversation(page).locator(".pr-event", { hasText: /Long conversation comment \d+\./ });
    await expect(comments).toHaveCount(40);
    await expect(comments.first()).toContainText("Long conversation comment 1.");
    await expect(comments.last()).toContainText("Long conversation comment 40.");
    const composer = conversation(page).locator("[data-pr-composer] textarea");
    await composer.scrollIntoViewIfNeeded();
    await expect(composer).toBeInViewport();
    // The composer follows the last comment, and nothing scrolls sideways.
    expect(await composer.evaluate(area => {
      const last = [...document.querySelectorAll("#pr-panel-conversation .pr-event")].filter(event => event.textContent?.includes("Long conversation comment 40.")).at(-1)!;
      return last.getBoundingClientRect().bottom <= area.getBoundingClientRect().top;
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureScreenshot(page, testInfo, "pr-read-long-conversation");
  });

  test("direct arrival on Files changed at a file; View in diff writes the thread, which reload and Back/Forward restore", async ({ page, request }) => {
    await resetGithub(page, request);
    await openPullRequest(page, "pr=642&tab=files&file=src/shared/github-contract.ts");
    await expect(page.locator("#pr-tab-files")).toHaveAttribute("aria-selected", "true");
    const contract = page.locator('.pr-file[data-file-path="src/shared/github-contract.ts"]');
    await expect(contract.locator(".pr-file-header")).toBeInViewport();

    await page.locator("#pr-tab-conversation").click();
    await expect.poll(() => param(page, "tab")).toBeNull();
    const view = conversation(page).locator("[data-view-in-diff]").first();
    const thread = (await view.getAttribute("data-view-in-diff"))!;
    await view.click();
    await expect.poll(() => param(page, "thread")).toBe(thread);
    const card = page.locator(`#pr-panel-files [data-thread-id="${thread}"]`);
    await expect.poll(async () => (await focusedElement(page)).inside(`[data-thread-id="${thread}"]`)).toBe(true);

    await page.reload();
    await expect(page.locator("#pr-tab-files")).toHaveAttribute("aria-selected", "true");
    await expect(card).toBeInViewport();
    await expect.poll(async () => (await focusedElement(page)).inside(`[data-thread-id="${thread}"]`)).toBe(true);

    await page.goBack();
    await expect(page.locator("#pr-tab-conversation")).toHaveAttribute("aria-selected", "true");
    await expect(conversation(page)).toBeVisible();
    await page.goForward();
    await expect(page.locator("#pr-tab-files")).toHaveAttribute("aria-selected", "true");
    await expect(card).toBeInViewport();
    await expect.poll(async () => (await focusedElement(page)).inside(`[data-thread-id="${thread}"]`)).toBe(true);
  });

  test("Refresh from the keyboard keeps focus on the button and acknowledges GitHub's answer", async ({ page, request }) => {
    await resetGithub(page, request);
    await page.goto("/");
    await expect(pane(page).locator(".pr-pane-title")).toBeVisible();
    const refresh = page.locator("#pull-request-refresh");
    await refresh.focus();
    const answered = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/github/refresh"));
    await page.keyboard.press("Enter");
    await answered;
    await expect(page.locator("#pull-request-live")).toHaveText(/Pull request updated from GitHub at \d\d:\d\d/);
    await expect(page.locator("#pull-request-updated")).toBeVisible();
    await expect(refresh).toBeFocused();
  });

  // Two Git repositories in one workspace, on the real service: the
  // workspace's repository is acme/widgets with #42 as its branch's pull
  // request; the second, docs-site, has no GitHub remote.
  test("two repositories: the pane follows the chosen one, a URL naming the other says it isn't on GitHub, and focus stays in the switcher", async ({ page, request }) => {
    await ownPullRequest(page, request, {}, { secondRepository: true });
    await expect(page.locator('[data-pane-id="pull-request"] > .pane-header')).toContainText("Pull request #42");
    await expect(page.locator("#change-overview")).toContainText("docs-site");

    await page.locator("#pull-request-browse").click();
    const toggle = page.locator('[data-switcher-menu-toggle="repository"]');
    await expect(toggle).toHaveAccessibleName("Repository: acme/widgets. Choose another");
    await toggle.click();
    const choices = page.locator('[data-switcher-menu="repository"] [role=menuitemradio]');
    await expect(choices).toHaveCount(2);
    await expect(choices.first()).toHaveAttribute("aria-checked", "true");
    await expect(choices.first()).toContainText("acme/widgets");
    await expect(choices.last()).toHaveText("docs-site");
    await choices.last().click();
    // docs-site isn't on GitHub: the selector stays, the way back, and focus
    // stays on it while the other repository is read.
    await expect(page.locator("#switcher-pr-notes")).toHaveText("docs-site isn't on GitHub.");
    await expect(toggle).toHaveAccessibleName("Repository: docs-site. Choose another");
    await expect(toggle).toBeFocused();
    // A repository that isn't on GitHub adds no Pull request pane.
    await expect(page.locator('[data-pane-id="pull-request"]')).toBeHidden();
    await page.keyboard.press("Enter");
    await choices.first().click();
    await expect(toggle).toHaveAccessibleName("Repository: acme/widgets. Choose another");
    await expect(page.locator('#switcher-pull-requests [data-pr-row="42"]')).toBeVisible();
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#hub-menu")).toBeHidden();
    await expect(page.locator('[data-pane-id="pull-request"] > .pane-header')).toContainText("Pull request #42");

    // The other repository's pull request URL says why there is nothing.
    await page.goto(`/?repository=${encodeURIComponent(await repositoryId(page, 1))}&pr=42`);
    await expect(page.locator("#preview-path")).toHaveText("#42 · unavailable");
    await expect(page.locator("#preview")).toContainText("This repository isn't on GitHub.");
    // And the workspace's own repository's URL shows #42 again.
    await page.goto(`/?repository=${encodeURIComponent(await repositoryId(page, 0))}&pr=42`);
    await expect(page.locator("#preview-path")).toHaveText("#42 · acme/widgets");
  });
});

test.describe("touch", () => {
  test.use(PORTRAIT);

  test("the Files tab's expanded pane: the summary, a 44px Details row across the pane, and the title bringing Preview forward", async ({ page, request }, testInfo) => {
    await resetTouchGithub(page, request);
    await page.goto("/");
    await openPullRequestPane(page);
    await expect(pane(page).locator(".pr-pane-title")).toHaveText("feat(preview): add GitHub PR review");
    const toggle = detailsToggle(page);
    await expectTouchTarget(toggle, "Details");
    const widths = await toggle.evaluate(button => {
      const body = document.querySelector<HTMLElement>("#pull-request-pane")!;
      const style = getComputedStyle(body);
      return { row: button.getBoundingClientRect().width, content: body.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
    });
    expect(widths.row).toBeGreaterThanOrEqual(widths.content - 2);
    for (const action of await pane(page).locator(".pr-pane-actions > *").all()) expect(await centreMiss(action)).toBeNull();
    // On touch Details opens inline, in the pane.
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(details(page)).toBeVisible();
    await expect(details(page)).not.toHaveClass(/is-floating/);
    await captureScreenshot(page, testInfo, "pr-read-touch-pane");

    await pane(page).locator(".pr-pane-title").click();
    await expect(page.locator("html")).toHaveAttribute("data-active-tab", "preview");
    await expect(page.locator("#preview-title")).toHaveText("feat(preview): add GitHub PR review");
  });

  test("the view's tabs are 44px, taken at their centre, and named once each", async ({ page, request }) => {
    await resetTouchGithub(page, request);
    await openPullRequest(page, "pr=642");
    for (const tab of ["conversation", "files"]) await expectTouchTarget(page.locator(`#pr-view-control [data-pr-tab="${tab}"]`), `the ${tab} tab`);
    const names = await page.locator("[role=tab]").evaluateAll(tabs => tabs
      .filter(tab => (tab as HTMLElement).checkVisibility())
      .map(tab => tab.getAttribute("aria-label") ?? tab.textContent!.trim().replace(/\s+/g, " ")));
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    await page.locator("#pr-tab-files").click();
    await expect(page.locator("#pr-panel-files diffs-container").first()).toBeVisible();
    await expect.poll(() => param(page, "tab")).toBe("files");
  });

  test("no credential and rate-limited on a phone: the pane and the view say so", async ({ page, request }) => {
    await resetTouchGithub(page, request, "no-credential");
    await page.goto("/");
    await openPullRequestPane(page);
    await expect(pane(page).locator(".gh-connect")).toContainText("GitHub isn't connected for this workspace");
    await page.goto("/?pr=642");
    await showTab(page, "preview");
    await expect(page.locator("#preview .gh-connect").first()).toContainText("Connect GitHub to review pull requests here");

    await resetTouchGithub(page, request, "rate-limited");
    await openPullRequest(page, "pr=642");
    await expect(banner(page)).toContainText("GitHub rate limit reached.");
    await expectTouchTarget(banner(page).getByRole("button", { name: "Retry" }), "Retry");
  });
});

test.describe("touch landscape", () => {
  test.use(LANDSCAPE);

  test("the Pull request pane keeps room for its body, and Details fills the rest of the actions' line", async ({ page, request }) => {
    await resetTouchGithub(page, request);
    await page.goto("/");
    await openPullRequestPane(page);
    await expect(pane(page).locator(".pr-pane-title")).toBeVisible();
    const toggle = detailsToggle(page);
    if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expectTouchTarget(toggle, "Details");
    const room = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>("#pull-request-pane")!;
      const button = document.querySelector<HTMLElement>("[data-pr-details-toggle]")!.getBoundingClientRect();
      const right = body.getBoundingClientRect().right - parseFloat(getComputedStyle(body).paddingRight);
      return { body: body.getBoundingClientRect().height, gap: right - button.right, brand: document.querySelector<HTMLElement>(".sidebar-header")!.getBoundingClientRect().height };
    });
    expect(room.body).toBeGreaterThanOrEqual(140);
    expect(Math.abs(room.gap)).toBeLessThanOrEqual(2);
    expect(room.brand).toBeLessThanOrEqual(48);
  });
});
