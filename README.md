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

`uatu` is a local watch UI for following what an AI coding agent is doing in
a codebase. Point it at a directory, open the browser UI it prints, and it
keeps a pleasant preview in sync with changing files. **Follow** jumps to the
latest change; **Pin** locks the view to one file. Today it's a live preview
and file browser; over time it grows toward a companion for onboarding, peer
review, and self-assessment of cognitive debt.

## Features

- Markdown / AsciiDoc rendering with unified metadata cards for frontmatter and AsciiDoc header attributes
- Mermaid diagrams (fenced and `[source,mermaid]`) with a fullscreen pan/zoom viewer
- Syntax highlighting for source files, plus per-file copy-to-clipboard on every code block
- Cross-document `.md`/`.adoc` link navigation; live reload over SSE
- **Rendered / Source / Diff** view chooser per document; Diff renders only the active file's changes against the resolved review base via [`@pierre/diffs`](https://diffs.com/)
- **Author / Review** mode toggle with a stale-content hint in Review when the active file changes on disk
- Side-by-side / stacked split layouts for Source + Rendered
- Whole-repo browsing with `.uatu.json tree.exclude` and `.gitignore` filtering on top of built-in defaults
- Review-oriented sidebar (change overview, files, git log, selection inspector producing `@path#L<a>-<b>` references)
- Review burden meter based on git diff size, file spread, and configurable path scoring
- Git preflight by default (`--force` to bypass for non-git folders); single-file or multi-root scope
- Embedded terminal panel (real PTY via Bun) toggled with `Ctrl+`` — dark theme, Nerd Font detection, dock to bottom or right, split for two concurrent PTYs
- Installable as a PWA so TUI editor shortcuts (`Cmd+W`, `Cmd+T`, `Cmd+L`, `Cmd+R`) reach the embedded terminal

## Install

Requires **Bun ≥ 1.3.5** (for the built-in PTY API; older Bun degrades the
terminal feature gracefully).

```bash
bun install
bun run src/cli.ts watch testdata/watch-docs   # run from source
bun run build && ./dist/uatu watch .            # standalone binary
bun link                                        # expose `uatu` on PATH
```

Windows is pending Bun's upstream PTY work — the terminal stays hidden there;
everything else works.

## Usage

```bash
uatu watch [PATH...] [--force] [--no-open] [--no-follow] [--no-gitignore] [--mode <MODE>] [--port <PORT>]
```

```bash
uatu watch .
uatu watch docs notes --no-open
uatu watch . --mode review
uatu watch README.md
uatu watch ~/Downloads/docs --force         # non-git, slow indexing
```

Click **Pin** in the preview header to narrow a running folder watch to the
current document. Click again to restore the full sidebar.

The server binds to `127.0.0.1:4711` by default and scans upward if the port
is taken; pass `--port 0` for an ephemeral port. **Breaking from earlier
versions:** the default changed from 4312 to 4711 to keep PWA install
identity stable across launches. Pass `--port 4312` to keep old behavior.

## Configuration: `.uatu.json`

Optional repo-root file. All sections are independent and validation errors
are surfaced in Change Overview rather than aborting the watch session.

```json
{
  "tree": {
    "exclude": ["bun.lock", "*.log", "!debug.log"],
    "respectGitignore": true
  },
  "terminal": {
    "fontFamily": "Berkeley Mono, monospace",
    "fontSize": 14
  },
  "review": {
    "baseRef": "origin/main",
    "thresholds": { "medium": 35, "high": 70 },
    "riskAreas":    [{ "label": "Auth",  "paths": ["src/auth/**"],            "score": 25, "perFile":  2, "max": 35 }],
    "supportAreas": [{ "label": "Tests", "paths": ["**/*.test.ts","tests/**"], "score": -10, "perFile": -1, "maxDiscount": 15 }],
    "ignoreAreas":  [{ "label": "Generated", "paths": ["dist/**","**/*.generated.ts"] }]
  }
}
```

The review base is resolved in order: configured `review.baseRef` →
`origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`, then
falls back to staged + unstaged worktree changes against `HEAD`.

Files at or above 1 MB render without syntax highlighting to keep the
browser responsive. Binary files appear with VS Code-style icons and route
to a "preview unavailable" view. Git status (added / modified / deleted /
renamed / untracked) is surfaced as ambient row annotations on the tree.

## Security posture of the terminal

The terminal endpoint accepts shell input, so it ships with a stricter
envelope than the rest of uatu:

- **Localhost binding only** — server binds `127.0.0.1`, never `0.0.0.0`
- **Per-server token** — 32-byte token minted at startup, required for the WS upgrade. Restarting rotates it; the URL with the token lands in stdout and may persist in logs — treat as a short-lived credential
- **Origin allowlist** — rejects upgrade for any `Origin` other than `127.0.0.1:<port>`, `localhost:<port>`, or the PWA origin
- **HttpOnly cookie** — `?t=<token>` mints a `uatu_term` HttpOnly + SameSite=Strict cookie so PWA launches re-auth without pasting; rotates with the in-memory token

**Safari 17+** blocks page-accessible Nerd Fonts (anti-fingerprinting), so
terminal prompts using Powerline glyphs show TOFU squares there. Chrome /
Edge / Brave or "Add to Dock" works around it.

## Watchdog and freeze recovery

`uatu watch` runs a sibling watchdog subprocess by default. If the parent's
1Hz heartbeat goes stale beyond `--watchdog-timeout=<ms>` (default 30 000) —
for example because the JS event loop is wedged on a native fsevents
deadlock — the watchdog captures a forensic dump and force-kills the parent
(see [issue #40](https://github.com/tjakobsson/uatu/issues/40)).

```bash
uatu watch --debug                  # also writes 1Hz NDJSON metrics
uatu watch --watchdog-timeout=60000
uatu watch --no-watchdog            # escape hatch
```

Diagnostic files live under `$XDG_CACHE_HOME/uatu/` (or `~/.cache/uatu/`):
heartbeat, snapshot, optional debug ring-buffer, and forensic dumps on
freeze. With `--debug`, `GET /debug/metrics` returns the live counters.

> **Privacy note:** forensic dumps include absolute repo paths from `lsof`
> (macOS) or `/proc/<pid>/fd/` (Linux). Review before sharing.

## Validation

```bash
bun test                # unit + integration
bun run check:licenses  # license audit
bun run build           # standalone build
bun run test:e2e        # Playwright
bun run bench:render    # informational render baseline
```

## Repository workflow

This repo uses [OpenSpec](./openspec) for change-driven work: branch, create
a change under `openspec/changes/<name>/` (proposal, design, spec, tasks),
implement, merge, archive under `openspec/changes/archive/`. Current product
behavior lives in `openspec/specs/`.

GitHub Actions runs `bun test`, license audit, build, and Playwright on
every PR. Renovate keeps npm packages and GitHub Actions versions current.
Claude Code reviews every non-draft pull request and responds to `@claude`
mentions.
