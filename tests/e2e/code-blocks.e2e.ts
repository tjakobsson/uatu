import { expect, test } from "./fixtures";

import { treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("code blocks expose a copy-to-clipboard control", async ({ page, context, request }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await request.post("/__e2e/reset", {
    data: { extras: { "config.yaml": "key: value\nport: 4321\n" } },
  });
  await page.goto("/");
  await treeRow(page, "config.yaml").click();

  const copyButton = page.locator("#preview pre .code-copy");
  await expect(copyButton).toHaveCount(1);

  await copyButton.click();
  await expect(copyButton).toHaveText("Copied!");

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("key: value");
  expect(clipboard).toContain("port: 4321");
  // Critical: clipboard must NOT contain the line-number gutter contents.
  expect(clipboard).not.toMatch(/^\s*1\b/);
});

test("non-Markdown code views show line numbers; Markdown fenced blocks do not", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        "config.yaml": "alpha: 1\nbeta: 2\ngamma: 3\n",
        "with-code.md":
          "# Sample\n\nText before.\n\n```js\nconst answer = 42;\n```\n\nText after.\n",
      },
    },
  });
  await page.goto("/");

  // Code view: per-line gutter present — one `.uatu-cl` block per source
  // line, each carrying its number in `data-ln` (rendered via CSS ::before,
  // so the number is not DOM text).
  await treeRow(page, "config.yaml").click();
  await expect(page.locator("#preview pre.has-line-numbers")).toHaveCount(1);
  const codeLines = page.locator("#preview pre.has-line-numbers .uatu-cl");
  await expect(codeLines).toHaveCount(3);
  await expect(codeLines.nth(0)).toHaveAttribute("data-ln", "1");
  await expect(codeLines.nth(2)).toHaveAttribute("data-ln", "3");

  // Markdown view: fenced block has NO per-line gutter
  await treeRow(page, "with-code.md").click();
  await expect(page.locator("#preview pre")).toHaveCount(1);
  await expect(page.locator("#preview pre .uatu-cl")).toHaveCount(0);
  await expect(page.locator("#preview pre.has-line-numbers")).toHaveCount(0);
});
