## Context

The embedded terminal shipped in commit `bb4785c` as a single bottom drawer with one PTY per browser tab. State is split across `sessionStorage` (visibility) and `localStorage` (height); auth is a per-server token in URL → sessionStorage → HttpOnly cookie. Server-side, `terminal-server.ts` keeps a `sessions` map but the v1 client only ever opens one entry. This change generalizes the panel into a multi-pane, multi-dock host without re-platforming auth or the PTY backend — the existing token + cookie + reaper-grace model already supports multiple concurrent sessions; only the client multiplexing and a `sessionId` parameter are missing.

Scope of touched code:
- `src/index.html` — terminal toggle button moves; panel header gains controls.
- `src/app.ts` — `setupTerminalPanel()` becomes a `TerminalPanelController` managing N panes.
- `src/terminal.ts` — `mountTerminalPanel()` parameterized to mount into a pane container, not the global `#terminal-panel`.
- `src/terminal-pane-state.ts` — schema expands; legacy keys read once, new keys written.
- `src/terminal-server.ts` — accept `sessionId`, validate uniqueness per token.
- `src/styles.css` — flex/grid for right-dock, minimized bar, fullscreen overlay, split resizers.

## Goals / Non-Goals

**Goals:**
- Make the terminal hard to lose: confirm before destructive close, preserve PTY on minimize/fullscreen.
- Move the entry point to where the rest of the workflow controls are (sidebar, near Author/Review).
- Let users dock the panel to the right when the bottom drawer crowds the preview.
- Let users run two PTYs concurrently in the same tab via split (N=2 in v1; arbitrary later).
- Backward-compatible persistence: existing users keep their last height and visibility on first load.

**Non-Goals:**
- Detached/floating terminal windows.
- Cross-tab session sharing (still one tab = its own PTYs; reattach across reload still has the 5s grace).
- Terminal tabs (named, scrollable list of N>2 PTYs). Splits cover the immediate need; tabs can come later.
- Per-pane theme overrides — theme stays single-source from `--terminal-*` CSS vars.
- Drag-to-rearrange between dock positions; dock change is a discrete action via a toggle.

## Decisions

### Decision 1: Multi-pane via a controller object, not a singleton handle

Replace the global `terminalHandle` with a `TerminalPanelController` that owns:
- `panes: Map<sessionId, TerminalPaneHandle>`
- `dock: "bottom" | "right"`
- `displayMode: "normal" | "minimized" | "fullscreen"`
- imperative API: `addPane()`, `closePane(id)`, `splitActive()`, `setDock()`, `setDisplayMode()`.

**Why:** the existing single-handle pattern already conflates panel-level state (visible, height) with pane-level state (the xterm instance + WebSocket). Untangling now is cheaper than retrofitting around a global singleton when adding a second PTY. **Alternative considered:** keep `terminalHandle` as primary and add a `secondaryHandle`. Rejected — special-cases two and immediately needs refactoring for fullscreen/minimize toggles that operate at panel level.

### Decision 2: `sessionId` as a URL query parameter, generated client-side

Client sends `crypto.randomUUID()` as `sessionId` in the WebSocket upgrade URL: `/api/terminal?t=<token>&sessionId=<uuid>`. Server enforces:
- `sessionId` is required, syntactically a UUID.
- A given `sessionId` already in `sessions` rejects with HTTP 409 (prevents accidental hijack on a reload race).
- The reaper grace window is keyed by `sessionId`, so reload-then-reattach can resume the same PTY.

**Why:** mirrors the existing token-in-URL pattern, requires no protocol framing change, and lets the server's existing `sessions` map become the source of truth without code duplication. **Alternative considered:** wrap input/output frames in a JSON envelope with a session field, multiplexed over one WS. Rejected — doubles the bandwidth for binary stdout, complicates resize framing, and breaks the trivial "one WS per PTY" mental model that's serving us well.

### Decision 3: Confirmation only on destructive close

