## Context

See `proposal.md` for motivation and `specs/document-tree/spec.md` for the revised contract. The user chose manual ancestor collapse as an explicit close-document action: selection and preview clear, Follow turns off, and the intentional empty state survives reloads.

The earlier implementation separated reveal from selection, preserved library expansion across resets, and restored the active file after directory clicks. Fresh UX review led to replacing that last policy, not stacking another behavior on it. `validation.md` and `research.md` remain historical evidence for the previous design; the affected implementation and verification tasks are reopened.

Accepted live frames reach `TreeView.update()` through `src/shell/events.ts` and `src/sidebar/shell.ts`. There are important existing constraints:

- The library owns expansion and focus. Selection callbacks can precede directory toggling, so a directory-selection callback alone does not identify a completed manual collapse.
- `resetPaths` initializes expanded ancestors of expanded descendants. Exact All-to-All restoration still needs a boundary snapshot and public-handle reconciliation.
- `nextSelectedDocumentId()` currently chooses a default when the current ID is null. Clearing only the ID would allow the next live update to undo deselection.
- Selection, preview mode/rendering, in-flight loads, URL/history, and persisted document restoration have separate lifecycle responsibilities. Closing the document must reconcile them together rather than merely remove its row highlight.

## Goals / Non-Goals

**Goals:**
- Keep manual tree-input detection in the adapter, and application deselection in the existing shell selection/preview lifecycle.
- Distinguish intentional empty selection from startup without a selection and from a retained but temporarily unavailable document.
- Preserve existing genuine-selection reveal and library-owned expansion/focus behavior.
- Exercise native pointer, touch, and keyboard interaction and real refresh/reload behavior in acceptance tests.

**Non-Goals:**
- A second continuously tracked folder-expansion model or persistence of expansion across reloads.
- New server events or APIs, replacement of the tree library, or custom row DOM/keyboard navigation.
- Changed-filter expansion redesign, unrelated virtualization/performance work, and mobile visual polish.

## Decisions

### 1. Observe completed manual collapse, not directory selection

The adapter reports an explicit user deselection when a native interaction changes an expanded directory to collapsed and that directory is an ancestor of the application's active document. Match canonical directory paths with separator boundaries; a similarly prefixed sibling is not an ancestor.

Observe the library's before/after expansion state at the user-input boundary rather than treating any selection callback or directory click as collapse. Pointer/touch clicks, native Enter/Space activation, and library-owned ArrowLeft collapse need coverage. ArrowLeft that only moves focus, opening a directory, unrelated-folder collapse, and interactions with no active document do not request deselection. Leave the library to perform the operation and keep keyboard focus on the operated folder; do not prevent or replace its native navigation. If closing the document drops the operated folder from the Changed view (it was shown only through the active-selection override), the library moves focus to a remaining visible row; the filter does not keep the folder around just to hold focus.

Adapter-driven resets, filter initialization/transitions, and public-handle expansion restoration are programmatic operations, not evidence of user intent. Retain the programmatic guard and dispose any input observers/listeners. There is no need to maintain an ongoing independent map of every directory's state.

Alternative rejected: deselect whenever the active row is hidden or any directory becomes selected. Both would misclassify unrelated navigation and background/filter work.

### 2. Close the document through one application action

Extend Follow's existing Rule A manual-navigation handling with a dedicated deselection variant, rather than create a fifth rule or an independent tree-side state mutation. It clears the requested document, marks the selection intentionally empty, disables Follow and updates its controls, resets the document preview mode, and renders the existing empty preview with no stale title/path/content. Synchronize the tree to no selected file without immediately restoring the former leaf. Preserve directory keyboard focus and do not navigate touch users away from Files simply because they collapsed a folder; the Preview tab must show the empty state when visited. The `follow-mode` delta updates the four-rule contract and programmatic guard alongside the tree behavior.

Coordinate preview-load cancellation/invalidation with this state transition. A response already in flight for the closed document must not remount rendered, source, or diff content after deselection or a later navigation. Rendering the empty DOM alone is not a sufficient lifecycle boundary.

Reopening the folder changes expansion only. A subsequent explicit file selection uses the normal navigation path and requests reveal as a new selection. Enabling Follow clears intentional-empty state and invokes its existing latest-document selection behavior. Existing explicit search/history/deep-link navigation remains document navigation, not a background fallback.

Alternative rejected: clear only the tree highlight while retaining the preview or hidden active identity. The user explicitly chose to close the document entirely.

### 3. Persist intentional emptiness without changing first-visit defaults

Represent explicit deselection separately from the absence of an initial selection. The user chose browser-only persistence for this indication: use workspace/base-path-scoped local storage through the existing presentation-storage wrapper. Do not add the indication to the personal-state API. Existing document-path, Follow, and other personal preferences remain Hub-backed; closing a document can still clear the remembered document path and save Follow off through their existing fields. A browser without the indication continues to use existing startup rules; do not change every null selection into permanent emptiness.

