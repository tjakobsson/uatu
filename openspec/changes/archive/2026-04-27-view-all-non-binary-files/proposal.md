## Why

uatu currently treats only `.md` and `.markdown` files as "documents": the sidebar lists nothing else, follow mode reacts to nothing else, and `uatu watch <path>` rejects anything that isn't a directory or a Markdown file. Real codebases mix Markdown with adjacent text content — YAML configs, source files, Dockerfiles, JSON schemas — and a watcher that observes only Markdown leaves most of the project invisible. Widening the model to "any non-binary file" makes uatu usable as a live preview for whole repositories, not just docs folders, while keeping the existing Markdown experience unchanged.

## What Changes

- Sidebar tree lists every file under each watched root, not just Markdown. Binary files appear in the tree but are non-clickable, with a generic icon.
- Preview pane renders non-Markdown text files as syntax-highlighted code (highlight.js, GitHub light theme) using a new extension → language map. Markdown files continue to render through the existing GFM pipeline unchanged.
- Follow mode, the on-startup default document, and the pin control all widen to operate on any non-binary file (today: Markdown only).
- `uatu watch <path>` accepts any non-binary file path. Binary file paths are still rejected with a clear error.
- New `.uatuignore` file at the watch root: gitignore syntax (including `!` negation) layers user filters on top of the existing hardcoded directory denylist.
- `.gitignore` at the watch root is respected by default. New `--no-gitignore` CLI flag opts out.
- File-size safety: above a threshold (default 1 MB), non-Markdown files render without syntax highlighting to avoid hanging the browser.
- **BREAKING**: change applies to spec-level behavior across multiple existing requirements (browse, render, follow, pin, default document, CLI rejection rule, file-type icon).

## Capabilities

### New Capabilities

None — all changes belong to the existing `document-watch-browser` capability.

### Modified Capabilities

- `document-watch-browser`: widen the supported document set from Markdown-only to any non-binary file; add `.uatuignore` and `.gitignore` filtering with a `--no-gitignore` opt-out; add a syntax-highlighted code render path for non-Markdown text files; add binary detection so the tree lists binary files as non-viewable.

## Impact

- **Source files**: `src/server.ts` (file walk, watcher ignored function, CLI parsing, single-file path validation), `src/markdown.ts` (export `highlightSource` or add a code-only render entry point), `src/shared.ts` (`DocumentMeta` gains a `kind: "text" | "binary"` discriminator), `src/app.ts` (sidebar disabled state, render dispatch by kind), `src/file-icons.ts` (extension-keyed language and icon entries), `src/cli.ts` (the new flag).
- **New dependency**: `ignore` npm package (~20 kB, zero deps, MIT) for gitignore-syntax matching.
- **Tests**: existing `src/server.test.ts`, `src/markdown.test.ts`, `src/shared.test.ts` need new cases; Playwright E2E tree and preview tests need cases for non-Markdown files and binary entries.
- **Spec**: `openspec/specs/document-watch-browser/spec.md` — multiple requirements modified, several new requirements added (filter resolution, code render path, binary detection).
- **README**: documents `.uatuignore`, `--no-gitignore`, the widened watch model.
- **Static asset fallback**: unchanged. Document rendering and asset serving stay orthogonal.
