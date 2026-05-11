<p align="center">
  <img src="./uatu-logo.svg" alt="uatu" width="156" height="160" />
</p>

<h1 align="center">UatuCode</h1>

<p align="center">
  <strong>Codebase Watcher</strong><br/>
  <em>I observe. I follow. I render.</em>
</p>

<p align="center">
  <a href="https://github.com/tjakobsson/uatu/actions/workflows/ci.yml"><img src="https://github.com/tjakobsson/uatu/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-000?logo=bun&logoColor=fbf0df" alt="Built with Bun" /></a>
  <a href="https://playwright.dev"><img src="https://img.shields.io/badge/e2e-Playwright-2EAD33?logo=playwright&logoColor=white" alt="Tested with Playwright" /></a>
</p>

---

`uatu` is a local watch UI for following what an AI coding agent is doing in a
codebase. Point it at a directory (or a single file), open the browser UI it
prints, and it keeps a pleasant, readable preview in sync with the files changing on
disk; **Follow** mode jumps to the latest change as it happens.

## Intent

`uatu` aims to make a codebase easier to observe while writing, explaining,
reviewing, or learning it. Today it is a live local preview and file browser;
over time it is growing toward a companion for codebase onboarding, peer review,
knowledge checks, and self-assessment of cognitive debt: helping teams understand
what exists, what changed, what they are responsible for, and which
project-specific checks matter.

## Features

- **Markdown** and **AsciiDoc** rendering, styled for readability, with a unified metadata card for YAML/TOML frontmatter and AsciiDoc header attributes
- **Mermaid** diagrams in fenced blocks and `[source,mermaid]` listings, fit to the preview width and openable in a fullscreen pan/zoom viewer
- **Syntax highlighting** for source files
- **Cross-document navigation** — clicking a link to another `.md`/`.adoc` swaps the preview in place
- **Live reload** over Server-Sent Events
- **Mode toggle** between **Author** (in-flow with auto-follow) and **Review** (stable navigation, no auto-switching, with a stale-content hint when the active file changes on disk)
- **Follow** mode jumps to the latest changed file in Author mode; **Pin** mode locks the session to one file
- **Whole-repo browsing** with `.uatu.json tree.exclude` and `.gitignore` filtering on top of sane built-in defaults (`node_modules/`, `.git/`, `dist/`, `build/`, etc.)
- **Source / Rendered view toggle** for Markdown and AsciiDoc documents (raw text with line numbers, or fully rendered HTML)
- **Review-oriented sidebar panes** for change overview, files, git history, and a Selection Inspector that produces Claude-Code-style `@path#L<a>-<b>` references from text marked in the source view
- **Review burden meter** based on deterministic git diff size, file spread, and configurable path scoring
- **Git-backed codebase** watching by default, with explicit `--force` for non-git folders
- **Single-file** or multi-root scope from the CLI
- **Embedded terminal** in a hidden-by-default panel toggled with `Ctrl+`` — real PTY in the watched repo via Bun's built-in terminal API, ANSI-color dark theme that picks up locally-installed Nerd Fonts, configurable via `terminal.fontFamily` / `terminal.fontSize` in `.uatu.json`. Bottom or right-side dock, minimize / fullscreen, split for two concurrent PTYs (`Ctrl+Shift+``), confirmation prompt on close so a long-running session isn't lost to a stray click
- **Installable as a PWA** on Edge / Chrome / Brave (and as "Add to Dock" in Safari) so TUI editors and other keyboard-heavy tools don't fight the browser for `Cmd+W`, `Cmd+T`, `Cmd+L`, or `Cmd+R`

## Upcoming

- **Codebase onboarding support** for understanding project structure, conventions, and important entry points
- **More configured workflows** via `.uatu.json` for PR review, onboarding, knowledge checks, and self-assessment
- **Cognitive debt tracking** to help people identify gaps in their understanding of codebases they own or maintain
- **AI assistance across workflows** later, layered on top of transparent signals rather than replacing them

