// Pull request review on a touch phone, portrait 390×844 and landscape
// 844×390 (add-github-pr-review task 6.3's touch half; the ux-loop probes
// r3-hits, r7-checks, r8-sticky, r8-row, r9-probe, ported): a tap on a
// line's row opens its composer, the tabs row's Review / Finish button, the
// tab bar stepping aside while a composer has focus, Jump to file, one file
// header pinned at a time, the review dialog's verdicts on a short screen,
// and 44px controls taken at their centre (elementFromPoint). On the
// in-memory GitHub fake (#642, the branch's pull request; src/github/fake.ts).

import type { Page } from "@playwright/test";

import { captureScreenshot } from "./evidence";
import { expect, test } from "./fixtures";
import {
  addPendingComment,
  centreMiss,
  expectTouchTarget,
  focusedElement,
  inlineComposer,
  LANDSCAPE,
  openPullRequest,
  openPullRequestPane,
  pinnedFileHeadersAt,
  PORTRAIT,
  previewScrollHeight,
  resetTouchGithub,
  reviewButton,
  reviewDialog,
  tapCentre,
} from "./pull-request-helpers";

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

// The point on a line's code (right of its numbers) that a finger taps,
// with the line scrolled to the middle of the screen; and whether the row
// itself takes a tap there.
async function codePoint(page: Page, path: string, text: string): Promise<{ x: number; y: number; hit: boolean }> {
  return page.evaluate(({ path, text }) => {
    const container = document.querySelector(`.pr-file[data-file-path="${path}"] diffs-container`)!;
    const line = [...container.shadowRoot!.querySelectorAll<HTMLElement>("[data-line]")].find(candidate => candidate.textContent?.includes(text))!;
    line.scrollIntoView({ block: "center" });
    const box = line.getBoundingClientRect();
    const x = box.left + Math.min(box.width - 10, Math.max(120, box.width * 0.6));
    const y = box.top + box.height / 2;
    return { x, y, hit: document.elementFromPoint(x, y) === container };
  }, { path, text });
}

// Where the diff starts below the pinned chrome, at the middle of the
// screen: the first y that hits a diff row.
const pinnedChromeBottom = (page: Page) => page.evaluate(() => {
  const x = Math.round(innerWidth / 2);
  for (let y = 0; y < innerHeight; y += 1) {
    const element = document.elementFromPoint(x, y);
    if (element && (element.tagName === "DIFFS-CONTAINER" || element.closest(".pr-file-body"))) return y;
  }
  return innerHeight;
});

const tabBar = (page: Page) => page.locator("#touch-tab-bar");

