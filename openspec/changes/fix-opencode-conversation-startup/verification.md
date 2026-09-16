# Implementation verification

## Outcome and cause

Implemented one-shot remembered-conversation restoration in
[`src/chat/ui.ts`](../../../src/chat/ui.ts). Empty bootstrap previously retained
the saved ID without opening it; later inventory patched the chooser but only
opened conversations through deletion recovery, which bootstrap had never entered.

The UI now retains an exact-ID startup intent, consumes it before the normal
history/subscription path, and invalidates startup ownership on selection or
confirmed creation. A never-opened saved reference stays outside deletion
recovery, including after creation cancellation of startup ownership. Its draft
survives persistence while discovery is incomplete. Failed history reads retain
explicit retry; duplicate inventories do not reopen them.

Product edits are limited to `src/chat/ui.ts`. No API, persisted storage format,
provider, dependency, authentication, or server-timeout changes were introduced.
The final diff contains no temporary diagnostic instrumentation.

## Red-to-green evidence

The pre-existing reproduction was retained in
[`src/chat/lifecycle.test.ts`](../../../src/chat/lifecycle.test.ts).

```sh
UATU_CHAT_LIFECYCLE_TEST_CHILD=1 bun test ./src/chat/lifecycle.test.ts --test-name-pattern 'cold restore'
```

Before the fix: **0 passed, 1 failed**. Captured startup state had the exact saved
ID selected, empty history, visible composer, disabled Send despite nonempty input,
and zero snapshot/subscription calls. The explicit-switch workaround assertions
passed before the captured startup assertion failed.

After the fix: **1 passed, 0 failed**. The saved history and draft restore, Send
is available, and startup makes exactly one history read and one subscription.

The expanded direct lifecycle suite passed **21 tests**, covering repeated empty,
unrelated and duplicate inventories; creation success/failure before bootstrap
settles and during discovery; manual selection; cancelled/confirmed agent choice;
explicit read retry; stale responses; no saved ID; nonempty bootstrap; delayed
catalogs; and actual opened-conversation disappearance/reappearance.

## Final checks

| Check | Result |
| --- | --- |
| `bun test ./src/chat/lifecycle.test.ts ./src/chat/ui.test.ts ./src/chat/agents.test.ts ./src/chat/inventory-reconciler.test.ts` | 40 passed, 0 failed; lifecycle runs in an isolated child |
| Same focused unit command plus `./tests/evidence-discipline.test.ts` after review | 41 passed, 0 failed |
| `bun run test:e2e -- tests/e2e/chat-inventory.e2e.ts tests/e2e/chat-agents.e2e.ts --workers=1` | 24 passed, 0 failed after review additions; final evidence export run (49.8 seconds) |
| `bun run typecheck` | Passed |
| `git diff --check` | Passed |
| `openspec validate fix-opencode-conversation-startup --strict` | Passed |
| `bun audit --audit-level=moderate` | No vulnerabilities found; 670 packages checked |
| `bun run check:licenses` | Passed; 583 installed packages audited |
| `bun run build` and `bun run smoke` | Passed; bundler warned about unsupported `::highlight` selectors |
| Full `bun test` in the clean environment below | 6,151 passed, 22 skipped, 0 failed; 401 files (273.56 seconds) |

```sh
env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" LANG=C.UTF-8 LC_ALL=C.UTF-8 bun test
```

The first full-unit attempt hit the command runner's 120-second limit. Repeating
with a 600-second allowance completed successfully. Unfiltered Bun discovery also
included the existing nested `fix-chat-send-button` checkout; the totals above
are the actual whole-command totals, not a current-checkout-only count. The clean
environment excludes projected credential wrappers. Platform/tool-dependent and
opt-in real-agent tests account for skips.

The first combined browser attempt incorrectly expected hidden Chat to render
its timeline. Existing `scheduleRender()` deliberately defers inactive-surface
rendering. The final test verifies successful history and subscription responses
while Chat remains inactive, then reveals the already-restored surface and checks
the rendered history and controls. No product rendering behavior was changed.
Browser runs emitted upstream-unreachable teardown warnings but passed all final
assertions. No remaining environment blocker was encountered.

