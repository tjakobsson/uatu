## Why

The embedded terminal currently lives in the preview toolbar as a single, bottom-only pane that closes silently — making it easy to lose long-running work (a `tail -f`, a `claude code` session, a build) with one stray click and limiting where users can put it. We want the terminal to feel like a first-class workspace tool with the kind of controls people expect from VS Code / iTerm: protected close, minimize/fullscreen, dockable, and splittable.

## What Changes

- Move the terminal entry point out of the preview toolbar and into the sidebar, alongside the Author/Review mode controls, so the terminal is reachable from the same place users manage their workflow.
- Add a confirmation prompt when closing the terminal panel while a PTY is attached, warning that the shell session will be lost. Toggling-via-shortcut and minimize do NOT require confirmation; only the destructive close does.
- Add **minimize** and **fullscreen** controls to the panel header. Minimize collapses the panel to a thin bar (preserving the PTY), fullscreen expands it to fill the main content area. Both are reversible without losing the session.
- Allow the terminal panel to dock on the **right side** in addition to the bottom. The chosen dock position persists per origin.
- Allow **splitting** the terminal pane to spawn a second concurrent PTY session in the same panel, with focus and resize handled per-pane. Closing the last pane closes the panel.
- **BREAKING (server)**: the terminal WebSocket protocol gains a `sessionId` query parameter and a per-session token scope so multiple concurrent PTYs from the same browser tab can be multiplexed safely.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `embedded-terminal`: panel hosting model (single bottom pane → multi-pane, multi-dock), close lifecycle (silent → confirmed when destructive), entry-point location (preview toolbar → sidebar), and protocol (single PTY per WS → multiple PTYs per tab keyed by `sessionId`).

## Impact

- **Code**:
  - `src/index.html` — relocate terminal toggle from `#terminal-toggle` (preview toolbar) into the sidebar's mode-control region; add minimize/fullscreen/split buttons to the panel header.
  - `src/app.ts` — `setupTerminalPanel()` and the global `terminalHandle` model: replace single-handle pattern with a pane registry; add dock-position state and confirmation handling; rewire keyboard shortcut owner.
  - `src/terminal.ts` — `mountTerminalPanel()` becomes mount-per-pane; FitAddon needs to react to dock changes; theme stays shared.
  - `src/terminal-pane-state.ts` — extend persisted state: dock position (`bottom` | `right`), per-tab pane list, panel display mode (`normal` | `minimized` | `fullscreen`).
  - `src/terminal-server.ts` — sessions map gains explicit `sessionId` lookup; reaper grace continues to apply per session.
  - `src/styles.css` — new layout rules for right-dock, minimized bar, fullscreen overlay, split orientation (horizontal/vertical), and resizers per pane.
- **APIs**: `/api/terminal` accepts `sessionId` in addition to `t`; missing or duplicate `sessionId` is rejected. `/api/state.terminalConfig` unchanged.
- **Persistence**: new `localStorage` keys `uatu:terminal-dock` and `uatu:terminal-panes` (replacing implicit single-pane `uatu:terminal-visible`/`uatu:terminal-height` semantics; old keys still read for migration).
- **Dependencies**: no new runtime dependencies; xterm.js + FitAddon already cover multi-instance use.
- **Tests**: extend Playwright coverage for confirmation modal, minimize/fullscreen, right-dock, and split — and add server-side tests for `sessionId` multiplexing.
