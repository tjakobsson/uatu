# Context-window verification

Initial verification on October 5, 2026, started from main `6ee68368` with
local changes. Subsequent PR review checks are recorded below.

## Reproduced defects

Before product edits, the added tests demonstrated three failures:

- `claudeContextWindow("claude-unknown-99")` returned 200,000 instead of unknown.
- A failed catalog window read never recovered on subsequent reads.
- The browser kept showing 75% after the catalog changed from 200k to 1M while
  the same 150k usage message remained displayed.

The affected user's original Opus 5.5 session was not reproduced. Direct
promptless queries and Uatu's provider both returned 1M locally. This change
fixes the demonstrated discovery and delivery failures and adds bounded
diagnostics for investigating a future mismatch.

## Real Claude Code

CLI 2.1.281, SDK 0.3.286. The focused real-CLI test sends no prompt and checks
that settings stay byte-identical and no transcript is written.

- Opus 5.5 reported `maxTokens` and `rawMaxTokens` of 1,000,000, with an
  auto-compaction threshold of 967,000.
- Haiku 4.5 reported 200,000, with an auto-compaction threshold of 167,000.
- The served windows matched direct CLI answers for every matching offered
  model in the test.
- The latest recorded run returned its initial catalog in 571 ms and finished
  the background window walk in 7,292 ms while the full unit suite also ran.

These observations distinguish an effective context window from the separately
named auto-compaction threshold. They do not infer hard capacity from the
similar `maxTokens` and `rawMaxTokens` field names.

## Automated checks

- `bun run typecheck`: passed.
- `bun run test:ci`: 4,866 passed, 15 skipped, zero failed across 273 files,
  including the PR review follow-up below.
  Ran with system Git/SSH and projected Git configuration removed from the
  child environment, as the repository instructions require for credential tests.
- Focused Playwright suites `chat-claude-polish`, `chat-configuration`, and
  `chat-agents`: 61 passed. New scenarios cover live catalog correction,
  source-only confirmation, occupancy beyond an estimate, and reconnect on
  desktop and touch layouts.
- `bun run api:validate` and the API contract/revision tests: passed. Redocly
  retains its existing single-schema `allOf` warning for `WorkspaceConflict`.
- `bun run scripts/api-contract/structural.ts`: passed, 66 HTTP operations.
- API compatibility against HEAD: passed; only the workspace domain changed.
- `bun run api:swift`: generated and compiled successfully.
- Promptless real-CLI window test: passed, 23 assertions.
- `bun run check:licenses`: audited 618 installed packages successfully.
- `bun run audit`: passed its policy with no fixable advisories. It reported
  the existing unpatched `braces` advisory in the OpenSpec development dependency.
- `bun run build` and `bun run smoke`: passed, including compiled Hub startup,
  authenticated workspace startup, live document delivery, and an error-free SPA.
- `git diff --check`: passed.

Playwright screenshots live in `test-results/` and the HTML report. The desktop
and touch `context-limit-unavailable` and `context-limit-confirmed-during-turn`
captures were inspected. The limit-only item creates no timeline bubble; the
same 212,897 tokens change from an unavailable percentage to 21% of 1,000,000.

PR-time captures were regenerated with `UATU_E2E_SCREENSHOTS_DIR`, with each
layout in its own folder so identical capture names cannot overwrite one another:

- [Desktop, limit unavailable](screenshots/desktop/context-limit-unavailable.png)
- [Desktop, confirmed during the turn](screenshots/desktop/context-limit-confirmed-during-turn.png)
- [Touch, limit unavailable](screenshots/touch/context-limit-unavailable.png)
- [Touch, confirmed during the turn](screenshots/touch/context-limit-confirmed-during-turn.png)

Both targeted capture runs passed. The main Claude chat spec was synced and
all 56 main capability specs passed validation before archival.

## Contract and release classification

The public live payload is workspace revision 23, with Hub revision 10
unchanged. `api/CHANGELOG.md` documents strict-client migration for the new
data item, execution key, and catalog revision map. Model-list provenance and
availability revisions remain internal same-build workspace fields.

