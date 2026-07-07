## Purpose

Define the Diff view in the preview pane: a third view-mode (alongside Rendered and Source) that renders the active file's git diff against a resolved review base, with intelligent payload shaping, lazy library loading, graceful degradation for non-git/unchanged/binary/large cases, and an in-host Unified / Split layout toggle.

## Requirements

### Requirement: Diff view renders the active file's git diff against the resolved review base

The preview pane SHALL expose a **Diff** view that renders the git diff of the currently selected file against the base implied by the active compare target. When the compare target is `base`, the base ref SHALL be resolved in the same priority order used by the review-burden meter (configured `review.baseRef` → `origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`), falling back to staged and unstaged worktree changes against `HEAD` when no remote base is resolvable. When the compare target is `last-commit`, the Diff view SHALL compare the selected file against `HEAD` (staged and unstaged worktree changes). The Diff view SHALL render only the hunks for the selected file — never the diff for other files in the repository. The rendered output SHALL be produced by the `@pierre/diffs` library (vanilla-JS entry) for normal-sized diffs, via one of two input shapes:

- **Two-blob path** — when the server payload carries both `oldContents` and `newContents`, the client SHALL feed them to Pierre as `oldFile` / `newFile`. This path enables Pierre's "N unmodified lines" chevrons to interactively expand surrounding context drawn from the blobs.
- **Patch-only path** — when blobs are absent (the per-blob size cap was exceeded), the client SHALL parse the unified-diff `patch` string via the library's patch-input API and feed Pierre the resulting metadata. The chevrons still render but expansion is bounded by the context git embedded in the patch.

Pierre SHALL NOT be invoked on the normal Source view or Rendered view — its scope is the Diff view only.

#### Scenario: A modified Markdown file shows added and deleted lines against the review base
- **WHEN** a user selects a Markdown file that has been modified against the resolved review base
- **AND** the active compare target is `base`
- **AND** activates the Diff view
- **THEN** the preview body renders only that file's diff, with added and deleted lines visually distinguished

#### Scenario: A modified source file shows the file's diff
- **WHEN** a user selects a `.ts` file that has been modified against the resolved review base
- **AND** the active compare target is `base`
- **AND** activates the Diff view
- **THEN** the preview body renders only that file's diff with syntax-aware highlighting

#### Scenario: Diff view follows the last-commit compare target
- **WHEN** the active compare target is `last-commit`
- **AND** a user activates the Diff view for a file with both committed-since-base and uncommitted changes
- **THEN** the rendered diff shows only the file's staged and unstaged changes against `HEAD`
- **AND** the diff does not include changes already committed between the review base and `HEAD`

#### Scenario: Blob-bearing payload enables expand-context chevrons
- **WHEN** the diff payload carries both `oldContents` and `newContents`
- **THEN** the Diff view feeds them to Pierre's two-blob input
- **AND** the rendered "N unmodified lines" chevrons can be clicked to reveal surrounding unchanged lines drawn from the blob contents

#### Scenario: Patch-only payload still renders with chevrons but expansion is bounded
- **WHEN** the diff payload carries only the `patch` string (no blobs)
- **THEN** the Diff view parses the patch and renders via Pierre's metadata input
- **AND** the rendered "N unmodified lines" chevrons appear but cannot expand beyond the context git embedded in the patch

#### Scenario: The Diff view never renders unrelated files
- **WHEN** a user activates the Diff view for file A while other files B and C have unrelated changes
- **THEN** only file A's hunks appear in the preview
- **AND** files B and C do not appear in the diff output

#### Scenario: Rendered and Source views do not invoke @pierre/diffs
- **WHEN** a user activates the Rendered or Source view for any document
- **THEN** the `@pierre/diffs` library is not loaded or invoked for that render

### Requirement: Diff view is sourced from a dedicated document-diff endpoint

