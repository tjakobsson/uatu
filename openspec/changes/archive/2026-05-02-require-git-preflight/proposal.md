## Why

Starting `uatu` from a broad non-project directory such as a user's home directory can spend a long time recursively preparing file watching and indexing before the UI appears. Requiring git-backed roots by default gives users a fast, understandable guardrail that matches `uatu`'s codebase-watcher intent while still allowing explicit overrides.

## What Changes

- Require each watched path to be inside a git worktree before starting the server or watcher.
- Add a `--force` startup flag that allows non-git roots anyway and prints a clear warning that indexing may be slow.
- Show an interactive indexing status while startup indexing is in progress, then replace it with the existing startup logo and URL once the session is ready.
- Report all non-git roots in the startup error or warning so multi-root sessions are understandable.
- Show loaded review scoring configuration even when configured risk, support, or ignore areas do not match the current change.
- **BREAKING**: Non-git directories and files are rejected by default unless `--force` is provided.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `document-watch-browser`: Change watch startup requirements to require git-backed roots by default, add the `--force` override, and define interactive indexing status behavior.
- `change-review-load`: Show configured review scoring areas even when they do not affect the current score.

## Impact

- `src/server.ts`: command parsing, watch option model, path/git preflight helpers, startup status helpers, and related unit coverage.
- `src/cli.ts`: startup order and output flow so preflight occurs before watching, indexing status appears during startup, and warnings/errors remain user-friendly.
- `README.md`: CLI usage and watch-root behavior documentation.
- `openspec/specs/document-watch-browser/spec.md`: startup behavior requirements and scenarios.
- `src/shared.ts`, `src/review-load.ts`, `src/app.ts`: review-load payload and UI rendering for unmatched configured areas.
- `openspec/specs/change-review-load/spec.md`: review configuration visibility requirements and scenarios.