The incorrect universal 200k fallback exists in the latest stable release,
v0.7.0, verified directly from that tag. A future fix PR for this user-visible
correction therefore remains a visible `fix(chat)` release entry. The earlier
background catalog probe was added after that tag in #483; this change also
finishes its live-delivery and retry behavior.

## PR #492 review follow-up

Both review findings were reproduced with failing tests before their fixes:

- [Bound the actual session window read](https://github.com/tjakobsson/uatu/pull/492#discussion_r4186834677).
  The deadline now settles the logical waiter and releases its in-flight slot,
  even when the SDK request never settles. The configured retry budget still
  applies. A late SDK reply loses the race and cannot overwrite the retry's
  answer. Turn-end reports explicitly supersede pending discovery rather than
  spending their own timeout budget waiting for it.
- [Recheck the account epoch after the startup wait](https://github.com/tjakobsson/uatu/pull/492#discussion_r4186834681).
  Account changes release obsolete discovery waiters. Prompt delivery rechecks
  the epoch after waiting and starts the current account's read before queueing
  the prompt. Revalidation shares one total startup grace budget.

Six new cases cover a permanently hung request, a late timed-out reply,
account changes with both settling and hung old reads, recovery after the
summary retry budget is exhausted, and turn-end recovery while discovery is
still hanging. The focused provider/window/readout suite passed 237 tests;
typecheck and the full parallel unit/integration suite also passed. The archived
design and architecture guidance now describe bounded logical waiters rather
than assuming SDK control requests can be cancelled.

## Second review: recovery after a failed full report

[The second review](https://github.com/tjakobsson/uatu/pull/492#discussion_r4188313494)
found that a turn-end report could take over discovery, fail, and leave a
background or scheduled session without further summary retries. Six variants
reproduced that failure before the fix.

Full reports now return discovery to the shared summary retry scheduler when
the same live execution still needs a confirmed window. This covers turn-end
and on-demand reports. The original retry count and backoff budget survive
the handoff; cancelling a pending retry clears both its timer and its occupied
slot. Superseded reports cannot rearm discovery for a newer execution.

Eleven new cases cover rejection, timeout, invalid data, and occupancy without
a limit across both background and scheduled sessions, plus an already-queued
retry, on-demand recovery, and exhaustion of the original retry budget. The
focused provider/window/readout suite passed 248 tests; typecheck and the full
parallel suite passed with 4,844 tests and 15 skips.

## Third review: default caches and post-delivery account changes

Both findings were reproduced before the fixes:

- [Post-delivery account changes](https://github.com/tjakobsson/uatu/pull/492#discussion_r4189598435)
  now reset the window binding and restart discovery for queries held by live
  work or scheduled wakeups. Idle queries keep lazy revalidation on their next
  prompt. The startup wait follows a replaced readiness promise as well as the
  account epoch, preserving its total wait budget.
- [Default-model cache reuse](https://github.com/tjakobsson/uatu/pull/492#discussion_r4189598441)
  now matches private observation bindings rather than comparing a requested
  `default` with the attributed concrete model name. Unset and explicit default
  selections share an identity. The binding also retains the actual resolved
  model and known catalog resolution, so a known alias or variant change cannot
  inherit an unrelated limit. A fresh answer or usage naming another model
  supersedes the cached default; the current query's answer wins over a stale
  catalog default.

Eleven added regressions cover post-delivery discovery and background/scheduled
retry recovery, default caching during slow and failed reads, changed actual
defaults, and rejection of cache reuse across variant changes and alias
retargeting. The five initial regression cases failed before product edits.
The focused provider/window/readout suite passed 259 tests; typecheck passed;
the full parallel suite passed with 4,855 tests and 15 skips.

## Fourth review: catalog revisions on brokered reconnects

[The review finding](https://github.com/tjakobsson/uatu/pull/492#discussion_r4191941720)
identified that the Hub synthesized bare inventory ticks for joining or
reconnecting pages, dropping the catalog revisions the child had sent. The
broker now retains one latest inventory payload and uses it for these ticks,
including a lingering upstream. Reopening the child clears the retained
payload, and the legacy bare tick remains the fallback before fresh data.

Three regression cases failed before the fix. Coverage includes behind-head,
no-cursor, and foreign-epoch subscribers; shared and lingering upstreams;
legacy payloads; and clearing old revisions when the child reconnects.
The broker, endpoint, and live-stream integration suites passed 94 tests.
Typecheck, API validation, and the six-tab Hub live-stream browser/performance
test passed. The full parallel suite passed with 4,857 tests and 15 skips.

## Fifth review: window restoration on model-staging rollback

[The review finding](https://github.com/tjakobsson/uatu/pull/492#discussion_r4193577951)
identified that prompt-admission rollback restored the configuration and live
model controls but left window discovery bound to the abandoned selection.
Rollback now invalidates that selection's pending reads, restores the previous
window binding, and prepares discovery after restoring the surviving query's
controls. Unpinned conversations explicitly restore the default binding.

Six failing-before-fix cases cover unpinned, explicit-default, and pinned
conversations, with either a rejected model switch or a later missing-attachment
failure. The attachment cases also reproduced an abandoned model's late 200k
answer overwriting the original model's 1M denominator. The tests now verify
correct follow-up usage, fresh discovery, and rejection of those stale answers.
The focused provider/window/readout suite passed 265 tests; typecheck passed;
the full parallel suite passed with 4,863 tests and 15 skips.

## Sixth review: revisions received before catalog bootstrap finishes

[The review finding](https://github.com/tjakobsson/uatu/pull/492#discussion_r4193757479)
identified that an early inventory revision could be marked seen while the
initial catalog was still loading, leaving no bank to refresh. A DOM regression
reproduced the stale single-read result before the fix.

Received revisions now remain separate from each bank's last successful
refresh. Initial catalog installation starts any pending catch-up read and
repaints the meter. Duplicate in-flight revisions coalesce, newer revisions
can supersede older reads, and failed or discarded refreshes do not acknowledge
the revision. Agent-scoped refreshes use the target agent's capabilities.

Four DOM regressions cover bootstrap invalidation, failed-refresh retry,
out-of-order replies, and inactive-agent refresh. A real-browser regression
holds the first model response until the newer revision has arrived over the
live stream, then verifies an automatic catch-up read and the corrected meter.
The UI/lifecycle/refresh suites and typecheck passed. The focused browser suites
passed 61 tests, and the full parallel suite passed with 4,863 tests and 15
skips; the DOM cases run inside the existing isolated UI-file test process.

## Seventh review: matching invalidations during a failed refresh

[The review finding](https://github.com/tjakobsson/uatu/pull/492#discussion_r4194112554)
identified that a matching revision received during an in-flight refresh was
coalesced away even if that request later failed. Regression tests reproduced
the missing automatic retry.

Matching requests now retain one pending retry on the active refresh. Success
consumes the demand; failure replays it once if the bank and revision remain
current. A failed retry stops without further invalidations. Reconnect and
picker reads participate in the same ownership tracking, so a superseded
request cannot replace its successor or lose demand that arrived during it.

The eight catalog-revision DOM cases pass, including four new cases covering
coalesced retry, stopping after retry failure, and request ownership across
reconnect. Typecheck, the full parallel suite with 4,863 tests and 15 skips,
and all 61 focused browser tests passed.

## Eighth review: ownership of replacement catalog walks

[The review finding](https://github.com/tjakobsson/uatu/pull/492#discussion_r4196708158)
identified that an obsolete catalog walk could clear the replacement's shared
handle after an account change. Cleanup now closes its own query first and
releases the shared handle or schedules retries only if it still owns that
handle. The settlement helper follows any replacement installed while waiting.

Three regression cases failed before the fix. They cover settlement beginning
before or after replacement, repeated catalog reads while the replacement is
blocked, stale results staying out of the current catalog, and keeping ownership
until query cleanup completes. The focused provider/window/readout suite passed
268 tests and typecheck passed. The full parallel suite passed with 4,866 tests
and 15 skips. The promptless real-Claude catalog test passed again with 23
assertions, unchanged settings, and no transcript created.