The server SHALL expose `GET /api/document/diff?id=<absolutePath>` returning a JSON payload describing the diff for the given document against the resolved review base. The payload SHALL include the resolved base ref when relevant and one of the following discriminated kinds: `text` (with the unified diff patch string, byte size, added and deleted line counts), `unchanged`, `binary`, or `unsupported-no-git`. The `text` kind MAY additionally include `oldContents` and `newContents` (the full file blobs at the base ref and in the worktree respectively) and `oldPath` (for renamed files) when both blobs fit under a per-blob size cap; the client uses these to drive @pierre/diffs' two-blob input path so the "N unmodified lines" chevrons can expand arbitrary context. When either blob exceeds the per-blob cap, the response SHALL omit both blob fields and the client SHALL fall back to a patch-only render. The endpoint SHALL invoke `git diff` with rename detection enabled (`-M`) so renamed files render as a single hunk pair rather than as an add-delete pair. When `git diff` returns an empty patch for a file that exists on disk but is not tracked, the endpoint SHALL fall back to `git diff --no-index /dev/null <path>` so newly-added files surface as additions rather than as a misleading "unchanged" state. The endpoint MUST NOT 404 on a non-git workspace; instead it returns `unsupported-no-git` so the client can render the muted fallback card. The endpoint MUST validate that the document id resolves to a watched file before running git, mirroring the existing document-rendering endpoint's path-safety posture.

#### Scenario: Endpoint returns a text-kind payload for a modified text file
- **WHEN** a request is made for a file that is modified against the resolved review base
- **THEN** the response carries `kind: "text"`, the resolved `baseRef`, the unified-diff `patch` string, the patch `bytes`, `addedLines`, and `deletedLines`

#### Scenario: Endpoint ships blob contents when both files fit under the per-blob cap
- **WHEN** a request is made for a modified file whose old and new contents both fit under the per-blob size cap
- **THEN** the response additionally carries `oldContents` (the contents at the resolved base ref, or `""` for files added on this branch) and `newContents` (the worktree contents)
- **AND** for renames the response also carries `oldPath` identifying the prior path

#### Scenario: Endpoint omits blob contents when either file exceeds the per-blob cap
- **WHEN** a request is made for a modified file whose old or new contents exceed the per-blob size cap
- **THEN** the response omits both `oldContents` and `newContents`
- **AND** the payload still carries the `patch` string so the client can render the diff in patch-only mode

#### Scenario: Endpoint surfaces untracked-but-on-disk files as additions
- **WHEN** a request is made for a file that exists on disk but is not tracked by git
- **AND** `git diff <ref> -- <path>` therefore returns an empty patch
- **THEN** the endpoint falls back to `git diff --no-index /dev/null <path>` and returns the resulting `text` payload showing the file as a pure addition

#### Scenario: Endpoint returns an unchanged payload when the file matches the base
- **WHEN** a request is made for a file whose working-tree content matches the resolved review base
- **THEN** the response carries `kind: "unchanged"` and the resolved `baseRef`

#### Scenario: Endpoint returns a binary payload for changed binary files
- **WHEN** a request is made for a binary file that has changed against the resolved review base
- **THEN** the response carries `kind: "binary"` and the resolved `baseRef`
- **AND** the response does not carry a patch string

#### Scenario: Endpoint returns unsupported-no-git outside a git workspace
- **WHEN** a request is made for a file whose watched root is not inside a git repository (e.g. uatu started with `--force`)
- **THEN** the response carries `kind: "unsupported-no-git"`
- **AND** no `git` subprocess is required to succeed for the response to be valid

#### Scenario: Endpoint detects renames
- **WHEN** a request is made for a file that has been renamed since the review base
- **THEN** the response includes a single diff for the renamed file rather than separate add/delete entries

### Requirement: Diff view degrades gracefully in non-git, unchanged, and binary cases

When the document-diff endpoint returns `unsupported-no-git`, `unchanged`, or `binary` for the active file, the Diff view SHALL render a single muted state card inside the preview body in place of any diff content. The card SHALL communicate the case to the reader and SHALL NOT load or invoke `@pierre/diffs`. For `unsupported-no-git`, the card MUST identify that no git history is available. For `unchanged`, the card MUST identify that the file has no changes against the resolved base and SHALL display the base ref. For `binary`, the card MUST identify the file as a changed binary and SHALL display the base ref. In each case the view choice SHALL remain Diff (the segment stays selected) so the user can leave it without re-activating the toggle.

#### Scenario: Non-git workspace shows a muted "no git history" card
- **WHEN** the active Diff view targets a file whose watched root is not in a git repository
- **THEN** the preview body shows a muted card stating that no git history is available
- **AND** the `@pierre/diffs` library is not loaded for that render
- **AND** the Diff segment remains the active view

#### Scenario: Unchanged file shows a muted "no changes" card
- **WHEN** the active Diff view targets a file whose contents match the resolved review base
- **THEN** the preview body shows a muted card stating that the file has no changes
- **AND** the card displays the resolved base ref
- **AND** the `@pierre/diffs` library is not invoked for that render

