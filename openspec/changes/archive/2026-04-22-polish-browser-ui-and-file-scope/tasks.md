## 1. Build metadata and version plumbing

- [x] 1.1 Rewrite `src/version.ts` to export a `BUILD` object `{ version, branch, commitSha, commitShort, buildTime }` with a compile-time injection point (`__UATU_BUILD__`) and a dev-run fallback that reads git via `Bun.spawnSync`.
- [x] 1.2 Update `package.json` `build` script to capture git branch/sha/date and pass them to `bun build --compile` via `--define` so the literal is replaced in the compiled binary.
- [x] 1.3 Update `cli.ts` and `server.ts` to consume the new `BUILD` object wherever the bare version is currently used (help text, `--version` output).
- [x] 1.4 Add a `build` field to the `/api/state` payload so the UI can render the badge from state like everything else.
- [x] 1.5 Unit tests in `src/version.test.ts` covering the injected path, the dev fallback, and the git-unavailable fallback (`main@unknown`).

## 2. Startup ASCII banner

- [x] 2.1 Add a `BANNER` constant to `cli.ts` containing the ASCII logo and tagline exactly as proposed.
- [x] 2.2 In `main()`, before printing the URL, print the banner only when `process.stdout.isTTY` is true.
- [x] 2.3 Unit test `printStartupBanner` (extract into `server.ts` or a small helper) with a fake TTY/non-TTY writable stream to confirm banner gating.

## 3. File-path watch scope at the CLI

- [x] 3.1 Change `resolveWatchRoots` to return a tagged union `{ kind: "dir" | "file", absolutePath }[]` after `fs.stat` classification; reject non-Markdown, non-directory inputs with the specified error message.
- [x] 3.2 Teach `scanRoots` to build a single-document `RootGroup` for file entries (label = basename, path = parent dir, docs = `[file]`).
- [x] 3.3 Update `createWatchSession` and the chokidar watch list so a file entry is watched directly (chokidar accepts file paths).
- [x] 3.4 Update `src/server.test.ts` with cases: a single `.md` file, a mix of file+dir, and a rejection for `.png`.

## 4. Pin-to-file scope control

- [x] 4.1 Extend the shared `StatePayload` type with `scope: { kind: "folder" } | { kind: "file", documentId: string }`.
- [x] 4.2 Add a `setScope(scope)` method on the watch session that narrows `scanRoots` output and the watcher's event filter; make it idempotent.
- [x] 4.3 Add `POST /api/scope` to `cli.ts` that validates the payload and calls `watchSession.setScope`.
- [x] 4.4 On `unlink` of a pinned document, reset scope to folder automatically and broadcast.
- [x] 4.5 Add an integration test in `src/server.test.ts` covering pin, unpin, and pinned-file deletion.

## 5. Browser UI: header badge, collapsible sidebar, pulsing Live, pin toggle

- [x] 5.1 Update `src/index.html` to add the build badge element, sidebar collapse/expand buttons, a dot span next to the connection state, and a pin toggle next to the preview title.
- [x] 5.2 In `src/app.ts`, render the badge from `payload.build`, wire the collapse button to toggle `.app-shell.is-sidebar-collapsed` and mirror to `localStorage["uatu:sidebar-collapsed"]` (restoring on load).
- [x] 5.3 Swap the connection state text for a stateful element that toggles `.is-live` / `.is-reconnecting` on SSE `open` / `error`.
- [x] 5.4 Wire the pin toggle to `POST /api/scope`; update local state from the broadcast that follows; hide the toggle while the scope is already narrowed to the current doc (show unpin instead).
- [x] 5.5 Update `src/styles.css`: `@keyframes uatu-pulse`, `.is-live .indicator-dot`, `.is-reconnecting .indicator-dot`, reduced-motion override, collapsed-rail grid layout, build-badge typography.

## 6. Independent sidebar scroll and sticky preview header

- [x] 6.1 Refactor `.app-shell` in `src/styles.css` to a full-viewport two-column layout (`height: 100vh`, column-level `overflow: hidden`); move the preview scroll from `.preview` onto `.preview-shell` and wrap the sidebar's `.tree` in a new `.sidebar-body` scroll container so the sidebar header stays pinned at the top of its column.
- [x] 6.2 Add a `.sidebar-body` wrapper in `src/index.html` around the `#tree` element so the new scroll container has somewhere to live.
- [x] 6.3 Apply `position: sticky; top: 0; z-index: 2` to `.preview-header` with `background: rgba(255, 255, 255, 0.72)` and `backdrop-filter: blur(14px) saturate(140%)` (plus `-webkit-backdrop-filter`); add a `@supports not (backdrop-filter: blur(1px))` rule that falls back to an opaque background.
- [x] 6.4 Add a `.preview-header::after` pseudo-element with a short linear-gradient (`rgba(36, 41, 47, 0.08)` → transparent) to produce the subtle top-edge shadow below the header.
- [x] 6.5 Add `scroll-margin-top` equal to the header height on `.preview :is(h1, h2, h3, h4, h5, h6)` so in-page anchor jumps land below the sticky header.
- [x] 6.6 Verify the responsive breakpoint (`max-width: 900px`): when stacked, the sidebar reverts to natural flow (its own scroller disabled) while the preview header remains sticky inside the preview pane.

## 7. GitHub-style syntax highlighting

- [x] 7.1 Add `highlight.js` to `dependencies` and `highlight.js/styles/github.css` to the stylesheet import chain.
- [x] 7.2 In `src/markdown.ts` (or a new `src/highlight.ts`), post-process the micromark output to run `hljs.highlight` per fenced block, preferring the info-string language.
- [x] 7.3 Preserve the existing Mermaid pipeline: confirm `replaceMermaidCodeBlocks` runs before highlighting so mermaid blocks are untouched.
- [x] 7.4 Extend `src/markdown.test.ts` with cases for a `js` block, a `mermaid` block, and an unknown-language block.
- [x] 7.5 Re-run `bun run check:licenses` and record the outcome (highlight.js is BSD-3-Clause, already compatible — verify).

## 8. End-to-end tests

- [x] 8.1 Playwright test: collapse the sidebar, reload the page, expect it to still be collapsed.
- [x] 8.2 Playwright test: pin the current document, modify an off-pin file, expect the preview to remain unchanged and the sidebar to show only the pinned doc.
- [x] 8.3 Playwright test: connect to the server, expect the connection indicator to carry the `is-live` class; simulate disconnect and expect `is-reconnecting`.
- [x] 8.4 Playwright test: start `uatu watch README.md`, expect the sidebar to show only that file.
- [x] 8.5 Playwright test: open a long Markdown document, scroll the preview, expect `.preview-header` to stay at a stable viewport position and the sidebar scroll offset to remain unchanged.

## 9. Docs and release prep

- [x] 9.1 Update `README.md` with a "Watch a single file" example and a short note on the pin toggle.
- [x] 9.2 Verify the compiled binary: run `bun run build`, launch it, confirm the badge shows `v<semver> · <shortsha>` and the banner prints in a TTY.
- [x] 9.3 Run full validation: `bun test`, `bun run check:licenses`, `bun run build`, `bun run test:e2e`.
