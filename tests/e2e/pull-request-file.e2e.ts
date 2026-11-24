// The pull request file view (`?pr=<n>&path=<path>[&rev=base]`) on the
// in-memory GitHub fake (the e2e server's reset with `github: true`;
// src/github/fake.ts, seeds src/github/fake-data.ts): one file of #639 at its
// head in the document Rendered / Source / Diff chooser, the threads bar, the
// Base revision, stepping between files, All files, and the consent card the
// `head-not-fetched` scenario shows before the narrow fetch. #639 changes four
// files; in tree order docs/terminal-links.adoc, docs/terminal.md,
// src/terminal/links.test.ts, src/terminal/links.ts.

import type { APIRequestContext, Page } from "@playwright/test";

import { expect, standardBeforeEach, test } from "./fixtures";

const HEAD = "c0ffee1";

async function resetGithub(page: Page, request: APIRequestContext, github: boolean | string = true): Promise<void> {
  await standardBeforeEach(page, request);
  await request.post("/__e2e/reset", { data: { git: true, github } });
  // Writes (a fetch, a comment) carry the workspace credential, as a session
  // URL printed by the CLI does.
  const { token } = await request.get("/__e2e/terminal-token").then(response => response.json()) as { token: string };
  await page.goto(`/?t=${encodeURIComponent(token)}`);
}

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

  test("Rendered shows the file at the PR head with its facts, Mermaid and the blob-route image", async ({ page }) => {
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
    // The scope's tree scrolls inside its pane; activate the row as a tap would.
    await row.dispatchEvent("click");
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

  test("the consent card fetches nothing until Fetch, then shows the file", async ({ page }) => {
    await page.goto("/?pr=639&path=docs/terminal.md");
    const card = page.locator("#preview .pr-fetch-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("refs/uatu/pull/639/head");
    await expect(card.locator("[data-pr-file-show-diff]")).toBeVisible();

    await card.locator("[data-pr-file-fetch]").click();
    await expect(card).toHaveCount(0);
    await expect(page.locator("#preview h1", { hasText: "Terminal" })).toBeVisible();
    await expect(facts(page)).toContainText(`at ${HEAD} (PR head)`);
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
