## Purpose

Define the Diff view in the preview pane: a third view-mode (alongside Rendered and Source) that renders the active file's git diff against a resolved review base, with intelligent payload shaping, lazy library loading, graceful degradation for non-git/unchanged/binary/large cases, and an in-host Unified / Split layout toggle.
## Requirements
### Requirement: Diff view is sourced from a dedicated document-diff endpoint

The server SHALL expose `GET /api/document/diff?id=<absolutePath>` returning a discriminated JSON diff against the resolved review base. It MUST validate watched-file identity before Git execution and support text, unchanged, binary, and non-Git outcomes.

#### Scenario: Diff requests carry bounded content and path-safe Git results
- **WHEN** a document diff is requested
- **THEN** the endpoint MUST validate that its id resolves to a watched file before Git execution, matching document-rendering path safety
- **AND** the payload SHALL include the relevant resolved base ref and kind `text` (unified patch, byte size, added/deleted line counts), `unchanged`, `binary`, or `unsupported-no-git`
- **AND** text MAY include full base/worktree blobs as `oldContents`/`newContents` and renamed `oldPath` when both fit the per-blob cap, enabling @pierre/diffs two-blob input and arbitrary "N unmodified lines" context expansion
- **WHEN** either blob exceeds the cap
- **THEN** both blob fields SHALL be omitted and the client SHALL render patch-only

#### Scenario: Git execution handles renames, additions, and non-Git roots
- **WHEN** the endpoint obtains the watched file's diff
- **THEN** it SHALL use `git diff -M` for single rename hunk pairs rather than add/delete pairs
- **AND** an empty patch for an on-disk untracked file SHALL fall back to `git diff --no-index /dev/null <path>` to show an addition, not unchanged
- **AND** a non-Git workspace MUST NOT produce 404; it SHALL return `unsupported-no-git` for the muted client card

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

For `unsupported-no-git`, `unchanged`, or `binary`, Diff SHALL replace diff content with one explanatory muted preview-body card, without loading or invoking `@pierre/diffs`, and SHALL keep Diff selected.

#### Scenario: State cards explain the exact non-text outcome
- **WHEN** the active file returns a non-text diff kind
- **THEN** `unsupported-no-git` MUST identify no Git history; `unchanged` MUST identify no changes against the resolved base and SHALL display that ref; `binary` MUST identify a changed binary and SHALL display the ref
- **AND** the Diff segment SHALL remain selected so leaving requires no toggle reactivation

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

Text patches exceeding `DIFF_MAX_BYTES` (default 256 KB) or `DIFF_MAX_LINES` (default 5 000 added plus deleted lines) SHALL use a lightweight escaped-HTML `<pre>` render instead of syntax highlighting or `@pierre/diffs`. Both cutoffs SHALL be exported module-level Diff constants, tunable and overridable from tests.

#### Scenario: Oversized patches retain classified lines and explain reduced rendering
- **WHEN** a patch with `kind: "text"` exceeds either configured patch cutoff
- **THEN** the lightweight emitter SHALL distinguish added `+`, deleted `-`, context, and `@@…@@` hunk-header lines through background and prefix styling without syntax highlighting or Pierre calls
- **AND** fixed-size chunks SHALL use `content-visibility: auto` and an intrinsic-size hint to skip offscreen layout/paint
- **AND** a one-line notice above or alongside MUST explain disabled highlighting
- **AND** both cutoffs SHALL be exported module-level Diff constants, tunable and overridable by tests

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

Diff SHALL initialize at most one Shiki highlighter per browser session and reuse it for all `@pierre/diffs` renders. Creation SHALL be lazy or explicitly prewarmed when Diff is plausibly imminent, never triggered by fallback render paths.

#### Scenario: Lazy highlighting reuses its instance and loaded grammars
- **WHEN** the first Pierre render needs highlighting or prewarm finds Diff plausibly imminent
- **THEN** the highlighter SHALL be created lazily or by that prewarm, never by fallback rendering itself
- **WHEN** any subsequent diff renders, including through view-mode toggles, file switches, or in-place refreshes
- **THEN** they MUST NOT recreate the highlighter or reload grammars already cached
- **AND** the cached instance MAY load additional grammars on demand for a new language

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

