import { expect, test } from "./fixtures";
import { promises as fs } from "node:fs";

import { workspacePath } from "./config";
import { revealTreeRow, treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

// Real-browser coverage for ⌘F. The matching, offset mapping, and counter
// wording are unit-tested in `src/find/`; what needs a real engine is the
// CSS Custom Highlight API, the shortcut reaching the page, and the
// interaction between find and the preview's remount lifecycle.

// Playwright maps ControlOrMeta to the host's primary modifier, which is the
// same rule `detectIsMac()` applies in the page.
const FIND = "ControlOrMeta+f";
const STEP = "ControlOrMeta+g";

// Documents with content chosen for specific properties: a repeated word for
// counting, a highlighted code block whose tokens split across elements, and a
// link whose URL is not rendered as text.
const FIXTURES = {
  "find-target.md": [
    "# Find Target",
    "",
    "alpha beta alpha gamma alpha",
    "",
    "See [the docs](https://example.com/hidden-url) for more.",
    "",
    "```js",
    "const answer = 42;",
    "```",
    "",
    "Trailing alpha.",
  ].join("\n"),
};

async function openFind(page: import("@playwright/test").Page) {
  await page.keyboard.press(FIND);
  // `#find-bar` is the zero-height sticky wrapper — never "visible" in its own
  // right. The query box is what the reader actually sees.
  await expect(page.locator("#find-query")).toBeVisible();
}

// How many ranges are currently painted. Highlights are not in the DOM, so
// this is the only way to observe them.
async function highlightCounts(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const registry = (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights;
    return {
      matches: registry.get("uatu-find-match")?.size ?? 0,
      current: registry.get("uatu-find-current")?.size ?? 0,
    };
  });
}

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
  await request.post("/__e2e/reset", { data: { extras: FIXTURES } });
  await page.goto("/");
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("finds matches in the rendered view, counts them, and wraps both ways", async ({ page }) => {
  await treeRow(page, "find-target.md").click();
  await expect(page.locator("#preview-title")).toHaveText("Find Target");

  await openFind(page);
  await page.locator("#find-query").fill("alpha");

  // Three in the paragraph plus one in the trailing line.
  await expect(page.locator("#find-status")).toHaveText("1 of 4");

  // One range is current, the rest are general — they are disjoint sets.
  const painted = await highlightCounts(page);
  expect(painted.current).toBe(1);
  expect(painted.matches).toBe(3);

  await page.keyboard.press("Enter");
  await expect(page.locator("#find-status")).toHaveText("2 of 4");

  // Wrap forward past the last match.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.locator("#find-status")).toHaveText("4 of 4");
  await page.keyboard.press("Enter");
  await expect(page.locator("#find-status")).toHaveText("1 of 4");

  // Wrap backward past the first.
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator("#find-status")).toHaveText("4 of 4");
});

test("⌘G steps matches without focus in the query box", async ({ page }) => {
  await treeRow(page, "find-target.md").click();
  await openFind(page);
  await page.locator("#find-query").fill("alpha");
  await expect(page.locator("#find-status")).toHaveText("1 of 4");

  await page.keyboard.press(STEP);
  await expect(page.locator("#find-status")).toHaveText("2 of 4");
  await page.keyboard.press(`Shift+${STEP}`);
  await expect(page.locator("#find-status")).toHaveText("1 of 4");
});

test("matches text split across syntax-highlight elements", async ({ page }) => {
  await treeRow(page, "find-target.md").click();
  // The fenced block is highlighted, so `const answer` is not one text node.
  await expect(page.locator("#preview pre code span").first()).toBeVisible();

  await openFind(page);
  await page.locator("#find-query").fill("const answer");
  await expect(page.locator("#find-status")).toHaveText("1 of 1");
  expect((await highlightCounts(page)).current).toBe(1);
});