for (const [orientation, device] of [["portrait", PORTRAIT], ["landscape", LANDSCAPE]] as const) {
  test.describe(orientation, () => {
    test.use(device);

    test.beforeEach(async ({ page, request }) => {
      await resetTouchGithub(page, request);
    });

    test("a tap on a line's code opens its composer; Add to review is taken where it sits, even brought back from under the tab bar", async ({ page }) => {
      await openPullRequest(page, "pr=642&tab=files");
      const point = await codePoint(page, "docs/hub.md", "Assign a credential");
      expect(point.hit, "the row takes the tap at its code").toBe(true);
      await page.touchscreen.tap(point.x, point.y);
      const composer = inlineComposer(page);
      await expect(composer.locator("[data-composer-line]")).toHaveValue("RIGHT:7");
      await expect(composer.locator("textarea")).toBeFocused();
      await composer.locator("textarea").fill("A tap on the row.");
      const add = composer.getByRole("button", { name: "Add to review" });
      await expectTouchTarget(add, "Add to review");
      // Scrolled under the tab bar, then brought back the way the browser does.
      await add.evaluate(button => { window.scrollBy(0, button.getBoundingClientRect().top - (innerHeight - 30)); });
      await add.evaluate(button => button.scrollIntoView({ block: "nearest" }));
      expect(await centreMiss(add)).toBeNull();
      await tapCentre(page, add);
      await expect(page.locator(".pr-thread.is-pending", { hasText: "A tap on the row." })).toBeVisible();
    });

    test("the tab bar steps aside while a composer has focus and comes back on blur", async ({ page }) => {
      await openPullRequest(page, "pr=642&tab=files");
      await expect(tabBar(page)).toBeVisible();
      const point = await codePoint(page, "docs/pr-review.md", "Click or tap a line");
      await page.touchscreen.tap(point.x, point.y);
      const textarea = inlineComposer(page).locator("textarea");
      await expect(textarea).toBeFocused();
      await expect(tabBar(page)).toBeHidden();
      await textarea.fill("Unsent.");
      await textarea.blur();
      await expect(tabBar(page)).toBeVisible();
    });

    test("the tabs row holds Conversation, Files changed, Review and Jump to file on one line, each 44px and taken at its centre", async ({ page }) => {
      await openPullRequest(page, "pr=642&tab=files");
      const controls = [
        page.locator("#pr-tab-conversation"), page.locator("#pr-tab-files"), reviewButton(page), page.locator("#pr-view-jump"),
      ];
      const rows = new Set<number>();
      for (const control of controls) {
        await expectTouchTarget(control, (await control.getAttribute("aria-label")) ?? (await control.innerText()));
        const box = (await control.boundingBox())!;
        rows.add(Math.round((box.y + box.height / 2) / 8));
        expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      }
      expect(rows.size).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(reviewButton(page)).toHaveText("Review");
    });

    test("each file header's Comment button is on the path's row, labelled, 44px, and opens its composer on the line picker", async ({ page }) => {
      await openPullRequest(page, "pr=642&tab=files");
      const sections = page.locator(".pr-file");
      for (const index of [0, 1, 2]) {
        const section = sections.nth(index);
        const path = (await section.getAttribute("data-file-path"))!;
        const comment = section.locator("[data-file-comment]");
        await expect(comment).toHaveAccessibleName(`Comment on a line in ${path}`);
        await expect(comment).toHaveAttribute("title", /.+/);
        await expect(comment.locator(".pr-file-action-label")).toHaveText("Comment");
        const sameRow = await comment.evaluate(button => {
          const toggle = button.closest(".pr-file")!.querySelector<HTMLElement>("[data-file-toggle]")!.getBoundingClientRect();
          const box = button.getBoundingClientRect();
          return box.top < toggle.bottom && box.bottom > toggle.top;
        });
        expect(sameRow, `${path}'s Comment is on its path's row`).toBe(true);
        // A short screen's file header keeps a 44px tap box (an extension
        // over the diff's gap): measured by hits above and below its box.
        await comment.evaluate(button => button.scrollIntoView({ block: "center" }));
        const reach = await comment.evaluate(button => {
          const box = button.getBoundingClientRect();
          const x = box.left + box.width / 2;
          // Its own box, or the box plus the extension below it.
          const bottom = box.height >= 43.5 ? box.bottom - 1 : box.bottom + 3.5;
          return { width: box.width, height: Math.max(box.height, bottom - box.top + 0.5), hits: [box.top + 1, bottom].map(y => button.contains(document.elementFromPoint(x, y))) };
        });
        expect(reach.width).toBeGreaterThanOrEqual(43.5);
        expect(reach.height).toBeGreaterThanOrEqual(43.5);
        expect(reach.hits, `${path}'s Comment answers across its 44px`).toEqual([true, true]);
        expect(await centreMiss(comment)).toBeNull();
      }
      const comment = page.locator('.pr-file[data-file-path="docs/pr-review.md"] [data-file-comment]');
      await tapCentre(page, comment);
      await expect(inlineComposer(page).locator("[data-composer-line]")).toBeFocused();
      expect(await (await focusedElement(page)).inside('.pr-file[data-file-path="docs/pr-review.md"]')).toBe(true);
    });

    test("one file header is pinned at a time, under the tabs row, never over it, with nothing of the title row left", async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      await page.goto("/");
      await addPendingComment(page, 642, "docs/pr-review.md", 1);
      await openPullRequest(page, "pr=642&tab=files");
      const total = await previewScrollHeight(page);
      const problems: string[] = [];
      let sawPinned = false;
      for (let y = 0; y < total; y += 97) {
        const at = await pinnedFileHeadersAt(page, y);
        if (at.pinned.length > 1) problems.push(`scroll ${at.scroll}: ${at.pinned.length} pinned headers (${at.pinned.join(", ")})`);
        if (at.pinned.length === 1) sawPinned = true;
        if (at.over.length) problems.push(`scroll ${at.scroll}: painted over the pinned header at ${at.over.slice(0, 3).join("; ")}`);
        if (at.slivers.length) problems.push(`scroll ${at.scroll}: a sliver of ${at.slivers.join(", ")}`);
      }
      expect(problems).toEqual([]);
      expect(sawPinned, "a file header pins while its diff scrolls").toBe(true);
      await captureScreenshot(page, testInfo, `pr-touch-${orientation}-pinned-header`);
    });

    test("pinned chrome leaves the diff its room: the first line high on open, and little pinned while scrolling a file", async ({ page }) => {
      await page.goto("/");
      await addPendingComment(page, 642, "docs/pr-review.md", 1);
      await openPullRequest(page, "pr=642&tab=files");
      const viewport = page.viewportSize()!;
      const first = await page.evaluate(() => {
        const container = [...document.querySelectorAll("diffs-container")].find(element => element.getBoundingClientRect().height > 0)!;
        return container.shadowRoot!.querySelector<HTMLElement>("[data-line]")!.getBoundingClientRect().top;
      });
      const tabBarTop = (await tabBar(page).boundingBox())!.y;
      if (orientation === "portrait") expect(first).toBeLessThanOrEqual(viewport.height * 0.4);
      expect(first).toBeLessThanOrEqual(tabBarTop - 60);
      await page.evaluate(() => {
        const second = document.querySelectorAll<HTMLElement>(".pr-file")[1]!;
        document.scrollingElement!.scrollTop += second.getBoundingClientRect().top + 120;
      });
      await expect.poll(() => pinnedChromeBottom(page)).toBeLessThanOrEqual(orientation === "portrait" ? 120 : 100);
    });

    test("Jump to file: the filter waits for a tap, and the picked file's header and first rows are clear of the pinned chrome", async ({ page }) => {
      await openPullRequest(page, "pr=642&tab=files");
      const jump = page.locator("#pr-view-jump");
      await expectTouchTarget(jump, "Jump to file");
      const files = await page.locator(".pr-file").evaluateAll(sections => sections.map(section => (section as HTMLElement).dataset.filePath!));
      for (const path of [files[3]!, files[6]!]) {
        await tapCentre(page, jump);
        const dialog = page.locator(".pr-jump-dialog");
        await expect(dialog).toBeVisible();
        // No keyboard pops up over the list on open.
        await expect(dialog.locator("[data-jump-filter]")).not.toBeFocused();
        await dialog.locator(`[data-jump-path="${path}"]`).click();
        await expect(dialog).toHaveCount(0);
        await expect.poll(() => new URL(page.url()).searchParams.get("file")).toBe(path);
        const section = page.locator(`.pr-file[data-file-path="${path}"]`);
        await expect.poll(() => section.evaluate(element => {
          const header = element.querySelector<HTMLElement>(".pr-file-header")!;
          const box = header.getBoundingClientRect();
          const container = element.querySelector("diffs-container")!;
          const rows = [...container.shadowRoot!.querySelectorAll<HTMLElement>("[data-line]")].slice(0, 2).map(row => {
            const rect = row.getBoundingClientRect();
            return document.elementFromPoint(rect.left + Math.min(40, rect.width / 2), rect.top + rect.height / 2) === container;
          });
          return header.contains(document.elementFromPoint(box.left + 20, box.top + box.height / 2)) && rows.every(Boolean);
        })).toBe(true);
      }
    });

    test("the review dialog: every verdict in view and taken, the footer one row, and Submit from the tabs row keeps focus there", async ({ page }, testInfo) => {
      await page.goto("/");
      await addPendingComment(page, 642, "docs/pr-review.md", 1);
      await openPullRequest(page, "pr=642&tab=files");
      await page.evaluate(() => window.scrollTo(0, 900));
      await tapCentre(page, reviewButton(page));
      const dialog = reviewDialog(page);
      await expect(dialog.locator(".gh-choice")).toHaveCount(3);
      // On touch focus starts on Cancel: the keyboard would cover the verdicts.
      await expect(dialog.locator("[data-dialog-cancel]")).toBeFocused();
      const layout = await dialog.evaluate(element => {
        const box = element.getBoundingClientRect();
        const footer = element.querySelector<HTMLElement>(".gh-dialog-footer")!.getBoundingClientRect();
        const rows = new Set([...element.querySelectorAll<HTMLElement>(".gh-dialog-footer .gh-dialog-actions > button")].map(button => Math.round(button.getBoundingClientRect().top))).size;
        const choices = [...element.querySelectorAll<HTMLElement>(".gh-choice")].map(choice => {
          const rect = choice.getBoundingClientRect();
          return rect.top >= box.top && rect.bottom <= footer.top && choice.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
        });
        return { footer: footer.height, rows, choices };
      });
      expect(layout.choices).toEqual([true, true, true]);
      expect(layout.rows).toBe(1);
      // A short screen has no row to spare: the footer is one compact line.
      if (orientation === "landscape") expect(layout.footer).toBeLessThanOrEqual(64);
      for (const control of await dialog.locator("textarea, .gh-choice, .gh-dialog-footer button").all()) {
        await control.evaluate(element => element.scrollIntoView({ block: "nearest" }));
        expect(await centreMiss(control)).toBeNull();
      }
      await captureScreenshot(page, testInfo, `pr-touch-${orientation}-review-dialog`);
      await dialog.locator(".gh-choice", { has: page.locator('input[value="COMMENT"]') }).click();
      await dialog.locator("[data-review-submit]").click();
      await expect(dialog).toBeHidden();
      await expect.poll(async () => (await focusedElement(page)).inside(".preview-toolbar")).toBe(true);
      await expect(page.locator('[data-pr-live="status"]')).toHaveText(/^Review submitted/);
    });

    test("the pane's pending pill is compact with a 44px tap box, and its actions sit whole inside the expanded pane", async ({ page }) => {
      await page.goto("/");
      await addPendingComment(page, 642, "docs/pr-review.md", 1);
      await page.reload();
      await openPullRequestPane(page);
      const pill = page.locator("#pull-request-pane-meta .gh-pill-button");
      await expect(pill).toHaveAccessibleName("Finish review (1 pending comment)");
      const reach = await pill.evaluate(button => {
        const box = button.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        return { height: box.height, hits: [[x, y - 21], [x, y + 21], [x - 20, y], [x + 16, y], [x, y]].map(([px, py]) => button.contains(document.elementFromPoint(px!, py!))) };
      });
      expect(reach.height).toBeLessThanOrEqual(24);
      expect(reach.hits).toEqual([true, true, true, true, true]);
      for (const action of await page.locator("#pull-request-pane .pr-pane-actions > *").all()) {
        const inside = await action.evaluate(element => {
          const pane = document.querySelector<HTMLElement>("#pull-request-pane")!.getBoundingClientRect();
          const box = element.getBoundingClientRect();
          return box.top >= pane.top && box.bottom <= pane.bottom;
        });
        expect(inside, `${await action.innerText()} inside the pane`).toBe(true);
        expect(await centreMiss(action)).toBeNull();
      }
    });
  });
}