`@pierre/diffs` SHALL load only through dynamic `import()`, not eager initial-bundle imports, and SHALL be cached for the session. Only a Pierre render or explicit imminent-use prewarm SHALL initiate loading.

#### Scenario: Pierre loading follows actual need or explicit prewarm
- **WHEN** a first Pierre render needs output or an explicit prewarm is invoked because Diff rendering is plausibly imminent
- **THEN** Pierre SHALL load through dynamic `import()` and its resolved module SHALL be reused for the session without re-import
- **AND** explicit prewarm may occur at post-boot browser idle where Diff is reachable in a Git workspace, or on hover/focus of the Diff segment
- **WHEN** `unsupported-no-git`, `unchanged`, `binary`, or lightweight large-diff fallback renders
- **THEN** it MUST NOT itself trigger import, though independent prewarm MAY already have loaded Pierre

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

### Requirement: Diff view DOM omits the whole-file source distinguishing class

The whole-file source `<pre>` distinguishing class (used by single Source view and the Source pane of split layouts) MUST NOT appear on Diff-view DOM, so class-keyed consumers (for example the word-wrap control) never treat Diff content as the whole-file source block.

#### Scenario: Diff view DOM omits the source-pre distinguishing class
- **WHEN** the Diff view is rendered for any document
- **THEN** the preview body does not contain a `<pre>` element carrying the whole-file source-view distinguishing class

### Requirement: Diff view exposes a Unified / Split layout toggle inside the diff body

Pierre-path Diff SHALL expose an in-host Unified/Split toggle with one global persisted preference, default Unified. Changing it MUST rerender from cached payload without a network round-trip or full document reload; fallback and non-Diff views SHALL omit it.

#### Scenario: In-host layout choice uses shared styling and independent persistence
- **WHEN** a Pierre-path Diff renders
- **THEN** its two-segment toggle SHALL use the inline layout chooser's in-content segmented-pill primitive
- **AND** Unified SHALL stack deletions above additions in classic Git shape; Split SHALL place deletions left and additions right
- **AND** one global preference SHALL persist in `localStorage` under a key distinct from `uatu:view-mode` and `uatu:view-layout`, defaulting Unified on first visit
- **WHEN** a segment is clicked
- **THEN** persistence MUST update immediately and the active diff MUST rerender in place using cached payload without fetch or full reload
- **AND** state-card and lightweight large-diff fallbacks SHALL omit the toggle, as SHALL every non-Diff view

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

Pierre-path Diff SHALL honor global Wrap through the library's line-overflow mode, preserve correct line numbers, and rerender Wrap changes in place from cached payload without network or full reload.

#### Scenario: Wrap configures Pierre without imposing behavior on fallbacks
- **WHEN** global Wrap is applied to a Pierre diff
- **THEN** long lines SHALL wrap when on and scroll horizontally when off, with the library's per-line numbers correct in both modes
- **WHEN** Wrap is toggled
- **THEN** active Diff MUST rerender from cached payload without network round-trip or full document reload
- **AND** state-card and lightweight large-diff fallback paths, which do not use the library line renderer, MAY show no visible Wrap effect

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

An uncached Diff request SHALL immediately mark the Diff segment busy and show delay-gated pane progress while retaining prior content until the replacement is ready. Rendering SHALL yield to paint so progress is visible.

#### Scenario: Uncached diff preparation exposes stable two-layer progress
- **WHEN** a view-mode click, compare-target switch, or file selection with Diff active requests an uncached payload
- **THEN** the Diff segment SHALL immediately show busy including `aria-busy="true"` until render completes or fails
- **AND** if not fully rendered after approximately 200 ms, an indeterminate pane indicator SHALL overlay rather than hide previous content and remain visible at least approximately 300 ms once shown
- **AND** the pane MUST NOT clear until payload is in hand and, for Pierre, library/highlighter are loaded
- **AND** after showing loading and before potentially long synchronous rendering, implementation SHALL yield to the browser paint cycle so busy state is visible during render

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

