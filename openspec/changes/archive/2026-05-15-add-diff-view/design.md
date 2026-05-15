## Context

UatuCode's preview pane today exposes two views for documents that have a non-trivial rendered representation (Markdown, AsciiDoc):

- **Rendered**: parses the source via `renderMarkdownToHtml` (`src/markdown.ts`) or `renderAsciidocToHtml` (`src/asciidoc.ts`) and emits sanitized HTML into `<article id="preview">`.
- **Source**: emits the file's verbatim text as a single `<pre class="uatu-source-pre"><code>` block through `renderCodeAsHtml` (`src/server.ts:583`) with the existing line-number gutter (`attachLineNumbers` at `src/app.ts:1393`).

A two-segment toggle (`#view-control` at `src/index.html:277`, sync logic in `src/app.ts` around `syncViewToggle`) lets the user switch between those views; the preference is persisted to `localStorage` under `uatu:view-mode` (`VIEW_MODE_STORAGE_KEY` in `src/shared.ts:219`). The toggle is **hidden** today for text / source files (where source = rendered), commit views, review-score views, and the empty state.

Git diff data is already used elsewhere in the app — `src/review-load.ts` runs `git diff --numstat` and `git diff --unified=0` to drive the review-burden meter (`collectDiffFiles` at `src/review-load.ts:336`) and resolves a review base ref via the same priority order the meter uses (configured `review.baseRef` → `origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`, falling back to worktree changes against `HEAD`). What is **not** yet exposed is the diff content for a single file.

The split-view change (archived `2026-05-14-add-document-split-view`) introduced a layout chooser (`single` / `split-h` / `split-v`) that lets users see Source and Rendered together. The split machinery, the `documentViewCache`, and the resizer infrastructure are all reusable, but this change deliberately scopes layout extensions out — it adds the **Diff view** as a third single-pane view first, and treats `Source | Diff` / `Rendered | Diff` split modes as a possible follow-up.

`@pierre/diffs` is an open-source library from The Pierre Computer Co. Per the docs at <https://diffs.com/docs>:

- Exports a vanilla-JS entry (`@pierre/diffs`) and a React entry (`@pierre/diffs/react`). We only need the vanilla-JS variant.
- Two primary input shapes for a diff:
  - `parsePatchFiles(patch)` — accepts a unified diff or git patch string. Used when only the patch is available (our case).
  - `parseDiffFromFile(oldFile, newFile)` — needs both blobs. Enables "expand unchanged" interactively.
- A `<FileDiff>` component renders pre-parsed metadata. The library writes to a Shadow DOM and lays out with CSS Grid; it "builds syntax highlighting on top of Shiki."
- Layout / change-style options demonstrated on <https://diffs.com/>: split vs stacked (we want stacked single-pane to start), background-color vs vertical-bar vs inline word-level change styles.
- The library is described as in "early active development" — APIs subject to change.

Shiki is a heavy initializer (loads language grammars and a theme bundle). Creating one per render would burn CPU on the main thread; we need to cache one highlighter instance for the session and reuse it.

## Goals / Non-Goals

**Goals:**

- Let the reviewer see what changed in the currently-previewed file, scoped to the file, without leaving the watch UI.
- Render diffs with intraline / token-aware highlighting that matches the GitHub-light visual language we already use.
- Keep the existing fast Rendered and Source render paths byte-identical — Pierre is only loaded when the user actually opens the Diff view.
- Cache a single Shiki highlighter instance across diff renders.
- Degrade gracefully for non-git workspaces, unchanged files, binary files, and very-large diffs — the preview never locks the browser.
- Make Diff available in both Author and Review modes; the existing stale-content hint in Review covers in-place refresh.

**Non-Goals:**

- Replacing the existing source-code render path with Pierre's `<File>` component. Pierre is for diff rendering only; normal source rendering stays on `renderCodeAsHtml` + `attachLineNumbers`.
- Replacing Markdown / AsciiDoc Rendered output with Pierre. Rendered keeps its existing pipelines.
- Splits that pair Diff with Rendered or Source (`Rendered | Diff`, `Source | Diff`). Deferred — design notes a path but the layout chooser stays two-axis (single / split-h / split-v with Source + Rendered) for this change.
- Per-document view-mode preference. Diff is a global view choice like Source / Rendered.
- Diff against arbitrary refs picked from the UI (commit pickers, branch pickers). Diff is always against the resolved review base (the same one used by the review-burden meter); a future change can add a ref picker.
- "Expand unchanged" interactions that need both file blobs. The first cut feeds Pierre the unified-diff string only.
- Inline editing or comment threads on hunks (Pierre supports it, but uatu has no commenting model).
- A keyboard shortcut for the Diff view. Three-segment radio control is enough; shortcuts can be added later.