Live-frame and reconnect/resume reconciliation must retain intentionally empty selection with Follow off instead of running the current null-to-default fallback. Boot at the workspace root reads the browser indication before any saved Hub destination and restores the empty state after reload. Filter changes may change visible paths but cannot choose a document. Only explicit document navigation or enabling Follow removes the browser indication; background reconciliation in another tab must not erase it. Commit-preview navigation does not itself resume document selection. Do not use storage events to force other already-open clients to change their current document.

Keep URL/history and remembered document destination consistent with closing the document: the current location must no longer name the closed file, and its stored path must not override intentional emptiness during boot. Use the existing session/base-path-aware navigation helpers to represent the session's no-document location; preserve ordinary explicit history/deep-link navigation as a way to select a document again. Do not add a server protocol or global cross-workspace preference.

Alternative rejected: rely on `selectedId === null` alone. It is currently also the startup/default-selection signal, so the next refresh or reload could reopen a document without user action.

### 4. Retain conditional reveal and reset-boundary expansion preservation

Read current expansion from library handles before All-to-All path rebuilds. Restore surviving expanded paths, adding selected-file ancestors only for a genuine selection reveal. When initialization implicitly opens ancestors of an expanded descendant, restore the intended collapsed ancestors through public handles without collapsing the descendants themselves. With intentionally empty selection, no selected-file ancestors are added. Keep the existing path fingerprint optimization.

Representation tracking is scoped to the current requested document identity. Initial/new selection requests reveal; an unchanged selection during background refresh does not. Clear representation on deliberate deselection, a changed requested identity (including an unavailable document), or disposal. A continuously retained unavailable document returning is still distinct from explicit deselection; A → unavailable B → A is still a new navigation. Tests for retained identity must not use a manual ancestor collapse as setup, since that now deliberately clears the request.

Keep the existing filter-specific expansion policy. Programmatic filter-driven visibility changes do not close the document, while a genuine user ancestor collapse closes it in either All or Changed mode. A later filter-driven expansion may follow its existing policy but must not recreate a document selection or nonempty preview.

### 5. Remove conflicting restoration and revalidate activation independently

Remove directory-callback reconciliation whose purpose is to keep or restore a hidden active file after manual ancestor collapse. Do not restore that file when its folder reopens, and remove tests asserting the superseded behavior.

Preserve the separate existing rule that deliberate activation of an already-selected visible file invokes manual navigation exactly once, including Follow-off and touch Preview behavior. That is still required even though collapse/reopen no longer produces this state. Reevaluate the existing activation bridge after removing hidden-selection reconciliation: retain only the part needed for actual same-file activation, keep ordinary selection changes library-driven, and verify disposal and programmatic-echo suppression. Do not keep obsolete complexity merely because it was previously implemented.

### 6. Verify empty state through real browser refreshes

Rewrite the previous collapsed-active-file reproductions: after manual ancestor collapse they must assert no active file, empty preview, and Follow off, including when Follow was previously on. Assert this remains true after reopening, changing the former document's content, unrelated add/remove/rename, filter transitions, reconnect/resume, and reload. Explicit file navigation and enabling Follow are the positive resumption controls.

An empty preview is no longer a refresh-completion signal. Await evidence that the specific update reached the index (library model/metadata, row addition/removal, or existing live-state observability) before asserting continued emptiness and folder state. Do not replace this with fixed sleeps. Test delayed old document responses, nested and multi-root ancestor matching, all native input routes, unrelated-folder controls, and programmatic restoration that must not close a document. Keep browser screenshots/evidence in `test-results/`, not this change directory.

## Risks / Trade-offs

- **False deselection from programmatic collapse or focus movement** → Require a native user action and an actual expanded-to-collapsed ancestor transition; test ArrowLeft focus-only and reset/filter controls.
- **Refresh or reload resurrects the closed document** → Persist explicit-empty intent and carry it through live, recovery, boot, and stored-destination reconciliation.
- **A late preview response undoes the close action** → Invalidate pending document presentation and assert empty preview after delayed responses resolve.
- **First visits unexpectedly start empty** → Interpret only deliberate persisted deselection as intentional-empty state; keep legacy/default boot behavior.
- **User loses place when closing a parent folder** → This is the approved interaction, not an accidental side effect. Keep focus on that folder and require explicit file navigation or Follow activation to resume.
- **Tests pass before a background update arrives** → Use index/live/model completion evidence independent of the empty preview.
- **Historical green reports are mistaken for current acceptance** → Preserve them as history, reopen the affected tasks, and append new validation only after implementation.

## Migration Plan

The implementation adds a browser-local marker, not a Hub record field; no server data/API migration or API revision is needed. Existing browsers without the marker keep the current startup selection policy. The briefly implemented Hub-field extension was superseded by the user's browser-only decision and is not part of the final change. Earlier hidden-selection behavior and its tests must be replaced by the reopened tasks.

Ship only after the revised lifecycle, input, persistence, and related browser suites pass. Older code ignores the new browser key without changing existing Hub records. Before preparing a fix PR, check the latest stable release and follow the repository's release-note classification/override rules for the final user-visible delta.