Diff SHALL export the test-overridable module-level byte constant `DIFF_MAX_HIGHLIGHT_BYTES` below the existing Pierre cutoffs. Text diffs meeting that threshold but below Pierre cutoffs SHALL use plaintext Pierre rendering with preserved diff interactions and a size explanation.

#### Scenario: Highlight-size calculation preserves Pierre interactions without tokenization
- **WHEN** patch bytes plus any blob sizes meet or exceed `DIFF_MAX_HIGHLIGHT_BYTES` but remain under `DIFF_MAX_BYTES` / `DIFF_MAX_LINES`
- **THEN** `@pierre/diffs` SHALL force plaintext with no grammar tokenization, preserving diff structure, word-level diffing, expand-context chevrons, Unified/Split, and Wrap
- **AND** a one-line notice SHALL explain disabled highlighting for size, consistent with lightweight fallback
- **AND** the byte threshold SHALL be an exported module-level constant below the existing cutoffs and overridable by tests

#### Scenario: A large-but-renderable diff renders via Pierre without grammar highlighting
- **WHEN** the diff endpoint returns a text payload whose size meets the highlight threshold but stays under the Pierre cutoffs
- **THEN** the diff renders via `@pierre/diffs` with the plaintext language
- **AND** word-level diffing, chevrons, and the Unified / Split toggle remain functional
- **AND** a one-line notice explains that highlighting was disabled

#### Scenario: Diffs under the highlight threshold keep syntax highlighting
- **WHEN** the diff endpoint returns a text payload under the highlight threshold
- **THEN** the diff renders with syntax-aware highlighting as before

### Requirement: Document-diff endpoint runs repo-wide rename detection only for pure-addition patches

The endpoint SHALL obtain a file-scoped diff first and run repository-wide rename detection only for pure additions or empty untracked-looking patches. Ordinary modified-file requests MUST NOT execute a repository-wide diff scan.

#### Scenario: Rename fallback scans only addition-shaped candidates
- **WHEN** a file-scoped patch is a pure addition or empty for an untracked-looking file, where a rename can masquerade as an addition
- **THEN** the endpoint SHALL run `git diff -M --name-status` without a path filter
- **AND** if it finds a prior path it SHALL rerun the file-scoped diff with both paths, returning one rename diff with `oldPath` populated

#### Scenario: Modified files skip the repo-wide scan
- **WHEN** a request is made for a tracked file whose file-scoped patch contains both old and new sides
- **THEN** no repo-wide `git diff --name-status` is executed for that request

#### Scenario: Renamed files still surface as renames
- **WHEN** a request is made for a file that was renamed since the review base
- **THEN** the file-scoped patch initially presents as a pure addition, the repo-wide scan runs, the prior path is found
- **AND** the response carries a single rename diff with `oldPath` populated

### Requirement: Document-diff endpoint reuses cached base resolution while HEAD is unchanged

The endpoint SHALL cache review base and settings per repository root, validating reuse with one cheap current-`HEAD` probe. `HEAD` movement or an approximately 30-second TTL SHALL force fresh resolution.

#### Scenario: Warm base resolution skips the expensive chain
- **WHEN** a cached root has unchanged `HEAD` and an unexpired bounded approximately 30-second TTL
- **THEN** review base/settings SHALL be reused with a single cheap current-`HEAD` probe
- **AND** the warm request MUST NOT rerun toplevel discovery, settings load, remote-default lookup, ref-existence probes, or merge-base
- **AND** moved `HEAD` or elapsed TTL SHALL trigger resolution from scratch

#### Scenario: Consecutive diff requests reuse the resolved base
- **WHEN** two diff requests for files in the same repository arrive while `HEAD` is unchanged and within the TTL
- **THEN** the second request reuses the cached settings and resolved base
- **AND** executes at most one git probe for cache validation before the file-scoped diff

