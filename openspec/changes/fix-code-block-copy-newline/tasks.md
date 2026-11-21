## 1. Render-Time Marker & Shared Copy Helper

- [x] 1.1 Add `MARKDOWN_CODE_ATTRIBUTE` and safe-by-default `codeBlockCopyText(pre, code)` in `src/shared/code-copy.ts`, stripping one trailing `\r?\n$` only on `<pre data-uatu-markdown-code>` blocks.
- [x] 1.2 Mark `codeFenced` and `codeIndented` (non-Mermaid) `<pre>` blocks with `data-uatu-markdown-code` after sanitization in `src/render/markdown.ts` and `src/chat/visual-markdown.ts` (preserving raw HTML `<pre><code>` and uncaptured SVG visual blocks unmarked), and preserve the attribute through `highlightCodeBlocks()`.
- [x] 1.3 Wire `attachCopyButtons` (`src/preview/code-block.ts`) and Chat `[data-chat-copy="code"]` (`src/chat/ui.ts`) through `src/shared/code-copy.ts`, removing caller flags and CSS class exclusions.

## 2. Verification & Spec Sync

- [x] 2.1 Add unit tests in `src/shared/code-copy.test.ts`, `src/preview/code-block.test.ts`, and `src/render/markdown.test.ts` covering fenced/indented Markdown blocks, CRLF, intentional trailing blank lines, raw HTML `<pre><code>` (including forged attributes), whole-file source views, AsciiDoc listing/literal and oversized fallback blocks, and uncaptured chat SVG blocks.
- [x] 2.2 Add exact E2E assertions in `tests/e2e/code-blocks.e2e.ts` for Markdown code blocks, whole-file source view, split-view source pane, and rendered AsciiDoc listing blocks, and update Markdown chat copy expectations in `tests/e2e/chat.e2e.ts`, `tests/e2e/chat-responsiveness.e2e.ts`, and `tests/e2e/chat-touch.e2e.ts`.
- [x] 2.3 Sync delta specs into `openspec/specs/document-rendering/spec.md` and `openspec/specs/opencode-chat/spec.md` and validate with `openspec validate --all --strict`, `tests/openspec-discipline.test.ts`, `bun run typecheck`, unit tests, and Playwright E2E.