## Decisions

### 1. Use Pierre's vanilla-JS entry, not the React entry

UatuCode is plain TypeScript + DOM with no React anywhere. The `@pierre/diffs` (vanilla) entry exposes `FileDiff` and friends as web components / DOM APIs that write into Shadow DOM, which slots cleanly into the preview pane.

**Alternatives considered:**

- *Adopt React just for the diff view*: rejected — adds a runtime, a build path, and a maintenance vector for a single view. Not justified.
- *Roll our own diff renderer on `diff` / `jsdiff`*: rejected — duplicates work Pierre already does well (intraline highlighting via Shiki, merge-conflict primitives, large-file performance shape). The proposal asked us to use Pierre specifically.

### 2. Feed Pierre a unified diff string from a new server endpoint

Pierre exposes two input paths: `parsePatchFiles(patch)` for a unified diff / git patch string, and `parseDiffFromFile(old, new)` for both blobs. We use `parsePatchFiles`.

A new server route `GET /api/document/diff?id=<absolutePath>` runs `git diff <base>... -- <relativePath>` inside the file's repository and returns:

```ts
type DocumentDiffResponse =
  | { kind: "text"; baseRef: string; patch: string; bytes: number; addedLines: number; deletedLines: number }
  | { kind: "unchanged"; baseRef: string }
  | { kind: "binary"; baseRef: string }
  | { kind: "unsupported-no-git" };
```

The endpoint reuses `safeGit` and the base-ref resolver currently in `src/review-load.ts` (refactored into a shared `src/git-base-ref.ts` module so both the meter and the diff endpoint share one implementation). When the file's containing repo can't be resolved or git is unavailable, the endpoint returns `{ kind: "unsupported-no-git" }` rather than 404 — the client uses it to render the muted fallback state.

**Why a unified-diff string and not the two file blobs:**

- `parsePatchFiles` requires one round-trip; `parseDiffFromFile` requires two file fetches plus client-side diffing in a Pierre worker. For our scope (single-file diff against an already-resolved base) the unified-diff string is sufficient and ~half the bytes over the wire.
- "Expand unchanged" is an interactive feature that needs both blobs. We mark it as a future enhancement — when we want it, we add `?withBlobs=1` to the same endpoint.

### 3. Single layout, "stacked" (unified) by default

Pierre supports split (side-by-side old / new) and stacked (unified). Stacked matches the single-pane preview body and reads more like a `git diff` output, which is the mental model users already have. Split inside a single preview pane competes with the existing global layout chooser — leave split-display-of-the-diff itself as a follow-up.

The Diff view does NOT participate in the existing layout chooser (`single` / `split-h` / `split-v`). The layout chooser keeps showing only when `viewMode === "rendered"` or `viewMode === "source"`; when `viewMode === "diff"`, the layout chooser is hidden (no split orientation makes sense yet, since Diff replaces both panes in a meaningful way).

### 4. Shiki highlighter is a module-level singleton, lazy-initialized

A new module `src/document-diff-view.ts` owns:

- A `let highlighterPromise: Promise<Highlighter> | null = null;` cache.
- `getDiffHighlighter()` that lazily calls Shiki's `createHighlighter({ themes: [<github-light>], langs: [...] })` and returns the cached promise on every subsequent call.
- A small allowlist of pre-loaded grammars covering the file kinds we already syntax-highlight in source view (TS/JS/TSX/JSX, JSON, YAML, Markdown, AsciiDoc, Python, Go, Rust, shell, CSS/HTML, Mermaid is not highlighted). Languages outside the allowlist fall back to Shiki's `plaintext` theme.
- `loadLanguage(highlighter, lang)` only calls `highlighter.loadLanguage(lang)` if it hasn't been loaded yet (Shiki's API is idempotent but the guard avoids a microtask hop per render).