test.describe("landscape diff room", () => {
  test.use(LANDSCAPE);

  test("on opening Files changed at least ten code rows show, and with a composer focused the diff keeps 200px", async ({ page, request }) => {
    await resetTouchGithub(page, request);
    await openPullRequest(page, "pr=642&tab=files");
    const rows = await page.evaluate(() => {
      let count = 0;
      for (const container of document.querySelectorAll("diffs-container")) {
        for (const line of container.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? []) {
          const box = line.getBoundingClientRect();
          if (box.height === 0 || box.top < 0 || box.bottom > innerHeight) continue;
          if (document.elementFromPoint(Math.min(innerWidth - 4, box.left + box.width / 2), box.top + box.height / 2) === container) count += 1;
        }
      }
      return count;
    });
    expect(rows).toBeGreaterThanOrEqual(10);
    const point = await codePoint(page, "docs/pr-review.md", "Click or tap a line");
    await page.touchscreen.tap(point.x, point.y);
    await expect(inlineComposer(page).locator("textarea")).toBeFocused();
    await page.evaluate(() => { document.scrollingElement!.scrollTop += 600; });
    const room = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".preview-header")!.getBoundingClientRect();
      const bar = document.querySelector<HTMLElement>("#touch-tab-bar")!;
      const bottom = bar.checkVisibility() ? bar.getBoundingClientRect().top : innerHeight;
      const fileHeaders = [...document.querySelectorAll<HTMLElement>(".pr-file-header")].map(element => element.getBoundingClientRect()).filter(box => box.top <= header.bottom + 1 && box.bottom > 0);
      return bottom - Math.max(header.bottom, ...fileHeaders.map(box => box.bottom));
    });
    expect(room).toBeGreaterThanOrEqual(200);
  });
});

test.describe("narrow phone", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });

  test("at 320px the tabs row fits, idle and with a review in progress, and nothing scrolls sideways", async ({ page, request }) => {
    await resetTouchGithub(page, request);
    for (const pending of [false, true]) {
      if (pending) {
        await page.goto("/");
        await addPendingComment(page, 642, "docs/pr-review.md", 1);
      }
      await openPullRequest(page, "pr=642&tab=files");
      for (const control of [page.locator("#pr-tab-conversation"), page.locator("#pr-tab-files"), reviewButton(page), page.locator("#pr-view-jump")]) {
        const box = (await control.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(320);
        expect(await centreMiss(control)).toBeNull();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    }
    await expect(reviewButton(page)).toHaveAccessibleName("Finish review (1)");
  });
});
