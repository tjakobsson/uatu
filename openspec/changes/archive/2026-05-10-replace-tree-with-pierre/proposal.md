## Why

uatu's document tree has accreted layered behavior — `.uatuignore` + `.gitignore` + a hardcoded denylist + an All/Changed scope toggle + manual open-state persistence + a 1s-tick mtime label per row + dir-rollup mtime + binary-disabled rows — all rendered through hand-rolled HTML strings in `src/app.ts`. The result is hard to reason about (three filtering sources of truth, two ways to "see what changed") and visibly diverges from the conventions readers expect from VS Code, Finder, and GitHub.

[`@pierre/trees`](https://trees.software) (Apache-2.0, [pierrecomputer/pierre/packages/trees](https://github.com/pierrecomputer/pierre/tree/main/packages/trees)) is a path-first file-tree library whose UX matches what readers already know. We replace our tree wholesale, retreat to a deliberately smaller surface, and re-add uatu-distinctive features (live-mtime, etc.) as separate follow-up changes once we understand the new substrate.

## What Changes

- **BREAKING**: Add `@pierre/trees` (vanilla entry) as a runtime dependency; render the document tree through it instead of `renderNodes()`.
- **BREAKING**: Remove the All/Changed Files-pane toggle. Git status is surfaced as ambient row annotations on a single tree via the library's `setGitStatus(...)`.
- **BREAKING**: Retire `.uatuignore`. Filtering is configured exclusively in `.uatu.json` under a new `tree` block: `tree.exclude: string[]` and `tree.respectGitignore: boolean` (default `true`). Built-in defaults (`node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, etc.) are always applied; `tree.exclude` is additive on top of them.
- **BREAKING**: On startup, if a `.uatuignore` file exists, log a one-line warning pointing users to `.uatu.json` and do not honor it.
- **BREAKING**: Drop the live-ticking mtime label on every row (file leaves and directory rollup). Deferred to a later change.
- **BREAKING**: Drop manual directory open-state persistence and the additive ancestor-reveal semantics. Whatever expansion behavior `@pierre/trees` provides is what we ship.
- **BREAKING**: Drop the "binary rows are non-clickable" treatment. Clicking a binary now loads the existing "preview unavailable" pane (matches VS Code).
- Drop the `· N hidden` segment of the sidebar file counter (no more dual filter sources to disclose).
- Keep pinned-document mode (`scope.kind === "file"`) as-is; it is orthogonal to tree filtering.
- Pin `@pierre/trees` to an exact version (currently `1.0.0-beta.3`) and accept upgrade churn.

## Capabilities

### New Capabilities
- `tree-filtering`: One source of truth for which files appear in the tree — built-in defaults plus `.uatu.json tree.exclude` plus optional `.gitignore` honoring. Replaces the multi-source filtering previously split across `ignore-engine.ts`, hardcoded denylists, and `.uatuignore`.

### Modified Capabilities
- `document-tree`: Rendering delegated to `@pierre/trees`. Drops requirements for manual open-state persistence, file-leaf and directory-rollup mtime labels, and binary-disabled rows. Adds a requirement that git status is surfaced as row annotations on a single tree, replacing the All/Changed scope toggle.
- `sidebar-shell`: File counter no longer emits the `· N hidden` segment. The Files pane no longer renders the All/Changed toggle controls.
- `document-watch-index`: Drops `.uatuignore` parsing and matching. Reads filter configuration from `.uatu.json` via the new `tree-filtering` capability.

## Impact

- **Code deleted**: `src/ignore-engine.ts`; `renderNodes`, `shouldDirRenderOpen`, `FOLDER_ICON_SVG`, `renderTreeMtime` and the 1s-tick `setInterval` (~lines 2349–2456 of `src/app.ts`); `FilesView` plumbing and the two toggle buttons in `src/app.ts` (~lines 102–117, 281–283, 1793, 2661, 2677–2678); `.uatuignore` references in `src/file-classify.ts:45`, `src/file-icons.ts:84`, `src/server.ts:1144`, `src/server.ts:1189`, and comments in `src/shared.ts:18` and `src/server.ts:980`.
- **Code added**: An adapter that converts the existing `TreeNode[]` model into the path-array input `@pierre/trees` expects, wires selection events back into the existing document-routing flow, and feeds git status from review-load into the library's annotation API. A `.uatu.json` reader for the new `tree` block.
- **Dependencies**: Adds `@pierre/trees` (pulls in `preact`, `preact-render-to-string`, `@pierre/path-store` transitively). Removes nothing — the existing `ignore` package is retained and used directly for `.gitignore` matching.
- **Configuration**: `.uatu.json` schema gains a `tree` block. The file already exists for terminal-config and review-load; this is an additive schema change.
- **Cross-platform**: All path handling in the new filter logic must use `node:path` and forward-slash normalization at the tree boundary, matching existing uatu conventions; no macOS-only assumptions.
- **CSS**: Existing `.tree-*` selectors in `src/styles.css` become dead and are removed. Theming for `@pierre/trees` is wired through its supported customization hooks.
- **Tests**: Existing tree-rendering tests against the hand-rolled HTML are retired; new tests cover the adapter (path translation, git-status mapping, selection round-trip) and the `.uatu.json` filter loader.
- **Deferred to later changes**: Re-introducing live-mtime visibility (likely as a row annotation or a "recently active" pulse), and re-introducing manual-open persistence with additive ancestor-reveal if the library's defaults prove lossy.
