# Final worktree verification

Recorded 2026-09-18 on `feat/git-worktree-workspaces`, with Bun 1.4.0 on macOS
27.0. All 40 implementation tasks are checked in `tasks.md`.

## Changes completed in this pass

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
- Added user documentation at `docs/WORKTREES.md`, README links and source-run
  guidance beside the optional agent skills.

## Automated checks

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
| `bunx tsc --noEmit -p tests/e2e/tsconfig.worktree.json` | Pass |
| `bunx tsc --noEmit -p docs/agent-skills/tsconfig.json` | Pass |
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
debug checks and four opt-in provider integration tests. Provider compatibility
was exercised separately by the manual worktree runner below.

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

## Real checkout acceptance

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
- CLI creation appearing on the existing live stream while source context stays
  selected, with one EventSource connection.
- External discovery and explicit registration through the picker branch-conflict
  flow, followed by a truthful disabled Missing checkout row after Git removal.
- A confirmed pending source inventory read and source conversation event
  released after switching, without changing the active child's context.

Screenshots and `integrated-acceptance.json` are attached through
`tests/e2e/evidence.ts` in `test-results/` and `playwright-report/`. Captures include
`integrated-desktop-*` and `integrated-touch-*` picker, child-preview, chat and
missing-checkout images. Representative desktop/touch images were inspected.
The broader worktree mock gallery also passed in the full suite.

## Actual agent binaries

The user explicitly authorized the model-backed checks. No agent installation
was needed. Run these only with permission to use the configured model accounts:

```sh
bun run tests/worktree-agent-smoke.ts claude
bun run tests/worktree-agent-smoke.ts opencode
```

Claude Code 2.1.268 passed two distinct checkout conversations, native marker
reads, same-session resume, and an inherited-directory subagent. Uatu's native
transcript reader enumerated only each checkout's own session, and the transcript
contained the actual subagent tool call. `claude --worktree native-smoke` created
a separate native checkout which Uatu identified as external and unregistered.
The final five-turn Claude run reported USD 0.0582085; this is that run's reported
cost, not an aggregate of earlier debugging runs.

OpenCode 1.18.31 passed two distinct checkout conversations, marker reads,
same-session resume and a recorded `task` subagent call. Exported session metadata
retained the exact originating checkout directory. The runner clears inherited
OpenCode attachment variables and passes the target directory explicitly so a
nested smoke run cannot attach to its caller's server.

The OpenCode native creation check can also run without model calls:

```sh
bun run tests/worktree-agent-smoke.ts opencode-native
```

It starts an authenticated loopback OpenCode service with temporary home/data
directories, creates a native worktree through its creation API, and checks that
Uatu discovers it as external without registration or ownership transfer. The
existing Uatu checkout remains intact. No native removal/reset API is invoked.

These checks cover the installed versions and listed flows. They do not establish
compatibility for all provider releases, hooks or transcript formats. The smoke
runner does not edit existing agent configuration or install the optional skills.
Skill packaging/configuration preservation remains covered by its fixture suite.

## Native macOS navigation

`bun run tests/worktree-native-smoke.ts` passed on macOS 27.0. It compiles the
desktop app's actual `WebViewHost`, `PageZoom` and `ExternalLinkRouter` into a
small AppKit executable, backed by a real temporary-repository Hub fixture.
It verifies login, picker navigation between main and a started child, native
Back/Forward restoration, and the host's titlebar-inset injection.

This is a native WKWebView/desktop-host smoke test. It does not automate the full
installed app's Hub roster or Keychain UI. The 390px Playwright run is browser
touch emulation, not verification on a physical phone.

## Branch integration

The feature branch base is `8a524297d367621ffe0116eea906c82318695b98`.
Compatibility was checked against that base. `origin/main` has since advanced
through workspace API revision 20 and separate chat/tree changes. Before merging
the PR, synchronize with main, preserve its newer workspace revision alongside
this feature's Hub revision 7, and run CI on the combined result. This report
does not claim validation of that future merge.
