## 1. Monotonic scheduler clock (#211)

- [x] 1.1 Swap `realClock.now` in `src/server/watch-session.ts` from `Date.now()` to `performance.now()`; leave `generatedAt` and the `refresh.last_*` metrics on `Date.now()` (wall-clock timestamps by meaning).
- [x] 1.2 Update any scheduler comments/test comments that name `Date.now()` as the deadline source; confirm the fake clock in `watch-session.test.ts` needs no change.

## 2. One `.uatu.json` warning source of truth (#213, #217)

- [x] 2.1 In `src/ignore/config.ts`, change the post-read guard from `if (!source)` to `if (source === null)` so an empty/whitespace-only file reaches `JSON.parse` and warns.
- [x] 2.2 Move the parse warning into `loadIgnoreConfig` (message shape `Invalid .uatu.json: <error>`), removing the "git-data.ts already surfaces a parse warning" split; update the module comment to say the loader is the single warning source.
- [x] 2.3 Rewrite `collectConfigWarnings` in `src/document/git-data.ts` to delegate to `loadIgnoreConfig` and return its warnings, dropping the local `readFile`/`JSON.parse`; keep the existing message shapes byte-identical.
- [x] 2.4 Extend `src/ignore/config.test.ts`: empty file warns, whitespace-only file warns, malformed JSON warns from the loader, missing file does not warn, shape warnings unchanged.
- [x] 2.5 Extend `src/document/git-data.test.ts`: snapshot config warnings include shape-validation warnings (invalid `ignore.exclude` / `ignore.respectGitignore`), the empty-file parse warning, and exactly one warning per underlying problem.

## 3. Severity-neutral notice tokens (#214)

- [x] 3.1 Delete `--score-low-border`, `--score-low-bg`, `--score-high-border`, `--score-high-bg` from `src/styles.css`.
- [x] 3.2 Rename `--score-medium-bg`/`--score-medium-border` to `--notice-warn-bg`/`--notice-warn-border` at the definition and both consumers (`.config-warning`, the stale-client notice); verify `grep -- --score- src/styles.css` comes back empty.

## 4. Per-watch-root collection (Codex review finding)

- [x] 4.1 Add `configRoots` to `RepositoryGroup` (dir watch roots only) and populate it in group detection for git, shared-repo, and non-git groups.
- [x] 4.2 Collect warnings across `configRoots` in `collectConfigWarnings` (realpath-normalized repo-relative prefix for roots below the top; exact-duplicate dedup) and before the git/non-git branch in `snapshotGroup`, threading them into `unavailableSnapshot`.
- [x] 4.3 Render config warnings in the Change Overview's non-git/unavailable branch.
- [x] 4.4 Tests: subdir watch root warns with prefix, repo-top file not consulted, non-git root warns, single-file root produces no warnings.

## 5. Verification

- [x] 5.1 Run `bun test` and confirm the suite passes.
- [x] 5.2 Manual spot check via `bun run dev`: an empty `.uatu.json` in `testdata/watch-docs` shows a parse warning in the Change Overview, and an `ignore.exclude: "nope"` shows the shape warning; both styled as before.

All four fixes stabilize unreleased post-v0.4.0 work, so the PR body must
carry a Release Please override (`chore(cleanup): …`) per the release-note
discipline; the PR closes
[#211](https://github.com/tjakobsson/uatu/issues/211),
[#213](https://github.com/tjakobsson/uatu/issues/213),
[#214](https://github.com/tjakobsson/uatu/issues/214), and
[#217](https://github.com/tjakobsson/uatu/issues/217).
