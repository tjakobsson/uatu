## 1. Source Cleanup

- [x] 1.1 Replace the literal NUL and control bytes in the binary-document fixture in `tests/e2e/document-tree.e2e.ts` with TypeScript escape sequences that produce the same runtime string.
- [x] 1.2 Inspect the resulting diff and source bytes to confirm the TypeScript file contains no literal NUL bytes and is recognized as text by standard file, search, and Git tooling.

## 2. Verification

- [x] 2.1 Run the focused binary-tree-row E2E test and confirm the escaped fixture is still detected as binary and routes to the preview-unavailable view.
- [x] 2.2 Run the complete `document-tree.e2e.ts` suite to confirm the source-only representation change introduces no regressions.