The full Playwright suite was not run locally; the focused inventory/agent suites
and compiled-browser smoke test were run. Full-suite CI remains the integration
gate. Post-review changes add browser tests and documentation, not product code;
the full-unit result above remains the earlier run of the same product fix.

## Desktop and touch evidence

Both final screenshots were opened and visually inspected. They show the
remembered conversation, synthetic saved history, a subsequent live update, a
nonempty restored draft, and enabled Send. The chooser truncates the visible
title normally; exact ID is established by test assertions.

- [Desktop screenshot](screenshots/conversation-startup-restored-desktop.png)
- [Touch screenshot](screenshots/conversation-startup-restored-touch.png)
- [Final passing Playwright report](../../../playwright-report/index.html)
- [Final run status](../../../test-results/.last-run.json)
- [Supporting browser tests](../../../tests/e2e/chat-inventory.e2e.ts): desktop/touch
  `restores the exact remembered conversation after empty inventory without taking focus`.

The tests retain real scoped presentation storage between page lifetimes and
control an empty-then-populated inventory. Before revealing Chat, assertions
prove exactly one successful saved-ID history read, an accepted live subscription,
restored draft, unchanged focus, and no forced panel/tab activation. No manual
conversation switch, reload, creation, or prompt submission occurs during
restoration. A subsequently published item proves live delivery after opening,
without another history read. Screenshots alone do not prove this sequence.

The screenshots are Git-visible evidence exported from the final combined
passing run using the existing evidence helper:

```sh
UATU_E2E_SCREENSHOTS_DIR=openspec/changes/fix-opencode-conversation-startup/screenshots bun run test:e2e -- tests/e2e/chat-inventory.e2e.ts tests/e2e/chat-agents.e2e.ts --workers=1
```

They remain with this change rather than being replaced by ordinary test runs.
The linked HTML report and run-status file are local ignored artifacts and may
be replaced by later runs. Tests contain no hardcoded change paths.

**Evidence boundary:** this is controlled fake-agent browser coverage and actual
client lifecycle coverage. The user's real OpenCode startup timing was not
captured; this does not prove that their workspace exceeded the four-second
inventory bound or reproduce a real-process timeout.

## Release-note classification

After refreshing upstream tags, the latest stable release is `v0.7.0`
(`2ba00746f821210c878054e57634d860e63652cc`). Its
[`installInitialChooser()`](https://github.com/tjakobsson/uatu/blob/v0.7.0/src/chat/ui.ts#L2224-L2234)
returns on empty inventory without opening the remembered conversation, and
[`applyConversationInventory()`](https://github.com/tjakobsson/uatu/blob/v0.7.0/src/chat/ui.ts#L2276-L2296)
only reopens through deletion recovery. The bounded multi-agent contribution
and late-arrival invalidation also already exist in that release. This corrects
the earlier stale-local-tag identification of `v0.6.2` as latest stable.

Classification: **visible `fix(chat)` release note**. The unreleased-feature
Release Please override is not required.

## Independent pre-publication reviews

Review baseline: upstream `main` at
`8a524297d367621ffe0116eea906c82318695b98`, including the proposal commit,
implementation, tests, verification, and screenshot evidence.

- **UX:** fresh desktop/touch browser runs found no user-facing regression.
  Focus, hidden-surface restoration, exact selection, saved draft, Send, and live
  delivery were checked. The review identified a browser-coverage gap for error
  recovery and user intent; these previously had lifecycle-only coverage.
- **Follow-up:** added four browser scenarios in both desktop and touch modes:
  failed read with explicit retry and no inventory retry; manual selection
  precedence; creation in flight and after failure; and dismissed agent choice.
  The 17-test inventory suite passed twice after these additions. No further
  product-code change was needed.
- **Security:** a separate review found no new vulnerability in saved-ID trust,
  agent/workspace authorization, live subscriptions, CSRF, stale-selection
  protection, rendering, or persistence. Restoration remains a read/subscription
  operation and never submits a draft or approves an action. The review was
  source-based, not a penetration test or real-agent exercise.
- **Standards and spec:** no documented-standard violations, actionable code
  smells, missing requirements, or scope creep were found.
- **Publication safety:** the lead additionally inspected the exact proposal and
  implementation diffs and Git metadata; evidence uses synthetic content and
  no secrets or private conversation data were found. The user explicitly
  approved publishing the currently configured Git author/committer identity.
