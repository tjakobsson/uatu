## 1. Narrow Chat Copy Decoration

- [x] 1.1 Remove whole-answer action-container and button creation from completed assistant decoration while preserving idempotent fenced code-block controls.
- [x] 1.2 Update timeline renderer tests to assert that completed and streaming messages have no answer-copy control and completed code blocks retain exactly one control each.

## 2. Narrow Copy Interaction

- [x] 2.1 Remove the whole-answer Markdown branch from delegated Chat copy handling and resolve copy input only from the owning code block.
- [x] 2.2 Remove answer-specific label assumptions from Chat copy feedback while preserving success, failure, bounded reset, and live-region announcements for code copy.
- [x] 2.3 Update focused interaction and clipboard tests to retain exact code text, failure containment, and repeated-feedback behavior.

## 3. Remove Answer-Only Presentation

- [x] 3.1 Remove answer-action layout, answer-icon sizing, and answer hover/focus selectors while retaining shared and code-specific copy styles.
- [x] 3.2 Update desktop and touch browser coverage to assert no whole-message copy icon and continued keyboard/tap access to code-block copy without geometry changes.

## 4. Verification

- [x] 4.1 Run focused Chat timeline, copy-action, clipboard, and Chat E2E tests.
- [x] 4.2 Run `bun test`, `bun run build`, and OpenSpec validation for `remove-chat-answer-copy`.