test("a query with no matches is distinct from an empty query", async ({ page }) => {
  await treeRow(page, "find-target.md").click();
  await openFind(page);

  // Nothing typed yet: no verdict.
  await expect(page.locator("#find-status")).toHaveText("");

  await page.locator("#find-query").fill("zzzznotpresent");
  await expect(page.locator("#find-status")).toHaveText("No results");
  await expect(page.locator("#find-status")).toHaveAttribute("data-state", "empty");
  expect(await highlightCounts(page)).toEqual({ matches: 0, current: 0 });
});

test("a link URL is findable in source view but not in rendered view", async ({ page }) => {
  await treeRow(page, "find-target.md").click();
  await openFind(page);
  await page.locator("#find-query").fill("hidden-url");

  // Rendered view shows the link text, not its href — find matches what the
  // reader can see.
  await expect(page.locator("#find-status")).toHaveText("No results");

  await page.locator("#view-source").click();
  // Switching views remounts the preview; the query survives and re-matches.
  await expect(page.locator("#find-query")).toHaveValue("hidden-url");
  await expect(page.locator("#find-status")).toHaveText("1 of 1");
});

test("match options narrow the result set", async ({ page }) => {
  await treeRow(page, "find-target.md").click();
  await openFind(page);

  // The document says "Find Target"; the query is lowercase.
  await page.locator("#find-query").fill("find");
  await expect(page.locator("#find-status")).toHaveText("1 of 1");

  await page.locator("#find-case").click();
  await expect(page.locator("#find-case")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#find-status")).toHaveText("No results");
  await page.locator("#find-case").click();
  await expect(page.locator("#find-status")).toHaveText("1 of 1");

  // Whole-word rejects a prefix of a longer word: "alph" inside "alpha".
  await page.locator("#find-query").fill("alph");
  await expect(page.locator("#find-status")).toHaveText("1 of 4");
  await page.locator("#find-word").click();
  await expect(page.locator("#find-status")).toHaveText("No results");
});

test("an invalid regular expression is reported rather than thrown", async ({ page }) => {
  await treeRow(page, "find-target.md").click();
  await openFind(page);
  await page.locator("#find-regex").click();
  await page.locator("#find-query").fill("(unterminated");

  await expect(page.locator("#find-status")).toHaveText("Invalid pattern");
  await expect(page.locator("#find-status")).toHaveAttribute("data-state", "invalid");
  // The typed text is kept — the user is mid-pattern, not wrong.
  await expect(page.locator("#find-query")).toHaveValue("(unterminated");
});

test("the query survives a live-reload remount", async ({ page }) => {
  await treeRow(page, "find-target.md").click();
  await openFind(page);
  await page.locator("#find-query").fill("alpha");
  await expect(page.locator("#find-status")).toHaveText("1 of 4");

  // Rewrite the open document with a different number of matches.
  await fs.writeFile(
    workspacePath("find-target.md"),
    "# Find Target\n\nalpha beta alpha\n",
    "utf8",
  );

  await expect(page.locator("#find-status")).toHaveText("1 of 2");
  await expect(page.locator("#find-query")).toHaveValue("alpha");
  expect((await highlightCounts(page)).current).toBe(1);
});

test("Escape closes find, clears highlights, and hands focus to the document", async ({ page }) => {
  await treeRow(page, "find-target.md").click();
  await openFind(page);
  await page.locator("#find-query").fill("alpha");
  await expect(page.locator("#find-status")).toHaveText("1 of 4");

  await page.keyboard.press("Escape");
  await expect(page.locator("#find-query")).toBeHidden();
  expect(await highlightCounts(page)).toEqual({ matches: 0, current: 0 });

  // Focus lands on the scroll container so the document stays keyboard-usable.
  const focused = await page.evaluate(() => document.activeElement?.className ?? "");
  expect(focused).toContain("preview-shell");
});

test("selecting text seeds the query", async ({ page }) => {
  await treeRow(page, "find-target.md").click();
  // Wait for the body to actually be mounted — clicking the row only starts
  // the fetch, and selecting inside a preview that has not rendered yet is a
  // race.
  await expect(page.locator("#preview")).toContainText("alpha beta alpha");
  await page.evaluate(() => {
    const target = [...document.querySelectorAll("#preview p")].find(p =>
      p.textContent?.includes("alpha"),
    )!;
    const text = target.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });

  await openFind(page);
  await expect(page.locator("#find-query")).toHaveValue("alpha");
  await expect(page.locator("#find-status")).toHaveText("1 of 4");
});

test("find works right after a tree click, with focus still in the sidebar", async ({ page }) => {
  // The routing rule that motivated the whole active-surface design. Focus is
  // in the tree here, so a literal focus rule would search the sidebar; the
  // active surface says preview, because picking a file is an act about the
  // document.
  await treeRow(page, "find-target.md").click();
  await expect(page.locator("#preview-title")).toHaveText("Find Target");

  // Selection did not pull focus into the preview.
  const focusedInSidebar = await page.evaluate(
    () => !!document.activeElement?.closest(".sidebar"),
  );
  expect(focusedInSidebar).toBe(true);

  await openFind(page);
  await page.locator("#find-query").fill("alpha");
  await expect(page.locator("#find-status")).toHaveText("1 of 4");
});

test("the preview scroll container is focusable and keyboard-scrollable", async ({ page }) => {
  await request_longDocument(page);

  await page.locator(".preview-shell").click({ position: { x: 20, y: 20 } });
  const start = await page.evaluate(
    () => document.querySelector(".preview-shell")!.scrollTop,
  );
  await page.keyboard.press("PageDown");
  await expect
    .poll(() => page.evaluate(() => document.querySelector(".preview-shell")!.scrollTop))
    .toBeGreaterThan(start);
});

// A document tall enough to scroll.
async function request_longDocument(page: import("@playwright/test").Page) {
  const lines = Array.from({ length: 200 }, (_, i) => `Line ${i} of filler text.`);
  await page.request.post("/__e2e/reset", {
    data: { extras: { "long.md": `# Long\n\n${lines.join("\n\n")}\n` } },
  });
  await page.goto("/");
  await treeRow(page, "long.md").click();
  await expect(page.locator("#preview-title")).toHaveText("Long");
}

test("finds text inside the Diff view's shadow tree", async ({ page, request }) => {
  // The diff component renders into a `<diffs-container>` shadow root, leaving
  // `#preview` holding nothing but toolbar text. Find has to descend into it
  // or the entire view is unsearchable.
  await request.post("/__e2e/reset", {
    data: {
      git: true,
      dirty: {
        "feature.md": "# Feature\n\nCommitted branch change.\n\nAdded review-time edit.\n",
      },
    },
  });
  await page.reload();
  await revealTreeRow(page, "feature.md");
  await treeRow(page, "feature.md").click();
  await expect(page.locator("#preview-path")).toHaveText("feature.md");

  await page.locator("#view-diff").click();
  await expect(page.locator(".uatu-diff-host")).toBeVisible();

  await page.locator("#preview").click({ position: { x: 10, y: 10 } });
  await openFind(page);
  await page.locator("#find-query").fill("review-time");
  await expect(page.locator("#find-status")).toHaveText("1 of 1");

  // And the shadow root carries the highlight rules, without which the match
  // would be counted but invisible.
  const styled = await page.evaluate(() => {
    const host = document.querySelector("#preview diffs-container");
    return !!host?.shadowRoot?.querySelector("style[data-uatu-find-highlight]");
  });
  expect(styled).toBe(true);
});

test.describe("terminal surface", () => {
  // Routing only: this asserts which surface ⌘F acts on, which is decided
  // before any PTY is involved. The terminal's own search behavior is unit
  // tested in `src/find/terminal-engine.test.ts`, and standing up a real shell
  // here would make the routing assertion hostage to PTY availability.
  test("an open terminal with no attached pane falls back to the document", async ({ page }) => {
    // The panel can be showing while no pane is attached — no PTY here. The
    // surface is `terminal`, but there is nothing to search, so find must fall
    // through instead of opening a bar over nothing.
    await treeRow(page, "find-target.md").click();
    await expect(page.locator("#preview-title")).toHaveText("Find Target");

    await page.locator("#terminal-toggle").click();
    await expect(page.locator("#terminal-panel")).toBeVisible();
    await page.locator("#terminal-panel").click({ position: { x: 40, y: 40 } });

    await openFind(page);
    await page.locator("#find-query").fill("alpha");
    await expect(page.locator("#find-status")).toHaveText("1 of 4");
  });

  test("hiding the terminal hands ⌘F back to the document", async ({ page }) => {
    // The active surface stays `terminal` after the panel is toggled away.
    // Routing there would mount the bar in a hidden slot with no pane to
    // search, so find would look dead rather than fall back.
    await treeRow(page, "find-target.md").click();
    await expect(page.locator("#preview-title")).toHaveText("Find Target");

    await page.locator("#terminal-toggle").click();
    await expect(page.locator("#terminal-panel")).toBeVisible();
    await page.locator("#terminal-panel").click({ position: { x: 40, y: 40 } });

    // Toggle it away again without touching any other surface.
    await page.locator("#terminal-toggle").click();
    await expect(page.locator("#terminal-panel")).toBeHidden();

    await openFind(page);
    await page.locator("#find-query").fill("alpha");
    await expect(page.locator("#find-status")).toHaveText("1 of 4");
  });

  test("searches the live terminal buffer", async ({ page, request }) => {
    // The routing test above deliberately avoids a PTY. This one needs it:
    // the search addon's `decorations` option is proposed API, and calling it
    // on a Terminal built without `allowProposedApi` throws rather than
    // degrading — which is how terminal find looked completely dead. Only a
    // real xterm exercises that path.
    const tokenResp = await request.get("/__e2e/terminal-token");
    const tokenBody = await tokenResp.json();
    if (!tokenBody.enabled) {
      test.skip(true, "terminal backend unavailable on this platform");
    }
    await page.goto(`/?t=${encodeURIComponent(tokenBody.token)}`);
    await page.evaluate(() => {
      try {
        window.sessionStorage.removeItem("uatu:terminal-visible");
      } catch {
        // best-effort
      }
    });
    await expect(page.locator("#connection-state .connection-label")).toHaveText("Connected");

    await page.locator("#terminal-toggle").click();
    await expect(page.locator(".terminal-pane-host .xterm").first()).toBeVisible({
      timeout: 8000,
    });
    await page.locator(".terminal-pane-host").first().click();

    const marker = "findmarker12345";
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".terminal-pane-host")).toContainText(marker, { timeout: 8000 });

    await openFind(page);
    await page.locator("#find-query").fill(marker);
    // A match in the scrollback, and nothing painted over the document.
    await expect(page.locator("#find-status")).not.toHaveText("No results");
    expect(await highlightCounts(page)).toEqual({ matches: 0, current: 0 });

    // The bar sits on the surface it searches, and says which one. A control
    // floating over the document while searching the terminal reads as
    // searching the document.
    expect(
      await page.evaluate(() => document.querySelector("#find-bar")?.parentElement?.id),
    ).toBe("terminal-find-slot");
    await expect(page.locator("#find-query")).toHaveAttribute("placeholder", "Find in terminal");

    // Returning to the document brings the bar back with it.
    await page.keyboard.press("Escape");
    await page.locator("#preview").click({ position: { x: 10, y: 10 } });
    await openFind(page);
    expect(
      await page.evaluate(() => document.querySelector("#find-bar")?.parentElement?.id),
    ).toBe("preview-find-slot");
    await expect(page.locator("#find-query")).toHaveAttribute("placeholder", "Find in document");
  });
});
