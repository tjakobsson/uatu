## Why

[Issue #534](https://github.com/tjakobsson/uatu/issues/534) reports that clicking the Copy button on rendered Markdown code blocks in Preview or Chat copies an unwanted trailing newline. Because `micromark` emits a parser-synthesized `\n` inside `<code>` before every closing fence, pasting a copied single-line command into a terminal can execute it immediately instead of letting the user review or edit it first.

## What Changes

- Add and export `codeBlockCopyText(pre, code)` in `src/preview/code-block.ts`, stripping a single parser-synthesized trailing `\r?\n$` from rendered Markdown code blocks while preserving internal line breaks, intentional extra trailing blank lines, whole-file source views (`pre.uatu-source-pre`), and AsciiDoc listing/literal blocks (`.listingblock`, `.literalblock`).
- Route Preview, side-reader (`/btw`), request plan, and subagent result code-copy buttons (`attachCopyButtons` in `src/preview/code-block.ts`) and Chat assistant code-block copy buttons (`[data-chat-copy="code"]` in `src/chat/ui.ts`) through `codeBlockCopyText(pre, code)`.
- Leave captured immutable SVG visual copies (`[data-visual-copy]` in `src/chat/visual-ui.ts`) byte-exact.
- Add colocated unit tests in `src/preview/code-block.test.ts`, add a Markdown code-block copy E2E test in `tests/e2e/code-blocks.e2e.ts`, and update existing E2E assertions in `tests/e2e/chat.e2e.ts`, `tests/e2e/chat-responsiveness.e2e.ts`, `tests/e2e/chat-touch.e2e.ts`, and `tests/e2e/chat-hold-to-queue.e2e.ts`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `document-rendering`: Markdown code block copy controls omit the parser-synthesized trailing newline while preserving multiline breaks, whole-file source views, and AsciiDoc blocks verbatim.
- `opencode-chat`: Chat fenced code block copy controls omit the parser-synthesized trailing newline while preserving internal line breaks and keeping captured SVG visual copies byte-exact.

## Impact

- Code: `src/preview/code-block.ts`, `src/chat/ui.ts`.
- Tests: `src/preview/code-block.test.ts`, `tests/e2e/code-blocks.e2e.ts`, `tests/e2e/chat.e2e.ts`, `tests/e2e/chat-responsiveness.e2e.ts`, `tests/e2e/chat-touch.e2e.ts`, `tests/e2e/chat-hold-to-queue.e2e.ts`.
- Non-goals: whole-file source views (`pre.uatu-source-pre`), raw document copy (`src/preview/outline.ts`), and captured immutable SVG visual copies (`[data-visual-copy]`) retain their exact source bytes.
