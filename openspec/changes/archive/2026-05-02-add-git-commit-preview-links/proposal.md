## Why

Git Log commit previews currently behave like a transient UI panel: clicking a commit renders its message, but the browser URL and history do not change. This means users cannot use Back/Forward to return from commit previews, refresh or share the current commit view, or open a commit preview in a new tab from the Git Log.

## What Changes

- Render Git Log commit rows as same-origin links that preserve SPA behavior for normal clicks while exposing standard browser link affordances such as copy link, open in new tab, and modifier-click.
- Add a URL contract for commit previews using query parameters that identify the repository and commit.
- Push a browser history entry when a user opens a commit preview from the Git Log.
- Restore commit previews from direct links, refreshes, and browser Back/Forward navigation when the referenced commit is present in the bounded commit log data.
- Show a clear unavailable state when a commit-preview URL references a repository or commit that is not present in the current bounded state payload.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `document-watch-browser`: Extend browser navigation and Git Log behavior so commit previews participate in URL, history, direct-link, and standard anchor semantics.

## Impact

- Client UI in `src/app.ts` for Git Log rendering, commit-preview state, URL parsing, `pushState`, direct-link boot, and `popstate` handling.
- Browser E2E coverage in `tests/e2e/uatu.e2e.ts` for commit preview links, history navigation, refresh/direct-link restoration, and unavailable states.
- No server API or dependency changes are expected; commit preview direct links resolve against the bounded commit data already returned by `/api/state`.
