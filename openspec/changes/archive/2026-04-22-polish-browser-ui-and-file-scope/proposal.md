## Why

The current browser UI is functional but visually anonymous, wastes horizontal space when the sidebar is not needed, and does not communicate which build of `uatu` is running — three rough edges that users hit every session. At the same time, users who want to follow a single file have to filter noise from every other Markdown file under the watched root, and code blocks in previews do not visually match the GitHub rendering the rest of the UI emulates. Landing these together avoids spreading small UI churn across multiple changes.

## What Changes

- Print a multi-line ASCII `uatu` logo with the tagline "I observe. I follow. I render." on the terminal when the watch server starts, ahead of the URL line.
- Show a build-identifier badge in the browser header: `<branch>@<shortsha>` for local/dev runs, and semver + short sha for compiled release binaries.
- Make the sidebar collapsible via a header toggle and persist the collapsed state across reloads in the same browser.
- Animate the "Live" connection indicator with a subtle pulse while the SSE channel is connected, and stop pulsing when it falls back to "Reconnecting".
- Accept file paths (not only directory paths) in `uatu watch [PATH...]` and on the existing positional arguments; single-file mode narrows the session to that file.
- Add a "Pin to file" control in the browser UI that narrows an already-running folder session to the currently selected Markdown file (and back) without restarting the process.
- Apply GitHub-style syntax highlighting to fenced code blocks in the preview so non-Mermaid fences render with the same visual treatment as GitHub.
- Give the sidebar its own scroll container so sidebar scrolling is independent of preview scrolling and the sidebar header stays in place while the preview scrolls.
- Make the preview header (the "Preview" eyebrow, document title, and file path) stick to the top of the preview pane while the document scrolls underneath it, with a frosted/blurred backdrop so the scrolling content remains faintly visible through it.
- Add a subtle top-edge gradient shadow beneath the sticky preview header so the transition between the floating header and the scrolling content is visible without a hard border.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `document-watch-browser`: startup output gains an ASCII logo; `uatu watch` accepts file paths; the browser UI gains a build identifier, collapsible sidebar, independent sidebar scroll, sticky frosted preview header with a subtle top-edge shadow, pulsing live indicator, pin-to-file scope control, and GitHub-style code block highlighting.

## Impact

- Source: `src/cli.ts` (startup banner, build metadata injection), `src/server.ts` (accept file inputs in `parseCommand`/`resolveWatchRoots` and restrict `scanRoots`/watcher to single-file mode, expose scope-change endpoint), `src/app.ts` and `src/index.html` (build badge, collapsible sidebar, live pulse, pin toggle, highlight wiring, sticky preview header markup), `src/styles.css` (pulse animation, collapsed layout, highlight theme, independent sidebar scroller, sticky/blurred preview header with gradient shadow), `src/markdown.ts` (attach language classes and run a GitHub-compatible highlighter), `src/version.ts` (expose build metadata rather than a bare version string).
- Build: `package.json` `build` script injects git sha + branch via `Bun.build` `--define` (or equivalent) so the compiled binary reports release identity; an additional runtime dependency for syntax highlighting (candidate: `highlight.js` with the GitHub theme) is added, subject to `bun run check:licenses`.
- Tests: `src/server.test.ts` and `src/preview.test.ts` (or new unit tests) cover file-path parsing, single-file scope, and highlighted markup; Playwright E2E covers sidebar collapse, pin toggle, and live-pulse states.
- Docs: `README.md` gains a note on watching a single file and the pin toggle.
