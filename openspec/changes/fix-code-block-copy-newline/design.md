## Context

CommonMark (`micromark`) renders both fenced and indented Markdown code blocks as `<pre><code>...line\n</code></pre>`, appending a terminating `\n` inside `<code>` even for single-line blocks. Both `attachCopyButtons` (`src/preview/code-block.ts`) and Chat's `[data-chat-copy="code"]` click handler (`src/chat/ui.ts`) copied `code.textContent` verbatim, carrying that synthetic newline to the clipboard.

In contrast:
- Whole-file source views (`<pre class="uatu-source-pre">`) render actual file bytes from disk (where a trailing `\n` is authored file content).
- Asciidoctor renders listing and literal blocks inside `.listingblock` / `.literalblock` wrappers without synthesizing a trailing newline.
- Captured inline SVG visuals (`[data-visual-copy]`) copy immutable captured snapshot bytes from `/api/chat/visuals/<id>/source` and must remain byte-exact (including UTF-8 BOM and CRLF).

## Goals / Non-Goals

**Goals:**
- Provide one shared helper `codeBlockCopyText(pre, code)` used by both Preview/uncaptured-chat `attachCopyButtons` and Chat message `[data-chat-copy="code"]`.
- Strip only the single parser-synthesized trailing `\r?\n$` on Markdown code blocks so single-line commands do not auto-execute on terminal paste while internal line breaks and intentional extra trailing blank lines remain intact.
- Preserve whole-file source views (`pre.uatu-source-pre`), AsciiDoc blocks (`.listingblock`, `.literalblock`), and captured `[data-visual-copy]` SVG bytes verbatim.

**Non-Goals:**
- Changing rendered DOM `<code>` content (syntax highlighting and line-number wrapping keep exact parser output).
- Adding server-side HTML marker attributes in `src/render/markdown.ts`.

## Decisions

1. **Share `codeBlockCopyText(pre, code)` from `src/preview/code-block.ts`.**
   `src/chat/visual-ui.ts` already imports `attachCopyButtons` from `../preview/code-block`, and `code-block.ts` only depends on `../shared/clipboard` and `./highlight-lines` (no circular imports). Sharing the helper guarantees consistent behavior across Preview, Chat messages, side-reader (`/btw`), request plans, and subagent results.

2. **Use DOM-based exclusion for verbatim surfaces and strip one `\r?\n$`.**
   ```ts
   if (pre.classList.contains("uatu-source-pre") || pre.closest(".listingblock, .literalblock")) {
     return raw;
   }
   return raw.replace(/\r?\n$/, "");
   ```
   Stripping only one trailing line break removes the exact terminator `micromark` adds without erasing intentional extra blank lines inside a fenced block.

## Risks / Trade-offs

- **Raw HTML `<pre><code>foo\n</code></pre>` inside Markdown:** Indistinguishable in DOM from a fenced Markdown block without extra markup; stripping a single trailing `\r?\n$` is acceptable and avoids touching `src/render/markdown.ts`.
- **Uncaptured SVG fences (side-reader `/btw`, plans, subagent results):** Treated as ordinary Markdown code blocks, stripping the synthetic trailing newline, while captured `[data-visual-copy]` SVG snapshots stay byte-exact.
