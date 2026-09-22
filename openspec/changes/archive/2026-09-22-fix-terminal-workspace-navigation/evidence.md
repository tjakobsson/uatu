# Implementation evidence

Recorded while applying the change (2026-09-21). Test output itself lives in
Playwright's `test-results/` and HTML report; this note keeps the diagnosis
and the checks that could not be run here.

## Reproduction (task 1.1)

**Microsoft Edge: verified by hand, not by suite.** No Edge is installed
on the development machine (`/Applications/Microsoft Edge.app` absent;
Playwright's `msedge` channel resolves to a system install, which
`playwright install msedge` would add with an administrator prompt), so the
Edge run of the suite was never performed and nothing below claims Edge
verification through emulation. The maintainer completed task 6.2 manually
on 2026-09-22 against a hub built from this change's final commit, in the
Microsoft Edge channel with the installed PWA: workspace navigation and
history behaved as specified, with the terminal and its shells intact.

**Chromium, through a real Hub (two workspaces, `/s/<id>/` traffic through
the proxy and bridge): reproduced.** `tests/e2e/terminal-hub-navigation.e2e.ts`
saves a lifecycle trace per test (page lifecycle events, every terminal
WebSocket's open/close with codes, the workspace-scoped terminal storage,
the child's inventory, browser and app versions). Run against the
unmodified code — browser `chromium 153.0.8010.12`, app `0.7.0`:

1. *Selecting the current workspace* navigated: a fresh document booted
   (the page marker set before the click was gone) and re-attached the same
   PTY. The departing document never closed its terminal socket — no
   `ws-close-called` precedes `pagehide` — so the PTY's release depended on
   the browser's own teardown of the old socket:

```
      0 ms  document-start     {"visibility": "visible"}
    264 ms  pageshow           {"persisted": false}
    409 ms  ws-new             {"ws": 1, "sessionId": "ff2c1f18", "takeover": false}
    410 ms  ws-open            {"ws": 1, "sessionId": "ff2c1f18"}
   1408 ms  pagehide           {"persisted": false}
   1408 ms  visibilitychange   {"visibility": "hidden"}
   1412 ms  document-start     {"visibility": "visible"}
   1429 ms  pageshow           {"persisted": false}
   1453 ms  ws-new             {"ws": 1, "sessionId": "ff2c1f18", "takeover": false}
   1468 ms  ws-open            {"ws": 1, "sessionId": "ff2c1f18"}
```

2. *Reload with the departing holder released late* (the harness holds the
   child's close processing for 1.5 s — the window a slow browser-side
   teardown produces). The replacement page's socket **opened** through the
   Hub and then closed `1011 upstream error` (the child refused the
   collision with 409). The pane was removed as if the shell had exited,
   visibility was persisted hidden and the pane records wiped (`storage`
   ended empty), while the PTY sat detached and orphaned — the reported
   symptom (terminal gone; the shell reachable only through the picker's
   *Take over* while the old holder lingers, or as an orphan afterwards):

```
      0 ms  document-start     {"visibility": "visible"}
    260 ms  pageshow           {"persisted": false}
    413 ms  ws-new             {"ws": 1, "sessionId": "653c4231", "takeover": false}
    414 ms  ws-open            {"ws": 1, "sessionId": "653c4231"}
   1349 ms  pagehide           {"persisted": false}
   1349 ms  visibilitychange   {"visibility": "hidden"}
   1354 ms  document-start     {"visibility": "visible"}
   1368 ms  pageshow           {"persisted": false}
   1395 ms  ws-new             {"ws": 1, "sessionId": "653c4231", "takeover": false}
   1413 ms  ws-open            {"ws": 1, "sessionId": "653c4231"}
   1413 ms  ws-close           {"ws": 1, "sessionId": "653c4231", "code": 1011, "reason": "upstream error"}
```

   Final state: panel hidden = True, pane records = [],
   inventory = [('653c4231', 'detached')].

**Diagnosis.** Two defects compound. The switcher rendered the current
workspace as an ordinary link, so activating it was a full navigation. And
the pane treated any close of a socket that had opened as "the shell is
gone" — through the Hub the browser socket always opens before the child is
asked, so a child refusal (the previous holder not yet released) looked like
an exit, removed the pane, and persisted the panel hidden. Whether Edge
adds a further delay to the old socket's teardown remains unmeasured; the
harness reproduces the same ordering deterministically, and the fix does
not depend on the length of that delay.

## After the change

Same spec, Chromium: 11/11 pass (the eight original scenarios plus a
duplicated-tab reference that parks on *Take over* while the original tab
keeps its shell, a confirmed close during recovery that kills the PTY and
leaves nothing to reappear, and a stopped child that parks on *Retry* —
never *Shell ended* — with the retry after restart reporting the shell
gone). That includes the late-release case (the
replacement's first attempt is refused `1011`, the pane stays visible under
*Reconnecting…*, inventory is polled with increasing delays, and the same
PTY is reattached by an ordinary attach ~1.7 s later with its shell variable
intact), a real second-window holder (parks on *Take over* after the
five-second budget; no ping-pong), and an exited shell (*Shell ended* /
*New shell*, no takeover offered). The departing page now closes its
sockets explicitly on `pagehide` (`ws-close-called 1000 "page hidden"`).

**WebKit** (Playwright's bundled WebKit 26.6, same spec, same hub): all
pass. Neither automated browser restored a page from the history cache in
the back/forward test — every `pageshow` carried `persisted: false` and
each navigation booted a fresh document — so actual cached-page
restoration was not exercised; the cached-page callback ordering is pinned
by the deterministic lifecycle tests (`terminal/lifecycle.test.ts`) and
the resume path is the same one a fresh document takes after `pagehide`.

Two existing suites changed expectation with the design: `terminal.e2e.ts`
(an exited shell parks on *Shell ended* whose close needs no confirmation,
where it used to vanish) and `terminal-switcher.e2e.ts` /
`terminal-collision.e2e.ts` (a restore that collides with a real holder
parks on the in-pane *Take over* card, where it used to fall back to the
picker). The touch-mode switcher case also caught a regression in the
first implementation: a pane parked behind another touch tab has no
layout, so `attach-ready` never goes out; the readiness deadline now
starts when that frame is sent, not when the socket opens.

## Suites (task 6.3)

- `bun test`: 3996 pass, 10 skip, 4 fail — the four failures are
  `credential-context.test.ts`'s "local workspace credential projection"
  cases, which pass 28/28 with the Hub-projected Git/SSH wrappers removed
  from the environment (this checkout runs inside a Hub-managed workspace;
  see CLAUDE.md).
- `bun run typecheck`: clean.
- Affected e2e (terminal persistence/collision/lifecycle/session-manager/
  switcher/main, hub switcher/live-stream/stopped-session): green except
  `hub-stopped-session.e2e.ts` "a start from elsewhere…", which fails
  identically on unmodified `main` in a separate worktree (an earlier test in
  the file restarts the alpha child; this one still stages work against the
  child's original port and gets `ECONNREFUSED`). Pre-existing and
  order-dependent; not touched here.

## Release note (task 6.5)

Both defects exist in the latest stable tag `v0.7.0`: its `hub-nav.ts`
renders the current workspace as a plain anchor (`aria-current` only), and
its `client.ts` calls the panel's removal callback on every close of an
opened socket. This is a stable regression fix: a visible `fix(terminal)`
entry, no Release Please override.
