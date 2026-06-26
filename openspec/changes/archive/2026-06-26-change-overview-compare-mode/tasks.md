## 1. Shared types & base resolution

- [x] 1.1 Add `ReviewCompareTarget = "base" | "last-commit"` to `src/shared/types.ts`
- [x] 1.2 Extend `ReviewBase` / `ReviewLoadResult` with the resolved compare target and its precise ref anchor (e.g. `compareTarget`, `comparedAgainstRef`)
- [x] 1.3 Add `compareTarget` (defaulting to `"base"`) to the relevant request/response shapes: `StatePayload` and the `/api/document/diff` response/typing
- [x] 1.4 Introduce a single helper that maps `(ReviewBase, ReviewCompareTarget) → compareRef` (`last-commit` ⇒ `HEAD`; `base` ⇒ existing resolution) so meter and diff share one source of truth — likely in `src/document/git-base-ref.ts`

## 2. Server: burden snapshot honors compare target

- [x] 2.1 Thread `compareTarget` into `snapshotGroup` / `collectChangedFiles` in `src/review/load.ts`, using the shared mapper to pick the compareRef
- [x] 2.2 Populate the resolved ref anchor on the result (resolved base ref for `base`, `HEAD` for `last-commit`)
- [x] 2.3 Ensure dirty-worktree-only base collapses both targets to the same compareRef and flags the collapsed state in the result
- [x] 2.4 Accept `compareTarget` on `/api/state` in `src/server/routes.ts` (and wire through `src/server/session.ts` snapshot assembly), defaulting to `"base"` when absent
- [x] 2.5 Unit tests in `src/review/load.test.ts`: base vs last-commit produce different changed-file sets/scores; collapsed state when no base; anchor reflects configured `review.baseRef`

## 3. Server: per-document diff honors compare target

- [x] 3.1 Accept `compareTarget` param on `/api/document/diff` in `src/server/routes.ts`
- [x] 3.2 Thread it into `getDocumentDiff` in `src/document/diff.ts` via the shared mapper; `last-commit` compares against `HEAD`
- [x] 3.3 Carry the resolved ref through the `DocumentDiffResponse` `baseRef` field for each kind
- [x] 3.4 Unit tests in `src/document/diff.test.ts`: last-commit excludes already-committed-since-base changes; base unchanged from current behavior

## 4. Client: state, persistence, transport

- [x] 4.1 Add `compareTarget` to `appState` in `src/shell/state.ts`, defaulting to `"base"`
- [x] 4.2 Persist/restore the target per session via `src/shell/storage.ts`; fall back to `"base"` on unreadable/missing value
- [x] 4.3 Send `compareTarget` on the `/api/state` fetch and on `/api/document/diff` requests (preview diff fetch wiring in `src/preview/`)
- [x] 4.4 Re-fetch state and refresh on target change without a full reload

## 5. Client: Change Overview control & readout

- [x] 5.1 Render the segmented toggle under the panel title in `src/sidebar/change-overview.ts` with plain-intent labels `Since base` / `Since last commit`
- [x] 5.2 Keep the evidence subtitle (`origin/main · merge-base abc1234`) beneath the toggle, tracking the active target; `merge-base` only here
- [x] 5.3 Anchor the burden readout with the precise resolved ref (`· vs origin/main` / `· vs HEAD`) using the result's anchor field; update `src/sidebar/git-log.ts` base labeling as needed
- [x] 5.4 Reflect the collapsed state (no resolvable base) in the control per the open question resolution (disabled or annotated)
- [x] 5.5 Wire the toggle to update `appState`, persist, and trigger refresh

## 6. End-to-end coherence & docs

- [x] 6.1 E2E test (`tests/e2e/`): toggling the compare target changes the burden meter AND a selected file's Diff view consistently (they agree on the ref)
- [x] 6.2 E2E test: default session shows `Since base`; selection persists across reload
- [x] 6.3 Update `ARCHITECTURE.md` (and `CLAUDE.md` map if needed) to describe the compare-target concept and where it threads through server → client
- [x] 6.4 Run `bun test` and `bun test:e2e`; confirm no regression in existing diff/review-load suites
