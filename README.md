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

- **GitHub Flavored Markdown** rendering with the light GitHub theme
- **Mermaid diagrams** from fenced ` ```mermaid ` blocks
- **Syntax-highlighted code** (highlight.js, GitHub theme)
- **Safe HTML passthrough** — inline HTML renders like on GitHub; `<script>`, event handlers, and `javascript:` URLs are stripped
- **Static asset serving** — images and other files next to your Markdown just work via their relative paths
- **Live reload** over Server-Sent Events, with a pulsing connection indicator
- **Follow mode** that jumps to the latest changed document
- **Pin mode** that narrows the session to a single file
- **Collapsible sidebar**, sticky preview header, and a build badge in the footer
- **Single-file mode** from the CLI (`uatu watch README.md`)

## Quick Start

Install dependencies:

```bash
bun install
```

Run against the bundled example docs:

```bash
bun run src/cli.ts watch testdata/watch-docs
```

Or build the standalone executable:

```bash
bun run build
./dist/uatu watch testdata/watch-docs
```

Useful options:

```bash
./dist/uatu watch .
./dist/uatu watch docs notes --no-open
./dist/uatu watch testdata/watch-docs --no-follow --port 4321
```

### Watching a single file

`uatu watch` also accepts a Markdown file path. The session starts scoped to that
one file and the sidebar only shows it:

```bash
./dist/uatu watch README.md
```

Mid-session, you can narrow an already-running folder watch to the currently
previewed document with the **Pin** button in the preview header. Clicking it
again restores the full sidebar. Deleting the pinned file on disk automatically
unpins the session.

## Validation Commands

Unit and integration tests:

```bash
bun test
```

License audit:

```bash
bun run check:licenses
```

Standalone build:

```bash
bun run build
```

Install the Playwright browser runtime for local E2E work:

```bash
bun run e2e:install
```

Run Playwright E2E tests:

```bash
bun run test:e2e
bun run test:e2e:headed
bun run test:e2e:ui
bun run test:e2e:debug
```

If you already have an interactive Playwright session running and need another
local E2E run, override the port:

```bash
UATU_E2E_PORT=4174 bun run test:e2e
```

## Repository Workflow

This repository uses OpenSpec for change-driven work.

Typical flow:

1. Create a branch for the work.
2. Create an OpenSpec change under `openspec/changes/<name>/`.
3. Write proposal, design, spec, and tasks artifacts.
4. Implement the change.
5. Merge the work.
6. Archive the completed change.

The current product behavior is defined in:

- `openspec/specs/document-watch-browser/spec.md`

Archived work lives under:

- `openspec/changes/archive/`

## GitHub Automation

GitHub Actions runs the core repository checks:

- `bun test`
- `bun run check:licenses`
- `bun run build`
- `bun run test:e2e`

Renovate keeps npm packages and GitHub Actions versions current so repository
tooling does not drift behind current releases. The Dependency Dashboard issue
tracks every pending update.

Claude Code reviews every non-draft pull request on open and on push, and also
responds to `@claude` mentions in issues, pull requests, and review comments.
