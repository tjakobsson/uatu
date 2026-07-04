## 1. Remove the --mode flag

- [ ] 1.1 Delete the `--mode` branch from `parseCommand` in `src/server/session.ts` so it falls through to `unknown flag: --mode`
- [ ] 1.2 Remove the `--mode <MODE>` lines from `usageText` (usage synopsis and options list)
- [ ] 1.3 Update `src/server/session.test.ts`: replace the deprecation-warning test with an unknown-flag rejection test; assert `usageText()` does not contain `--mode`

## 2. Remove legacy localStorage migration keys

- [ ] 2.1 Delete `LEGACY_MODE_KEY`, `LEGACY_SIDEBAR_PANES_KEY_AUTHOR/REVIEW`, `LEGACY_FILES_PANE_FILTER_KEY_AUTHOR/REVIEW` and the cleanup code consuming them from `src/shell/state.ts`
- [ ] 2.2 Remove any tests exercising the legacy-key migration path

## 3. Remove the .uatuignore warning

- [ ] 3.1 Delete `src/ignore/warning.ts` and its colocated test
- [ ] 3.2 Remove the warning call site from session startup in `src/server/session.ts`
- [ ] 3.3 Remove the `.uatuignore` warning scenarios from any e2e coverage that asserts the stderr advisory

## 4. Prune needlessly public exports

- [ ] 4.1 De-export internal-only symbols in `src/sidebar/shell.ts` (width/collapse helpers) and `src/sidebar/panes.ts`
- [ ] 4.2 De-export internal-only symbols in `src/shell/state.ts`, `src/shell/url.ts`, `src/shell/connection.ts`
- [ ] 4.3 De-export internal-only symbols in `src/render/markdown.ts`, `src/terminal/pane-state.ts`, `src/terminal/client.ts`, `src/terminal/server.ts`, `src/sidebar/change-overview.ts`; keep exports consumed by colocated tests
- [ ] 4.4 Delete any symbol with zero references anywhere (including its own module)

## 5. Reconcile documentation

- [ ] 5.1 Rewrite the README Usage section to match `usageText` exactly (add `--debug`, `--no-watchdog`, `--watchdog-timeout`; mention `UATU_DEBUG`)
- [ ] 5.2 Grep README/ARCHITECTURE.md/CLAUDE.md for `--mode`, `.uatuignore`, author/review mode remnants and remove them

## 6. Verify

- [ ] 6.1 `bun test` passes
- [ ] 6.2 `bun run build` compiles (catches any de-export that something still imports)
- [ ] 6.3 `bun run test:e2e` passes
- [ ] 6.4 `bunx openspec validate --change remove-deprecated-leftovers` passes
