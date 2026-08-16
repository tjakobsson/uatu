## Why

On desktop, Preview and Chat are mutually exclusive main surfaces behind a
segmented switch, which structurally blocks the product's core loop: the agent
in Chat edits docs whose live preview is the point of uatu — you cannot watch
the doc change while talking to the agent that changes it (issue #255, agreed
follow-up to #252).

## What Changes

- Desktop mode renders Preview and Chat **co-visible** as a split of the work
  area: Preview left, Chat right, separated by a draggable divider that
  persists the split as a **fraction** of the work-area width.
- Chat is a **primary surface, fixed in position**: it cannot be moved or
  docked. It is collapsible to a slim edge strip that carries the reopen
  affordance; the split fraction survives collapse/reopen and reloads.
- The terminal is untouched: it keeps its bottom/right dock, sizes,
  persistence, and viewport fallback, and it frames the Preview+Chat pair —
  bottom dock spans under both; right dock keeps the true right edge (Chat
  sits left of a right-docked terminal).
- Below a viewport-width threshold, Chat auto-collapses (preference preserved,
  restored when the viewport grows) — Preview wins when two primary surfaces
  cannot fit. This guard is independent of the terminal's existing right-dock
  fallback.
- **BREAKING (UI):** the Preview/Chat segmented switch is retired, and with it
  the full-width Chat state — Chat now maxes out at the split's maximum
  fraction. The `mainSurface` app state and its persistence key are replaced
  by chat-panel state (open/collapsed + fraction).
- Chat file references no longer "switch to Preview" — Preview is always
  present; activating a reference navigates and reveals in place. ⌘F over a
  collapsed Chat expands the panel instead of switching surfaces.
- Touch mode is unaffected: Chat remains a full-screen tab; its
  `position: fixed` presentation does not depend on the desktop layout.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: the desktop-viewport requirement ("Chat SHALL occupy the
  main content surface… a visible workspace control SHALL switch between
  Preview and Chat") is replaced by co-visible split requirements
  (side-by-side rendering, collapse/expand with state retention, split
  persistence, narrow-viewport fallback, terminal framing invariants), and
  the file-reference requirement's "SHALL switch to Preview" wording becomes
  reveal-in-place.
- `touch-navigation`: the mode-toggle requirement's description of desktop
  mode ("main Preview-or-Chat surface") and its mode-switch normalization
  ("the active Preview-or-Chat main surface remains selected") are updated to
  the split work area: entering desktop with the Chat tab active opens the
  panel; entering touch lands on Chat only when the user was last working in
  an open panel.

Note: `opencode-chat` currently exists only as a delta under the completed,
not-yet-archived `add-opencode-chat` change. This proposal assumes
`add-opencode-chat` is archived (its delta synced to `openspec/specs/`)
before this change is applied; the delta here is written against that
resulting spec.

## Impact

- `src/chat/surface.ts` — segmented-switch module becomes chat-panel state
  (open/collapsed + fraction, divider drag, viewport guard).
- `src/shell/state.ts` — `mainSurface`/`MAIN_SURFACE_KEY` replaced by
  chat-panel state and key(s).
- `src/find/active-surface.ts` — the desktop `onMainSurfaceChange` claim is
  deleted; pointer/focus tracking already covers a co-visible Chat.
- `src/find/find-bar.ts` — reveal-chat-for-find becomes expand-if-collapsed.
- `src/chat/file-references.ts` — drops `setMainSurface("preview")`.
- `src/shell/tab-bar.ts` — touch-tab → mainSurface sync becomes touch-tab →
  panel-open normalization on mode switch.
- `src/index.html` / `src/styles.css` — new `.work-row` wrapper around
  `.preview-shell` + `#chat-surface` inside `.main-stack`; the two-line
  exclusivity rule and switch styles are removed. Terminal DOM/CSS untouched.
- E2E: `chat.e2e.ts`, `chat-panels.e2e.ts` activate Chat via the switch and
  need the new activation path; `chat-touch.e2e.ts` unaffected.
