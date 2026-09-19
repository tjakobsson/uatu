# Worktree verification

## Final verification (2026-09-19)

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
