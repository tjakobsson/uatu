## 1. Snapshot-Based Freshness

- [ ] 1.1 Add a pure active-document freshness decision that combines selected-ID event matching with previous/incoming `mtimeMs` and `kind` comparison.
- [ ] 1.2 Use the freshness decision before applying each server snapshot while preserving Follow selection, Review-mode suppression, search staleness, and cache invalidation behavior.
- [ ] 1.3 Add unit coverage for single-file events, multi-file representative-event mismatch, unchanged snapshots, kind changes, and reconnection-style snapshots with `changedId: null`.

## 2. Preview Request Ordering

- [ ] 2.1 Add a monotonic generation and captured request context to ordinary rendered/source document loads.
- [ ] 2.2 Prevent superseded responses from mutating document caches, preview mode, or mounted content while leaving existing Diff guards intact.
- [ ] 2.3 Add controlled tests proving that an older selection load and an older same-document refresh cannot replace the newest preview.

## 3. Watch Regression Coverage

- [ ] 3.1 Add an E2E regression for changing the active document and another watched path in one debounce batch, asserting an in-place content refresh.
- [ ] 3.2 Remove or narrow the documented page-reload workaround in the relative-image E2E test once the active preview self-refreshes reliably.
- [ ] 3.3 Cover recovery after a missed active-document event through a fresh state snapshot if the E2E harness can control EventSource reconnection deterministically.

## 4. Verification

- [ ] 4.1 Run focused shell event, shared type, preview mount, watch-session, and relevant E2E tests.
- [ ] 4.2 Run `bun test`, `bun run build`, and OpenSpec validation for `fix-active-document-refresh`.
