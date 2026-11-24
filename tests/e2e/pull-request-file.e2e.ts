// The pull request file view (`?pr=<n>&path=<path>[&rev=base]`) on the
// in-memory GitHub fake (the e2e server's reset with `github: true`;
// src/github/fake.ts, seeds src/github/fake-data.ts): one file of #639 at its
// head in the document Rendered / Source / Diff chooser, the threads bar, the
// Base revision, stepping between files, All files, and the consent card the
// `head-not-fetched` scenario shows before the narrow fetch. #639 changes four
// files; in tree order docs/terminal-links.adoc, docs/terminal.md,
// src/terminal/links.test.ts, src/terminal/links.ts.

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";

import type { Page } from "@playwright/test";

import { workspacePath, workspaceRoot } from "./config";
import { captureScreenshot } from "./evidence";
import { expect, standardBeforeEach, test } from "./fixtures";
import { expectTouchTarget, LANDSCAPE, ownPullRequest, PORTRAIT, pushPullRequestHead, refreshPullRequest, resetGithub, resetTouchGithub } from "./pull-request-helpers";

const HEAD = "c0ffee1";

// Opens a file view and waits until its bar and content are on screen.
async function openFile(page: Page, query: string): Promise<void> {
  await page.goto(`/?${query}`);
  await expect(page.locator("#pr-tab-file")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".pr-file-bar [data-pr-file-facts]")).toContainText(/at \S+ \(/);
}

async function chooseMode(page: Page, mode: "rendered" | "source" | "diff"): Promise<void> {
  const button = page.locator(`#view-${mode}`);
  if (await button.getAttribute("aria-checked") !== "true") await button.click();
  await expect(button).toHaveAttribute("aria-checked", "true");
}

