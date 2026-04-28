<p align="center">
  <img src="./uatu-logo.svg" alt="uatu" width="156" height="160" />
</p>

<h1 align="center">uatu</h1>

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

`uatu` is a local codebase watcher. Point it at a directory (or a single file),
open the browser UI it prints, and it keeps a GitHub-style preview in sync with
whatever changes on disk.

## Features

- **Markdown** (GFM) and **AsciiDoc** rendering, GitHub-styled
- **Mermaid** diagrams in fenced blocks and `[source,mermaid]` listings
- **Syntax highlighting** for source files (highlight.js, GitHub theme)
- **Cross-document navigation** — clicking a link to another `.md`/`.adoc` swaps the preview in place
- **Live reload** over Server-Sent Events
- **Follow** mode jumps to the latest changed file; **Pin** mode locks the session to one file
- **Whole-repo browsing** with `.uatuignore` and `.gitignore` filtering
- **Single-file** or multi-root scope from the CLI

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
uatu watch [PATH...] [--no-open] [--no-follow] [--no-gitignore] [--port <PORT>]
```

`PATH` may be a directory, multiple directories, or a single non-binary file.

```bash
uatu watch .
uatu watch docs notes --no-open
uatu watch testdata/watch-docs --no-follow --port 4321
uatu watch . --no-gitignore
uatu watch README.md
uatu watch GUIDE.adoc
```

Mid-session, click **Pin** in the preview header to narrow an already-running
folder watch to the currently previewed document. Click again to restore the
full sidebar.

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
