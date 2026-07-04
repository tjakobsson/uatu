# Split the server/session god-file and centralize the fetch fallback

## Why

`src/server/session.ts` is 1,501 lines carrying five to six unrelated responsibilities — CLI parsing, startup banners, filesystem scanning, document render dispatch, static-file security, HTTP navigation, browser launching, and the live-reload engine — which makes ARCHITECTURE.md's claim that "cli.ts owns flag parsing" false and every change to any one concern risk the others. Separately, the "route table declared once" convention has already been violated in the way it predicted: the `/api/terminal`, `/api/auth`, and terminal-sessions fetch-fallback handlers are duplicated near-verbatim between `src/cli.ts` and `tests/e2e/server.ts`.

## What Changes

- `src/server/session.ts` is dissolved into cohesive modules, each with its colocated test:
  - CLI argument parsing, usage text, version text, ASCII banner, and TTY status printers move to a new `src/cli/` domain folder (the `src/cli.ts` entrypoint stays at the root and imports from it).
  - The live-reload engine (`createWatchSession`, watcher ignore predicate, crash guard, fingerprinting) moves to `src/server/watch-session.ts`.
  - Root resolution and filesystem scanning (`resolveWatchRoots`, `findNonGitWatchEntries`, `scanRoots`, `walkAllFiles`) move to `src/server/roots.ts`.
  - Document render dispatch (`renderDocument`) moves to `src/server/render-dispatch.ts`.
  - Static-file resolution and its security checks (`resolveStaticFileRequest`, `isSecretName`, `shouldDenyPath`, `isPathInsideRoot`) move to `src/server/static-files.ts`.
  - SPA navigation handling (`createNavigationFetchHandler`, `spaShellResponse`) and `openBrowser` move to `src/server/navigation.ts`.
- The WebSocket-upgrade/auth/sessions fetch fallback becomes a single `buildFetchFallback(deps)` in `src/server/routes.ts` (or a sibling module), consumed by both `src/cli.ts` and `tests/e2e/server.ts` — ending the current duplication.
- ARCHITECTURE.md and CLAUDE.md folder maps are updated to match reality.
- No behavior change: same routes, same flags, same output. This is a pure decomposition.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `module-structure`: the "HTTP route table is declared in exactly one place" requirement is extended to cover the fetch-fallback handlers (`/api/terminal`, `/api/auth`, `/api/terminal/sessions`) via a shared builder; a new requirement pins the server-core decomposition (no `server/session.ts` god-file; CLI parsing lives in `src/cli/`).

## Impact

- `src/server/session.ts` — deleted; ~25 importers across `src/` and `tests/` update their import paths.
- `src/cli.ts`, `tests/e2e/server.ts` — inline fetch-fallback handlers replaced by the shared builder.
- `src/server/routes.ts` — gains `buildFetchFallback(deps)`.
- New files: `src/cli/parse.ts`, `src/cli/output.ts`, `src/server/watch-session.ts`, `src/server/roots.ts`, `src/server/render-dispatch.ts`, `src/server/static-files.ts`, `src/server/navigation.ts` (exact grouping may be refined during implementation; the constraint is cohesion, not the precise file count).
- `src/server/session.test.ts` — split alongside its subjects.
- ARCHITECTURE.md, CLAUDE.md — folder-map updates.
- **Sequencing**: best landed after `rename-watch-to-serve` to avoid moving code that change is editing (parser, usage text). Behavior-neutral, so the full unit + e2e suites are the safety net.
