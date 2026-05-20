import { expect, test, type Page } from "./fixtures";
import { promises as fs } from "node:fs";

import { workspacePath } from "./config";
import { clickTreeFile, treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

// Programmatically replace the page's selection with one anchored on a node we
// pick by selector. Using a synthetic Range + dispatchEvent mirrors what the
// browser does when the user mouse-selects, so the live selectionchange
// listener inside the inspector fires.
async function selectNodeContents(page: Page, selector: string): Promise<void> {
  await page.evaluate(target => {
    const node = document.querySelector(target);
    if (!node) {
      throw new Error(`selectNodeContents: missing element ${target}`);
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    if (!selection) {
      throw new Error("selectNodeContents: getSelection() returned null");
    }
    selection.removeAllRanges();
    selection.addRange(range);
    // selectionchange usually fires automatically when the selection mutates,
    // but dispatching it explicitly here makes the test robust against
    // browsers that batch selection events across animation frames.
    document.dispatchEvent(new Event("selectionchange"));
  }, selector);
}

async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
}

// Anchor a selection on a known span of source-view text (under
// `pre.uatu-source-pre code`). The test fixture's README.md is short and
// stable, so we select the exact source lines we want by character offsets
// inside the source `<code>` element.
async function selectSourceLineRange(
  page: Page,
  options: { startLine: number; endLine: number },
): Promise<void> {
  await page.evaluate(({ startLine, endLine }) => {
    const code = document.querySelector("pre.uatu-source-pre code");
    if (!code) {
      throw new Error("selectSourceLineRange: no source-view code element");
    }
    const text = code.textContent ?? "";
    const lines = text.split("\n");
    if (startLine < 1 || endLine < startLine || endLine > lines.length) {
      throw new Error(
        `selectSourceLineRange: invalid range L${startLine}-${endLine} for ${lines.length}-line document`,
      );
    }
    let startOffset = 0;
    for (let i = 1; i < startLine; i += 1) {
      startOffset += lines[i - 1].length + 1; // +1 for the trailing newline
    }
    let endOffset = startOffset;
    for (let i = startLine; i <= endLine; i += 1) {
      endOffset += lines[i - 1].length;
      // Include the newline that terminates this line, except when it would
      // walk past the end of the source (no newline after the final line in
      // a file with no trailing newline). This mirrors how a user dragging a
      // visual-line selection from line N to line M lands the focus at the
      // start of line M+1 — and how `@path#L<a>-<b>` should resolve.
      if (i < lines.length || (lines[i - 1].length > 0 && i === lines.length)) {
        endOffset += 1;
      }
    }
    if (endOffset > text.length) {
      endOffset = text.length;
    }
    // The source view's `<code>` element wraps highlighted source which may
    // be split into many text nodes by the syntax highlighter; we therefore
    // need to walk to find the text nodes containing startOffset / endOffset.
    function nodeAt(target: number): { node: Node; offset: number } | null {
      let consumed = 0;
      function walk(n: Node): { node: Node; offset: number } | null {
        if (n.nodeType === 3) {
          const len = (n.nodeValue ?? "").length;
          if (target <= consumed + len) {
            return { node: n, offset: target - consumed };
          }
          consumed += len;
          return null;
        }
        for (const child of Array.from(n.childNodes)) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      }
      return walk(code!);
    }
    const startPos = nodeAt(startOffset);
    const endPos = nodeAt(endOffset);
    if (!startPos || !endPos) {
      throw new Error("selectSourceLineRange: failed to resolve text nodes for range");
    }
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    const selection = window.getSelection();
    if (!selection) {
      throw new Error("selectSourceLineRange: getSelection() returned null");
    }
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, options);
}

test("Source view captures a line range and shows it as @path#L<a>-<b>", async ({ page }) => {
  // README.md is already loaded in beforeEach. Flip to source view so the
  // preview body is rendered as a whole-file <pre class="uatu-source-pre">.
  await page.locator("#view-source").click();
  await expect(page.locator("pre.uatu-source-pre")).toBeVisible();

  const pane = page.locator('[data-pane-id="selection-inspector"]');
  await expect(pane).toBeVisible();
  // Initially nothing is selected — the placeholder is visible.
  await expect(pane.locator("[data-selection-inspector-empty]")).toBeVisible();
  await expect(pane.locator("[data-selection-inspector-control]")).toBeHidden();

  // Select source lines 2 through 4. README.md is the active file.
  await selectSourceLineRange(page, { startLine: 2, endLine: 4 });

  await expect(pane.locator("[data-selection-inspector-control]")).toBeVisible();
  await expect(pane.locator("[data-selection-inspector-empty]")).toBeHidden();
  await expect(pane.locator("[data-selection-inspector-control]")).toHaveText("@README.md#L2-4");
  await expect(pane.locator("[data-selection-inspector-control]")).toHaveAttribute(
    "data-state",
    "reference",
  );
});

test("Single-line source-view selection collapses to @path#L<n>", async ({ page }) => {
  await page.locator("#view-source").click();
  await expect(page.locator("pre.uatu-source-pre")).toBeVisible();

  await selectSourceLineRange(page, { startLine: 5, endLine: 5 });
  const pane = page.locator('[data-pane-id="selection-inspector"]');
  await expect(pane.locator("[data-selection-inspector-control]")).toHaveText("@README.md#L5");
});

test("Clicking the captured reference copies it to the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.locator("#view-source").click();
  await expect(page.locator("pre.uatu-source-pre")).toBeVisible();

  await selectSourceLineRange(page, { startLine: 1, endLine: 3 });
  const control = page
    .locator('[data-pane-id="selection-inspector"] [data-selection-inspector-control]');
  await expect(control).toHaveText("@README.md#L1-3");

  await control.click();
  // Copy confirmation flashes briefly.
  await expect(
    page.locator('[data-pane-id="selection-inspector"] [data-selection-inspector-status]'),
  ).toHaveText("Copied");

  const clipboard = await page.evaluate(async () => navigator.clipboard.readText());
  expect(clipboard).toBe("@README.md#L1-3");
});

test("Rendered view shows the hint and clicking it switches to Source view", async ({ page }) => {
  // Default view is Rendered; do NOT click the source toggle.
  await expect(page.locator("#view-rendered")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("pre.uatu-source-pre")).toHaveCount(0);

  // Mark prose text in the rendered preview.
  await selectNodeContents(page, "#preview h1, #preview h2, #preview h3");

  const pane = page.locator('[data-pane-id="selection-inspector"]');
  const control = pane.locator("[data-selection-inspector-control]");
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute("data-state", "hint");
  await expect(control).toContainText("Switch to Source view");

  await control.click();
  await expect(page.locator("#view-source")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("pre.uatu-source-pre")).toBeVisible();
});

test("Selection inside a rendered fenced code block produces the hint, not a reference", async ({ page }) => {
  // The testdata fixture's only fenced code blocks are Mermaid diagrams,
  // which the preview rewrites into `<div class="mermaid">` rather than
  // leaving as `<pre><code>`. Build a small Markdown fixture in-place that
  // contains a plain fenced code block, so we can assert the inspector
  // treats selections inside it as Rendered-view content (hint state) and
  // NOT as a source-aligned line range.
  const fixture = "# Fenced fixture\n\n\`\`\`bash\nset -e\necho hello\n\`\`\`\n";
  await fs.writeFile(workspacePath("guides", "fenced-fixture.md"), fixture, "utf8");
  await clickTreeFile(page, "guides/fenced-fixture.md");
  await expect(page.locator("#preview-path")).toHaveText("guides/fenced-fixture.md");
  await page.locator("#view-rendered").click();
  // The per-block fenced `<pre>` does NOT carry the uatu-source-pre class.
  const fenced = page.locator("#preview pre:not(.uatu-source-pre) code");
  await expect(fenced).toBeVisible();
  await selectNodeContents(page, "#preview pre:not(.uatu-source-pre) code");

  const control = page
    .locator('[data-pane-id="selection-inspector"] [data-selection-inspector-control]');
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute("data-state", "hint");
});

test("Selection Inspector pane returns to placeholder after the selection is collapsed", async ({ page }) => {
  await page.locator("#view-source").click();
  await expect(page.locator("pre.uatu-source-pre")).toBeVisible();
  const pane = page.locator('[data-pane-id="selection-inspector"]');

  await selectSourceLineRange(page, { startLine: 1, endLine: 2 });
  await expect(pane.locator("[data-selection-inspector-control]")).toBeVisible();

  await clearSelection(page);
  await expect(pane.locator("[data-selection-inspector-empty]")).toBeVisible();
  await expect(pane.locator("[data-selection-inspector-control]")).toBeHidden();
});

test("Selection Inspector pane visibility persists across page reload", async ({ page }) => {
  const pane = page.locator('[data-pane-id="selection-inspector"]');
  await expect(pane).toBeVisible();

  // Hide via the in-pane × button.
  await pane.getByRole("button", { name: "Hide Selection Inspector" }).click();
  await expect(pane).toBeHidden();

  await page.reload();
  // Reload should preserve the hidden state via the persisted pane store.
  await expect(pane).toBeHidden();

  // Restore via the Panels menu so the pane comes back, then reload again
  // and confirm visibility persists in the visible state too.
  await page.locator("#panels-toggle").click();
  await page.locator('#panels-menu label:has-text("Selection Inspector") input').check();
  await expect(pane).toBeVisible();

  await page.reload();
  await expect(pane).toBeVisible();
});