The confirmation modal fires only when the user clicks the **close (×)** button on a pane that has an attached PTY. It does **not** fire for:
- `Ctrl+`` toggle (that's minimize-equivalent — keep semantics symmetric with VS Code).
- Minimize button.
- Fullscreen toggle.
- Closing the second pane of a split when the first is still alive (the panel itself stays open).
- Closing a pane whose WS is already detached.

**Why:** the user complaint is unintentional loss of a long-running session. Toggle/minimize don't lose anything; only the explicit × does. Adding a "are you sure?" to the keyboard toggle would be friction users would learn to ignore. **Alternative considered:** confirm on any path that kills the PTY, including reload. Rejected — `beforeunload` prompts are inconsistent across browsers and feel like spam.

UI: in-app modal (not `window.confirm`) so it can match the rest of uatu's chrome and be Playwright-testable. Pattern: a small centered card with "Close terminal?" / "You'll lose your shell session" / [Cancel] [Close terminal]. Default focus on Cancel; Esc cancels.

### Decision 4: Minimize collapses to a header bar; fullscreen overlays the main grid area

- **Minimize**: panel height shrinks to the header height (≈32px); body hidden via `hidden` attribute on `.terminal-body`. PTY stays attached. xterm is paused via `term.dispose()`? **No** — keep the xterm instance alive but don't run FitAddon while collapsed; on restore, `fitAddon.fit()` and re-emit a resize frame.
- **Fullscreen**: `.terminal-panel` gets `data-display="fullscreen"`; CSS positions it `absolute` over the `.app-grid` area (not the full viewport — sidebar and topbar stay accessible). Esc exits fullscreen.

**Why:** preserving the PTY on minimize is the whole point of having minimize separate from close. Constraining fullscreen to the app-grid (rather than full viewport) keeps the sidebar/title visible so the user can leave fullscreen via UI, not just keyboard.

### Decision 5: Right-dock implemented as a layout-mode flag, not a separate component

`.terminal-panel` keeps a single DOM home in `.main-stack`. A `data-dock="right"` attribute on the panel switches its CSS:
- `bottom`: panel sits below the preview (current behavior). Resizer is on top edge.
- `right`: `.main-stack` becomes flex-row; panel sits on the right with width `var(--terminal-panel-width)`. Resizer is on the left edge.

Width and height are tracked separately so dock toggling restores the user's last sized dimension on each axis.

**Why:** keeps a single component lifecycle and lets CSS do the heavy lifting; no remount of xterm on dock change (just `fitAddon.fit()`). **Alternative considered:** move `.terminal-panel` between two layout slots in DOM. Rejected — would force xterm to remount, risking lost scrollback and WS churn.

### Decision 6: Split is horizontal-side-by-side when bottom-docked, vertical-stacked when right-docked

A panel split direction adapts to dock:
- Bottom dock → split is vertical line (panes side-by-side, share full height).
- Right dock → split is horizontal line (panes stacked, share full width).

The user gets one split in v1 (max 2 panes per panel); the split button is hidden when 2 panes already exist.

**Why:** matches what users expect from terminal apps (splits are perpendicular to the dominant axis). Capping at 2 panes keeps focus management trivial in v1; we can lift the cap later without spec changes.

### Decision 7: Persistence migration is a one-shot read fallback

`terminal-pane-state.ts` reads new keys first; if absent, reads legacy `uatu:terminal-visible` and `uatu:terminal-height` and writes the migrated shape. Legacy keys are not deleted (forward-only writes). After migration, all writes go to the new keys only.

New shape (one localStorage key, JSON):
```json
{
  "dock": "bottom",
  "displayMode": "normal",
  "bottomHeight": 240,
  "rightWidth": 360,
  "panes": [{"id": "<uuid>", "createdAt": <ms>}]
}
```
sessionStorage continues to gate visibility per-tab; key remains `uatu:terminal-visible` for boot-time symmetry with current behavior.

**Why:** users who already set a comfortable height shouldn't have it reset. **Alternative considered:** version field + explicit migration step. Rejected as overkill for a single one-shot transform with no data loss.

### Decision 8: Sidebar entry point uses a button (not a link) directly under the Author/Review toggle

The terminal control sits in the sidebar's `#mode-control` region as a separate button row labeled "Terminal" with the `Ctrl+`` hint. It does not become a "mode" (Author/Review) — it's a visibility toggle that survives mode switches.