#### Scenario: Binary file shows a muted "binary file changed" card
- **WHEN** the active Diff view targets a binary file that differs from the resolved review base
- **THEN** the preview body shows a muted card identifying the file as a changed binary
- **AND** the card displays the resolved base ref
- **AND** the `@pierre/diffs` library is not invoked for that render

### Requirement: Diff view falls back to a lightweight render for very large diffs

When the document-diff endpoint returns `kind: "text"` but the patch exceeds either the configured byte cutoff (`DIFF_MAX_BYTES`, default 256 KB) or the configured changed-line cutoff (`DIFF_MAX_LINES`, default 5 000 — the sum of added and deleted lines), the Diff view SHALL render the diff using a lightweight escaped-HTML emitter inside a `<pre>` block. The lightweight path SHALL distinguish added lines (`+`-prefixed), deleted lines (`-`-prefixed), context lines, and hunk headers (`@@…@@`) via background and prefix styling, but SHALL NOT invoke syntax highlighting and SHALL NOT call into `@pierre/diffs`. The emitter SHALL group lines into fixed-size chunks styled with `content-visibility: auto` and an intrinsic-size hint so offscreen chunks skip layout and paint. A one-line notice MUST be rendered above or alongside the lightweight diff to explain why syntax highlighting was disabled. Both cutoffs SHALL be exported as module-level constants in the Diff view implementation so they are tunable and overridable from tests.

#### Scenario: A patch above the byte cutoff renders via the lightweight emitter
- **WHEN** the diff endpoint returns a text patch larger than `DIFF_MAX_BYTES`
- **THEN** the Diff view renders the diff inside a `<pre>` with added/deleted/context line styling
- **AND** no syntax highlighting is applied
- **AND** the `@pierre/diffs` library is not loaded for that render
- **AND** a one-line notice explains that highlighting was disabled

#### Scenario: A patch above the line-count cutoff renders via the lightweight emitter
- **WHEN** the diff endpoint returns a text patch whose `addedLines + deletedLines` exceeds `DIFF_MAX_LINES`
- **THEN** the Diff view renders via the lightweight emitter
- **AND** no syntax highlighting is applied

#### Scenario: Lightweight output is chunked for offscreen skipping
- **WHEN** the lightweight emitter renders a very large patch
- **THEN** the emitted lines are grouped into chunks styled with `content-visibility: auto`
- **AND** line classification (added / deleted / context / hunk header) is unchanged

#### Scenario: A patch below both cutoffs uses @pierre/diffs
- **WHEN** the diff endpoint returns a text patch under both cutoffs
- **THEN** the Diff view loads `@pierre/diffs` (on first use in the session) and renders the patch via Pierre — with syntax-aware highlighting when under the highlight-size threshold, and with the plaintext language otherwise

### Requirement: A single Shiki highlighter is cached and reused across diff renders

The Diff view implementation SHALL initialize at most one Shiki highlighter instance per browser session and reuse it across every subsequent `@pierre/diffs` render in that session. The highlighter SHALL be created lazily — on the first Diff render that actually invokes `@pierre/diffs`, or earlier via the prewarm path when Diff rendering is plausibly imminent — and never on the fallback render paths themselves. Subsequent diff renders, including renders triggered by view-mode toggles, file switches, and in-place refreshes, MUST NOT re-create the highlighter and MUST NOT re-load grammars that are already loaded on the cached highlighter. The cached highlighter MAY load additional grammars on demand when a file requires a language not yet loaded.

#### Scenario: First Diff render initializes one highlighter
- **WHEN** a user activates the Diff view for the first time in a session for a file that exercises the @pierre/diffs path
- **THEN** exactly one Shiki highlighter instance is created

#### Scenario: Prewarm initializes the same single highlighter
- **WHEN** the prewarm path runs before any Diff render
- **AND** the user later activates the Diff view
- **THEN** the render reuses the prewarmed highlighter and no second instance is created

#### Scenario: Subsequent Diff renders reuse the cached highlighter
- **WHEN** the user activates the Diff view multiple times for different files in the same session
- **THEN** no additional Shiki highlighter instance is created beyond the first

#### Scenario: A new language reuses the cached highlighter
- **WHEN** the first Diff render is for a TypeScript file
- **AND** a later Diff render targets a Python file
- **THEN** the same Shiki highlighter instance loads the Python grammar
- **AND** no second highlighter instance is created

