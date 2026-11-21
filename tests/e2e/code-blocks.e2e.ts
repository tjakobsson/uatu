import { expect, test } from "./fixtures";

import { openTreeFile, treeRow } from "./tree-helpers";
import { standardBeforeEach } from "./fixtures";
import { installClipboardMock, readClipboardMock } from "./chat-helpers";

test.beforeEach(async ({ page, request }) => {
  await standardBeforeEach(page, request);
});

test.afterEach(async ({ request }) => {
  await request.post("/__e2e/reset");
});

test("code blocks expose a copy-to-clipboard control", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: { extras: { "config.yaml": "key: value\nport: 4321\n" } },
  });
  await page.goto("/");
  await installClipboardMock(page);
  await openTreeFile(page, "config.yaml");

  const copyButton = page.locator("#preview pre .code-copy");
  await expect(copyButton).toHaveCount(1);

  await copyButton.click();
  await expect(copyButton).toHaveText("Copied!");

  const clipboard = await readClipboardMock(page);
  expect(clipboard).toBe("key: value\nport: 4321\n");
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
  await openTreeFile(page, "config.yaml");
  await expect(page.locator("#preview pre.has-line-numbers")).toHaveCount(1);
  const codeLines = page.locator("#preview pre.has-line-numbers .uatu-cl");
  await expect(codeLines).toHaveCount(3);
  await expect(codeLines.nth(0)).toHaveAttribute("data-ln", "1");
  await expect(codeLines.nth(2)).toHaveAttribute("data-ln", "3");

  // Markdown view: fenced block has NO per-line gutter
  await openTreeFile(page, "with-code.md");
  await expect(page.locator("#preview pre")).toHaveCount(1);
  await expect(page.locator("#preview pre .uatu-cl")).toHaveCount(0);
  await expect(page.locator("#preview pre.has-line-numbers")).toHaveCount(0);
});

test("Markdown code block copy omits the trailing newline while preserving multiline breaks", async ({ page, request }) => {
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        "commands.md": [
          "# Commands",
          "",
          "```bash",
          "git status",
          "```",
          "",
          "```bash",
          "git add .",
          "git commit -m \"save\"",
          "```",
          "",
        ].join("\n"),
      },
    },
  });
  await page.goto("/");
  await installClipboardMock(page);
  await openTreeFile(page, "commands.md");

  const buttons = page.locator("#preview pre .code-copy");
  await expect(buttons).toHaveCount(2);

  await buttons.nth(0).click();
  await expect(buttons.nth(0)).toHaveText("Copied!");
  expect(await readClipboardMock(page)).toBe("git status");

  await buttons.nth(1).click();
  await expect(buttons.nth(1)).toHaveText("Copied!");
  expect(await readClipboardMock(page)).toBe("git add .\ngit commit -m \"save\"");
});

test("split-view source pane and rendered AsciiDoc listing blocks keep verbatim copy contents", async ({ page, request }) => {
  const markdownSource = "# Split Copy\n\n```bash\necho hello\n```\n";
  const asciidocSource = "= Guide\n\n[source,bash]\n----\nnpm test\necho done\n----\n";
  await request.post("/__e2e/reset", {
    data: {
      extras: {
        "split-copy.md": markdownSource,
        "guide.adoc": asciidocSource,
      },
    },
  });
  await page.goto("/");
  await installClipboardMock(page);

  // Split view: source pane keeps the file's trailing newline verbatim while
  // the rendered pane strips only the Markdown fence's synthesized terminator.
  await openTreeFile(page, "split-copy.md");
  await page.locator(".uatu-layout-toolbar [data-layout-value='split-h']").click();
  await expect(page.locator("#preview.is-split.is-split-h")).toBeVisible();

  const sourceCopy = page.locator("#preview pre.uatu-source-pre .code-copy");
  await expect(sourceCopy).toHaveCount(1);
  await sourceCopy.click();
  await expect(sourceCopy).toHaveText("Copied!");
  expect(await readClipboardMock(page)).toBe(markdownSource);

  const renderedCopy = page.locator("#preview pre[data-uatu-markdown-code] .code-copy");
  await expect(renderedCopy).toHaveCount(1);
  await renderedCopy.click();
  await expect(renderedCopy).toHaveText("Copied!");
  expect(await readClipboardMock(page)).toBe("echo hello");

  // Rendered AsciiDoc listing block keeps its verbatim contents.
  await page.locator(".uatu-layout-toolbar [data-layout-value='single']").click();
  await openTreeFile(page, "guide.adoc");
  const adocCopy = page.locator("#preview .listingblock pre .code-copy");
  await expect(adocCopy).toHaveCount(1);
  await adocCopy.click();
  await expect(adocCopy).toHaveText("Copied!");
  expect(await readClipboardMock(page)).toBe("npm test\necho done");
});