## Install

Requires **Bun ≥ 1.3.5** (for the built-in PTY API used by the embedded
terminal — older Bun degrades the terminal feature gracefully but the rest of
uatu still works).

```bash
bun install
```

Run from the source tree:

```bash
bun run src/cli.ts watch testdata/watch-docs
```

Build a standalone binary:

```bash
bun run build
./dist/uatu watch .
```

The standalone binary embeds Bun's runtime, so the terminal feature works
without any extra setup on macOS and Linux. Windows is pending Bun's
upstream Windows PTY work; until then `terminal: "disabled"` is reported on
Windows and the sidebar terminal toggle stays hidden.

### Install globally with `bun link`

Expose `uatu` on your `PATH` from any directory:

```bash
bun install
bun link
```

`bun link` registers this package's `bin` (`./src/cli.ts`) as a global symlink
in `~/.bun/install/global/bin`. As long as that directory is on your `$PATH`
(Bun's installer sets this up by default), `uatu` works from anywhere:

```bash
uatu watch .
uatu watch README.md
uatu watch docs notes --no-open
```

To unlink later: `bun unlink` from the repo root.

## Usage

```bash
uatu watch [PATH...] [--force] [--no-open] [--no-follow] [--no-gitignore] [--mode <MODE>] [--port <PORT>]
```

`PATH` may be a directory, multiple directories, or a single non-binary file.
By default, each path must be inside a git worktree. This prevents accidental
startup over broad folders such as your home directory. Use `--force` to watch a
non-git path anyway; `uatu` will warn that indexing may be slow.

```bash
uatu watch .
uatu watch docs notes --no-open
uatu watch testdata/watch-docs --no-follow --port 4321
uatu watch . --no-gitignore
uatu watch ~/Downloads/docs --force
uatu watch . --mode review
uatu watch README.md
uatu watch GUIDE.adoc
```

Mid-session, click **Pin** in the preview header to narrow an already-running
folder watch to the currently previewed document. Click again to restore the
full sidebar.

### Default port and PWA install identity

The server binds to `127.0.0.1:4711` by default. If 4711 is already in use,
uatu scans upward for the next free port and warns on stderr. Pinning a
default keeps the PWA install identity stable across launches — installed
PWAs are keyed on origin (host + port), so a moving port creates a new
installable app every restart.

Override at any time with `--port <n>`. Pass `--port 0` to opt back into
ephemeral kernel-assigned ports (handy when you want to run multiple uatu
instances and don't care about PWA install identity).

> **Breaking from earlier versions.** The default port changed from 4312 to
> 4711. If you had bookmarks, scripts, or PWA installs pinned to 4312, pass
> `--port 4312` to keep the old behavior, or update the pinned origin to
> 4711.

### Embedded terminal

A hidden-by-default panel hosts one or more `xterm.js` terminals connected
to real PTYs in the watched repo. Toggle it with **`Ctrl+`** (also `Cmd+``
on macOS), or click the **Terminal** button in the sidebar (under the
Author/Review row).

- **Theme.** Dark by default, ANSI-color palette tuned to the rest of the
  uatu UI. The font stack prefers locally-installed Nerd Fonts (FiraCode,
  JetBrainsMono, Hack, MesloLGS, CaskaydiaCove) so shell prompts that use
  Powerline / starship glyphs render correctly.
- **`.uatu.json` overrides.** Set `terminal.fontFamily` (string) and
  `terminal.fontSize` (number 8–32) to override the defaults per-project:
  ```json
  { "terminal": { "fontFamily": "Berkeley Mono, monospace", "fontSize": 14 } }
  ```
- **Layout.** Dock the panel to the **bottom** or the **right** side via
  the dock button in the header. **Minimize** collapses the panel to its
  header bar while keeping every PTY attached; **fullscreen** expands the
  panel to fill the main content area (sidebar + topbar stay accessible,
  press `Esc` to exit). On viewports narrower than 720px, the right dock
  falls back to the bottom automatically.
- **Split.** Press the split button (or `Ctrl+Shift+`` / `Cmd+Shift+``) to
  spawn a second concurrent PTY in the same panel. Each pane has its own
  shell session, focus ring, and close button. Splits orient
  perpendicular to the dock — side-by-side when bottom-docked, stacked
  when right-docked. Maximum two panes per panel in v1.
- **Close protection.** Clicking the panel's close button when a PTY is
  attached prompts a confirmation modal so a stray click won't drop a
  long-running `tail -f`, `claude code` session, or build. The keyboard
  toggle (`Ctrl+``) and minimize / fullscreen buttons all preserve PTYs
  and don't prompt.
- **Clipboard.** Windows-Terminal-parity shortcuts on Windows / Linux:
  bare `Ctrl+C` copies when text is selected (otherwise sends SIGINT to
  the shell), bare `Ctrl+V` pastes, and `Ctrl+Shift+C` / `Ctrl+Shift+V`
  work the same. macOS keeps the standard `Cmd+C` / `Cmd+V`. Inside the
  installed PWA, `Ctrl+Shift+C` is captured via the Keyboard Lock API so
  Edge's DevTools shortcut doesn't steal it.

### Installing as a desktop app (PWA)

On Chrome, Edge, or Brave, an install icon appears in the address bar after
loading the URL. Click it to install **UatuCode** as a standalone window.
On Safari (macOS Sonoma+), use **File → Add to Dock**.

The standalone window has no browser chrome, so keyboard shortcuts that the
browser would normally intercept (`Cmd+W`, `Cmd+T`, `Cmd+L`, `Cmd+R`) reach
the embedded terminal — making nvim, helix, and other TUI editors usable
inside uatu without conflict.

### Security posture of the terminal

Because the terminal endpoint accepts shell input, it has a stricter
security envelope than the rest of uatu:

- **Localhost binding.** The server only listens on `127.0.0.1`, never on
  `0.0.0.0`. Other hosts on your network can't reach uatu.
- **Per-server token.** A 32-byte token is minted at startup and embedded
  in the URL printed to stdout. The server requires it on the WebSocket
  upgrade for `/api/terminal`. Because the URL is written to stdout in
  plaintext, it can also land in shell history, CI logs, or recorded
  terminal sessions; if you pipe `uatu`'s output somewhere persistent,
  treat the token like any other short-lived credential. Restarting `uatu`
  rotates the token.
- **Origin allowlist.** The upgrade rejects any `Origin` other than
  `http://127.0.0.1:<port>`, `http://localhost:<port>`, or the PWA's
  origin.
- **HttpOnly cookie persistence.** Visiting `?t=<token>` once mints a
  `uatu_term` cookie (HttpOnly + SameSite=Strict) so subsequent PWA
  launches authenticate without re-pasting the token. The cookie rotates
  with the in-memory token on every uatu restart.
- **Re-auth UI.** When the cookie is stale (typically after a uatu
  restart), the panel shows a "Reconnect to uatu" form. Paste a fresh
  token from the new uatu's stdout to refresh the cookie.

### Safari and Nerd Fonts

Safari 17+ blocks pages from seeing user-installed fonts (anti-fingerprinting
protection). Locally-installed Nerd Fonts will not resolve in the terminal
on Safari, even though they are correctly listed in the font-family chain.
Chrome / Edge / Brave have no such restriction. Recommendation: use
Chrome-family for uatu, or install via "Add to Dock" in Safari and accept
that prompts using Nerd Font glyphs will show TOFU squares there until Bun
or the upstream font story changes.

### Mode: Author vs Review

The preview header shows a top-level **Mode** toggle with two values:

- **Author** (default) — in-flow stance for active coding (often with an AI
  assistant). The Follow chip is available; the review-burden score is
  labeled "Reviewer burden forecast".
- **Review** — stable navigation for peer-reviewing a Change. Follow is
  disabled, and file-system change events do not switch the active preview.
  Manual file selection still works. The same score is labeled "Change
  review burden". When the file you're currently viewing changes on disk,
  a hint strip appears above the preview header offering a manual refresh
  (or a "Close" affordance if the file was deleted on disk); the rendered
  content stays put until you act, so your scroll position and line
  references aren't yanked out from under you.

The selected Mode persists per browser via `localStorage`. Pass
`--mode=author|review` on the CLI to override the persisted preference at
startup; `--mode=review` also forces follow mode off for the session.

### Review panes

The expanded sidebar is organized into panes:

- **Change Overview** shows git repository status, review base detection, dirty state, review burden level, score drivers, ignored-file summaries, and `.uatu.json` warnings.
- **Files** contains the document tree and preserves existing selection, follow, pin, binary-file, relative-time, and directory open/closed behavior.
- **Git Log** shows a bounded recent commit list for each detected repository.
- **Selection Inspector** (Review mode only) observes the user's current selection inside the preview and renders one of three states: a placeholder ("No selection") when nothing is marked, an active hint ("Switch to Source view to capture a line range.") when text is marked in Rendered view, or a clickable `@path#L<a>-<b>` reference when text is marked inside the whole-file Source view. Single-line selections collapse to `@path#L<n>`. Clicking the reference copies it to the clipboard. The pane is Review-only because Author mode's Follow auto-switches the active preview, which would routinely yank captures out from under the pane.

### Source / Rendered view toggle

For Markdown and AsciiDoc documents, the preview header exposes a Source / Rendered toggle. Rendered (the default) is the parsed-HTML preview UatuCode has always shown; Source displays the file's verbatim text inside a syntax-highlighted `<pre><code>` block with the line-number gutter. The preference is global (one setting for the whole UI, like Mode and Follow) and is persisted in `localStorage`. Source view is what enables the Selection Inspector pane to produce `@path#L<a>-<b>` references — line counting is only deterministic when operating against the whole-file source DOM. Plain source / code files (which have no separate rendered representation) hide the toggle.

Pane visibility, per-pane collapse, and vertical pane sizes are persisted in
browser `localStorage`. The whole-sidebar collapse button remains separate from
pane visibility.

When a watched root is inside git, `uatu` resolves the review base in this order:
configured `review.baseRef`, `origin/HEAD`, `origin/main`, `origin/master`,
`main`, then `master`. If no base can be resolved, the meter falls back to
staged and unstaged worktree changes against `HEAD`.

### `.uatu.json` review scoring

Add an optional `.uatu.json` at the repository root to tune review scoring:

```json
{
  "review": {
    "baseRef": "origin/main",
    "thresholds": { "medium": 35, "high": 70 },
    "riskAreas": [
      { "label": "Auth", "paths": ["src/auth/**"], "score": 25, "perFile": 2, "max": 35 }
    ],
    "supportAreas": [
      { "label": "Tests", "paths": ["**/*.test.ts", "tests/**"], "score": -10, "perFile": -1, "maxDiscount": 15 }
    ],
    "ignoreAreas": [
      { "label": "Generated", "paths": ["dist/**", "**/*.generated.ts"] }
    ]
  }
}
```

Invalid or missing configuration does not stop the watch session. Invalid
sections are ignored, defaults are used, and warnings appear in Change Overview.

### What gets indexed

Every file under each watched root, with these exclusions composed in one place:

1. Built-in directory denylist (`node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, etc.) — always applied.
2. `.uatu.json` `tree.exclude` at the watch root (gitignore syntax, `!` negation supported).
3. `.gitignore` at the watch root (honored by default; opt out per session with `--no-gitignore`, or per project with `tree.respectGitignore: false` in `.uatu.json`; the CLI flag wins when both are set).

Binary files appear in the sidebar (with the library's standard icon) and route
to a "preview unavailable" view when clicked, matching VS Code.

Files at or above 1 MB render without syntax highlighting so the browser stays
responsive.

Git status (added / modified / deleted / renamed / untracked) is surfaced as
ambient row annotations on the single tree — there is no longer a separate
"Changed" view. The previous `.uatuignore` file is retired; on session start
uatu emits a one-line warning if it finds one, pointing you to
`.uatu.json tree.exclude`.

#### Example `.uatu.json` tree block

```json
{
  "tree": {
    "exclude": ["bun.lock", "*.log", "!debug.log"],
    "respectGitignore": true
  }
}
```

### Diagnostics and freeze recovery

`uatu watch` ships with a sibling **watchdog subprocess** and a small
on-disk diagnostic surface, both intended to make `uatu` self-recovering
and self-explaining if it ever wedges (see
[issue #40](https://github.com/tjakobsson/uatu/issues/40)).

By default the watchdog is on. It reads a heartbeat file the parent process
touches every second; if the heartbeat goes stale beyond
`--watchdog-timeout=<ms>` (default 30 000) — for example because the JS event
loop is wedged on a native fsevents deadlock — the watchdog captures a
forensic dump and force-kills the wedged parent so you don't have to escalate
to `kill -9` from another terminal.

```bash
uatu watch                          # watchdog on, no verbose history
uatu watch --debug                  # also writes a 1Hz NDJSON metrics log
uatu watch --watchdog-timeout=60000 # tolerate longer pauses before force-kill
uatu watch --no-watchdog            # escape hatch — disables the watchdog
```

Diagnostic files live under `$XDG_CACHE_HOME/uatu/` (or `~/.cache/uatu/` if
`XDG_CACHE_HOME` is unset):

| File | When |
|---|---|
| `heartbeat-<pid>` | Always, while `uatu watch` is healthy. |
| `snapshot-<pid>.json` | Always, refreshed once per second. |
| `debug-<pid>.ndjson` | Only with `--debug` (or `UATU_DEBUG=1`). Ring-buffered to ~10 MB. |
| `dump-<pid>-<ts>.{stack,fds,metrics-tail,cause}.*` | Written by the watchdog when a freeze is detected. |

When `--debug` is on, `GET /debug/metrics` returns the live counter snapshot
as JSON.

> **Privacy note.** Forensic dumps include absolute repository paths from
> `lsof` (macOS) or `/proc/<pid>/fd/` (Linux). Review before sharing
> externally.

Forensic capture is platform-specific:
- **macOS**: `sample <pid> 5` for stack, `lsof -Pan -p <pid>` for fds.
- **Linux**: reads from `/proc/<pid>/` directly — no external commands.
- **Windows**: capture is currently a sentinel; the watchdog still
  force-terminates the wedged process.

## Validation

```bash
bun test                # unit + integration
bun run check:licenses  # license audit
bun run build           # standalone build
bun run test:e2e        # Playwright E2E
bun run e2e:install     # install the Playwright browser runtime once
```

If you have an interactive Playwright session running, override the port for
another local run:

```bash
UATU_E2E_PORT=4174 bun run test:e2e
```

## Repository Workflow

This repository uses [OpenSpec](./openspec) for change-driven work:

1. Branch.
2. Create a change under `openspec/changes/<name>/` (proposal, design, spec, tasks).
3. Implement.
4. Merge.
5. Archive the change under `openspec/changes/archive/`.

Current product behavior lives in `openspec/specs/document-watch-browser/spec.md`.

## GitHub Automation

GitHub Actions runs `bun test`, `bun run check:licenses`, `bun run build`, and
`bun run test:e2e` on every PR. Renovate keeps npm packages and GitHub Actions
versions current. Claude Code reviews every non-draft pull request and responds
to `@claude` mentions.