#### Scenario: A new commit invalidates the cached base
- **WHEN** `HEAD` changes between two diff requests for the same repository
- **THEN** the second request re-resolves the review base from scratch

### Requirement: Diff view renders the active file's git diff against the resolved compare base

The preview pane SHALL expose Diff for only the selected file's hunks against the active compare target. Normal-sized diffs SHALL use the vanilla-JS `@pierre/diffs` entry with blob or patch input; normal Source and Rendered views SHALL NOT invoke Pierre.

#### Scenario: Compare targets select the review base without unrelated hunks
- **WHEN** compare target is `base`
- **THEN** the base SHALL resolve automatically in order `origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`, falling back to staged/unstaged changes against `HEAD` when no remote base resolves
- **WHEN** target is `last-commit`
- **THEN** selected-file comparison SHALL be against `HEAD` for staged/unstaged changes
- **AND** only selected-file hunks SHALL render, never unrelated repository files

#### Scenario: Pierre inputs control available context expansion
- **WHEN** payload carries `oldContents` and `newContents`
- **THEN** the client SHALL feed them as `oldFile` / `newFile`, enabling "N unmodified lines" chevrons to expand surrounding blob context
- **WHEN** blobs are absent because the per-blob cap was exceeded
- **THEN** the client SHALL parse unified `patch` through Pierre's patch-input API and feed resulting metadata; chevrons still render but expansion is bounded by Git's embedded patch context

#### Scenario: A modified Markdown file shows added and deleted lines against the resolved base
- **WHEN** a user selects a Markdown file that has been modified against the resolved base
- **AND** the active compare target is `base`
- **AND** activates the Diff view
- **THEN** the preview body renders only that file's diff, with added and deleted lines visually distinguished

#### Scenario: A modified source file shows the file's diff
- **WHEN** a user selects a `.ts` file that has been modified against the resolved base
- **AND** the active compare target is `base`
- **AND** activates the Diff view
- **THEN** the preview body renders only that file's diff with syntax-aware highlighting

#### Scenario: Diff view follows the last-commit compare target
- **WHEN** the active compare target is `last-commit`
- **AND** a user activates the Diff view for a file with both committed-since-base and uncommitted changes
- **THEN** the rendered diff shows only the file's staged and unstaged changes against `HEAD`
- **AND** the diff does not include changes already committed between the resolved base and `HEAD`

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

### Requirement: Diff view follows only repository changes that can affect the active diff
Repository updates SHALL refresh active Diff only when they can affect it. Unrelated updates MUST NOT refetch, rerender, or show Diff loading; active-file disk-change refresh remains unaffected.

#### Scenario: Repository invalidation is limited to diff-relevant facts
- **WHEN** a repository update is received
- **THEN** active Diff SHALL refetch only for changed active-file entry in changed-files context, changed resolved compare base, moved `HEAD`, or changed `.gitattributes` (which controls Git diff behavior)
- **AND** other updates MUST NOT refetch, rerender, or show loading, without changing active-file-on-disk refresh behavior

#### Scenario: Another file changes
- **WHEN** the Diff view is active for file A
- **AND** a repository update reflects a change to file B only
- **THEN** file A's diff is neither re-fetched nor re-rendered
- **AND** the Diff loading indicator does not appear

#### Scenario: A commit moves HEAD
- **WHEN** the Diff view is active for a file
- **AND** a repository update reports that `HEAD` moved
- **THEN** the Diff view re-fetches and re-renders the file's diff

#### Scenario: The compare base moves
- **WHEN** the Diff view is active for a file
- **AND** a repository update reports a different resolved compare base
- **THEN** the Diff view re-fetches and re-renders the file's diff against the new base

#### Scenario: Attributes change how the file is diffed
- **WHEN** the Diff view is active for a file
- **AND** a `.gitattributes` file changes
- **THEN** the Diff view re-fetches and re-renders the file's diff

#### Scenario: The active file's change entry changes
- **WHEN** the Diff view is active for a file
- **AND** a repository update changes that file's entry in the changed-files context, for example after staging or a rename
- **THEN** the Diff view re-fetches and re-renders the file's diff
