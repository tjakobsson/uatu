# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/);
versions follow the `package.json`'s `version` field.

## Unreleased

### Added

- **Files-pane `All ↔ Changed` filter chip.** The Files-pane header gains a segmented chip that reduces the tree to `changedFiles ∪ ignoredFiles` (ancestor directories auto-expanded; gitignored entries excluded). Defaults `Changed` in Review and `All` in Author, persisted per Mode. The active document is always visible (follow-override reveals an out-of-set row with a subtle dim/italic cue), the file count displays `N of M files` under filter, and an empty filtered set surfaces an inline message naming the review base.
- **Document tree powered by [`@pierre/trees`](https://github.com/pierrecomputer/pierre/tree/main/packages/trees)** (`1.0.0-beta.3`, Apache-2.0). The Files-pane tree is now rendered by the library; uatu owns walking the filesystem and feeding it paths. Ambient git status (added / modified / deleted / renamed / untracked) appears as row annotations on every changed path.
- **Untracked files surfaced as a distinct category.** Tree rows for untracked files now show the library's untracked annotation (previously they masqueraded as `added`); Change Overview gains a small "Includes untracked files" indicator when applicable; the score-explanation preview breaks out the untracked subcount alongside the existing change-shape inputs. Tracked-added files are now reported as `added` rather than being collapsed into `modified` (the diff pipeline now consults `git diff --name-status` for the per-file category letter).
- **`.uatu.json` `tree` block** for tree filtering: `tree.exclude: string[]` (gitignore-compatible patterns including `!` negation) and `tree.respectGitignore: boolean` (default `true`; opt-out alternative to the `--no-gitignore` CLI flag — CLI flag wins when both are set).

### Changed

- **AsciiDoc bare `[mermaid]` blocks now render as diagrams.** Previously only `[source,mermaid]` was recognized; `[mermaid]` was rendered as a plain literal block to match GitHub's limited AsciiDoc support. uatu now treats `[mermaid]` as the canonical Asciidoctor Diagram block style and routes it through the same client-side mermaid pipeline as `[source,mermaid]`. Recognized over `----` (listing), `....` (literal), and `--` (open) delimiters. Authors whose `.adoc` files contained `[mermaid]` blocks will start seeing them render as diagrams instead of preformatted text — invalid bodies surface Mermaid's inline error indicator without breaking surrounding content.
- **BREAKING — `.uatuignore` is retired.** Move patterns into `.uatu.json` `tree.exclude`. On session start, uatu emits a one-line warning if a `.uatuignore` file exists at any watched root, and does not honor its contents.
- **BREAKING — All / Changed Files-pane toggle removed.** The "Changed" filtered view is replaced by ambient git-status row annotations on the single tree — diff state is always in context, never a separate page.
- **BREAKING — Binary files are clickable, with inline image preview.** Selecting an image binary (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.ico`, `.avif`, `.bmp`) renders the image inline in the preview pane via `<img>` (served by the static-file fallback). Other binaries render a "this file type isn't viewable" notice. Previously these rows were non-clickable; the misleading "the selected file no longer exists" message has been fixed (it was hitting non-image binaries by accident).
- **BREAKING — Sidebar file counter no longer shows `· N hidden`.** With one filtering source of truth (`.uatu.json` + built-in defaults + `.gitignore`), there is no longer a dual-source distinction to disclose. The counter shows `N files` or `N files · M binary`.

### Deferred (returning in follow-up changes)

- **Live mtime ticker.** The 1-second-ticking relative-time label on every tree row was uatu's signature cue but it's load-bearing against any third-party tree renderer. We accept that loss for now; expect it back as a row annotation or "recently active" pulse in a follow-up that targets `@pierre/trees`' `renderRowDecoration` slot.

### Added (continued)

- **Embedded terminal.** Hidden-by-default panel with a real PTY shell in
  the watched repo, toggled with `Ctrl+`` / `Cmd+`` or the **Terminal**
  button in the sidebar (under Author/Review). xterm.js rendering,
  ANSI-color dark theme, locally-installed Nerd Fonts picked up by default,
  optional `.uatu.json` overrides via `terminal.fontFamily` and
  `terminal.fontSize`. Backed by Bun's built-in
  `Bun.spawn(..., { terminal })` API (Bun ≥ 1.3.5).
- **Terminal panel UX:** confirmation modal on destructive close (so a
  stray click doesn't drop a long-running `tail -f` or `claude code`
  session); minimize / fullscreen controls (PTYs stay attached on either);
  optional **right-side dock** in addition to bottom-dock; **split** to
  run two PTYs concurrently in the same panel (`Ctrl+Shift+`` /
  `Cmd+Shift+``). Dock, display mode, sizes, and active panes persist
  across reloads.
- **PWA install.** `/manifest.webmanifest`, 192/512 PNG icons, a minimal
  pass-through service worker, and a stable default origin so uatu can be
  installed as a desktop-style standalone webapp from Chrome / Edge /
  Brave (or via "Add to Dock" in Safari). Eliminates browser-shortcut
  conflicts with embedded TUI tools.
- **Token-gated terminal endpoint.** Per-server-session 32-byte token,
  required on the `/api/terminal` WebSocket upgrade alongside an `Origin`
  allowlist. Token persists across PWA launches via an HttpOnly
  SameSite=Strict cookie (`uatu_term`). The browser shows a
  "Reconnect to uatu" form when the cookie is stale (typically after a
  uatu restart), and pasting a fresh token from `uatu`'s stdout refreshes
  the cookie.

### Changed

- **BREAKING — default port is now 4711** (was 4312). The pin keeps PWA
  install identity stable across launches; uatu scans upward to the next
  free port if 4711 is occupied. Pass `--port 4312` to restore the
  previous default, or `--port 0` to opt back into a kernel-assigned
  ephemeral port.
- The startup-printed URL now includes `?t=<token>` when the terminal
  feature is enabled. The browser strips it from `location` on first
  load and stores it in `sessionStorage` + the `uatu_term` cookie.

### Notes

- Windows is unsupported for the terminal feature pending Bun's upstream
  Windows PTY work; on Windows uatu reports `terminal: "disabled"` and
  hides the sidebar terminal toggle. The rest of uatu still runs.
- Safari 17+ blocks pages from seeing user-installed fonts as
  anti-fingerprinting protection. Locally-installed Nerd Fonts will fall
  through to Menlo in the terminal on Safari; Chrome / Edge / Brave have
  no such restriction.
