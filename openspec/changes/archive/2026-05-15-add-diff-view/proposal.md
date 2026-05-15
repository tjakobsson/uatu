## Why

UatuCode is geared toward observing what changes during an active coding session, but the preview today only shows a file's whole content (Rendered or Source). To tell what an AI assistant or a teammate just modified, the reviewer has to leave the app and run `git diff` in a terminal — or scroll the Source view and guess. A dedicated **Diff view** brings the change itself into the preview, scoped to the file being inspected, so reviewers can stay inside the watch UI for the loop they already do most: "what did this file just become?"

A built diff renderer is non-trivial (intraline diff, syntax-aware tokenization, large-file handling) and we should not reinvent it. `@pierre/diffs` is a focused open-source library built on Shiki that already covers split / stacked / inline layouts, intraline highlighting, and merge-conflict primitives — and it ships a vanilla-JS variant compatible with our `<article id="preview">` element. Adopting it for **diff rendering only** lets us add a Diff view without touching the existing fast Rendered / Source render paths.

## What Changes

- Add a third preview view, **Diff**, that renders the active file's git diff against the resolved review base (the same base the review-burden meter already resolves: configured `review.baseRef` → `origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`, falling back to worktree changes against `HEAD`).
- Extend the existing Source / Rendered toggle to a three-segment control:
  - For **Markdown / AsciiDoc** documents the available views are **Rendered**, **Source**, **Diff**.
  - For **text / source** documents the available views are **Source**, **Diff** (no Rendered, matching today's behavior where the toggle is hidden).
- Use **`@pierre/diffs` only for actual git diff rendering**. Rendered Markdown / Rendered AsciiDoc continue to use markdown-it / Asciidoctor as today. Source view continues to use the existing `renderCodeAsHtml` + `attachLineNumbers` path. Pierre is **not** in the hot path of normal source rendering.
- Add a new server endpoint `GET /api/document/diff?id=<absolutePath>` that returns the unified diff for the file against the resolved review base, plus enough metadata for the client to choose a render strategy (kind: `text` / `binary` / `unchanged` / `unsupported-no-git`, base ref, added / deleted line counts, byte size of the diff).
- The Diff view degrades gracefully:
  - **Non-git workspace** (uatu started with `--force` on a folder without a git worktree, or git unavailable): the Diff segment is shown but rendered as a single muted state inside the preview — "No git history available" — rather than hidden, so the control set stays consistent.
  - **No changes** for the file against the base: render a muted "No changes against `<base>`" state.
  - **Binary files**: render "Binary file changed against `<base>`" (no attempt to feed the binary to Pierre).
  - **Very large diffs** (above a configured size cutoff): fall back to a lightweight render path that emits a plain escaped-HTML diff (no syntax highlighting, no intraline) with a one-line notice explaining why, so the preview never locks up the browser.
- Cache and reuse a **single Shiki highlighter instance** across diff renders for the languages we actually use, instead of creating one per render. The highlighter is initialized lazily on the first Diff view and re-used for every subsequent diff render in the session.
- Persist the user's view choice using the **existing** `uatu:view-mode` storage key, extended from `"source" | "rendered"` to `"source" | "rendered" | "diff"`. Default stays `rendered` for Markdown / AsciiDoc and `source` for text files (since they have no Rendered). Persistence is global, like today.
- Add `@pierre/diffs` to runtime dependencies (`bun i @pierre/diffs`) — first new client-side rendering dependency since `@pierre/trees`.

Review-mode **split layouts that pair Diff with Rendered or Source** (`Rendered | Diff`, `Source | Diff`) are **out of scope** for this change. Split today is `Source | Rendered`; extending the layout chooser is a possible follow-up once the single-pane Diff view is stable.

## Capabilities

### New Capabilities

- `document-diff-view`: a per-document Diff view rendered with `@pierre/diffs` against the resolved review base, with graceful states for non-git, unchanged, binary, and very-large diffs, plus a Shiki highlighter cached and reused across renders.

### Modified Capabilities

- `document-source-view`: the Source / Rendered toggle becomes a three-segment view chooser with a **Diff** segment. For text / source files the chooser is now visible (Source / Diff) instead of hidden. The `uatu:view-mode` storage key is extended to include `"diff"`. Split layouts (`single` / `split-h` / `split-v`) remain `Source | Rendered` only — adding a Diff axis is deferred.

## Impact

- **Dependencies**: add `@pierre/diffs` (and any peer deps it pulls — `shiki` is the documented runtime peer). `bun i @pierre/diffs`. License must be MIT or compatible — verified by the existing `bun run check:licenses` audit before merge.
- **Server (`src/server.ts`, new `src/document-diff.ts`)**: new diff endpoint, plus a helper that resolves the review base and runs `git diff <base>... -- <path>` (or `git diff -- <path>` worktree fallback) inside the document's repository. Reuses `safeGit` and the base-ref resolution already in `src/review-load.ts`.
- **Client (`src/app.ts`)**: extend the view toggle to three segments, extend `appState.viewMode` to include `"diff"`, add a Diff builder that calls into a new `src/document-diff-view.ts` module which owns the `@pierre/diffs` import, the cached Shiki highlighter, and the fallback (large-diff / non-git / binary / unchanged) rendering. The `documentViewCache` gains a `diff` slot.
- **Markup (`src/index.html`)**: a third segment in `#view-control`.
- **Styles (`src/styles.css`)**: rules for the Pierre diff host (target the Pierre Shadow DOM CSS variables so the diff matches the GitHub-light visual language already used by Rendered and Source views) plus the fallback states' muted-card styling.
- **Selection Inspector**: unaffected. Diff view does not produce `@path#L<a>-<b>` references; the inspector's existing "switch to Source view" hint already covers the case where the active view doesn't support line capture.
- **Mode interactions**: Diff is available in both **Author** and **Review** modes. The stale-content hint in Review applies to Diff the same way it applies to Source / Rendered — when the underlying file changes on disk, the hint offers a refresh that re-fetches the diff against the unchanged base.
- **Tests**: unit coverage for diff endpoint behavior (non-git / unchanged / binary / large), client-side coverage for the three-segment toggle visibility per kind, Playwright E2E for the Diff view happy path on a known fixture file, plus a smoke test that re-using the cached Shiki highlighter across multiple renders does not regress.
- **Benchmarks**: `bun run bench:render` gains a Diff scenario for the existing render-benchmark fixtures so we have a local baseline for Pierre's render cost.
- **No removed features.** Rendered and Source paths remain byte-identical for non-Diff views; existing scenarios in `document-rendering` and `document-source-view` continue to pass.

### Scope additions discovered during implementation

Captured here so the archived proposal matches what shipped:

- **Inline layout chooser, not header.** The layout chooser (Single / Side by side / Stacked) was moved from a control inside the preview-header pill to an inline segmented pill rendered above the document body in `.preview-shell`, mirroring the new in-host Diff toolbar. The header now hosts only the view chooser (Rendered / Source / Diff). See the updated `Layout chooser in the preview header` requirement.
- **Follow chip relocated to the sidebar mode row.** Follow was previously in the preview-header pill alongside the view chooser; it now sits beside the Author / Review segmented control in the sidebar, on the basis that Follow is a selection-behavior toggle (conceptually a sibling of Mode) rather than a view-of-current-document control. ID and event handler unchanged.
- **In-host Diff layout toggle (Unified / Split).** The Diff view exposes a small Pierre-internal layout toggle inside its host. New `uatu:diff-style` persistence key, new requirement under `document-diff-view`.
- **Two-blob render path for expand-context.** The diff endpoint optionally ships `oldContents` / `newContents` / `oldPath` so Pierre's "N unmodified lines" chevrons can interactively expand surrounding context; per-blob 200 KB cap to bound the wire payload. Falls back to patch-only render above the cap.
- **Untracked-but-on-disk file fallback.** When `git diff` is empty for a path that exists on disk but isn't tracked, the endpoint falls back to `git diff --no-index /dev/null <path>` so newly-added files render as additions rather than as a misleading "unchanged" state.
- **In-body toolbars share one visual primitive.** The Diff view's Unified / Split toggle and the layout chooser use the same segmented-pill styling as the header view chooser (`.view-segment` shape values), so all segmented controls in the app read as one primitive.