### Requirement: Diff view loads @pierre/diffs lazily and only on the Pierre render path

The `@pierre/diffs` library SHALL be loaded via a dynamic `import()` and MUST NOT be present in the initial application bundle's eager imports. The import SHALL be triggered either by the first Diff render that needs Pierre output, or by an explicit prewarm invoked when Diff rendering is plausibly imminent: at browser idle time after boot in a session where the Diff view is reachable (a git workspace), or on hover/focus of the Diff segment. Once loaded, the resolved module SHALL be cached for the lifetime of the session so subsequent Pierre-path renders reuse it without re-importing. The fallback render paths (`unsupported-no-git`, `unchanged`, `binary`, lightweight large-diff) MUST NOT themselves trigger the dynamic import, though a prewarm MAY have loaded the module independently of them.

#### Scenario: Pierre is not eagerly bundled
- **WHEN** the application boots
- **THEN** the `@pierre/diffs` module is not part of the eager initial bundle and is only ever loaded via dynamic import

#### Scenario: Prewarm loads Pierre before the first Diff render
- **WHEN** the session is in a git workspace and the browser reaches idle after boot, or the user hovers or focuses the Diff segment
- **THEN** the `@pierre/diffs` module and highlighter MAY begin loading before any Diff render is requested
- **AND** a subsequent first Diff render reuses that in-flight or completed load rather than starting a new one

#### Scenario: Pierre is loaded once on the first Pierre-path Diff render
- **WHEN** a user activates the Diff view for a file with a normal-sized diff and no prewarm has run
- **THEN** the `@pierre/diffs` module is dynamically imported

#### Scenario: Subsequent Pierre-path renders reuse the cached module
- **WHEN** a user activates the Diff view for additional files after the first load
- **THEN** no second dynamic `import("@pierre/diffs")` is observed

#### Scenario: Fallback paths do not load Pierre
- **WHEN** the Diff view renders an `unsupported-no-git`, `unchanged`, `binary`, or large-diff fallback card
- **THEN** that render does not itself trigger the dynamic import of `@pierre/diffs`

### Requirement: Diff view auto-refreshes when the active file changes on disk

The Diff view SHALL re-fetch the document-diff endpoint and re-render against the unchanged base whenever the active file changes on disk. This behavior is uniform across the application — there is no Mode-dependent variant — and matches the auto-refresh behavior of the Rendered and Source views. The base ref MUST NOT be re-resolved on a file-content change alone — base resolution happens at fetch time and is not invalidated by worktree changes.

#### Scenario: Diff view auto-refreshes on file change
- **WHEN** the Diff view is active for a file
- **AND** the underlying file changes on disk
- **THEN** the Diff view re-fetches the document-diff endpoint and re-renders without user action

#### Scenario: Base ref is not re-resolved on file-content changes
- **WHEN** the Diff view is active for a file
- **AND** the underlying file changes on disk
- **THEN** the system does NOT re-run base-ref resolution
- **AND** the re-rendered Diff continues to compare against the same base that was resolved at fetch time

### Requirement: Diff view selection is not captured by the Selection Inspector

The Diff view SHALL NOT produce `@path#L<a>-<b>` references via the Selection Inspector pane. The whole-file source `<pre>` distinguishing class (used by single Source view and the Source pane of split layouts) MUST NOT appear on Diff-view DOM, so the existing Selection Inspector detection treats Diff selections as non-source. The Selection Inspector's existing hint ("Switch to Source view to capture a line range.") MAY appear when text is selected in Diff view; no Diff-specific hint is required.

#### Scenario: Selecting text in Diff view does not produce a line-range reference
- **WHEN** the user has the Diff view active for a file
- **AND** marks a contiguous run of text inside the rendered diff
- **THEN** the Selection Inspector does not produce an `@path#L<a>-<b>` reference

#### Scenario: Diff view DOM omits the source-pre distinguishing class
- **WHEN** the Diff view is rendered for any document
- **THEN** the preview body does not contain a `<pre>` element carrying the whole-file source-view distinguishing class

### Requirement: Diff view exposes a Unified / Split layout toggle inside the diff body

