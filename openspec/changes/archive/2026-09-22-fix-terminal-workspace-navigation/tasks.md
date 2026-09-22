## 1. Establish the failing lifecycle

- [x] 1.1 Reproduce A -> A, A -> B -> A, and refresh against an isolated Hub in Microsoft Edge; record browser/app versions, scoped terminal storage, page lifecycle events, WebSocket events, and child inventory in test output. Verify the evidence identifies when visibility is lost and which connection holds the PTY, or explicitly records a reproduction blocker without claiming confirmation.
- [x] 1.2 Add a Hub-backed terminal-navigation E2E fixture or extend the existing Hub fixture with two workspaces and shell-state probes. Verify the test uses `/s/<id>/` traffic through the actual proxy and can distinguish the same PTY from a replacement shell. Keep test helpers under `tests/` and evidence in Playwright output directories.

## 2. Make current-workspace activation non-disruptive

- [x] 2.1 Update the current running workspace's ordinary click and keyboard activation to dismiss the menu without navigation, retaining the current document URL. Verify the Hub-backed A -> A test leaves the page instance, pane ids, PTY ids, and shell state intact.
- [x] 2.2 Preserve stable-id matching, availability guards, stopped-workspace Start, sibling navigation, and explicit new-tab gestures. Verify focused hub-nav tests cover duplicate display names, current stopped workspace recovery, modified clicks, and middle-click behavior.

## 3. Separate terminal lifecycle from presentation

- [x] 3.1 Add an idempotent panel suspend/resume path that releases transports on pagehide while retaining workspace-scoped visibility and pane references, then resumes once on a later pageshow or visibility return of a suspended page. Verify lifecycle tests cover both pagehide persistence values, ordinary background tabs, and no duplicate attach on overlapping resume signals.
- [x] 3.2 Add attempt-generation guards and cancellation for sockets, reconstruction callbacks, inventory requests, and recovery timers. Verify late callbacks after suspend/resume, user hide, user close, or pane replacement cannot remove current panes, change visibility, or attach obsolete sessions.

## 4. Recover attachment failures without losing the terminal

- [x] 4.1 Classify attachment completion by terminal reconstruction readiness rather than WebSocket open, and separate transport failure from confirmed shell exit. Verify a browser-open/child-refused connection keeps the saved pane and visible panel, while an explicit exit is reported as ended.
- [x] 4.2 Implement inventory reconciliation with the design's five-second total budget, increasing retry delays, and bounded fetch/readiness waits. Verify controlled-time tests cover delayed old-holder release, occupied-to-detached transitions, an attach collision after a detached inventory read, silent sockets, and deadline exhaustion without resetting the budget.
- [x] 4.3 Provide visible reconnecting, occupied/Take over, ended/New shell, Retry, and authentication/origin outcomes while retaining saved references as appropriate. Verify missing inventory entries never trigger automatic replacement shells, failed reads never imply occupancy or exit, and recovery does not steal keyboard focus.
- [x] 4.4 Preserve explicit takeover and termination semantics across the new lifecycle, including clearing automatic reuse of a previous takeover flag. Verify real second-window holders, duplicated-tab references, 4410 Take back behavior, hide-without-termination, and confirmed termination during recovery do not cause ownership ping-pong or orphaned retry work.

## 5. Complete Hub bridge teardown

- [x] 5.1 Add idempotent bridge cancellation and cleanup for browser departure, failed browser upgrade, and upstream failure, including late upstream open after disposal. Verify proxy tests show both peers and pending messages are released and no queued readiness/input reaches an abandoned connection.
- [x] 5.2 Verify bridge integration with a real terminal child: ordinary navigation detaches without killing the PTY, refusal preserves the existing holder, and explicit termination, collision, and takeover retain their established application close codes. Cover delayed peer closure so recovery is tested against the Hub rather than only a direct connection.

## 6. Verify navigation across browsers and document the result

- [x] 6.1 Complete Hub-backed E2E coverage for A -> A, A -> B -> A with multiple panes, per-workspace hidden/visible state, refresh, and browser back/forward. Verify stable PTY ids, retained shell-local variables, pane arrangement and layout, no extra shells, and no takeover action when no other client claimed the shell. Exercise actual history-cache restoration where available and deterministic lifecycle tests for the cached-page callback ordering.
- [x] 6.2 Run the targeted Hub navigation suite in Chromium and the installed Microsoft Edge channel, then manually verify the installed Edge PWA's navigation and history behavior. Deliver browser-specific evidence; record unavailable browser/PWA checks as blockers rather than marking them verified through emulation.
- [x] 6.3 Run the affected shell, terminal, and Hub unit/integration tests, existing terminal persistence/collision E2E suites, `bun run typecheck`, and `bun test`. Verify failures are resolved or identified as unrelated with evidence; use a clean tool environment if credential tests detect projected Git/SSH wrappers.
- [x] 6.4 Update `ARCHITECTURE.md` with terminal suspend/resume, readiness-aware recovery, and bridge cleanup, and record the confirmed Edge diagnosis in the change's implementation evidence. Verify the documentation agrees with the implemented behavior and regression tests.
- [x] 6.5 Before preparing a fix PR, determine whether the defect exists in the latest stable `v*` tag and record the result. Verify the planned release-note treatment follows `CLAUDE.md`, including a Release Please override if this only stabilizes unreleased functionality.