const param = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);
const facts = (page: Page) => page.locator(".pr-file-bar [data-pr-file-facts]");

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test.describe("desktop", () => {
  test.beforeEach(async ({ page, request }) => {
    await resetGithub(page, request);
  });

  test("Rendered shows the file at the PR head with its facts, Mermaid and the blob-route image", async ({ page }, testInfo) => {
    await openFile(page, "pr=639&path=docs/terminal.md");
    await chooseMode(page, "rendered");
    await expect(page.locator("#pr-tab-file")).toContainText("terminal.md");
    await expect(facts(page)).toContainText(new RegExp(`at ${HEAD} \\(PR head\\) · \\d+ B`));
    await expect(page.locator("#preview h1", { hasText: "Terminal" })).toBeVisible();
    await expect(page.locator("#preview svg").first()).toBeVisible();
    await expect(page.locator("#pr-file-nav [data-pr-file-count]")).toContainText("2 of 4");
    await expect(page.locator(".pr-file-threads")).toContainText("1 thread");

    // The relative image is the blob at #639's head, from the blob route.
    const image = page.locator('#preview img[alt="A wrapped row keeps its link"]');
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 100 && img.currentSrc.includes("/api/github/pr-blob/")))
      .toBe(true);
    await page.locator("#preview h1").scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, "pr-file-rendered-desktop");
  });

  test("Rendered marks the block holding the thread's line, and its marker opens the thread in Diff", async ({ page }, testInfo) => {
    await openFile(page, "pr=639&path=docs/terminal.md");
    await chooseMode(page, "rendered");
    await expect(page.locator("#preview svg").first()).toBeVisible();
    // The thread is on line 3, inside the paragraph that starts there.
    const block = page.locator("#preview .has-pr-thread-block");
    await expect(block).toHaveCount(1);
    await expect(block).toHaveAttribute("data-source-line", "3");
    await expect(block).toContainText("Links printed with OSC 8 open in a new tab");
    const marker = page.locator("#preview .pr-block-thread");
    await expect(marker).toHaveCount(1);
    await expect(marker).toHaveAttribute("aria-label", "1 review thread on line 3: Show in Diff");
    // Read-only: no composer, and the marker adds no text to the document.
    await expect(page.locator("#preview [data-file-comment]")).toHaveCount(0);
    await expect(marker).toHaveText("");
    await captureScreenshot(page, testInfo, "pr-file-rendered-thread-marker");

    await marker.click();
    await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-thread-id]")?.getAttribute("data-thread-id") ?? null))
      .toBe("thread-639-docs");
  });

  test("Source marks the thread's line, and Show in Diff focuses the thread in Diff", async ({ page }) => {
    await openFile(page, "pr=639&path=docs/terminal.md");
    await chooseMode(page, "source");
    await expect(page.locator("#preview pre.uatu-source-pre")).toHaveCount(1);
    await expect(page.locator('#preview .uatu-cl.has-pr-thread[data-ln="3"]')).toHaveCount(1);
    await expect(page.locator("#preview .uatu-cl.has-pr-thread")).toHaveCount(1);
    // Neither Rendered nor Source offers a composer.
    await expect(page.locator("#preview [data-file-comment]")).toHaveCount(0);

    await page.locator("[data-pr-file-show-threads]").click();
    await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-thread-id]")?.getAttribute("data-thread-id") ?? null))
      .toBe("thread-639-docs");
  });

  test("Diff is Files changed for this one file, with its thread and the composer", async ({ page }) => {
    await openFile(page, "pr=639&path=docs/terminal.md");
    await chooseMode(page, "diff");
    await expect(page.locator("#preview .pr-file")).toHaveCount(1);
    await expect(page.locator('#preview .pr-file[data-file-path="docs/terminal.md"]')).toHaveCount(1);
    await expect(page.locator('#preview [data-thread-id="thread-639-docs"]')).toHaveCount(1);
    await expect(page.locator("#preview [data-file-comment]")).toHaveCount(1);
    // Diff needs no threads bar: the threads are inline.
    await expect(page.locator(".pr-file-threads")).toHaveCount(0);
  });

  test("› steps to the next file in tree order, keeping the mode and focus; Back returns", async ({ page }) => {
    await openFile(page, "pr=639&path=docs/terminal.md");
    await chooseMode(page, "source");
    const next = page.locator('#pr-file-nav [data-pr-file-direction="next"]');
    await next.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => param(page, "path")).toBe("src/terminal/links.test.ts");
    await expect(page.locator("#pr-file-nav [data-pr-file-count]")).toContainText("3 of 4");
    await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#preview pre.uatu-source-pre")).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.prFileDirection ?? null)).toBe("next");

    // At the last file › is disabled and focus moves to ‹.
    await page.keyboard.press("Enter");
    await expect.poll(() => param(page, "path")).toBe("src/terminal/links.ts");
    await expect(next).toBeDisabled();
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.prFileDirection ?? null)).toBe("previous");

    // Each step is a history entry.
    await page.goBack();
    await expect.poll(() => param(page, "path")).toBe("src/terminal/links.test.ts");
    await expect(page.locator("#pr-file-nav [data-pr-file-count]")).toContainText("3 of 4");
  });

  test("Base shows the file at the PR's base commit and adds rev=base", async ({ page }) => {
    await openFile(page, "pr=639&path=docs/terminal.md");
    await chooseMode(page, "rendered");
    await expect(page.locator("#preview svg").first()).toBeVisible();
    await page.locator('[data-pr-file-rev="base"]').click();
    await expect.poll(() => param(page, "rev")).toBe("base");
    await expect(facts(page)).toContainText("at 7dd6e40 (main, the base)");
    await expect(page.locator('[data-pr-file-rev="base"]')).toHaveAttribute("aria-checked", "true");
    // The base predates the diagram.
    await expect(page.locator("#preview p", { hasText: "Links printed with OSC 8 open in a new tab." })).toBeVisible();
    await expect(page.locator("#preview svg")).toHaveCount(0);
  });

  test("All files opens a file the pull request leaves unchanged, without Diff", async ({ page }) => {
    await openFile(page, "pr=639&path=docs/terminal.md");
    await page.locator('[data-pr-scope-mode="all"]').click();
    const row = page.locator('#pr-scope-tree button[data-item-path="ARCHITECTURE.md"]');
    await expect(row).toBeAttached();
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await expect.poll(() => param(page, "path")).toBe("ARCHITECTURE.md");
    await expect(facts(page)).toContainText("not changed by this pull request");
    await expect(page.locator("#view-diff")).toBeHidden();
    await expect(page.locator("#pr-file-nav [data-pr-file-count]")).toContainText("4 changed");
  });

  test("a direct URL reload shows the same file, revision and tab", async ({ page }) => {
    await openFile(page, "pr=639&path=docs/terminal.md&rev=base");
    await chooseMode(page, "source");
    await page.reload();
    await expect(page.locator("#pr-tab-file")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#pr-tab-file")).toContainText("terminal.md");
    await expect(facts(page)).toContainText("(main, the base)");
    await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#preview pre.uatu-source-pre")).toContainText("Links printed with OSC 8 open in a new tab.");
    await expect(page.locator("#preview pre.uatu-source-pre")).not.toContainText("mermaid");
  });
});

