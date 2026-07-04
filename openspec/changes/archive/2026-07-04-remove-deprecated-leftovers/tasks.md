## 1. Remove the --mode flag

- [x] 1.1 Delete the `--mode` branch from `parseCommand` in `src/server/session.ts` so it falls through to `unknown flag: --mode`
- [x] 1.2 Remove the `--mode <MODE>` lines from `usageText` (usage synopsis and options list)
- [x] 1.3 Update `src/server/session.test.ts`: replace the deprecation-warning test with an unknown-flag rejection test; assert `usageText()` does not contain `--mode`

## 2. Remove legacy localStorage migration keys

- [x] 2.1 Delete `LEGACY_MODE_KEY`, `LEGACY_SIDEBAR_PANES_KEY_AUTHOR/REVIEW`, `LEGACY_FILES_PANE_FILTER_KEY_AUTHOR/REVIEW` and the cleanup code consuming them from `src/shell/state.ts`
- [x] 2.2 Remove any tests exercising the legacy-key migration path

## 3. Remove the .uatuignore warning

- [x] 3.1 Delete `src/ignore/warning.ts` and its colocated test
- [x] 3.2 Remove the warning call site from session startup in `src/server/session.ts`
- [x] 3.3 Remove the `.uatuignore` warning scenarios from any e2e coverage that asserts the stderr advisory

## 4. Prune needlessly public exports

- [x] 4.1 De-export internal-only symbols in `src/sidebar/shell.ts` (width/collapse helpers) and `src/sidebar/panes.ts`
- [x] 4.2 De-export internal-only symbols in `src/shell/state.ts`, `src/shell/url.ts`, `src/shell/connection.ts`
- [x] 4.3 De-export internal-only symbols in `src/render/markdown.ts`, `src/terminal/pane-state.ts`, `src/terminal/client.ts`, `src/terminal/server.ts`, `src/sidebar/change-overview.ts`; keep exports consumed by colocated tests
- [x] 4.4 Delete any symbol with zero references anywhere (including its own module)

## 5. Reconcile documentation

- [x] 5.1 Rewrite the README Usage section to match `usageText` exactly (add `--debug`, `--no-watchdog`, `--watchdog-timeout`; mention `UATU_DEBUG`)
- [x] 5.2 Grep README/ARCHITECTURE.md/CLAUDE.md for `--mode`, `.uatuignore`, author/review mode remnants and remove them

## 6. Verify

- [x] 6.1 `bun test` passes
- [x] 6.2 `bun run build` compiles (catches any de-export that something still imports)
- [x] 6.3 `bun run test:e2e` passes
- [x] 6.4 `bunx openspec validate --change remove-deprecated-leftovers` passes
