## Context

The browser UI already has two navigation models. Document previews are represented by the URL pathname and participate in `pushState`, `replaceState`, direct-link boot, and `popstate`. Review-score previews are represented by `?reviewScore=<repositoryId>` and can be restored across reloads and state refreshes. Git Log commit previews are different: commit rows are rendered as buttons, clicking one mutates in-memory preview state, and no URL or history entry is recorded.

The commit log data is already present in `/api/state` as a bounded recent log per repository. The first implementation should use that existing data rather than introducing an API for arbitrary commit lookup.

## Goals / Non-Goals

**Goals:**

- Make Git Log commit rows real links so standard browser link affordances work.
- Preserve SPA behavior for normal in-app clicks: no full page load, Follow disabled, commit message rendered in the preview.
- Record user-initiated commit preview opens in browser history.
- Restore commit previews on refresh, direct link arrival, and Back/Forward navigation when the repository and commit are present in the current bounded state payload.
- Keep the implementation client-side and avoid expanding the server API.

**Non-Goals:**

- Durable commit pages for commits outside the bounded recent log.
- Hosted forge integration or links to remote GitHub/GitLab commit pages.
- Changing commit-log collection size or replacing short SHAs with full SHAs.
- Adding new persistence beyond browser history and the existing state payload.

## Decisions

### D1. Represent commit previews with root-level query parameters

Commit preview URLs should use the existing SPA root path with explicit query parameters:

```text
/?repository=<repositoryId>&commit=<commitSha>
```

`repository` stores the `RepositoryReviewSnapshot.id` value already used by review-score routing. `commit` stores the commit log entry's `sha` value from the bounded payload.

This keeps the route server-compatible. Requests to `/` with query parameters are already served by the SPA shell, so direct links and new-tab opens do not need catch-all route changes. A path-based route such as `/commits/<repo>/<sha>` would require new server dispatch behavior because unknown paths currently fall through to static-file handling or 404.

Alternatives considered:

- `?commit=<sha>` only: insufficient when multiple repositories are detected.
- `/commits/<sha>`: cleaner visually, but requires server route changes and still needs a repository disambiguator.
- Reusing `?reviewScore=`: conflates two distinct preview modes and would complicate existing review-score behavior.

### D2. Render Git Log rows as anchors and intercept only normal SPA clicks

Git Log rows should be `<a>` elements with `href` set to the commit preview URL and data attributes for repository id and commit sha. The click handler should intercept only ordinary same-window clicks and let browser-default behavior happen for modifier clicks, middle clicks, downloads, non-self targets, or anything that is no longer same-origin.

For intercepted clicks, the handler should disable Follow, clear document selection, set commit preview mode with repository and commit identity, push the commit URL via `history.pushState`, render the sidebar, and render the commit message.

Alternatives considered:

- Keep buttons and call `pushState`: fixes Back/Forward but does not provide copy/open-in-new-tab affordances.
- Let every anchor click perform full navigation: works but unnecessarily reloads the SPA for normal clicks.

### D3. Store commit identity in `PreviewMode`

Commit preview mode should carry enough identity to re-resolve itself:

```ts
{ kind: "commit"; repositoryId: string; sha: string }
```

The current `{ kind: "commit" }` state cannot determine which commit should be restored after a state refresh or `popstate` event. With explicit identity, the UI can re-render from the latest `/api/state` payload or show an unavailable message if the bounded log no longer contains that commit.

### D4. Add commit-preview URL parsing beside review-score parsing

Client startup and `popstate` handling should parse commit-preview query parameters similarly to `reviewScore`. When both `repository` and `commit` are non-empty, the client resolves them against `appState.repositories`.

Resolution outcomes:

- Repository and commit found: render the full commit message preview.
- Repository missing: render an empty preview explaining that the commit repository is unavailable.
- Commit missing from that repository's bounded log: render an empty preview explaining that the commit is unavailable in the current Git Log data.

Generated commit URLs should not include document pathnames. When a commit preview is active, `selectedId` remains `null`, the file tree has no selected document, and the pin control remains hidden.

### D5. State refresh keeps the active commit preview truthful

When an SSE state update arrives while commit preview mode is active, the client should update repositories, re-render the sidebar, and re-resolve the active commit identity against the new payload. If the commit is still available, the preview is re-rendered from fresh data. If it is no longer available, the preview changes to the empty unavailable state instead of silently leaving stale commit text on screen.

## Risks / Trade-offs

- [Bounded-log links can expire] -> Mitigation: make unavailable states explicit. This is acceptable because the change intentionally avoids arbitrary commit lookup.
- [Short SHA ambiguity] -> Mitigation: use the exact `sha` value already rendered in the Git Log and resolve only within one repository's bounded log. Full SHA support can be added later if durable commit pages become a goal.
- [Repository id contains path characters] -> Mitigation: build URLs with `URL` and `URLSearchParams`, never string concatenation for query values.
- [Query parameter names may conflict with future preview modes] -> Mitigation: keep generated URLs minimal and reserve `repository` plus `commit` as the commit-preview pair; other modes should use distinct required parameter sets.

## Migration Plan

No migration is required. Existing document URLs and review-score URLs continue to work. Existing sessions simply gain linkable commit previews after the client update.

Rollback is straightforward: reverting the client changes restores button-only commit previews. Old commit-preview links would then load the default root view because no parser would consume the query parameters.

## Open Questions

- None for the bounded-link implementation.