test.describe("head not fetched", () => {
  test.beforeEach(async ({ page, request }) => {
    await resetGithub(page, request, "head-not-fetched");
  });

  test("the consent card fetches nothing until Fetch, then shows the file", async ({ page }, testInfo) => {
    await page.goto("/?pr=639&path=docs/terminal.md");
    const card = page.locator("#preview .pr-fetch-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("refs/uatu/pull/639/head");
    await expect(card.locator("[data-pr-file-show-diff]")).toBeVisible();
    await captureScreenshot(page, testInfo, "pr-file-consent-card");

    await card.locator("[data-pr-file-fetch]").click();
    await expect(card).toHaveCount(0);
    await expect(page.locator("#preview h1", { hasText: "Terminal" })).toBeVisible();
    await expect(facts(page)).toContainText(`at ${HEAD} (PR head)`);
  });
});

// The branch's own pull request on the real service over the transport fake
// (#42, tests/e2e/pull-request-helpers.ts): the facts line compares the PR
// head's file with the checkout, and a head that moves on GitHub says so.
test.describe("the branch's own pull request", () => {
  test.beforeEach(async ({ page, request }) => {
    await standardBeforeEach(page, request);
  });

  test("Same as your checkout, then the new-commits notice when GitHub's head moves; Reload asks to fetch it", async ({ page, request }, testInfo) => {
    await ownPullRequest(page, request);
    await openFile(page, "pr=42&path=feature.md");
    await chooseMode(page, "rendered");
    await expect(page.locator("#preview")).toContainText("Committed branch change.");
    await expect(facts(page)).toContainText("Same as your checkout");
    await expect(facts(page).locator("[data-pr-file-open-local]")).toHaveText("Open in workspace");

    const head = await pushPullRequestHead(request, { "feature.md": "# Feature\n\nCommitted branch change.\n\nMore work on GitHub.\n" });
    await refreshPullRequest(page);
    const notice = facts(page).locator('[role="status"]');
    await expect(notice).toContainText("#42 has new commits since this file was read.");
    // The file read before stays until Reload.
    await expect(page.locator("#preview")).not.toContainText("More work on GitHub.");
    await captureScreenshot(page, testInfo, "pr-file-new-commits");

    // The new head isn't local: Reload asks before fetching it.
    await notice.locator("[data-pr-file-reload]").click();
    const card = page.locator("#preview .pr-fetch-card");
    await expect(card).toBeVisible();
    await card.locator("[data-pr-file-fetch]").click();
    await expect(card).toHaveCount(0);
    await expect(page.locator("#preview")).toContainText("More work on GitHub.");
    await expect(facts(page)).toContainText(`at ${head.slice(0, 7)} (PR head)`);
    // The checkout is now behind the head.
    const checkout = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: workspaceRoot(), encoding: "utf8" }).trim();
    await expect(facts(page)).toContainText(new RegExp(`Your checkout differs \\(checkout at ${checkout}[0-9a-f]*\\); showing the PR head\\.`));
  });

  test("a checkout ahead of the head, or with local edits, differs; Open your copy opens the workspace file", async ({ page, request }) => {
    await ownPullRequest(page, request);
    // Local edits on the PR head.
    await fs.writeFile(workspacePath("feature.md"), "# Feature\n\nCommitted branch change.\n\nA local edit.\n", "utf8");
    await openFile(page, "pr=42&path=feature.md");
    await chooseMode(page, "rendered");
    await expect(facts(page)).toContainText("Your checkout differs (local edits); showing the PR head.");
    await expect(page.locator("#preview")).not.toContainText("A local edit.");

    // Committed: the checkout is ahead of the head.
    const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: workspaceRoot(), encoding: "utf8" }).trim();
    git("commit", "--quiet", "-am", "local work");
    const checkout = git("rev-parse", "--short=7", "HEAD");
    // Once the session's Git data has the new commit, a fresh view compares.
    await expect.poll(async () => JSON.stringify(await (await request.get("/api/state")).json())).toContain(checkout);
    await page.reload();
    await chooseMode(page, "rendered");
    await expect(facts(page)).toContainText(new RegExp(`Your checkout differs \\(checkout at ${checkout}[0-9a-f]*\\); showing the PR head\\.`));

    await facts(page).locator("[data-pr-file-open-local]").click();
    await expect(page.locator("#preview-path")).toHaveText("feature.md");
    await expect(page.locator("#preview")).toContainText("A local edit.");
  });
});

