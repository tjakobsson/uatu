## Why

`document-watch-browser` has grown to 46 requirements / 1420 lines and now covers CLI startup, file watching, sidebar layout, Markdown/AsciiDoc rendering, Mermaid, URL routing, the document tree, metadata cards, and several Mode-specific behaviors. The breadth makes it hard to reason about what is in scope for any given change, hard to map requirements to code modules, and hard to review when only one slice of behavior is moving. Splitting it into focused capabilities is a prerequisite for the upcoming code restructure (Phase 2) — without smaller capabilities, the new `client/` and `server/` folder layout would not have meaningful names to mirror.

## What Changes

- Carve `document-watch-browser` into seven new focused capabilities by moving requirements verbatim — no behavior change, no new requirements, no removals beyond the source capability being emptied.
- Retire `document-watch-browser` once all 46 requirements have been moved out.
- Resolve a small overlap with `change-review-load` (which already owns review-burden computation and bounded commit-log data) by placing the *rendering* of those sidebar panes in `sidebar-shell` and the *URL routing* of commit previews in `document-routing`. The compute side stays in `change-review-load`.

This change is **spec-only**. No code moves, no module renames, no test changes. Phase 2 (a separate change) will restructure code to mirror these capability boundaries.

## Capabilities

### New Capabilities

- `watch-cli-startup`: The `uatu watch` command surface — paths, flags (`--force`, `--no-gitignore`, `--no-open`, `--no-follow`, `--mode`), preflight checks, indexing status, ASCII banner, browser auto-open. (2 requirements moved.)
- `document-watch-index`: Server-side scanning, indexing, and live updates of watched roots — `.uatuignore` and `.gitignore` filtering, binary detection, follow-the-latest-change behavior, and serving adjacent static files. (7 requirements moved.)
- `document-rendering`: How a single document is rendered in the preview — GitHub-style Markdown, AsciiDoc, non-Markdown text as syntax-highlighted code, fenced-block highlighting, line numbers, the copy-to-clipboard control, the preview header (file-type indicator, sticky behavior), and the Review-mode stale-content hint. (9 requirements moved.)
- `mermaid-rendering`: Mermaid diagram rendering, the fullscreen viewer, theme application, and graceful tolerance of invalid diagrams. (4 requirements moved.)
- `document-metadata-card`: The metadata block surfaced above a document body. (1 requirement moved.)
- `document-routing`: URL is the source of truth for navigation — direct document URLs, cross-document anchor clicks, browser back/forward, force-follow-off on direct URLs, and Git Log commit-preview URLs. (6 requirements moved.)
- `document-tree`: The file tree's leaf and directory rows — type icons, folder icons, last-modified time, manual open/closed state, sidebar file-count breakdown. (5 requirements moved.)
- `sidebar-shell`: The sidebar as a chrome — pane composition and resize, sidebar width and collapse, scrollability, the live connection indicator, the build identifier, the Author/Review Mode control (visual treatment, per-Mode pane composition), the All/Changed files toggle, and rendering of the Change Overview and Git Log panes (the data for those comes from `change-review-load`). (12 requirements moved.)

### Modified Capabilities

None via spec deltas. `document-watch-browser` is retired by deleting `openspec/specs/document-watch-browser/` directly as part of this change — OpenSpec's REMOVED delta cannot reduce a capability to zero requirements (validation rejects empty specs), so the folder cleanup happens out-of-band. See the Decommissioning Note in design.md and the per-requirement migration table for which new capability each old requirement moved to.

## Impact

- `openspec/specs/`: One folder removed (`document-watch-browser/`), seven added.
- Code: **none** — this change is intentionally spec-only so the carve can be reviewed and merged without coupling to a code refactor.
- Archived changes referencing `document-watch-browser` by name remain valid — archives are frozen and OpenSpec does not retroactively rewrite them.
- Future changes referencing the old capability will need to target the new ones; this is the expected outcome.
- Phase 2 (separate proposal) will introduce `src/{client,server,shared}/` tier folders aligned to these capability names. Phase 3 (separate proposal) will add light/dark theme support and likely introduce a `theme-and-appearance` capability.
