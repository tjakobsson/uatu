# Context-window verification

Verified on October 5, 2026, starting from main `6ee68368` with local changes.

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
- The final recorded run returned its initial catalog in 763 ms and finished
  the background window walk in 7,946 ms while the full unit suite also ran.

These observations distinguish an effective context window from the separately
named auto-compaction threshold. They do not infer hard capacity from the
similar `maxTokens` and `rawMaxTokens` field names.

## Automated checks

- `bun run typecheck`: passed.
- `bun run test:ci`: 4,833 passed, 15 skipped, zero failed across 273 files,
  including the PR review follow-up below.
  Ran with system Git/SSH and projected Git configuration removed from the
  child environment, as the repository instructions require for credential tests.
- Focused Playwright suites `chat-claude-polish`, `chat-configuration`, and
  `chat-agents`: 60 passed. New scenarios cover live catalog correction,
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