test.describe("touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the file view is the Preview tab, and its controls are at least 44px", async ({ page, request }) => {
    await request.post("/__e2e/reset", { data: { git: true, github: true } });
    await page.goto("/");
    await page.evaluate(() => { try { window.localStorage.clear(); } catch { /* best-effort */ } });
    await page.goto("/?pr=639&path=docs/terminal.md");
    await expect(page.locator("#touch-tab-preview")).toHaveAttribute("aria-selected", "true");
    await expect(facts(page)).toContainText(`at ${HEAD} (PR head)`);
    await expect(page.locator("#pr-file-nav [data-pr-file-count]")).toBeVisible();

    const misses = await page.evaluate(() => {
      const selectors = ["#pr-file-nav button", "#view-control .view-segment:not([hidden])", "[data-pr-file-rev]", "[data-pr-file-show-threads]"];
      const out: string[] = [];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll<HTMLElement>(selector)) {
          element.scrollIntoView({ block: "nearest" });
          const box = element.getBoundingClientRect();
          if (box.width === 0) continue;
          const name = `${selector} "${element.textContent!.trim().slice(0, 16)}"`;
          if (box.height < 43.5 || box.width < 43.5) out.push(`${name} is ${Math.round(box.width)}×${Math.round(box.height)}`);
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          if (!(hit === element || element.contains(hit))) out.push(`${name} is covered by ${hit?.tagName.toLowerCase()}`);
        }
      }
      return out;
    });
    expect(misses).toEqual([]);
  });
});

