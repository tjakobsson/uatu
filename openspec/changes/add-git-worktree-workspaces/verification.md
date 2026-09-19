# Worktree verification

Latest integration: [rebase onto `a1ac6d3` and Hub API revision 8](#latest-rebase-and-api-revision-correction-2026-09-19).

## Rebased review fixes (2026-09-19, tasks 12.1–12.8)

The user accepted all seven findings from the review of `f5f5f0a`, rebased onto
`origin/main` at `36f3f70`. This section supersedes the earlier verification
summaries for the current working tree; those sections remain historical.

### Fixes and regression evidence

- **Creation recovery:** real-Git restart tests first reproduced false ownership
  when an external checkout appeared at a pending destination. Recovery no
  longer stamps that checkout and requires a durably recorded matching identity.
  Without it, files and the pending journal remain for reconciliation. Verified
  retained-checkout recovery and registration retry continue to work.
- **Deletion recovery:** the removal marker is written and synced before the
  `removing` phase. Tests cover that ordering and legacy journals with a live
  matching checkout but no marker. Those cases retain registration/provenance;
  a subsequent Delete reports uncertainty rather than falsely claiming removal.
  Verified removal, cleanup retry and replacement-occupant protections remain.
- **Ownership:** Hub state and inventory use the same canonical resolver.
  Real-Git cases cover owned/external, missing, replaced, unreadable and
  repository-identity mismatches, including cache invalidation.
- **Shared rules and wire validation:** branch rules no longer import the
  dialog. Shared parser factories are injected into the minification-safe
  dashboard script. Red-before-fix tests cover malformed inventory, refs,
  preflight, operation results and JSON, including structurally valid results
  for the wrong endpoint or missing required checkout identity. Both Open
  paths validate before navigation. Drafts survive, no false success is
  emitted, and aborted reads stay silent. Explicit Fetch uses the published
  POST. Repeated retained-registration failure now omits its invalid top-level
  phase, preserving the valid sanitized error through client parsing.
- **Rename safety:** real-Git tests first reproduced the unsafe depth-limited
  verdict, including a deeply named submodule with an external linked tree.
  Ordinary and submodule scans now propagate depth, entry-budget and read
  uncertainty. Fully inspected leaves and ordinary boundary repositories stay
  safe; no recursive unbounded scan was added.
- **Narrow navigation:** browser tests first measured 374px/409px documents in
  320px/390px viewports with Notifications present. Hub navigation now wraps,
  retains every action and provides 44px phone targets. New real-Hub tests
  assert navigation, create/delete dialogs and their controls fit the visible
  viewport at 320, 390 and 1440px. The 320px run uses a 568px-tall viewport.
  Fresh screenshots were inspected. Escape focus restoration was separately
  confirmed; the review's initial focus suspicion was retracted, not patched.

### Combined verification

Unit tests, browser tests and compiled smoke used the clean tool environment:

```sh
env -i HOME="$HOME" TMPDIR="$TMPDIR" SHELL=/bin/zsh \
  PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin bun test
```

The same environment prefix was used for the browser and smoke commands below.
No project dependencies were added by these fixes.

| Command | Result |
| --- | --- |
| `bun test` (final full run) | **3,860 pass, 11 skip, 0 fail**; 28,186 assertions across 238 files; 194.81 seconds |
| `bun run typecheck` | Passed |
| `bunx --no-install tsc --noEmit -p tests/tsconfig.worktree.json` | Passed |
| `bun run test:api` | 183 pass, 0 fail; 1,488 assertions |
| `bun run api:validate` | Passed; existing single-member `WorkspaceConflict allOf` warning |
| `bun run test:e2e tests/e2e/worktree-ui.e2e.ts tests/e2e/worktree-integration.e2e.ts tests/e2e/worktree-webkit.e2e.ts tests/e2e/hub-switcher.e2e.ts tests/e2e/hub-live-stream.e2e.ts tests/e2e/hub-nav-bounds.e2e.ts --workers=1 --retries=0 --output=test-results/review-fixes` | **19 passed**, no retries; 1.8 minutes |
| `bun run check:licenses` | Passed; 585 installed packages |
| `bun run build` then `bun run smoke` | Passed; 16 compiled smoke checks, including real first-attempt worktree creation and minified dashboard dialog |
| `bunx --no-install openspec validate --all --strict` | 54 passed, 0 failed |
| `git diff --check` | Passed |

The first full unit run had 3,857 passes, 11 skips and three failures: a detached
terminal exit timeout; a temporary credential-runtime directory cleanup `EPERM`
on Hub Stop; and its consequential missing-operation-coverage assertion. A
rerun of `src/terminal/server.test.ts` and `src/hub/hub.integration.test.ts`
passed (107 pass, 4 skip), followed by the clean full run above. No product or
test-timeout changes were made to conceal these transient failures.

Evidence is in Playwright output under `test-results/review-fixes/`, including
`hub-nav-{320,390,1440}`, `hub-create-{320,390,1440}` and
`hub-delete-{320,390,1440}` screenshots and per-viewport `bounds.json` files.
Earlier red/green navigation captures remain under `test-results/nav-bounds-*`.
Tests do not write to this change's screenshot folder.

The full repository browser suite, native macOS WebView smoke and physical
phone/software-keyboard behavior were not rerun. The 11 unit skips are optional
installed-TUI, Linux-only and real-provider tests. Build warnings about CSS
`::highlight` remain non-fatal. At verification time, all fixes were uncommitted
and no push had been made.

Release-note classification: worktree corrections stabilize this branch's
unreleased feature, and navigation corrects the unreleased notification
addition inherited from main. A separate future `fix` PR needs the documented
Release Please `chore(...)` override, not a stable-regression release note.

## Earlier final verification (2026-09-19)

The change was verified after the scope change and the migrated UI, including the fresh UX review (tasks 11.1–11.2) and three production bugs found by the user on the compiled binary in a disposable live Hub:
- Dashboard dialog script broken by minification
- Running rows lacking Open and the title link
- First-attempt registration failing on the shared path-reservation fence

Refer to the §11 notes in `tasks.md` for finding-by-finding detail.

### Results

| Command | Result |
| --- | --- |
| `bunx tsc --noEmit` and `bunx tsc --noEmit -p tests/tsconfig.worktree.json` | clean |
| `bun test` (clean tool environment, no projected Git wrappers) | 3,690 pass, 10 skip, 0 fail; 27,411 assertions across 229 files; 178 s |
| `bun run test:api` | 182 pass, 0 fail |
| `bunx playwright test tests/e2e/worktree-ui.e2e.ts tests/e2e/worktree-integration.e2e.ts --workers=1` (with `UATU_E2E_SCREENSHOTS_DIR=openspec/changes/add-git-worktree-workspaces/screenshots`) | 10 passed; 37 evidence files captured |
| `bunx playwright test tests/e2e/hub-switcher.e2e.ts tests/e2e/hub-live-stream.e2e.ts --workers=1` | 3 passed |
| `bun run build` then `bun run smoke` (compiled `dist/uatu`, clean tool environment) | smoke passed, including the dashboard fork menu, inventory dialog and first-attempt worktree creation checks |
| `bun run check:licenses` | clean, 583 packages |
| `openspec validate --all --strict` | 53 passed, 0 failed |

### Environment note

In a Hub-managed workspace the 4 ambient-Git-config tests in `src/hub/credential-context.test.ts` fail because of projected Git/SSH wrappers (see `CLAUDE.md`); they pass in a clean tool environment, which is the number recorded above.

### Live test note

A disposable Hub built from this tree, with two throwaway repositories and a local bare remote, was exercised by the user on desktop and phone (creation, fetch, registration of an external tree, deletion, forget, dashboard); the three bugs above were found there and fixed with regression tests before this verification.

### Not re-run

`tests/worktree-native-smoke.ts` (manual macOS WebView smoke) — its worktree creation step now uses the JSON family and it needs a desktop GUI session.

## Scope changes 2026-09-18

Three user decisions narrowed this change after the runs recorded below. The
recorded results remain true for what they tested; final verification will be
re-run after the migration in tasks 7-11.

- The Uatu-mediated agent path was removed from scope before release: the
  `uatu worktree` CLI, the least-privilege capability transport, the optional
  Claude/OpenCode skills and the agent smoke runner. Their checks are removed
  from this file with the scope they verified. The Hub's worktree operations
  remain, served to the Hub's own surfaces.
- The worktree UI moves onto the published JSON family under
  `/api/hub/worktrees`, like every other Hub surface. The server-rendered
  `/worktrees` fragment and redirect flow, its two contract exclusions and the
  separate operation-progress poll are removed, and the Hub state fields are
  reshaped within the unreleased revision 7.
- The mock-first prototype host, review gallery and demo suites are retired. The
  UX approval they earned stands; coverage moves to linkedom unit tests of the
  client dialog, the worktree API integration tests and the real-Hub browser
  journeys with temporary repositories.

## Recorded runs before the scope change (2026-09-18)

Recorded 2026-09-18 on `feat/git-worktree-workspaces`, with Bun 1.4.0 on macOS
27.0. Every implementation task existing at that date was checked in `tasks.md`;
sections 7-11 were added afterwards and are unchecked.

### Changes completed in this pass

- Added real-Hub desktop and 390px touch acceptance journeys with temporary Git
  repositories, watched workspace children, real PTYs and deterministic chat.
- Fixed external branch-conflict recovery. The Git occupancy probe returns a
  path; presentation now resolves it to the checkout or workspace ID before
  rendering Register, Start or Open.
- Preserved missing/replaced availability in the workspace picker and disabled
  unavailable navigation. Authoritative reconciliation updates the Hub-state
  availability cache before its live invalidation, so the notification cannot
  serve the pre-removal cached state.
- Corrected the misplaced OpenAPI example. Declared Hub API revision 7 for the
  closed state-object additions and new live topic, with migration guidance.
- Fixed test isolation: the chat fixture clears permission reply history, and
  the live-stream integration test waits for its independent inventory upstream.
- Added user documentation at `docs/WORKTREES.md` and README links.

### Automated checks

| Check | Final result |
| --- | --- |
| `bun test` | 3,649 pass, 9 skip, 0 fail; 27,457 assertions across 232 files; 137.12 seconds |
| `bun run test:e2e --retries=2` | 799 pass on the first attempt, 4 pass on retry, 0 remaining failures; 8.1 minutes |
| `bun run test:api` | 182 pass, 0 fail; 1,461 assertions |
| `bun run api:validate` | Pass; one existing single-member `allOf` lint warning |
| `bun run scripts/api-contract/structural.ts` | Pass; 50 HTTP operations |
| Contract compatibility against the branch base | Pass; changed domain is Hub, revision 6 to 7 |
| `bun run api:swift` | Swift client generation and compilation passed |
| `bun run typecheck` | Pass |
| `bun run check:licenses` | Pass; 593 installed packages |
| `bun run build` and `bun run smoke` | Pass, including compiled Hub login, child startup, assets and live document state |
| `openspec validate --all --strict` | 53 pass, 0 fail |
| `git diff --check` | Pass |

Unit and broad browser checks used a clean tool environment. `PATH` named Bun,
Homebrew and system tools rather than this development session's projected
Git/SSH wrappers. `HOME`, `TMPDIR` and `SHELL=/bin/zsh` were retained; ambient
credential-projection variables were absent. The shell matters to the browser
bracketed-paste test. The first run without it used a shell that did not provide
the expected interactive paste behavior.

The nine unit skips are three optional installed-TUI checks, two Linux-specific
debug checks and four opt-in provider integration tests.

An intermediate unit run overlapped the full browser suite and hit two
five-second lifecycle-test budgets. The final unit run ran alone and passed
without timeout changes. The final browser run used the same two-retry allowance
as CI. Its four flaky tests were:

- `change-overview.e2e.ts`: non-Git and invalid-settings fallback states.
- `chat-agents.e2e.ts`: plan approval intents.
- `chat-claude-polish.e2e.ts`: switching away from a rate-limited conversation.
- `touch-scroll.e2e.ts`: find reveals a match by scrolling the page.

These are recorded as retry passes, not first-attempt successes. Both real
worktree journeys passed on their first attempt in the final broad run.

### Real checkout acceptance

Run `bun run test:e2e tests/e2e/worktree-integration.e2e.ts --workers=1` to repeat
the two integrated journeys. Separate parent repositories keep desktop and touch
independent even when they share a worker. The fixture's preserve-workspace mode
starts each child without resetting its real Git checkout.

The journeys verify:

- Picker creation from local main, stopped completion and explicit start/open.
- Exact branch and recorded source, child-only committed content, preview,
  project search and Git metadata/log presentation.
- Actual PTY cwd by running a command in each shell and checking its output file.
- Separate documents, fixture conversations and terminal sessions over picker
  and browser-history round trips.
- A worktree committed outside the page appearing on the existing live stream
  while source context stays selected, with one EventSource connection.
- External discovery and explicit registration through the picker branch-conflict
  flow, followed by a truthful disabled Missing checkout row after Git removal.
- A confirmed pending source inventory read and source conversation event
  released after switching, without changing the active child's context.

Screenshots and `integrated-acceptance.json` are attached through
`tests/e2e/evidence.ts` in `test-results/` and `playwright-report/`. Captures include
`integrated-desktop-*` and `integrated-touch-*` picker, child-preview, chat and
missing-checkout images. Representative desktop/touch images were inspected.

### Native macOS navigation

`bun run tests/worktree-native-smoke.ts` passed on macOS 27.0. It compiles the
desktop app's actual `WebViewHost`, `PageZoom` and `ExternalLinkRouter` into a
small AppKit executable, backed by a real temporary-repository Hub fixture.
It verifies login, picker navigation between main and a started child, native
Back/Forward restoration, and the host's titlebar-inset injection.

This is a native WKWebView/desktop-host smoke test. It does not automate the full
installed app's Hub roster or Keychain UI. The 390px Playwright run is browser
touch emulation, not verification on a physical phone.

### Branch integration

The full browser results above were recorded before synchronizing
the branch, against original base `8a524297d367621ffe0116eea906c82318695b98`.

Before pushing for testing, merged main at
`3a76a6dc0e8f128ad1a1b9d4cd5f797ce538341a`. Resolved the four API metadata conflicts
by retaining Hub revision 7 and main's workspace revision 20, including its chat
receipt schemas and migration notes. Installed the merged frozen lockfile.

Post-integration checks on 2026-09-18:

- Clean-environment `bun test`: 3,746 pass, 9 skip, 0 fail, 28,380 assertions
  across 235 files in 136.98 seconds.
- `bun run test:e2e tests/e2e/worktree-integration.e2e.ts tests/e2e/hub-switcher.e2e.ts --workers=1`:
  all four desktop/touch journeys passed without retries in 23.6 seconds.
- Root and worktree-dedicated typechecks, API lint/structure and compatibility
  against current main passed. Only the Hub domain changes relative to main.
- All 53 strict OpenSpec validations passed.

The earlier full-browser results remain identified above; CI will run the full
suite on the pushed combined branch.

### Latest rebase and API revision correction (2026-09-19)

Rebased onto `origin/main` at `a1ac6d3`; the resulting HEAD before this correction
is `937bff3`. The user explicitly approved Hub revision 8 / workspace revision 20,
superseding the earlier claim that both unreleased changes could share Hub 7.
Main already uses Hub 7 for notification `allWorkspaces`. The compatibility policy
requires a newer Hub revision for the worktree additions to closed state objects
and the live topic, regardless of release status.

Runtime, contract metadata, OpenAPI revision metadata and both state examples now
declare 8/20 (`8.20.0-experimental`). The changelog adds a separate Hub 8 worktree
entry with migration guidance; its entire Hub 7/20 notification and Hub 6/20
receipt/notification history matches current main unchanged. Current design and
proposal state the corrected decision; earlier verification and task records
remain historical rather than being retroactively rewritten.

Revision-focused verification:

- `bun run typecheck`: passed (`tsc --noEmit`).
- `bun run api:validate`: passed metadata, schemas, examples and OpenAPI lint;
  one existing `no-illogical-composition-keywords` warning remains for the
  single-member `WorkspaceConflict.allOf` at `api/openapi.yaml:1551`.
- `bun test src/shared/api-revisions.test.ts api/contract.test.ts`: 25 pass,
  0 fail, 375 assertions across 2 files (4.50 seconds). Existing tests cover
  revision consistency and examples, so no redundant regression test was added.
- The existing compatibility checker, invoked with `origin/main` contract and
  streaming snapshots versus the working tree: `API compatibility against
  origin/main passed`. The temporary invocation script was removed afterward.
- `git diff --check`: passed. Compared the changelog against `origin/main`:
  only the new Hub 8/20 entry is added; all upstream entries remain intact.

Post-rebase integration verification (clean tool environment, as above):

- `bun run test:api`: 183 pass, 0 fail, 1,491 assertions (27.80 seconds).
- `bun test src/hub/notifications.test.ts src/hub/worktree-lifecycle.integration.test.ts src/hub/worktree-onboarding.test.ts src/hub/worktree-api.integration.test.ts src/hub/worktree-journal.test.ts src/hub/worktree-rename-guard.test.ts src/shared/worktree-contract.test.ts src/shell/worktree-dialog.test.ts src/shell/worktree-dialog-script.test.ts`:
  276 pass, 0 fail, 1,372 assertions (43.15 seconds).
- `bun run test:e2e tests/e2e/worktree-ui.e2e.ts tests/e2e/worktree-integration.e2e.ts tests/e2e/worktree-webkit.e2e.ts tests/e2e/hub-switcher.e2e.ts tests/e2e/hub-live-stream.e2e.ts tests/e2e/hub-nav-bounds.e2e.ts tests/e2e/notifications.e2e.ts --workers=1 --retries=0 --output=test-results/rebase-hub8-repeat`:
  all 28 passed in 2.4 minutes, including notifications' all-workspaces rule,
  WebKit, checkout round trips and 320/390px dialog bounds. The initial run
  (`test-results/rebase-hub8`) passed 27 and failed the touch creation journey
  because a picker `boundingBox()` measurement returned null. The complete
  repeat passed without source/test changes; the initial failure is retained
  as a transient layout-measurement failure, not counted as a first-run pass.
- Root and worktree-dedicated typechecks passed.
- `bun run build` and `bun run smoke`: all 16 compiled checks passed, including
  notification assets, first-attempt creation and the minified dashboard dialog.
- `bunx --no-install openspec validate add-git-worktree-workspaces --strict`
  and `git diff --check`: passed.

The full unit suite, full browser suite, native WebView and physical-phone checks
were not rerun after this rebase; their earlier results above remain historical.
No dependencies were installed. At verification time, the rebase had replayed
existing commits, the Hub 8 correction and this verification update were
uncommitted, and nothing had been pushed.
