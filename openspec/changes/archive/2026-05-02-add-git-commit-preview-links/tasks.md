## 1. Commit Preview URL Model

- [x] 1.1 Extend commit preview state to store `repositoryId` and `sha`.
- [x] 1.2 Add helpers to build commit preview URLs with `URLSearchParams` using `repository` and `commit` query parameters.
- [x] 1.3 Add helpers to parse and resolve commit preview URLs against `appState.repositories`.
- [x] 1.4 Add unavailable-preview rendering for missing commit repositories and missing commits.

## 2. Git Log Link Behavior

- [x] 2.1 Render Git Log commit rows as anchors with commit preview `href` values and commit identity data attributes.
- [x] 2.2 Update the Git Log click handler to intercept only ordinary same-window same-origin clicks.
- [x] 2.3 On intercepted commit clicks, disable Follow, clear document selection, push a history entry, render the sidebar, and render the commit message.
- [x] 2.4 Preserve browser-default behavior for modifier-clicks, middle-clicks, non-self targets, and other new-context link interactions.

## 3. Browser Navigation Integration

- [x] 3.1 Restore commit previews from commit preview URLs during initial SPA boot.
- [x] 3.2 Restore commit previews from commit preview URLs during `popstate` without pushing or replacing history.
- [x] 3.3 Re-resolve and re-render active commit previews after state refresh events.
- [x] 3.4 Ensure document and review-score URL handling continue to behave as before.

## 4. Verification

- [x] 4.1 Add E2E coverage that commit rows are anchors with commit preview URLs.
- [x] 4.2 Add E2E coverage that clicking a commit row pushes history and Back/Forward restores the previous and next previews.
- [x] 4.3 Add E2E coverage that refresh and direct navigation to a commit preview URL restore the commit message.
- [x] 4.4 Add E2E coverage for unavailable commit preview URLs.
- [x] 4.5 Run the relevant browser E2E tests and the full test suite.