This is the single most important performance decision in this change: never create a highlighter per render, never re-load a language that's already loaded.

**Alternatives considered:**

- *A new highlighter per render*: rejected — Shiki initialization is in the tens-of-MS range and dominates the diff render budget.
- *Reuse `highlight.js` (already a dependency) instead of Shiki*: rejected — Pierre is built on Shiki and reusing highlight.js would require an adapter; the duplication is worse than carrying both libraries.

### 5. Performance cutoffs: byte size and line count, with a lightweight fallback

The Diff view applies two cutoffs before deciding which renderer to use:

| Signal | Threshold | Behavior |
|---|---|---|
| Patch byte size | ≥ 256 KB | Skip Pierre. Render an escaped-HTML diff (lines prefixed with `+`, `-`, ` `) inside the existing `<pre class="uatu-diff-fallback-pre">` styling, with a one-line notice "Large diff — rendered without syntax highlighting." |
| Total changed lines (added + deleted) | ≥ 5 000 | Same fallback as above. |
| Detected `kind: "binary"` | n/a | Render the muted "Binary file changed against `<base>`" card. No Pierre. |
| Detected `kind: "unchanged"` | n/a | Render the muted "No changes against `<base>`" card. No Pierre. |
| Detected `kind: "unsupported-no-git"` | n/a | Render the muted "No git history available" card. No Pierre. |

Both numeric thresholds are exported constants in `src/document-diff-view.ts` (`DIFF_MAX_BYTES`, `DIFF_MAX_LINES`) so they can be tuned without a code archaeology trip, and so tests can override them. The cutoffs are deliberately conservative on the first cut — we can lower them once we have local benchmark data.

The lightweight fallback uses our own escaped-HTML emitter, not Pierre. Lines starting with `+` use the existing `--diff-added-bg` token, `-` the `--diff-deleted-bg` token, ` ` and `@@…@@` headers use the existing source-view neutral background. This path is cheap enough (linear in line count, no syntax grammar) that even multi-megabyte diffs render in a few ms.

**Alternatives considered:**

- *Let Pierre render everything and trust its worker pool (`@pierre/diffs/worker`)*: rejected for v1 — adds a worker entry to our bundling story and we don't have a benchmarked threshold yet. Keep it as an option for a future "render very large diffs in a worker" change if the fallback proves too austere.
- *Use line count only, ignore bytes*: rejected — pathological diffs (one mega-long line) bypass a line-count check.

### 6. Lazy dynamic import of Pierre, not a top-level import

`@pierre/diffs` is imported via `await import("@pierre/diffs")` the first time the Diff view actually needs to render Pierre output (i.e. not the fallback path). This:

- Keeps the initial JS bundle small for the (still common) case where the user never opens the Diff view in a session.
- Means non-git workspaces never load Pierre at all (the endpoint short-circuits to `unsupported-no-git` and the fallback card renders without touching Pierre).
- Plays well with `bun build` — Bun's static analysis treats dynamic `import()` as a code-split point.

Cache the resolved module the same way we cache the highlighter:

```ts
let pierreModulePromise: Promise<typeof import("@pierre/diffs")> | null = null;
function getPierre() {
  return pierreModulePromise ??= import("@pierre/diffs");
}
```

### 7. Three-segment toggle, kind-aware visibility

`#view-control` becomes a three-segment radiogroup: `Rendered | Source | Diff`. Visibility per document kind:

| Kind | Segments shown |
|---|---|
| Markdown | Rendered, Source, Diff |
| AsciiDoc | Rendered, Source, Diff |
| Text / source (`.ts`, `.py`, `.json`, …) | Source, Diff (Rendered hidden — same as today's behavior of hiding the whole toggle for source files; now we show the chooser because Diff makes it meaningful) |
| Binary | None (preview is "unavailable") |
| Commit / review-score / empty | None |

A small helper `availableViewModes(payload)` returns the allowed set; `syncViewToggle` reads it and hides the unsupported segments. The persisted preference is honored when valid for the kind; if not (e.g. preference is `rendered` but kind is text/source), the chooser falls back to the first available segment (Source for text, Rendered for Markdown/AsciiDoc) without writing back to localStorage — same pattern the existing Source / Rendered logic uses today.

### 8. Persistence: extend `uatu:view-mode` to include `"diff"`

`VIEW_MODE_STORAGE_KEY` stays `uatu:view-mode`. The `ViewMode` type widens from `"source" | "rendered"` to `"source" | "rendered" | "diff"`. `isViewMode` and `readViewModePreference` are updated to accept the new value. Old values stored in localStorage by previous versions continue to parse correctly (they were already in the new set).

No migration is needed — adding a third value is forward-compatible with any older read path.

### 9. DOM shape: `#preview` hosts a single Diff container in Diff view

In Diff view, `<article id="preview">` contains exactly one child: `<div class="uatu-diff-host">` that owns the Pierre Shadow DOM. The host element has its own `overflow: auto` so long diffs scroll within the preview body (matching today's source view scroll model). The pinned preview header (see `document-rendering` "Keep the preview header visible while scrolling") stays unchanged — it sits above `#preview` and is not affected.

For fallback states (`unsupported-no-git`, `unchanged`, `binary`, large-diff), `#preview` contains a single `<div class="uatu-diff-state">` carrying a status icon, the base ref (when applicable), and one line of explanation. The state card matches the visual language of the existing "Document unavailable" / "Preview unavailable" cards.

### 10. Stale-content hint applies to Diff in Review mode

When Mode is Review and the active file changes on disk, the existing stale-content hint already covers the case. In Diff view, "refresh" re-runs the diff endpoint (the base ref is unchanged, the worktree changed). No new behavior is needed beyond pointing the existing refresh handler at the diff endpoint when the active view is Diff.

In Author mode, file changes auto-refresh as today. The diff endpoint is re-fetched on the same change event the existing Rendered / Source refresh listens for.

## Risks / Trade-offs

- **`@pierre/diffs` is "early active development"** → API changes between versions may force code changes. **Mitigation**: pin the exact version in `package.json`, encapsulate Pierre usage behind the single `src/document-diff-view.ts` module so any future API churn touches one file. Bun's lockfile makes the version reproducible across machines.
- **Shiki adds bundle weight** → Shiki's grammar bundles are non-trivial; lazy-loading Pierre + Shiki keeps that out of the cold path. **Mitigation**: dynamic `import()` for Pierre, only load grammars on demand, do not pre-load grammars at app boot. We accept that the first Diff render in a session has a one-time initialization cost; subsequent renders are cheap.
- **Two highlighters in the app** → Source view uses `highlight.js`; Diff view uses Shiki. **Mitigation**: this is a deliberate trade — Source view is the hot path and `highlight.js` is already tuned for it; Shiki is Pierre's required peer. Migrating Source to Shiki is a separate, much bigger conversation. We document the split in the design and accept the temporary duplication.
- **Cross-platform git availability** → uatu is meant to work cross-platform (memory: tooling must be cross-platform). The diff endpoint calls `git` via `safeGit`; on systems without git on PATH it returns `unsupported-no-git` and the fallback card renders. **Mitigation**: no platform-specific code paths in the renderer; the unhappy path is identical on every OS.
- **Renamed / moved files** → `git diff` with `-M` already detects renames; the patch carries both old and new paths. Pierre's `parsePatchFiles` handles standard git patch headers. **Mitigation**: pass `-M` to `git diff`, write a server test that a renamed-file patch parses and renders.
- **Submodule files / files outside any repo's tree** → the file may live in a repo but be untracked, or live in a submodule. **Mitigation**: untracked files diff cleanly against `/dev/null` and render as additions; submodule paths return `unsupported-no-git` (we don't recurse into submodule histories in v1).
- **Bun standalone build packaging** → `@pierre/diffs` and its Shiki peer must end up in the standalone binary produced by `scripts/build.ts`. **Mitigation**: verify the build during implementation; Bun bundles `node_modules` content for dynamic imports it can statically resolve, and our `import("@pierre/diffs")` qualifies.
- **License audit** → `bun run check:licenses` must pass with Pierre and Shiki in dependencies. **Mitigation**: the proposal explicitly gates merge on the audit. If Pierre's license is incompatible, the change does not ship — we revisit before code is written by checking the package manifest as the first task.
- **Diff view in folder-watch sessions that span multiple repos** → uatu can watch multiple roots, each possibly in its own repo. The file's containing repo determines the diff base. **Mitigation**: the endpoint takes the document's absolute path, resolves it to a repo, and runs the diff there; the repo-resolution helper already exists for `change-review-load`.
- **Pierre injects styles into Shadow DOM** → our app's CSS does not reach inside; this is intentional but means theming Pierre is via the variables it documents on its host element. **Mitigation**: a small `.uatu-diff-host { --pierre-...: ... }` rule block in `styles.css` maps our existing GitHub-light tokens onto Pierre's expected variables. If Pierre changes its variable names between minor versions, we adjust this block.

## Migration Plan

No data migration. The `uatu:view-mode` localStorage key already accepts an enum-shaped string; old values (`"source"` and `"rendered"`) stay valid. New value `"diff"` is written only after the user explicitly clicks the Diff segment.

No server migration either — the new endpoint is additive.

Rollout is a single change shipped behind no flag. To rollback we revert the change; persisted `"diff"` values fall back to `DEFAULT_VIEW_MODE` (`"rendered"`) the next time the app reads the preference on an older binary, because `isViewMode` will reject `"diff"` and `readViewModePreference` returns the default.

## Open Questions (resolved during implementation)

- **Exact `DIFF_MAX_BYTES` and `DIFF_MAX_LINES` cutoffs.** Shipped values: 256 KB / 5 000 lines. Bench scenarios in `scripts/bench-render.ts` validated these are not hit by realistic project fixtures.
- **Shiki language allowlist.** Shipped allowlist: TS/JS/TSX/JSX, JSON, YAML, Markdown, AsciiDoc, Python, Go, Rust, shell, CSS, HTML. Languages outside this set fall back to Pierre's `text` plaintext path.
- **Whether to enable Pierre's intraline (word-level) highlighting on by default.** Shipped with `lineDiffType: "word-alt"` (Pierre's word-level intraline). No "too noisy" feedback during smoke; keeping it on.
- **Expand-unchanged behavior with vs without blobs.** Initially tried `expandUnchanged: true` (pre-expand all unchanged regions); dumped the whole file into the view and was rejected. Resolution: leave `expandUnchanged` unset so the diff opens collapsed with "N unmodified lines" chevrons; expansion is interactive and works whenever the server ships blobs (the two-blob render path).
- **Side-by-side diff inside the Diff view.** **Shipped.** Implemented as the in-host Unified / Split toggle (see the corresponding requirement in `specs/document-diff-view/spec.md`). Persisted under `uatu:diff-style`, defaults to Unified, re-renders the active diff in place on toggle.
- **`Rendered | Diff` and `Source | Diff` split modes.** Still deferred — the outer layout chooser remains Single / Side by side / Stacked over Source + Rendered, and the inline layout chooser hides while Diff is the active view-mode. A future change could lift this if the use case becomes pressing.