The Diff view SHALL render a two-segment toggle inside the diff host that switches Pierre's internal diff layout between **Unified** (stacked: deletions above additions, classic git-diff shape) and **Split** (side-by-side: deletions left, additions right). The toggle SHALL use the same in-content segmented-pill visual primitive as the inline layout chooser, so all in-body segmented controls in the app read as one primitive. The user's choice SHALL be a single global preference, persisted to `localStorage` under a key distinct from `uatu:view-mode` and `uatu:view-layout`, defaulting to **Unified** on first visit. Clicking a segment MUST update the persisted preference immediately and MUST re-render the active Diff in place using the cached payload — no network round-trip, no full document reload. The toggle SHALL appear only when Pierre's render path is taken (i.e. not on the state-card fallback paths nor the lightweight large-diff fallback, which have no notion of unified-vs-split). The toggle SHALL NOT appear outside the Diff view.

#### Scenario: First visit defaults to Unified
- **WHEN** the user opens the Diff view for the first time on a fresh `localStorage`
- **AND** the diff renders via Pierre (not a fallback path)
- **THEN** an in-host two-segment toggle is rendered with Unified active and Split inactive

#### Scenario: Clicking Split re-renders the diff in place
- **WHEN** the user clicks the Split segment of the in-host toggle while a diff is rendered
- **THEN** the toggle indicates Split as active
- **AND** the active diff re-renders with Pierre's side-by-side layout using the already-cached payload
- **AND** no new fetch is made against `/api/document/diff`

#### Scenario: Diff-style preference persists across reload
- **WHEN** the user clicks Split
- **AND** reloads the page
- **AND** re-opens the Diff view
- **THEN** the in-host toggle indicates Split as active and the diff renders side-by-side

#### Scenario: Fallback paths do not render the toggle
- **WHEN** the Diff view renders an `unsupported-no-git`, `unchanged`, `binary`, or large-diff lightweight-fallback state
- **THEN** no in-host Unified / Split toggle is rendered

#### Scenario: Toggle does not appear outside the Diff view
- **WHEN** the active view-mode is Rendered or Source for any document
- **THEN** no in-host Unified / Split toggle is rendered

### Requirement: Diff view honors the global Wrap preference

When the diff renders via the Pierre render path, the Diff view SHALL
honor the global Wrap preference by configuring the library's line
overflow mode: wrapping long lines when Wrap is on and scrolling them
horizontally when Wrap is off. The library's own per-line line numbers
SHALL remain correct in both modes. Toggling Wrap MUST re-render the
active diff in place from the already-cached payload — no network
round-trip and no full document reload. On the state-card fallback paths
and the lightweight large-diff fallback (which do not use the library's
line renderer), the Wrap preference MAY have no visible effect.

#### Scenario: Wrap on wraps diff lines
- **WHEN** the diff renders via the Pierre path and the global Wrap preference is on
- **THEN** long diff lines wrap within the available width
- **AND** the library's line numbers remain correct

#### Scenario: Wrap off scrolls diff lines horizontally
- **WHEN** the diff renders via the Pierre path and the global Wrap preference is off
- **THEN** long diff lines scroll horizontally rather than wrapping

#### Scenario: Toggling Wrap re-renders the diff in place
- **WHEN** a diff is rendered via the Pierre path and the user toggles Wrap
- **THEN** the active diff re-renders with the new wrap mode using the cached payload
- **AND** no new fetch is made against the document-diff endpoint

### Requirement: Diff view signals loading while a diff is being prepared

When a diff is requested (view-mode click, compare-target switch, or file selection while Diff is active) and no cached payload is available, the Diff view SHALL provide loading feedback in two layers. First, the Diff segment of the view chooser SHALL enter a visible busy state (including `aria-busy="true"`) immediately when the request starts and leave it when the render completes or fails. Second, if the diff is not fully rendered within a delay threshold (approximately 200 ms), an indeterminate progress indicator SHALL appear over the preview pane without hiding the previously rendered content; once shown, the indicator SHALL remain visible for a minimum display time (approximately 300 ms) to avoid flicker. The preview pane MUST NOT be cleared until the replacement diff content is ready to render — "ready" meaning the payload is in hand and, on the Pierre path, the library and highlighter are loaded. The implementation SHALL yield to the browser paint cycle after showing the loading state and before invoking a potentially long synchronous render, so the busy indication is actually visible during the render.

#### Scenario: Fast diffs show no pane indicator
- **WHEN** a user activates the Diff view and the payload arrives and renders within the delay threshold
- **THEN** no pane-level progress indicator is shown
- **AND** the previous view's content remains visible until the diff replaces it

