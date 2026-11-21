export const MARKDOWN_CODE_ATTRIBUTE = "data-uatu-markdown-code";

/**
 * Compute clipboard text for a `<pre><code>` block.
 *
 * CommonMark (`micromark`) appends a single trailing line break to fenced and
 * indented Markdown code blocks and marks those `<pre>` elements with
 * `data-uatu-markdown-code`. Strip only that single parser-synthesized
 * terminator when marked; every other `<pre><code>` block (whole-file source
 * views, AsciiDoc listing/literal blocks and fallbacks, raw HTML `<pre><code>`,
 * uncaptured SVG visuals, and future surfaces) stays verbatim by default.
 */
export function codeBlockCopyText(pre: HTMLPreElement, code: Element): string {
  const raw = code.textContent ?? "";
  return pre.hasAttribute(MARKDOWN_CODE_ATTRIBUTE) ? raw.replace(/\r?\n$/, "") : raw;
}
