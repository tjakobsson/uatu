## Context

CommonMark (`micromark`) renders both fenced and indented Markdown code blocks as `<pre><code>...line\n</code></pre>`, appending a terminating `\n` inside `<code>` even for single-line blocks. Both `attachCopyButtons` (`src/preview/code-block.ts`) and Chat's `[data-chat-copy="code"]` click handler (`src/chat/ui.ts`) copied `code.textContent` verbatim, carrying that synthetic newline to the clipboard.

In contrast:
- Whole-file source views (`<pre class="uatu-source-pre">`) render actual file bytes from disk (where a trailing `\n` is authored file content).
- Asciidoctor renders listing and literal blocks (and oversized-file plain-`<pre>` fallbacks) without synthesizing a trailing newline.
- Raw HTML `<pre><code>...</code></pre>` authored inside Markdown preserves whatever line endings the author wrote.
- Captured (`[data-visual-copy]`) and uncaptured (`renderVisual` in `src/chat/markdown.ts`) SVG visuals preserve exact SVG source bytes.

## Goals / Non-Goals

**Goals:**
- Mark parser-generated Markdown code blocks (`codeFenced` and `codeIndented`, excluding Mermaid) where they are rendered (`src/render/markdown.ts` and `src/chat/visual-markdown.ts`) with `data-uatu-markdown-code` on `<pre>`.
- Provide one shared, safe-by-default helper `codeBlockCopyText(pre, code)` in `src/shared/code-copy.ts` used by both `attachCopyButtons` (`src/preview/code-block.ts`) and Chat `[data-chat-copy="code"]` (`src/chat/ui.ts`).
- Strip only the single parser-synthesized trailing `\r?\n$` when `pre` carries `data-uatu-markdown-code`, preserving internal line breaks, intentional blank trailing lines, raw HTML `<pre><code>`, whole-file source views, AsciiDoc blocks/fallbacks, and both captured and uncaptured SVG visuals verbatim by default.

**Non-Goals:**
- Changing rendered DOM `<code>` content (syntax highlighting and line-number wrapping keep exact parser output).
- Requiring preview or future copy surfaces to opt out with a caller flag.

## Decisions

1. **Mark Markdown parser code blocks at render time with `data-uatu-markdown-code`.**
   Both `renderMarkdownToHtml()` (`src/render/markdown.ts`) and `prepareChatVisualMarkdown()` (`src/chat/visual-markdown.ts`) distinguish `codeFenced`/`codeIndented` tokens from raw `htmlFlow`/`htmlText` tokens before HAST sanitization using an unforgeable per-call temporary attribute (transferred to `node.data` before `sanitize()`, then emitted as `data-uatu-markdown-code` on non-Mermaid `<pre>` after `sanitize()`). Raw HTML `<pre>` blocks—even with forged attributes—never receive `data-uatu-markdown-code`, and `highlightCodeBlocks()` preserves the attribute on `<pre>`.

2. **Place `codeBlockCopyText(pre, code)` in `src/shared/code-copy.ts` with a verbatim default.**
   Living next to `src/shared/clipboard.ts`, the helper is shared cleanly by both `src/preview/code-block.ts` and `src/chat/ui.ts` with no cross-feature preview import from chat. Because stripping only runs when `pre.hasAttribute("data-uatu-markdown-code")`, every non-Markdown surface (`mount.ts` source views, split source panes, AsciiDoc listing/literal blocks and oversized fallbacks, raw HTML `<pre><code>`, uncaptured SVG visuals, and any future copy surface) stays verbatim automatically without caller flags or CSS class checks.

## Risks / Trade-offs

- **Exact `<pre>` HTML markup in Markdown tests:** Rendered Markdown code blocks now emit `<pre data-uatu-markdown-code><code class="hljs...">` instead of `<pre><code class="hljs...">`; unit tests in `src/render/markdown.test.ts` are updated accordingly while Mermaid `<pre><code class="language-mermaid">` remains unchanged.
