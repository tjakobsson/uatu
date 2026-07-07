## ADDED Requirements

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

## MODIFIED Requirements

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
