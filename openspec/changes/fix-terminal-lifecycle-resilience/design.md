## Context

The embedded terminal is a long-lived browser-side artifact: an `xterm.js` canvas driven by a WebSocket that owns a real PTY on the server. Anything that tears down the SPA — a full-page browser navigation, an unhandled `WebSocket` constructor throw on boot, or a layout race that bricks the first paint — costs the user their shell session (within the 5-second PTY reconnect grace, after which the server reaps the PTY).

Three independently reported bugs share this root concern:

1. **404 navigation kills the SPA.** `src/preview/anchors.ts:141-150` only calls `event.preventDefault()` for same-origin links whose path resolves to a known non-binary doc. Unresolved paths fall through to a real browser navigation; the server's `createNavigationFetchHandler` (`src/server/session.ts:823-837`) returns `404 Not Found` in plain text; the SPA is unloaded; all terminal WebSockets close. By the time the user hits the back button (re-loading the SPA fresh), the 5-second PTY grace has likely expired.

2. **Refresh-with-deep-link throws `SyntaxError`.** `src/terminal/client.ts:197` builds the WebSocket URL from `new URL(window.location.href)`, which inherits the URL's hash. The `WebSocket` constructor rejects URLs with fragment identifiers. The Promise rejection bubbles to the page; the terminal pane never connects.