## Notes added during implementation

- **Layout chooser moved into the preview body.** The chooser is now rendered as an inline `.uatu-layout-toolbar` segmented pill above `#preview` inside `.preview-shell`, not as an icon-only control inside the preview-header pill. Reason: visual harmonization with the new in-host Diff toolbar — both controls now use the same segmented-pill primitive with text labels. The header now hosts only the view chooser (Rendered / Source / Diff).
- **Follow chip moved to the sidebar mode row.** Follow lives next to the Author / Review toggle in the sidebar header, on the basis that both controls describe how the file selection should behave (a sibling of Mode) rather than what the current preview is rendering (a sibling of the view chooser).
- **Untracked-file diff fallback.** When `git diff <ref> -- <path>` returns empty and the path is untracked (verified via `git ls-files --error-unmatch`), the endpoint falls back to `git diff --no-index /dev/null <path>` so newly-added files render as additions instead of "unchanged".
- **Two-blob expand-context path.** The diff endpoint optionally ships `oldContents` / `newContents` / `oldPath` (per-blob cap 200 KB). When present, the client feeds them to Pierre as `oldFile` / `newFile`, unlocking interactive expansion of "N unmodified lines" chevrons. When absent (too large), Pierre falls back to the patch-only `parsePatchFiles` render and chevrons are bounded by the patch's embedded context.
