import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { renderChatMarkdown } from "../chat/markdown";
import { renderAsciidocToHtml } from "../render/asciidoc";
import { renderCodeAsHtml, renderMarkdownToHtml } from "../render/markdown";
import { codeBlockCopyText, MARKDOWN_CODE_ATTRIBUTE } from "./code-copy";

function blocksFor(html: string): Array<{ pre: HTMLPreElement; code: Element }> {
  const { document } = parseHTML(`<div id="root">${html}</div>`);
  return Array.from(document.querySelectorAll("pre")).map(pre => ({
    pre: pre as unknown as HTMLPreElement,
    code: pre.querySelector("code") as unknown as Element,
  }));
}

describe("codeBlockCopyText", () => {
  test("strips only the single parser-synthesized trailing newline on Markdown fenced and indented code blocks", () => {
    const html = [
      renderMarkdownToHtml("```sh\ngit status\n```").html,
      renderMarkdownToHtml("```sh\necho first\n\necho second\n```").html,
      renderMarkdownToHtml("```txt\nkeep blank below\n\n```").html,
      renderMarkdownToHtml("    indented cmd\n").html,
    ].join("");
    const blocks = blocksFor(html);
    expect(blocks).toHaveLength(4);
    expect(codeBlockCopyText(blocks[0]!.pre, blocks[0]!.code)).toBe("git status");
    expect(codeBlockCopyText(blocks[1]!.pre, blocks[1]!.code)).toBe("echo first\n\necho second");
    expect(codeBlockCopyText(blocks[2]!.pre, blocks[2]!.code)).toBe("keep blank below\n");
    expect(codeBlockCopyText(blocks[3]!.pre, blocks[3]!.code)).toBe("indented cmd");
  });

  test("handles CRLF endings and code blocks without a trailing newline when marked", () => {
    const html = `<pre ${MARKDOWN_CODE_ATTRIBUTE}><code>echo hi\r\n</code></pre>`
      + `<pre ${MARKDOWN_CODE_ATTRIBUTE}><code>echo bare</code></pre>`
      + `<pre ${MARKDOWN_CODE_ATTRIBUTE}><code>\n</code></pre>`;
    const blocks = blocksFor(html);
    expect(codeBlockCopyText(blocks[0]!.pre, blocks[0]!.code)).toBe("echo hi");
    expect(codeBlockCopyText(blocks[1]!.pre, blocks[1]!.code)).toBe("echo bare");
    expect(codeBlockCopyText(blocks[2]!.pre, blocks[2]!.code)).toBe("");
  });

  test("defaults to verbatim copy for unmarked blocks: raw HTML in Markdown, source views, AsciiDoc, and uncaptured chat SVG", async () => {
    const rawHtmlInMd = renderMarkdownToHtml('<pre><code>raw line\n</code></pre>').html;
    const rawHtmlInChat = renderChatMarkdown('<pre><code>chat raw\n</code></pre>');
    const sourceView = renderCodeAsHtml("key: value\nport: 4321\n", "yaml");
    const asciidoc = (await renderAsciidocToHtml("[source,bash]\n----\nnpm test\n----\n")).html;
    const oversizedFallback = '<pre><code class="hljs">= Title\n\nBody\n</code></pre>';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Hi</text></svg>\n';
    const uncapturedSvg = renderChatMarkdown(`\`\`\`svg\n${svg}\`\`\``);

    expect(blocksFor(rawHtmlInMd).map(({ pre, code }) => codeBlockCopyText(pre, code))).toEqual(["raw line\n"]);
    expect(blocksFor(rawHtmlInChat).map(({ pre, code }) => codeBlockCopyText(pre, code))).toEqual(["chat raw\n"]);
    expect(blocksFor(sourceView).map(({ pre, code }) => codeBlockCopyText(pre, code))).toEqual(["key: value\nport: 4321\n"]);
    expect(blocksFor(asciidoc).map(({ pre, code }) => codeBlockCopyText(pre, code))).toEqual(["npm test"]);
    expect(blocksFor(oversizedFallback).map(({ pre, code }) => codeBlockCopyText(pre, code))).toEqual(["= Title\n\nBody\n"]);
    expect(blocksFor(uncapturedSvg).map(({ pre, code }) => codeBlockCopyText(pre, code))).toEqual([svg]);
  });
});
