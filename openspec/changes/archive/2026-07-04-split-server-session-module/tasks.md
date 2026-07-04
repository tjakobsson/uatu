## 1. Extract leaf modules

- [x] 1.1 Create `src/server/static-files.ts` (static resolution + `isSecretName`/`shouldDenyPath`/`isPathInsideRoot`) with its tests
- [x] 1.2 Create `src/server/roots.ts` (`resolveWatchRoots`, `findNonGitWatchEntries`, `scanRoots`, `walkAllFiles`, `WatchEntry` type) with its tests
- [x] 1.3 Create `src/server/render-dispatch.ts` (`renderDocument` + render-related types) with its tests

## 2. Extract the CLI domain

- [x] 2.1 Create `src/cli/parse.ts` (`parseCommand`, `usageText`, `versionText`, option types) with its tests
- [x] 2.2 Create `src/cli/output.ts` (`STARTUP_BANNER`, `printStartupBanner`, `printIndexingStatus`, build identifier) with its tests
- [x] 2.3 Point `src/cli.ts` at the new modules

## 3. Extract the live-reload engine and navigation

- [x] 3.1 Create `src/server/watch-session.ts` (`createWatchSession`, ignore predicate, crash guard, fingerprint cache, SSE plumbing) with its tests
- [x] 3.2 Create `src/server/navigation.ts` (`createNavigationFetchHandler`, `spaShellResponse`, `openBrowser`) with its tests
- [x] 3.3 Update all remaining importers of `src/server/session` across `src/` and `tests/`, then delete `src/server/session.ts` and `src/server/session.test.ts`

## 4. Centralize the fetch fallback

- [x] 4.1 Add `buildFetchFallback(deps)` to `src/server/routes.ts` covering `/api/terminal` upgrade, `/api/auth` GET/POST, `/api/terminal/sessions`, and delegation to the navigation handler
- [x] 4.2 Replace the inline handlers in `src/cli.ts` with the builder (leave the `"/": index` literal and `routes:` table untouched)
- [x] 4.3 Replace the duplicated handlers in `tests/e2e/server.ts` with the same builder

## 5. Documentation

- [x] 5.1 Update ARCHITECTURE.md: folder tour, request-lifecycle diagram labels, and the now-true "cli.ts/cli/ owns flag parsing" statement
- [x] 5.2 Update CLAUDE.md's src/ folder map (add `cli/`, revise `server/` line)

## 6. Verify

- [x] 6.1 `bun test` passes with tests colocated next to their moved subjects
- [x] 6.2 `bun run test:e2e` passes (terminal auth/upgrade paths exercise the shared fallback)
- [x] 6.3 `bun run build && bun run smoke` — compiled binary serves `/`, chunks, and the terminal upgrade as before; `--help` output unchanged
- [x] 6.4 `bunx openspec validate split-server-session-module` passes
