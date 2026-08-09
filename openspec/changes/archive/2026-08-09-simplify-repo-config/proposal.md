# simplify-repo-config

## Why

`.uatu.json` accreted four independently parsed blocks, but only one of them describes the repository. Fonts (`mono`, `terminal.fontFamily`/`fontSize`) are the reader's taste, and the OSC 52 `terminal.clipboard` policy is a per-user consent setting — a file in the repo should not decide whether programs may write a visitor's clipboard. Reducing the file to content facts makes repository config honest, deletes three parsers, and leaves a clean shopping list (fonts, clipboard policy) for future hub user settings. Part of the 0.5.0 debt paydown: deletions and renames only.

## What Changes

- **BREAKING (rename):** the `tree` block becomes `ignore` with identical semantics — `exclude` (gitignore-syntax patterns incl. `!` negation, live re-read, single-file-root exemption) and `respectGitignore` (default true, `--no-gitignore` CLI still wins). It was always content scoping: the ignore engine is its only consumer. The loader moves from `src/sidebar/tree-config.ts` into `src/ignore/`.
- **BREAKING (removal):** the `mono` block is deleted — `src/mono/config.ts`, its warnings, and the `monoConfig` payload field threaded through `cli.ts` → `watch-session` → the client's `applyMonoConfig` call sites. The bundled Hack Nerd Font Mono stack remains the standing default via `--mono-font-family`; without overrides, rendering is pixel-identical.
- **BREAKING (removal):** the `terminal` block is deleted — `src/terminal/config.ts` and the `terminalConfig` payload field. The terminal keeps its existing default font chain (`--terminal-font-family` → `--mono-font-family` → bundled face) and default size; the OSC 52 clipboard policy is fixed at today's default `notify` (toast on copy, coalescing), and the dead `confirm`/`silent`/`off` branches are deleted with their config.
- Net effect: one `.uatu.json` parser (the ignore loader) instead of four; `src/mono/` shrinks to the boot-time CSS-variable application or dissolves entirely if nothing remains.
- No migration shim: existing `mono`/`terminal`/`tree` blocks are simply no longer read; a release-note line covers the rename (single-digit user base). Future hub user settings for fonts and clipboard policy are explicitly out of scope.

## Capabilities

### New Capabilities

_None — removals and a rename only._

### Modified Capabilities

- `tree-filtering`: the two `.uatu.json`-driven requirements are restated with `ignore.exclude` / `ignore.respectGitignore` key names; behavior unchanged.
- `mono-font`: the `mono.fontFamily` override requirement and the `terminal.fontFamily`-narrower-override requirement are removed; the single-variable requirement is restated without config-override references.
- `embedded-terminal`: the `.uatu.json` font-configuration requirement is replaced by the default-font behavior it already contained; the clipboard-policy-configuration requirement collapses to fixed `notify` behavior (toast + coalescing), removing `confirm`/`silent`/`off`.

## Impact

- Deleted: `src/mono/config.ts` (+test), `src/terminal/config.ts` (+test), non-`notify` clipboard-policy branches in the terminal client, `monoConfig`/`terminalConfig` payload plumbing.
- Moved/renamed: `src/sidebar/tree-config.ts` → `src/ignore/config.ts` (or similar), reading the `ignore` block; `ignore/engine.ts` import updated.
- Edited: `shared/types.ts` payload types, `cli.ts` startup loading, `watch-session.ts` payload assembly, `shell/boot.ts`/`events.ts` apply calls, terminal panel font setup, docs (`CLAUDE.md` folder map and `.uatu.json` description, `ARCHITECTURE.md`, README, `testdata/` examples).
- Ordering: independent of `remove-review-burden` in code, but both edit `shared/types.ts`, `cli.ts`, and `watch-session.ts` — land sequentially to avoid conflict noise. The `review` block's removal belongs to that change, not this one.
