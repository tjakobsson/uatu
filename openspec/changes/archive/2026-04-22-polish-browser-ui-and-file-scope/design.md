## Context

`uatu` starts a Bun server that serves a single-page UI (`src/index.html` + `src/app.ts`) and exposes three endpoints (`/api/state`, `/api/document`, `/api/events`). The watch session is created once at startup from a fixed list of root directories resolved by `resolveWatchRoots`; `scanRoots` walks those directories and builds the sidebar tree. The current UI shows a static "uatu / Document Watch" header, a "Follow on/off" pill, a text status ("Live" / "Reconnecting"), and a preview pane using `github-markdown-css`. Markdown is rendered by `micromark` with the GFM extension; fenced code blocks come out as plain `<pre><code class="language-…">` without any syntax coloring.

Two constraints shape the design:

- Bun's `bun build --compile` produces a standalone binary. Any build metadata has to be baked in at build time, because the running binary has no access to `.git`.
- The SSE channel is long-lived and `SERVE_IDLE_TIMEOUT_SECONDS = 0` to avoid spurious timeouts; anything we add to the pulsing indicator must not require new server round-trips.

## Goals / Non-Goals

**Goals:**

- Ship a cohesive polish pass: startup banner, in-browser build identity, collapsible sidebar, pulsing live indicator, and GitHub-style code highlighting.
- Let users scope a session to a single Markdown file either at launch (positional path is a file) or mid-session (pin toggle in the browser), without introducing a separate command.
- Keep the binary self-contained — build metadata is injected at compile time, highlight theme is bundled.

**Non-Goals:**