3. **Refresh leaves the terminal "empty" until pane resize.** `setupTerminalPanel` calls `setVisible(true, false)` on boot when the persisted visibility preference is true. `setVisible(true)` triggers `addPane(record)` → `handle.attach()` → `term.open(container)` + `fit.fit()` synchronously, before the panel container has its final layout. xterm caches the initial cell measurement at 0×0 (or a similarly bogus size); subsequent data arrives into a degenerate grid. A user-initiated resize fires the `ResizeObserver`, `fit.fit()` re-measures, and the cached buffer renders correctly. (Bug #3 in disguise: if the URL has a hash, the WebSocket never opens at all — but the perceived symptom "resize fixes it" then comes from xterm repainting, not from data finally arriving. See Decision 4.)

The terminal's *server-side* contract is solid (token + sessionId + 5s reconnect grace, see `embedded-terminal` spec). The fragility is entirely on the browser side, and the fixes are small and local. The reason to ship them together is that the e2e regression coverage and the framing benefit from being unified: each fix is a small step in the same direction (terminal lifecycle survives page-level URL events).

## Goals / Non-Goals

**Goals:**

- Clicking an unresolved same-origin link, or typing an unknown URL, does NOT close any terminal WebSocket. The SPA stays mounted and shows the existing "Document not found" empty state.
- Refreshing a page with a deep-linked hash does NOT throw on boot. The terminal connects on the first attempt.
- The terminal pane's first paint after a refresh shows running output without requiring a user-initiated resize.
- An e2e regression test exists for each of the above.

**Non-Goals:**

- Extending the 5-second PTY reconnect grace. If the user spends >5s on a 404 page (in the bug-#1 scenario, before the fix) the PTY is reaped; this change makes that scenario unreachable rather than addressing the grace window itself.
- Refactoring `createNavigationFetchHandler` more broadly. We add one branch, not a new dispatch layer.
- Restructuring how `replaceSelection` handles the URL hash on boot. The hash is *deliberately* preserved (`src/shell/history.ts:86`) so deep-link scroll works. We fix the WebSocket builder at its own site, not the URL it reads from.
- Hardening the terminal against other in-tab disruptions (tab-discard, BFCache, etc.). Those are real issues but require different mechanisms.

## Decisions

### Decision 1: Strip the hash at the WebSocket URL builder, not upstream

The WebSocket URL builder in `client.ts:197` is the bug site. The fragment slips in because `new URL(window.location.href)` faithfully copies the page URL.

Alternatives:

- **(A)** Strip `wsUrl.hash = ""` before `new WebSocket(...)`. One line.
- **(B)** Stop building from `window.location.href`; construct from `window.location.origin` + explicit pathname.
- **(C)** Strip the hash from `window.location` on boot (e.g., `history.replaceState(..., url.pathname + url.search)`).

**Chosen: (A).** Smallest possible blast radius — the WebSocket constructor is the only consumer that cares about fragments. (B) achieves the same effect but reformulates a URL the rest of the function works with; (C) breaks the boot-time fragment scroll that `loadInitialState()` captures into `initialHash` at `boot.ts:48`. The right invariant is "WebSocket URLs must not have fragments," and that invariant belongs at the WebSocket builder.

### Decision 2: Intercept *every* same-origin click in the cross-doc anchor handler

Today, the cross-doc handler returns without `preventDefault()` for "path not in index" and "binary doc". The first case is the bug. Two ways to close it:

- **(A)** Make the anchor handler intercept any same-origin non-binary click; route unknown paths through `pushSelection(null, …)` + `renderEmptyPreview("Document not found", …)`.
- **(B)** Let the click fall through, but have the server return the SPA shell for HTML-preferring navigations to unknown paths so the SPA re-hydrates and renders the in-app 404.

**Chosen: BOTH.** (A) covers the most common case (in-app click) without involving the server at all, which is faster and avoids any WebSocket reconnect at all. (B) is a defense-in-depth measure for the cases (A) can't catch: address-bar entry, external deep links, browser-restored sessions to an unknown URL. They compose without conflict. (B) also brings the server's behavior into line with conventional SPA expectations.

Binary docs continue to fall through (the static fallback serves them as before). External, modifier-clicked, and non-HTTP(s) clicks continue to fall through.

### Decision 3: Don't break the static-file fallback

`createNavigationFetchHandler` currently dispatches HTML-preferring requests to the SPA shell *only* when the path resolves to a known viewable doc. Non-HTML-preferring requests (e.g. `curl`, sub-resource `Accept: */*`) flow through `staticFileResponse`. We add a branch *after* the static fallback returns `null`: if the request is HTML-preferring AND no static file matches, return the SPA shell instead of `404 Not Found`.

This means:

| Request kind | Path resolves to viewable doc | Path resolves to static file | Neither |
|---|---|---|---|
| HTML-preferring | SPA shell (today) | Static file (today) | **SPA shell (changed)** |
| Non-HTML-preferring | Static file (today) | Static file (today) | `404 Not Found` (unchanged) |

`curl http://localhost:4711/typo` still returns `404` (right behavior — no SPA shell shoved at a non-browser). The browser hitting the same URL gets the SPA shell, boots, and renders the in-app empty state.

### Decision 4: Confirm bug #2's root cause before sizing the fix

The proposal lists "deferred fit on first attach" as the fix. That's the high-likelihood cause (xterm sizing race), but it's possible bug #2 is partly or wholly bug #3 in disguise — every "refresh on a deep-linked URL" reproduction is a candidate for both. The implementation task explicitly starts with a 5-minute reproduction check on a URL with no hash to disambiguate:

- If empty-on-refresh still reproduces without a hash → real xterm sizing race; apply the deferred-fit fix.
- If it does not reproduce without a hash → bug #2 was bug #3, and the hash-strip fix from Decision 1 covers it. The deferred-fit work becomes optional defense-in-depth.

Either outcome is fine. The check protects against shipping a fix for a phenomenon that doesn't exist.

### Decision 5: Drive the initial xterm open via `ResizeObserver`, not `requestAnimationFrame`

First attempt used `requestAnimationFrame` to defer `term.open()` + `fit.fit()` by one frame. That passed the e2e test (which checked DOM presence) but real-browser manual testing still showed the empty-until-resize symptom — the rAF fires after layout in the spec, but in practice, on a refresh that auto-restores the panel from `sessionStorage`, the panel container's final dimensions can land in a layout pass that happens AFTER the first rAF.

The robust fix is to wait for the container to actually report a non-zero `contentRect`, which by definition only happens after layout has settled. `ResizeObserver` is the right primitive: its first dispatch after `observe()` fires once layout has computed dimensions, and there's no guessing about rAF-vs-layout ordering.

Concretely:

- `connect()` constructs the `Terminal` and `FitAddon` synchronously but does NOT call `term.open()`.
- A single `ResizeObserver` is attached to the pane container. Its callback drives two distinct behaviors:
  - **First non-zero observation**: call `openXtermNow()` which does `term.open(container)` + `fit.fit()` + `term.refresh(0, rows-1)` + send the initial `resize` frame if the WebSocket is already open. Sets `openDone = true`.
  - **Subsequent observations**: `fit.fit()` + send a resize frame only if the column/row count changed.
- The WebSocket is created immediately (synchronously) so the upgrade handshake starts as early as possible. PTY data that arrives before `openXtermNow()` gets buffered by `term.write()` (xterm.js handles pre-open buffering internally) and renders on first paint after `term.open()`.
- The `socket.open` handler sends the initial resize frame ONLY IF `openDone` is true; otherwise `openXtermNow()` will send it the moment it opens. This avoids the bug where we'd report xterm's default 80×24 to the server before fit had measured the real container.

Alternatives considered (and rejected):

- **(A)** `requestAnimationFrame` deferred open. Tried first; insufficient — see the analysis above. The user manually verified the empty-until-resize symptom persisted.
- **(B)** Synchronous open + post-WebSocket-open refit + `term.refresh()`. Also tried; same root issue — the initial cell measurement gets cached at the wrong dimensions and `fit.fit()` after the fact doesn't always recover the canvas.
- **(C)** Double rAF (`rAF(() => rAF(...))`). Would buy more layout time but is still timing-based and fragile to CSS transition durations.

`ResizeObserver`-driven open is event-driven rather than timing-based — it's the right shape for "wait until the container is actually sized."

### Decision 6: Force `SIGWINCH` on PTY reattach by toggling rows

User-verified during the implementation: even with Decision 5 in place, refreshing while a TUI (htop, vim) was running produced a blank or stale-frame-corrupted canvas. Manual pane resize fixed it instantly — which made the actual mechanic visible. `ioctl(TIOCSWINSZ)` is the kernel-level mechanism that delivers `SIGWINCH` to the foreground process group, and it only signals when the size actually *changes*. On a typical refresh the new panel is the same size as before, so the client's own resize message sets the PTY to dimensions it already had, the kernel skips `SIGWINCH`, and the TUI has no idea anything happened. The xterm canvas is now blank (fresh `Terminal` instance) and the TUI is still waiting for a reason to redraw.

The fix is server-side, on the reattach branch in `src/terminal/server.ts:open()`:

```ts
existing.pty.resize(existing.cols, Math.max(1, existing.rows - 1));
existing.pty.resize(existing.cols, existing.rows);
```

The first call to `pty.resize()` changes the rows by one — guaranteed to fire `SIGWINCH`. The second restores the actual rows. The TUI sees `SIGWINCH`, queues a redraw, and on its next refresh tick draws the full screen into the now-attached xterm canvas. The client's own resize message (sent moments later from `socket.open`) is either a no-op (same dims as the server already has — the common case) or a real resize (panel was resized between sessions) — both are fine.

Alternatives considered:

- **(A)** Have the client send TWO resize messages, the first with a deliberately-different size. Works but pushes the workaround into every client, including future PWA / mobile clients. The "trigger SIGWINCH" concern is really server-side.
- **(B)** Track a `justReattached` flag and conditionally force SIGWINCH on the next client resize. More state to track without meaningful benefit; the unconditional toggle on reattach has the same end state.
- **(C)** Server-side, send `term.write("\x1bc")` (full reset) to the client. Resets xterm but doesn't actually make the TUI redraw — the TUI hasn't been signaled and still thinks the screen state is what it last drew.

The toggle approach is the minimum mechanism that addresses the root cause. The cost is one extra `SIGWINCH` per reattach, which the TUI coalesces with its normal refresh cycle.

## Risks / Trade-offs

- **Risk:** Serving the SPA shell for unknown HTML-preferring paths could mask legitimate broken-link reports.
  **Mitigation:** The SPA renders an explicit "Document not found at <path>" message. The user *sees* that the doc doesn't exist; the only behavioral change is that the SPA remains alive. The existing `Document not found` message in `boot.ts:111-114` and `history.ts:202` is the surface that already handles this case for in-app navigation.

- **Risk:** Intercepting *every* same-origin click might catch links the user intended to follow externally (e.g., a hand-authored link to a non-viewable static asset).
  **Mitigation:** Binary docs continue to fall through. Static assets that the index doesn't know about (e.g. images served by the static-file fallback) are addressed by Decision 3 (B) — the server still serves them. We only intercept clicks at the *anchor* level, not all navigation, so window.open / form submissions / etc. are untouched.

- **Risk:** Deferring `term.open()` to `requestAnimationFrame` introduces a one-frame latency on terminal first paint.
  **Mitigation:** One frame is ~16ms — visually unnoticeable, and the alternative is "empty pane until manual resize," which is far worse. The post-open `term.refresh()` ensures buffered output appears as soon as the WebSocket has anything to deliver.

- **Risk:** Decision 4 (the reproduction check) is execution discipline, not code. An impatient implementation could skip it and "fix" both bugs with just the deferred-fit pass.
  **Mitigation:** Calling it out in the design doc is the mitigation. The tasks.md item that introduces deferred-fit lists the reproduction check as its first sub-task.

- **Trade-off:** We're adding e2e tests (slow) to cover behaviors that could also be unit-tested. We accept this because the terminal's failure modes are inherently integration-level (browser navigation, WebSocket lifecycle, layout timing). A unit test on the URL builder (Decision 1) is cheap and still added; the other two are e2e-only.
