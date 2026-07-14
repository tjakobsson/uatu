## 1. File Facts Presentation

- [x] 1.1 Generalize the Source-only facts-strip state and renderer naming so the same document-facts variant represents Rendered and Source payloads.
- [x] 1.2 Synchronize document facts for Rendered and Source payloads in single and split layouts while preserving the Diff variant and hidden state for non-document previews.
- [x] 1.3 Update inline documentation and any accessibility or styling details that still describe Rendered view as strip-less.

## 2. Update Signal

- [x] 2.1 Verify the existing strip-visibility routing highlights Rendered view's freshness segment and keeps the `Updated` chip as a no-facts fallback.
- [x] 2.2 Add focused unit coverage for Rendered/document strip output and signal presentation across visible-strip and no-facts states.

## 3. End-to-End Coverage and Validation

- [x] 3.1 Update file-facts E2E coverage to assert facts are visible in Rendered and Source views and remain a single shared strip in split layouts.
- [x] 3.2 Add an E2E scenario proving an on-disk edit in Rendered view refreshes and highlights the facts strip without showing the fallback header chip.
- [x] 3.3 Run the focused file-facts unit and E2E tests, then run `bun test`, `bun run build`, and strict OpenSpec validation.
