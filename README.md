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
- **Whole-repo browsing** with `.uatuignore` and `.gitignore` filtering
- **Review-oriented sidebar panes** for change overview, files, and git history
- **Review burden meter** based on deterministic git diff size, file spread, and configurable path scoring
- **Git-backed codebase** watching by default, with explicit `--force` for non-git folders
- **Single-file** or multi-root scope from the CLI

## Upcoming

- **Codebase onboarding support** for understanding project structure, conventions, and important entry points
- **More configured workflows** via `.uatu.json` for PR review, onboarding, knowledge checks, and self-assessment
- **Cognitive debt tracking** to help people identify gaps in their understanding of codebases they own or maintain
- **AI assistance across workflows** later, layered on top of transparent signals rather than replacing them

## Install

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

Every file under each watched root, with these exclusions:

1. Hardcoded directory denylist (`node_modules/`, `.git/`, `dist/`, etc.).
2. `.uatuignore` at the watch root (gitignore syntax, `!` negation).
3. `.gitignore` at the watch root (default; opt out with `--no-gitignore`).
4. Binary files appear in the sidebar but are non-clickable.

Files at or above 1 MB render without syntax highlighting so the browser stays
responsive.

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
