# uatu

[![CI](https://github.com/tjakobsson/uatu/actions/workflows/ci.yml/badge.svg)](https://github.com/tjakobsson/uatu/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

`uatu` is a local document watch server that opens a browser UI for browsing and previewing watched files.

Current scope:

- Markdown support with GitHub Flavored Markdown-compatible rendering
- GitHub-style light-mode preview by default
- Mermaid support for fenced `mermaid` blocks
- Follow mode that jumps to the latest changed document

The long-term product direction is format-neutral, but the current implementation is Markdown-only.

## Quick Start

Install dependencies:

```bash
bun install
```

Run the app against the bundled example docs:

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

If you already have an interactive Playwright session running and need another local E2E run, override the port:

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

Dependabot is configured to keep npm packages and GitHub Actions versions current so repository tooling does not drift behind current releases.
