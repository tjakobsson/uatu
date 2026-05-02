## 1. Command Model And Preflight

- [x] 1.1 Extend `WatchOptions` and `parseCommand` to support `--force`, including usage text and unit coverage.
- [x] 1.2 Add a git preflight helper that checks each resolved watch entry's directory with `git rev-parse --show-toplevel` and returns all non-git entries.
- [x] 1.3 Make startup reject non-git watch entries by default with one clear error listing every offending path and mentioning `--force`.
- [x] 1.4 Make startup allow non-git watch entries under `--force` while printing a warning to stderr that indexing may be slow.

## 2. Startup Output

- [x] 2.1 Add a TTY-only indexing status helper that writes a single-line indexing message before initial watcher/index startup.
- [x] 2.2 Clear the indexing status before printing the existing ASCII logo and URL once the watch session is ready.
- [x] 2.3 Preserve URL-only stdout behavior when stdout is not a TTY, with warnings and errors kept off stdout.

## 3. CLI Startup Flow

- [x] 3.1 Update `src/cli.ts` so path resolution and git preflight run before `createWatchSession().start()`.
- [x] 3.2 Ensure missing paths, denied paths, and binary file paths still fail before server or watcher startup.
- [x] 3.3 Keep browser auto-open behavior unchanged after the session is ready and the URL has been printed.

## 4. Documentation And Validation

- [x] 4.1 Update `README.md` usage docs to describe the git-backed default prerequisite and `--force` override.
- [x] 4.2 Update the review-load payload to expose configured risk, support, and ignore areas separately from score drivers.
- [x] 4.3 Render loaded configured areas in the score explanation or Change Overview even when no files match them, clearly marking unmatched areas as zero-impact.
- [x] 4.4 Add or update unit tests for git-backed roots, non-git rejection, `--force` warnings, multi-root reporting, TTY/non-TTY startup output, and unmatched configured review areas.
- [x] 4.5 Run `bun test` and `bun run build`, fixing any regressions introduced by the change.
