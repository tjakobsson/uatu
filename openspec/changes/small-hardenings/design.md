## Context

Four deferred review findings, all post-v0.4.0 (unreleased):

- `createRefreshScheduler` (`src/server/watch-session.ts`) computes its
  max-wait deadline from `Date.now()` through a `RefreshSchedulerClock` seam
  introduced by PR #210.
- `.uatu.json` warnings are split across two readers by design:
  `loadIgnoreConfig` (`src/ignore/config.ts`) emits read-failure and
  `ignore`-shape warnings but deliberately not parse warnings ("git-data.ts
  already surfaces a parse warning; don't double-warn"), while
  `collectConfigWarnings` (`src/document/git-data.ts`) emits read + parse
  warnings only. The seam has two holes: `loadIgnoreMatcher` discards the
  loader's warnings (#217), and both readers use a truthiness guard that
  swallows an empty file (#213).
- `--score-low-*` and `--score-high-*` in `src/styles.css` lost their last
  consumers with the review-burden removal (#212); only `--score-medium-*`
  survives, used by `.config-warning` (~line 2706) and the stale-client
  notice (~line 4095).

## Goals / Non-Goals

**Goals:**

- Refresh max-wait deadline immune to wall-clock steps.
- Every `.uatu.json` problem — unreadable, malformed (including empty),
  invalid `ignore` shape — reaches `RepositorySnapshot.configWarnings`
  exactly once.
- No dead `--score-*` tokens; surviving tokens named severity-neutrally.

**Non-Goals:**

- No change to ignore matching, refresh cadence, or the debounce/max-wait
  constants.
- No tokenization of the warning text color the two CSS consumers duplicate
  (`light-dark(#6f4e00, #eac54f)`) — rename only, per #214's scope.
- No live re-render of config warnings mid-session beyond what refresh
  already does.

## Decisions

1. **One warning source of truth: `loadIgnoreConfig`.** Move the parse
   warning into the loader (deleting the "don't double-warn" split) and have
   `collectConfigWarnings` delegate to it, dropping git-data's own
   `readFile`/`JSON.parse`. Fixes #217 without threading warnings through
   `loadIgnoreMatcher`/the watch session, and makes the dedup scenario true
   structurally rather than via filtering. *Alternative rejected:* appending
   the loader's warnings to git-data's own list — keeps two readers of the
   same file that must stay string-identical to dedup, which is exactly the
   drift that produced #217.
2. **Empty-file fix lives in the loader.** Replace `if (!source)` with
   `if (source === null)`; `JSON.parse("")` then throws and produces the
   parse warning naturally. Fixes #213 for both former call paths at once.
3. **Scheduler clock swaps to `performance.now()`** in `realClock.now` only.
   The scheduler consumes durations (`deadline - now`), never epoch values,
   so the origin change is invisible; `generatedAt` and the
   `refresh.last_*` metrics keep `Date.now()` because they are wall-clock
   timestamps by meaning. The fake clock in `watch-session.test.ts` is
   already source-agnostic.
4. **CSS tokens: delete `--score-low-*`/`--score-high-*`, rename
   `--score-medium-*` → `--notice-warn-*`.** Both consumers are
   warning-toned notices, so the name says what the token is for rather
   than where it ranked in a removed scoring scale.

## Risks / Trade-offs

- [Delegating `collectConfigWarnings` changes warning strings' origin] →
  keep the exact existing message shapes ("Could not read .uatu.json: …",
  "Invalid .uatu.json: …") so snapshot consumers and tests see identical
  text.
- [`performance.now()` returns fractional ms] → the scheduler only compares
  and subtracts; `setTimeout` accepts fractional delays. No truncation
  needed.
- [Renamed CSS variables missed at a call site] → grep for `--score-` must
  come back empty after the rename; trivial to enforce in review.

## Open Questions

_None — all four fixes have a single obvious shape once the warning source
of truth is unified._
