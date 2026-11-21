## 1. Code-Block Copy Normalization

- [x] 1.1 Add and export `codeBlockCopyText(pre, code)` in `src/preview/code-block.ts`, stripping one trailing `\r?\n$` on rendered Markdown code blocks while keeping `pre.uatu-source-pre` and `.listingblock` / `.literalblock` verbatim.
- [x] 1.2 Wire `attachCopyButtons` (`src/preview/code-block.ts`) and Chat `[data-chat-copy="code"]` (`src/chat/ui.ts`) through `codeBlockCopyText(pre, code)`, leaving captured `[data-visual-copy]` byte-exact.

## 2. Verification & Spec Sync

- [x] 2.1 Add colocated unit tests in `src/preview/code-block.test.ts` covering single-line, multiline, CRLF, intentional trailing blank lines, whole-file source views, AsciiDoc blocks, and click-to-copy behavior.
- [x] 2.2 Add Markdown code-block copy E2E coverage in `tests/e2e/code-blocks.e2e.ts` and update existing trailing-newline clipboard expectations in `tests/e2e/chat.e2e.ts`, `tests/e2e/chat-responsiveness.e2e.ts`, `tests/e2e/chat-touch.e2e.ts`, and `tests/e2e/chat-hold-to-queue.e2e.ts`.
- [x] 2.3 Sync delta specs into `openspec/specs/document-rendering/spec.md` and `openspec/specs/opencode-chat/spec.md` and validate with `openspec validate --all --strict`, `tests/openspec-discipline.test.ts`, `bun run typecheck`, unit tests, and Playwright E2E.
