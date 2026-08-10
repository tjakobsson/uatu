## Why

Four small review findings were deferred to the 0.5.0 debt paydown
([#211](https://github.com/tjakobsson/uatu/issues/211),
[#213](https://github.com/tjakobsson/uatu/issues/213),
[#214](https://github.com/tjakobsson/uatu/issues/214),
[#217](https://github.com/tjakobsson/uatu/issues/217)). Each is a gap between
promised and actual behavior, or dead weight left behind by a removed feature —
none warrants its own change, together they close out the milestone's hardening
debt in one pass.

## What Changes

- **Monotonic scheduler clock (#211):** the watch-refresh scheduler's max-wait
  deadline uses `Date.now()`; a backwards wall-clock step during sustained file
  churn can grow `deadline - now` again and defer refresh past the 2 s
  starvation bound. Swap the real clock's `now` to `performance.now()` via the
  existing clock seam.
- **Empty `.uatu.json` warns (#213):** `collectConfigWarnings` skips
  `JSON.parse` when the file reads as `""`, so a zero-byte `.uatu.json` is
  silently treated as valid. Distinguish "missing/unreadable" (`null`) from
  "empty string" so an empty file produces the promised parse warning.
- **Ignore-validation warnings reach the session (#217):**
  `loadIgnoreMatcher` discards the `warnings` array that `loadIgnoreConfig`
  returns for invalid `ignore.exclude` / `ignore.respectGitignore` shapes, so
  those warnings never reach `RepositorySnapshot.configWarnings` or the Change
  Overview despite the tree-filtering spec's "the session emits a settings
  warning" scenarios. Thread them into the session's config warnings.
- **Prune the dead score CSS tokens (#214, rescoped):** `--score-low-*` AND
  `--score-high-*` are both unused after the review-burden removal (the issue
  predates the stale-client notice, which consumes only `--score-medium-*`).
  Delete the four dead variables and rename the surviving medium pair to
  severity-neutral names — the `score` prefix is the last trace of the removed
  review-burden vocabulary.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `tree-filtering`: strengthen the `.uatu.json` warning contract — an empty
  (zero-byte or whitespace-only) `.uatu.json` SHALL produce the same parse
  warning as malformed JSON, and shape-validation warnings SHALL surface in
  the session's config warnings (the Change Overview), not just at the loader
  level.

## Impact

- `src/server/watch-session.ts` — `realClock.now` swaps to `performance.now()`
  (one line; the fake clock in `watch-session.test.ts` is source-agnostic).
- `src/document/git-data.ts` — `collectConfigWarnings` empty-file guard, plus
  appending `loadIgnoreConfig` warnings (dedup against its own read/parse
  warnings).
- `src/ignore/config.ts` / `src/ignore/engine.ts` — warning source of truth;
  no behavior change to matching itself.
- `src/styles.css` — token prune + rename; the two consumers are
  `.config-warning` and the stale-client notice.
- No public API, CLI, or dependency changes. All four fixes stabilize
  post-v0.4.0 work, so the PR carries a Release Please override
  (`chore(cleanup): …`) per the release-note discipline.
