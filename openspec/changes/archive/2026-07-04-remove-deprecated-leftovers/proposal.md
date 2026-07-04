# Remove deprecated leftovers

## Why

The `simplify-modes-and-follow` change (archived 2026-05-20) mandated that the transitional `--mode` flag be removed in the release after its deprecation window, but the flag is still accepted today — and worse, `usageText` still advertises it as a live option ("Start in 'author' or 'review' mode"), contradicting the deprecation warning the parser actually emits. Alongside it, a cluster of dead concepts from the same era lingers: legacy localStorage migration keys, a whole module dedicated to warning about the retired `.uatuignore` file, and ~40 exported symbols with no external importer.

## What Changes

- **BREAKING**: `--mode` is removed entirely; `uatu watch docs --mode=review` now fails with `unknown flag: --mode`, completing the sunset the `watch-cli-startup` spec already mandates.
- The `--mode` line is removed from `usageText`; README usage documentation is reconciled with `--help` (watchdog flags, `--debug`, `UATU_DEBUG`).
- Legacy localStorage migration keys and their cleanup code are removed from `src/shell/state.ts`: `LEGACY_MODE_KEY`, `LEGACY_SIDEBAR_PANES_KEY_AUTHOR`, `LEGACY_SIDEBAR_PANES_KEY_REVIEW`, `LEGACY_FILES_PANE_FILTER_KEY_AUTHOR`, `LEGACY_FILES_PANE_FILTER_KEY_REVIEW`.
- The `.uatuignore` startup warning (`src/ignore/warning.ts`) is removed along with its `tree-filtering` requirement — the file has been retired since 2026-04-27 and the advisory has served its transition purpose.
- Needlessly public exports with no external importer are made module-private (clusters in `src/sidebar/shell.ts`, `src/sidebar/panes.ts`, `src/shell/state.ts`, `src/shell/url.ts`, and singletons elsewhere); symbols used by tests keep their export.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `watch-cli-startup`: the transitional "accept `--mode` with a deprecation warning" requirement is replaced by its own post-window rule — `--mode` is an unknown CLI argument. The usage text MUST NOT list `--mode`.
- `tree-filtering`: the "Warn about retired `.uatuignore` files on session start" requirement is removed; `.uatuignore` is simply an ordinary ignored filename with no special handling.

## Impact

- `src/server/session.ts` — `parseCommand` (drop the `--mode` branch), `usageText` (drop the flag line).
- `src/shell/state.ts` — delete legacy key constants and the migration/cleanup code that consumes them.
- `src/ignore/warning.ts` — delete the module, its test, and its call site in session startup.
- `src/sidebar/shell.ts`, `src/sidebar/panes.ts`, `src/shell/url.ts`, `src/shell/connection.ts`, `src/render/markdown.ts`, `src/terminal/pane-state.ts`, `src/terminal/client.ts`, `src/terminal/server.ts`, `src/sidebar/change-overview.ts` — de-export internal-only symbols.
- `README.md` — usage section reconciled with `--help`.
- Tests covering the `--mode` deprecation path and the `.uatuignore` warning are removed or inverted (unknown-flag rejection).
- No runtime behavior change for any documented, non-deprecated flag.