// The rest of the ux-loop file view probe (fv-checks), with real clicks and
// keys: the mode kept across ‹ › in Diff, the counter's Jump to file, View
// file from Files changed, a relative link, Source's Wrap, and no page
// errors on the way.
test.describe("desktop, moving between files", () => {
  test.beforeEach(async ({ page, request }) => {
    await resetGithub(page, request);
  });

  test("Diff is kept across › and Back / Forward, and a reload lands on the file view in Diff", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await openFile(page, "pr=639&path=docs/terminal.md");
    await chooseMode(page, "diff");
    const next = page.locator('#pr-file-nav [data-pr-file-direction="next"]');
    await next.click();
    await expect.poll(() => param(page, "path")).toBe("src/terminal/links.test.ts");
    await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('#preview .pr-file[data-file-path="src/terminal/links.test.ts"]')).toHaveCount(1);
    await expect(next).toBeFocused();
    await next.click();
    await expect.poll(() => param(page, "path")).toBe("src/terminal/links.ts");
    await page.goBack();
    await expect.poll(() => param(page, "path")).toBe("src/terminal/links.test.ts");
    await page.goForward();
    await expect.poll(() => param(page, "path")).toBe("src/terminal/links.ts");
    await expect(page.locator("#pr-file-nav [data-pr-file-count]")).toContainText("4 of 4");
    await page.reload();
    await expect(page.locator("#pr-tab-file")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#view-diff")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('#preview .pr-file[data-file-path="src/terminal/links.ts"]')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("the counter opens Jump to file: Escape gives focus back to it, and a pick opens that file", async ({ page }) => {
    await openFile(page, "pr=639&path=src/terminal/links.ts");
    const counter = page.locator("#pr-file-nav [data-pr-file-count]");
    await counter.click();
    const dialog = page.locator(".pr-jump-dialog[open]");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(counter).toBeFocused();
    await counter.click();
    await page.locator('.pr-jump-dialog [data-jump-path="docs/terminal.md"]').click();
    await expect.poll(() => param(page, "path")).toBe("docs/terminal.md");
    await expect(counter).toContainText("2 of 4");
  });

  test("View file from a Files changed header opens the document Rendered; leaving the file view takes its bar away", async ({ page }) => {
    await openFile(page, "pr=639&path=docs/terminal.md");
    await chooseMode(page, "diff");
    await page.locator("#pr-tab-files").click();
    const files = page.locator("#pr-panel-files");
    await expect(files.locator("[data-file-view]")).toHaveCount(4);
    await expect(page.locator(".pr-file-bar")).toHaveCount(0);
    await files.locator('[data-file-path="docs/terminal.md"] [data-file-view]').click();
    await expect.poll(() => param(page, "path")).toBe("docs/terminal.md");
    await expect(page.locator("#view-rendered")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#preview h1", { hasText: "Terminal" })).toBeVisible();
  });

  test("a relative link opens its target's file view, and AsciiDoc renders there", async ({ page }) => {
    await openFile(page, "pr=639&path=docs/terminal.md");
    await chooseMode(page, "rendered");
    await page.locator("#preview a", { hasText: "the link rules" }).click();
    await expect.poll(() => param(page, "path")).toBe("docs/terminal-links.adoc");
    await expect(page.locator("#pr-tab-file")).toContainText("terminal-links.adoc");
    await expect(page.locator("#preview table").first()).toBeVisible();
  });

  test("Source keeps the threads bar and offers Wrap; Changed brings the scope back after All files", async ({ page }) => {
    await openFile(page, "pr=639&path=docs/terminal.md");
    await chooseMode(page, "source");
    await expect(page.locator(".pr-file-threads")).toContainText("1 thread");
    await expect(page.locator("#wrap-control")).toBeVisible();
    await page.locator('[data-pr-scope-mode="all"]').click();
    await expect(page.locator('[data-pr-scope-mode="all"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('#pr-scope-tree button[data-item-path="ARCHITECTURE.md"]')).toBeAttached();
    await page.locator('[data-pr-scope-mode="changed"]').click();
    await expect(page.locator('#pr-scope-tree button[data-item-path="ARCHITECTURE.md"]')).toHaveCount(0);
    await expect(page.locator('#pr-scope-tree button[data-item-path="docs/terminal.md"]')).toBeAttached();
  });
});

test.describe("head not fetched, scope", () => {
  test("the consent card leaves the scope switch, and All files still lists the tree", async ({ page, request }) => {
    await resetGithub(page, request, "head-not-fetched");
    await page.goto("/?pr=639&path=docs/terminal.md");
    await expect(page.locator("#preview .pr-fetch-card")).toBeVisible();
    await expect(page.locator('#pr-scope-switch [data-pr-scope-mode="all"]')).toBeVisible();
  });
});

test.describe("the branch's own pull request, opening the checkout", () => {
  test("Same as your checkout: Open in workspace opens the live document, without the file view's bar", async ({ page, request }) => {
    await standardBeforeEach(page, request);
    await ownPullRequest(page, request);
    await openFile(page, "pr=42&path=feature.md");
    await expect(facts(page)).toContainText("Same as your checkout");
    await facts(page).locator("[data-pr-file-open-local]").click();
    await expect(page.locator("#preview-path")).toHaveText("feature.md");
    await expect(page.locator(".pr-file-bar")).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).pathname).toBe("/feature.md");
  });
});

for (const [orientation, device] of [["portrait", PORTRAIT], ["landscape", LANDSCAPE]] as const) {
  test.describe(`touch ${orientation}, from the Files tab`, () => {
    test.use(device);

    test("a row of the pull request's Files scope brings Preview forward on the file; every file view control is 44px and taken", async ({ page, request }) => {
      await resetTouchGithub(page, request);
      await page.goto("/?pr=639");
      await page.locator("#touch-tab-files").click();
      const toggle = page.locator('[data-pane-toggle="files"]');
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      const row = page.locator('#pr-scope-tree button[data-item-path="docs/terminal.md"]');
      await row.scrollIntoViewIfNeeded();
      await row.tap();
      await expect.poll(() => param(page, "path")).toBe("docs/terminal.md");
      await expect(page.locator("#touch-tab-preview")).toHaveAttribute("aria-selected", "true");
      await expect(facts(page)).toContainText(`at ${HEAD} (PR head)`);
      const selectors = ["#pr-file-nav button", '#pr-view-control [data-pr-tab="files"]', "#pr-view-review button", "#view-control .view-segment:not([hidden])", "[data-pr-file-rev]", "[data-pr-file-show-threads]"];
      for (const selector of selectors) {
        for (const control of await page.locator(selector).all()) {
          if (!(await control.isVisible())) continue;
          await expectTouchTarget(control, `${selector} "${(await control.innerText()).trim().slice(0, 16)}"`);
        }
      }
    });
  });
}