- Dark-mode theming. The UI stays light-mode; a dark variant can be a future change.
- Custom highlight themes or per-language opt-in — we ship GitHub Light only.
- Watching multiple mixed file+directory roots in one invocation beyond the straightforward union (files are added as single-file roots; directories keep today's behavior).
- Persisting pin state across browser reloads in v1 — collapsed sidebar state is persisted, but pin-to-file resets on reload to avoid surprising users with a narrowed view.

## Decisions

### Build metadata injection

Use `Bun.build`'s `--define` flag (equivalent to `--env`) during `bun build --compile` to replace `__UATU_BUILD__` literals in `src/version.ts` with a JSON blob `{ version, branch, commitSha, commitShort, buildTime }`. The `build` npm script reads git info via `git rev-parse --short HEAD`, `git rev-parse --abbrev-ref HEAD`, and `date -u +%FT%TZ`. When running via `bun run dev` (no compile step), `src/version.ts` falls back to reading the same values at process start with a `Bun.spawnSync(["git", …])` call; on git failure it reports `dev` for branch and `unknown` for sha.

Alternative considered: read git info at every startup. Rejected — the compiled binary does not ship `.git`, and we want the badge to reflect the release commit, not the user's checkout.

Exposed to the client via `/api/state` payload so the header badge renders from the same data path as everything else. Formatting:

- Release build: `v0.1.0 · 6fa9c10`
- Dev run: `main@6fa9c10` (or `main@unknown` if git is unavailable)

### Single-file scope at the CLI

`parseCommand` keeps accepting zero or more positional paths. `resolveWatchRoots` now `fs.stat`s each path and classifies it as `{ kind: "dir", absolutePath }` or `{ kind: "file", absolutePath, parentDir }`. `scanRoots` switches on kind: directories behave as today; files produce a root whose `docs` array contains only that file, and the `label`/`path` fields still point at a sensible display (`path.basename(file)` for label, file's parent directory for path).

Chokidar already accepts file paths in the watch list; we pass the file directly so the watcher fires on that file only. Non-Markdown file paths are rejected with a clear error at `resolveWatchRoots` time.

Alternative considered: a `--file` flag. Rejected — `uatu watch README.md` is what users will try first, and an overloaded positional argument matches the user's mental model (and common tools like `tail`).

### Pin-to-file mid-session

Add a `scope: { kind: "folder" } | { kind: "file", documentId: string }` field to the state payload and a new `POST /api/scope` endpoint. The UI shows a pin button next to the document title in the preview header. Clicking it sends `{ scope: { kind: "file", documentId } }`; the server narrows `scanRoots` output and the watcher filter to just that document until the client posts `{ scope: { kind: "folder" } }`.

We do not physically change the chokidar watchers on pin (cheaper, simpler); instead we filter events in the server's `watcher.on("all", …)` handler when `scope.kind === "file"`, and we restrict the broadcast payload's `roots` to the pinned document. This keeps "unpin" instant because the watchers never stopped.

Alternative considered: reuse the existing follow-mode toggle. Rejected — follow-mode is "jump to latest changed", pin-to-file is "ignore everything else". Conflating them hides both intents.

### Sidebar collapse

Add a dedicated collapse button in the sidebar header. Collapsed state is a CSS class on `.app-shell` (`is-sidebar-collapsed`) that switches the grid template to a narrow rail (`32px`) showing only an expand chevron. State is mirrored to `localStorage["uatu:sidebar-collapsed"]` so the preference survives reloads. No server-side state.

### Live pulse

Wrap the existing `#connection-state` element in a span with an adjacent colored dot. When the SSE `open` event fires we add a `is-live` class that drives a CSS `@keyframes` opacity pulse on the dot; on `error` we swap to an `is-reconnecting` class (solid amber, no animation). Reduced-motion preference (`@media (prefers-reduced-motion: reduce)`) disables the pulse.

### GitHub-style syntax highlighting

`micromark` emits `<pre><code class="language-js">…</code></pre>`. We extend `renderMarkdownToHtml` to run `highlight.js` (with only `common` languages registered to keep the bundle small) over every fenced code block after micromark returns. Language resolution reuses the info string; unknown languages fall back to `highlight.js/lib/core`'s auto-detection. The bundled GitHub Light theme CSS (`highlight.js/styles/github.css`) is imported from `styles.css` so the compiled binary inlines it the same way `github-markdown-css` already is.

The Mermaid replacement in `src/preview.ts` must continue to run *before* highlight.js so we do not colorize blocks we are about to turn into diagrams. Order: micromark → `replaceMermaidCodeBlocks` → highlight.js.

Alternative considered: `shiki`. Rejected — significantly larger bundle, requires WASM or JSON grammars; `highlight.js` GitHub theme is the literal source for GitHub's code blocks visually and it ships compact CSS.

### Independent sidebar scroll

Change `.app-shell` from a simple two-column CSS grid into a grid whose rows fill the viewport height (`min-height: 100vh; height: 100vh`), and make both `.sidebar` and `.preview-shell` `overflow: hidden` at the column level with an inner scroll container in each. The sidebar's scroll is on a new `.sidebar-body` wrapper around `.tree` (header stays pinned at the top of the column); the preview's scroll moves from `.preview` onto `.preview-shell` so the sticky header (see next decision) can anchor to the scrolling container. `body` itself no longer scrolls; this is the standard two-pane docs layout.

Alternative considered: keep `body` scrolling and `position: sticky` the sidebar. Rejected — sticky sidebars pin only until the sidebar itself is taller than the viewport, and they still scroll-jack the body, which is exactly what we want to avoid.

### Sticky preview header with frosted backdrop

Apply `position: sticky; top: 0; z-index: 2` to `.preview-header`, paired with a semi-transparent background (`background: rgba(255, 255, 255, 0.72)`) and `backdrop-filter: blur(14px) saturate(140%)` (with `-webkit-backdrop-filter` for Safari). The header sits inside the scrolling `.preview-shell` so the blur picks up whatever is beneath it as the user scrolls.

For the subtle top-edge shadow, we avoid a hard `border-bottom` and instead use a `::after` pseudo-element on `.preview-header` that extends ~14px below the header with a linear gradient from `rgba(36, 41, 47, 0.08)` to transparent. That gives the "touch of shadow from the top" effect requested without a visible divider line.

Fallback: when `backdrop-filter` is unsupported (`@supports not (backdrop-filter: blur(1px))`), the background becomes fully opaque (`#ffffff`) and the gradient shadow still renders — the feel degrades, the function does not.

Alternative considered: a separate fixed header above both columns. Rejected — couples sidebar and preview layouts, complicates the responsive breakpoint, and breaks the "document title lives above the document" information architecture.

### Startup banner

Print the provided ASCII logo and tagline to stdout in `src/cli.ts` before `console.log(url)`. Gate the banner on stdout being a TTY (`process.stdout.isTTY`) so pipes and CI logs stay clean; in non-TTY mode just print the URL as today. The banner is a single-string constant to keep alignment obvious.

## Risks / Trade-offs

- **highlight.js bundle size** → Using `highlight.js/lib/common` limits languages to the standard GitHub-relevant set (~30) and keeps the compiled binary growth modest (<200KB). Validated against `bun run check:licenses` before merge.
- **Dev run without git** → `src/version.ts` silently falls back to `main@unknown`, which could confuse a user who expects a real sha. Mitigation: the fallback is intentional and tested; users running a release binary always see a real sha.
- **Pin-to-file on a deleted document** → If the pinned file is unlinked, the next `watcher.on("unlink", …)` clears scope back to folder mode and broadcasts a state change. Tested.
- **Sidebar-collapsed UX on narrow screens** → The responsive breakpoint (`max-width: 900px`) already stacks sidebar above preview; when collapsed on narrow screens we keep the rail visible above the preview so the toggle remains reachable.
- **`backdrop-filter` browser support** → Supported in every current Chromium, Safari, and Firefox, but we ship a `@supports` fallback to an opaque header so older engines remain readable.
- **Sticky header + in-page anchors** → When a reader clicks a heading anchor, the target normally lands flush to the top and is hidden behind the sticky header. Mitigation: apply `scroll-margin-top` equal to the header height on all headings inside `.preview`, so anchor jumps park the target below the header.
- **Independent scrollers and preserved scroll position** → Switching the active document resets the preview scroll to top (current behavior) and leaves the sidebar scroll untouched, which is the whole point of the split. No regression expected.
- **Pulse + reduced motion** → CSS media query disables the animation; the live dot still changes color so the state is conveyed without motion.

## Migration Plan

No data migration. One UX discontinuity: users who memorized "pass a directory" may now pass a file by mistake. The error message for non-Markdown files is explicit (`watch path must be a directory or a Markdown file: <path>`), and the README gains a short usage line.