**Why:** the user's request is to put it where they look (alongside Author/Review), but elevating it to a third mode would imply Author/Review/Terminal are mutually exclusive — they aren't. A button row preserves orthogonality.

The old `#terminal-toggle` chip in the preview toolbar is removed (not hidden) — keeping two entry points doubles the surface area for state desync.

## Risks / Trade-offs

- **[Risk]** Two concurrent PTYs double process count per tab; a user with 5 tabs splits = 10 shells. → **Mitigation:** keep the v1 cap at 2 panes per panel. Document in `embedded-terminal/spec.md`. Server already reaps on disconnect; no new resource holders.
- **[Risk]** Right-dock at narrow viewport widths squeezes the preview to the point of unusability. → **Mitigation:** clamp `--terminal-panel-width` to `[280px, 60% of viewport]`. Auto-revert to bottom dock if viewport narrower than 720px.
- **[Risk]** Confirmation modal on close adds friction for users who close-and-reopen often. → **Mitigation:** the modal is only on click of × — `Ctrl+`` toggle and minimize remain frictionless. Don't add a "don't ask again" toggle; the warning is the whole point.
- **[Risk]** Server-side `sessionId` collision (two clients pick the same UUID) is astronomically unlikely but possible. → **Mitigation:** server returns 409 on collision; client retries with a fresh UUID. Log collisions to stderr — if they ever happen we want to know.
- **[Trade-off]** Sidebar gains visual weight (one more control near Author/Review). → Acceptable; the alternative (preview toolbar) drifts as more preview-related actions accrue there.
- **[Trade-off]** Fullscreen overlays the app-grid only, not the viewport, so the sidebar stays visible. Some users will expect "true" fullscreen. → If complaints arrive, add `Shift+Fullscreen` for viewport mode. Out of scope for v1.

## Migration Plan

1. Land server-side `sessionId` validation behind tolerant parsing — accept missing `sessionId` for the rollout window (one release) and log a warning. After v0.X+1, require it.
2. Land client controller with single-pane behavior (no split UI, no right-dock UI) under a feature flag in `localStorage` (`uatu:terminal-ux=v2`). All existing users see no change.
3. Land sidebar entry, confirmation modal, minimize/fullscreen — still single pane.
4. Land split + right-dock; flip the flag default to on.
5. After two releases, remove the flag and the legacy `#terminal-toggle` element.

Rollback: reverting the flag default restores single-pane bottom-only behavior with the new sidebar entry; full revert is a single PR revert because new persistence keys coexist with legacy ones.

## Resolved Questions

- **`sessionId` persists across reload.** The persisted pane list includes each pane's `sessionId`; on boot, the client reattaches by sending the same `sessionId` on the WS upgrade. Within the existing 5-second reaper grace, the server reuses the PTY (already covered by the lifecycle requirement). Past the grace, the server returns 409 not found semantics — client falls back to spawning a fresh PTY for that pane slot and logs a debug warning. Persistence shape's `panes[].id` is exactly that `sessionId` (UUID).
- **Split keyboard shortcut: `Cmd+Shift+`` (macOS) / `Ctrl+Shift+`` (other).** Extends the existing `Cmd+`` / `Ctrl+`` toggle family rather than colliding with browser bookmark (`Cmd+D`). Listed in the panel header tooltip alongside the toggle hint.

## Open Questions

- Where exactly in the sidebar mode-control region does the Terminal button sit — above Author/Review, below, or as a divider-separated row? Lean toward below with a visual separator; defer final placement to the implementer with a screenshot review.
