# simplify-repo-config — tasks

## 1. Rename tree → ignore and consolidate the loader

- [x] 1.1 Move `src/sidebar/tree-config.ts` (+test) to `src/ignore/config.ts`, reading the `ignore` block (`exclude`, `respectGitignore`) with unchanged validation/warnings; update `ignore/engine.ts` to import locally.
- [x] 1.2 Update `watch-session.ts` matcher-cache invalidation comment/paths and any other `loadTreeConfig` importers; keep live re-read behavior verbatim.
- [x] 1.3 Update unit + e2e fixtures (`testdata/`, `tests/`) from `tree.*` to `ignore.*`; add the legacy-`tree`-block-not-read test.

## 2. Delete the mono block

- [x] 2.1 Delete `src/mono/config.ts` (+test) and the `monoConfig` loading in `cli.ts`.
- [x] 2.2 Remove `monoConfig` from the state payload (`shared/types.ts`, `watch-session.ts`) and the `applyMonoConfig` call sites in `shell/boot.ts`/`shell/events.ts`; dissolve `src/mono/` if `apply.ts` has no remaining caller.
- [x] 2.3 Confirm `--mono-font-family` default in `styles.css` is the sole source; run the no-hardcoded-stack grep check from the mono-font spec.

## 3. Delete the terminal block

- [x] 3.1 Delete `src/terminal/config.ts` (+test) and `terminalConfig` from payload assembly and `shared/types.ts`.
- [x] 3.2 Remove payload-driven font/size application in the terminal client; the CSS default chain and the touch runtime font-size control remain.
- [x] 3.3 Fix the clipboard policy at `notify`: delete `confirm`/`silent`/`off` branches and the `TerminalClipboardPolicy` plumbing; keep toast, coalescing, size-cap feedback, and the blocked-write Copy-button fallback.
- [x] 3.4 Update terminal unit + e2e suites: drop config-driven scenarios, keep bundled-default and OSC 52 behavior coverage.

## 4. Docs and verification

- [x] 4.1 Update `CLAUDE.md` (folder map: `mono/` gone or shrunk, `ignore/` owns config; `.uatu.json` description), `ARCHITECTURE.md`, README, and any `.uatu.json` examples.
- [x] 4.2 Full `bun test` and `bun test:e2e` green; manual dev pass confirms identical rendering with no `.uatu.json` present.
- [x] 4.3 Release-note prep: one visible entry — `.uatu.json` reduced to `ignore` (renamed from `tree`); `mono`/`terminal` blocks retired.