#### Scenario: Slow diffs show the busy segment and the pane indicator
- **WHEN** a user activates the Diff view and preparation exceeds the delay threshold
- **THEN** the Diff segment is in a busy state from the moment of the click
- **AND** an indeterminate indicator appears over the preview pane while the previous content stays visible underneath
- **AND** both clear when the diff renders

#### Scenario: The pane is not blanked while the diff library loads
- **WHEN** the first Pierre-path diff of a session is prepared and the library and highlighter are still loading
- **THEN** the preview pane retains its previous content until the render is ready to begin

#### Scenario: All diff triggers share the loading feedback
- **WHEN** a diff fetch is triggered by a compare-target switch or by selecting another file while the Diff view is active
- **THEN** the same busy-segment and delay-gated indicator behavior applies

### Requirement: Diff view skips grammar highlighting above a size threshold

The Diff view SHALL define an exported byte threshold (`DIFF_MAX_HIGHLIGHT_BYTES`) below the existing `DIFF_MAX_BYTES` / `DIFF_MAX_LINES` cutoffs. When a text diff's size (patch bytes, plus blob sizes when blobs are present) meets or exceeds this threshold while remaining under the Pierre cutoffs, the Diff view SHALL still render via `@pierre/diffs` — preserving diff structure, word-level diffing, expand-context chevrons, the Unified / Split toggle, and Wrap behavior — but SHALL force the plaintext language so no grammar tokenization runs. A one-line notice SHALL explain that syntax highlighting was disabled for size, consistent with the existing lightweight-fallback notice. The threshold SHALL be exported as a module-level constant overridable from tests.

#### Scenario: A large-but-renderable diff renders via Pierre without grammar highlighting
- **WHEN** the diff endpoint returns a text payload whose size meets the highlight threshold but stays under the Pierre cutoffs
- **THEN** the diff renders via `@pierre/diffs` with the plaintext language
- **AND** word-level diffing, chevrons, and the Unified / Split toggle remain functional
- **AND** a one-line notice explains that highlighting was disabled

#### Scenario: Diffs under the highlight threshold keep syntax highlighting
- **WHEN** the diff endpoint returns a text payload under the highlight threshold
- **THEN** the diff renders with syntax-aware highlighting as before

### Requirement: Document-diff endpoint runs repo-wide rename detection only for pure-addition patches

The document-diff endpoint SHALL obtain the file-scoped diff first and SHALL run repo-wide rename detection (`git diff -M --name-status` without a path filter) only when that file-scoped patch presents the file as a pure addition (or when the patch is empty for an untracked-looking file) — the only cases in which a rename can masquerade as an add. When the scan identifies a prior path, the endpoint SHALL re-run the file-scoped diff with both paths so the response still carries a single rename diff with `oldPath` populated. Requests for ordinary modified files MUST NOT execute a repo-wide diff scan.

#### Scenario: Modified files skip the repo-wide scan
- **WHEN** a request is made for a tracked file whose file-scoped patch contains both old and new sides
- **THEN** no repo-wide `git diff --name-status` is executed for that request

#### Scenario: Renamed files still surface as renames
- **WHEN** a request is made for a file that was renamed since the review base
- **THEN** the file-scoped patch initially presents as a pure addition, the repo-wide scan runs, the prior path is found
- **AND** the response carries a single rename diff with `oldPath` populated

### Requirement: Document-diff endpoint reuses cached base resolution while HEAD is unchanged

The document-diff endpoint SHALL cache the resolved review base and review settings per repository root and reuse them for subsequent requests, validating the cache with a single cheap probe of the repository's current `HEAD` commit. When `HEAD` has moved, or a bounded time-to-live (approximately 30 seconds) has elapsed, the endpoint SHALL re-resolve from scratch. A warm request MUST NOT re-execute the full base-resolution chain (toplevel discovery, settings load, remote-default lookup, ref existence probes, merge-base).

#### Scenario: Consecutive diff requests reuse the resolved base
- **WHEN** two diff requests for files in the same repository arrive while `HEAD` is unchanged and within the TTL
- **THEN** the second request reuses the cached settings and resolved base
- **AND** executes at most one git probe for cache validation before the file-scoped diff

#### Scenario: A new commit invalidates the cached base
- **WHEN** `HEAD` changes between two diff requests for the same repository
- **THEN** the second request re-resolves the review base from scratch
