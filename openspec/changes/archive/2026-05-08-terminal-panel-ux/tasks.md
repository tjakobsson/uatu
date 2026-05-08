## 1. Server: sessionId multiplexing

- [x] 1.1 In `src/terminal-server.ts`, parse `sessionId` from the upgrade URL and validate it as a UUID; reject with HTTP 400 on missing or malformed values
- [x] 1.2 Reject duplicate active `sessionId` upgrades with HTTP 409
- [x] 1.3 Key the existing `sessions` map by `sessionId` and route I/O accordingly so multiple concurrent PTYs from one tab work
- [x] 1.4 Apply the 5-second reaper grace per `sessionId` so a reload reusing the same id reattaches to the same PTY
- [x] 1.5 Add server tests covering: valid upgrade with sessionId, missing sessionId (400), malformed sessionId (400), duplicate sessionId (409), reattach within grace, two concurrent sessions exchanging I/O independently

## 2. Persistence schema

- [x] 2.1 In `src/terminal-pane-state.ts`, define the new shape `{dock, displayMode, bottomHeight, rightWidth, panes: [{id, createdAt}]}` and write/read it under a new `localStorage` key (e.g. `uatu:terminal-state`)
- [x] 2.2 Add a one-shot migration: if new key is absent and legacy `uatu:terminal-visible` / `uatu:terminal-height` exist, populate `dock=bottom`, `bottomHeight=<legacy>`, `displayMode=normal`, then write the new shape
- [x] 2.3 Keep `sessionStorage` `uatu:terminal-visible` for per-tab visibility; document the separation in a one-line comment
- [x] 2.4 Add unit tests for migration (legacy present → migrated; new present → no-op; both absent → defaults)

## 3. Client: TerminalPanelController refactor

- [x] 3.1 Replace the global `terminalHandle` in `src/app.ts` with a `TerminalPanelController` owning `panes: Map<sessionId, TerminalPaneHandle>`, `dock`, `displayMode`
- [x] 3.2 Parameterize `mountTerminalPanel()` in `src/terminal.ts` so it mounts into a passed-in pane container element rather than a global `#terminal-panel`; keep theming and font config behavior unchanged
- [x] 3.3 Generate a fresh `crypto.randomUUID()` per pane; include it in the WebSocket upgrade URL as `sessionId`
- [x] 3.3a On `restoreFromState`, reattach panes using their persisted `sessionId`; if the server returns 409/not-found past the reaper grace, fall back to spawning a new PTY for that pane slot and log a debug warning
- [x] 3.4 Implement controller methods: `addPane()`, `closePane(id)`, `splitActive()`, `setDock(d)`, `setDisplayMode(m)`, `restoreFromState()`
- [x] 3.5 Wire the existing `Ctrl+`` / `Cmd+`` keyboard shortcut to controller-level toggle; ensure only one pane is created on first reveal

## 4. Sidebar entry point

- [x] 4.1 In `src/index.html`, add a "Terminal" button to the sidebar's `#mode-control` region (separate row, below the Author/Review controls), with the `Ctrl+`` keyboard hint visible
- [x] 4.2 Remove the `#terminal-toggle` chip and surrounding markup from the preview toolbar
- [x] 4.3 Update `src/app.ts` setup to bind the new sidebar button to the controller's toggle action; remove old toolbar bindings
- [x] 4.4 Add a Playwright test verifying the toolbar control is gone and the sidebar control toggles the panel

## 5. Confirmation modal on destructive close

- [x] 5.1 Add an in-app modal element (markup + styles) for the close confirmation; ensure default focus is on Cancel and `Esc` cancels
- [x] 5.2 Wire each pane's close (×) button to invoke the modal only when its WebSocket is attached
- [x] 5.3 Bypass the modal in: keyboard panel toggle, minimize, fullscreen toggle, and close on already-detached panes
- [x] 5.4 On confirm, close the pane's WebSocket and remove the pane (hide panel if last)
- [x] 5.5 Add Playwright tests: close prompts, cancel preserves PTY, confirm tears down, keyboard toggle does NOT prompt

## 6. Minimize and fullscreen

- [x] 6.1 Add minimize and fullscreen buttons to the panel header in `src/index.html`
- [x] 6.2 In `src/styles.css`, add `[data-display="minimized"]` rules that collapse `.terminal-body` to header height; add `[data-display="fullscreen"]` rules that overlay the `.app-grid` area (sidebar + topbar remain visible)
- [x] 6.3 In the controller, implement display-mode transitions; never dispose xterm or close WebSockets on transition; call `fitAddon.fit()` and emit a resize frame on restore from minimized
- [x] 6.4 Bind `Esc` to exit fullscreen when a pane has focus
- [x] 6.5 Persist `displayMode` and restore on next load
- [x] 6.6 Add Playwright tests for minimize/restore (output is preserved), fullscreen toggle, and `Esc`-to-exit

## 7. Right-side dock

- [x] 7.1 In `src/styles.css`, add `[data-dock="right"]` rules: `.main-stack` becomes flex-row, panel positions on the right with width `var(--terminal-panel-width)`, resizer moves to the left edge
- [x] 7.2 Track `--terminal-panel-width` independently from height; clamp to `[280px, 60% of viewport width]`
- [x] 7.3 Add a dock-toggle control in the panel header; switching dock must NOT remount xterm (just refit)
- [x] 7.4 Implement viewport-narrow auto-fallback: when viewport width < 720px, force `dock=bottom` while preserving the user's preference for restoration when wider
- [x] 7.5 Persist dock preference and restore on next load
- [x] 7.6 Add Playwright tests for dock switch (no remount, PTY survives), persistence across reload, and narrow-viewport auto-fallback

## 8. Split (multi-pane within a panel)

- [x] 8.1 Add a split control in the panel header; hide or disable it when two panes already exist
- [x] 8.2 Implement `splitActive()` in the controller: spawn a second pane with a fresh `sessionId`, mount xterm, open WebSocket, focus the new pane
- [x] 8.3 Add CSS for split orientation: side-by-side when bottom-docked, stacked when right-docked; render an inter-pane resizer that adjusts the split ratio
- [x] 8.4 Implement per-pane focus management; clicks within a pane focus that pane's terminal
- [x] 8.5 Implement per-pane close behavior: confirmation flow per pane; closing one of two panes keeps the panel open and expands the survivor; closing the last pane hides the panel
- [x] 8.6 Wire the split keyboard shortcut `Cmd+Shift+`` (macOS) / `Ctrl+Shift+`` (other); show it in the panel header tooltip alongside the toggle hint
- [x] 8.7 Add Playwright tests: split spawns second PTY, orientation matches dock, inter-pane resizer works, closing one pane vs. the last pane behaves correctly

## 9. Documentation and rollout

- [x] 9.1 Update CHANGELOG.md with the user-facing changes (sidebar entry, confirmation, minimize/fullscreen, right-dock, split)
- [x] 9.2 Update README.md terminal section to reflect the new entry-point location and new controls (no need to expose the `sessionId` protocol detail to end users)
- [x] 9.3 Run the full Playwright suite locally and in CI; fix regressions
- [x] 9.4 Manual verification across both dock positions, both display modes, split, and confirmation flow before merging
