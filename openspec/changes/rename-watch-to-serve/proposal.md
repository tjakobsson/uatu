# Rename `uatu watch` to `uatu serve`

## Why

"watch" describes the original mechanism (a file watcher), not what uatu became: a local server that previews docs, scores review burden, hosts a terminal, and follows an AI agent's work — the verb users actually experience is **Follow**, and the runtime is a `Bun.serve` loop. Docs-preview tools have strong precedent for `serve` (`mkdocs serve`, `jekyll serve`, `hugo server`), and freeing the verb namespace keeps room for future subcommands.

## What Changes

- `uatu serve [PATH...]` becomes the canonical command, accepting exactly the flag surface `uatu watch` has today.
- **BREAKING**: bare `uatu [PATH...]` — including `uatu` with no arguments — defaults to `serve` instead of printing help. Help remains on `-h`/`--help`.
- `uatu watch` becomes a deprecated alias for one release: identical behavior plus a one-line stderr deprecation warning, mirroring the `--mode` sunset pattern. The release after, `watch` is treated as an ordinary positional path.
- Startup surfaces (usage text, error messages like "watch root does not exist") adopt serve/root vocabulary.
- README, ARCHITECTURE.md, CLAUDE.md, and the `bun run dev` script move to `serve`.
- Internal type renames (`WatchSession`, `WatchOptions`, `WatchEntry`, `createWatchSession`, …) are explicitly deferred — user-facing surface only in this change.

## Capabilities

### New Capabilities

- `serve-cli-startup`: the full CLI startup surface under the `serve` verb — session start rules (paths, git preflight, `--force`, `--no-gitignore`), the bare-invocation default, the deprecated `watch` alias, browser/follow startup behavior, and diagnostic flags. Supersedes `watch-cli-startup`.

### Modified Capabilities

- `watch-cli-startup`: all requirements removed — superseded in full by `serve-cli-startup`.

## Impact

- `src/server/session.ts` — `parseCommand` (accept `serve`, bare default, `watch` alias with warning), `usageText`, error-message wording.
- `src/cli.ts` — no structural change; `runWatch` naming can trail.
- `package.json` — `"dev": "bun run src/cli.ts serve"`.
- `tests` — unit tests for `parseCommand` gain serve/bare/alias cases; e2e harness unaffected (it doesn't go through the CLI verb).
- Docs: README (install/usage/watchdog sections), ARCHITECTURE.md (30-second map, run/test), CLAUDE.md (commands).
- **Sequencing**: depends on `remove-deprecated-leftovers` landing first — the new `serve-cli-startup` spec is written against the post-`--mode` state of the CLI, and stacking both deltas on `watch-cli-startup` concurrently would conflict at sync time.
- Capability folder renames for `document-watch-index` and `watch-freeze-diagnostics` are out of scope (their requirements don't define the CLI verb); a follow-up docs change can sweep scenario prose.
