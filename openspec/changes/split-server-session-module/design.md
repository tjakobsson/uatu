# Design — split-server-session-module

## Context

`src/server/session.ts` (1,501 lines) accreted into the server core: CLI parsing, banners, scanning, rendering, static-file security, navigation, browser launching, and the live-reload engine all live there. Two documented conventions are currently false: ARCHITECTURE.md says `cli.ts` owns flag parsing (it doesn't — session.ts does), and the module-structure spec says the route surface is declared once (the terminal/auth fetch fallback is duplicated between `src/cli.ts:308-329` and `tests/e2e/server.ts:167-180`).

## Goals / Non-Goals

**Goals:**
- Each server concern in its own module with its colocated test; `session.ts` gone.
- CLI parsing/usage/banner in a `src/cli/` domain folder, making the documented ownership true.
- One shared fetch-fallback builder consumed by both server entry points.
- Zero behavior change — same flags, output, routes, and responses.

**Non-Goals:**
- No renames of types or functions beyond what the file moves force (e.g. `WatchSession` keeps its name; the `rename-watch-to-serve` follow-up owns vocabulary).
- No decomposition of `src/terminal/panel.ts` (a separate candidate, out of scope).
- No route additions/removals; no change to `buildRoutes`' mode semantics.

## Decisions

- **A `src/cli/` folder rather than folding parsing into `src/cli.ts`.** The entrypoint executes `void main()` at module load, so unit tests can't import it; parsing must stay in an importable side-effect-free module. Keeping it under `src/server/` is what made the docs false, so a small CLI domain folder (`parse.ts`, `output.ts`) is the honest home. `src/cli.ts` stays at the root per the module-structure spec's entrypoint rule.
- **Six server modules, grouped by lifecycle stage** (`roots.ts` → `watch-session.ts` → `render-dispatch.ts` / `static-files.ts` / `navigation.ts`, with `routes.ts` untouched apart from gaining `buildFetchFallback`). The grouping follows the seams already visible in the file's section comments; implementation may merge two of these if a hard circular dependency appears, but may not merge back CLI, watching, and HTTP concerns.
- **`buildFetchFallback(deps)` mirrors `buildRoutes(deps)`.** Same deps-injection pattern, same prod/e2e parameterization, declared in `src/server/routes.ts` so route-surface grep still lands on one file. The WebSocket `upgrade()` call needs the live `Bun.serve` server handle, so the builder returns a `(request, server) => Response | undefined` closure rather than a route-table entry.
- **Move-only migration, verified by the existing suites.** No logic edits ride along. The unit suite, the e2e suite (which exercises terminal auth/upgrade paths), and a compiled-binary smoke run are the acceptance gate; `git log --follow` keeps history usable across the moves.

## Risks / Trade-offs

- [Hidden circular imports surface during the split (session.ts currently hides them inside one module)] → Split in dependency order (leaf modules first: static-files, roots), keep shared types in `src/shared/types.ts` or a small `src/server/types.ts`, and let `tsc`/`bun run build` catch cycles per step.
- [~25 import sites churn in one PR, making review noisy] → Keep the PR mechanically structured: one commit per extracted module, no logic edits, so each commit diffs as pure moves.
- [The compiled-binary route analysis (`"/": index` literal constraint in cli.ts) breaks if fetch wiring changes shape] → The `"/": index` literal and the `routes:` table in `cli.ts` are untouched; only the `fetch:` property's body is replaced by the builder call. Verified by `bun run smoke`.
- [e2e harness deps differ from prod (token access, terminal server instance)] → `buildFetchFallback(deps)` takes the same getter-style deps `buildRoutes` already uses; the e2e server passes its own getters as it does today.

## Migration Plan

Single PR, sequenced after `rename-watch-to-serve` (which edits `parseCommand`/`usageText` — moving and editing the same code in parallel branches would conflict). Commit order: extract leaf modules → extract watch-session → introduce `buildFetchFallback` and switch both entry points → delete `session.ts` → update ARCHITECTURE.md/CLAUDE.md maps. Rollback is a revert; no state or data involved.

## Open Questions

None.
