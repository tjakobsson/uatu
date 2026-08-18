## Context

See proposal.md — Why. Current desktop layout facts that shape the approach:

- `#chat-surface` is already an always-mounted sibling of `.preview-shell`
  inside `.main-stack`; Preview/Chat exclusivity is a two-line CSS rule keyed
  on `html[data-main-surface]` (`styles.css` ~4587). State retention across
  the old switch was achieved by CSS visibility, not remount — that property
  must survive.
- `.main-stack` is flex-column (terminal bottom) and flips to flex-row via
  `.app-shell:has(.terminal-panel[data-dock="right"])` (terminal right). The
  terminal's dock, sizes, and fallbacks live in `src/terminal/pane-state.ts`
  and are out of bounds for this change.
- Touch mode presents Chat as a `position: fixed` full-screen tab — it is
  indifferent to Chat's desktop DOM position.
- `setMainSurface` has exactly three non-UI callers: `chat/file-references.ts`
  (switch to Preview on link), `find/find-bar.ts` (reveal Chat for find), and
  the `onMainSurfaceChange` desktop claim in `find/active-surface.ts`.
- An inline boot script in `index.html` (~line 40) applies the persisted
  main-surface attribute before first paint to avoid a layout flash.

## Goals / Non-Goals

**Goals:**
- Settle desktop work-area geometry: Preview and Chat co-visible, Chat fixed
  right of Preview and left of a right-docked terminal.
- Terminal subsystem byte-for-byte untouched (code, CSS selectors, persisted
  state, fallback rules).
- Replace the main-surface switch and its state with chat-panel state without
  losing the no-remount property.

**Non-Goals:**
- No dockable/movable chat (issue #255 option 2 is rejected, not deferred).
- No full-width chat mode; no touch-mode changes.
- No changes to chat's service, API, timeline, or composer behavior.

## Decisions

### 1. Chat stays inside `.main-stack`, wrapped with Preview in a `.work-row`

The terminal frames the work area on an edge; Preview and Chat split whatever
remains.

```
.app-shell                          untouched
└── .main-stack                     flex column ⇄ row exactly as today —
    │                               the :has() dock rule does not change
    ├── .work-row        NEW        flex row: preview | divider | chat
    │   ├── .preview-shell          existing
    │   ├── chat divider  NEW
    │   └── #chat-surface           already here — just gets wrapped
    ├── #terminal-resizer           untouched
    └── #terminal-panel             untouched
```

```
terminal hidden                     terminal bottom (spans both)
┌────┬─────────────┬─┬───────┐      ┌────┬─────────────┬─┬───────┐
│side│   PREVIEW   │║│ CHAT  │      │side│   PREVIEW   │║│ CHAT  │
│bar │             │║│       │      │bar ├─────────────┴─┴───────┤
│    │             │║│ [comp]│      │    │   TERMINAL (bottom)   │
└────┴─────────────┴─┴───────┘      └────┴───────────────────────┘

terminal right (keeps true right edge)   chat collapsed
┌────┬─────────┬─┬──────┬──────┐      ┌────┬──────────────────┬─┐
│side│ PREVIEW │║│ CHAT │ TERM │      │side│     PREVIEW      │▐│← strip +
│bar │         │║│      │ (rt) │      │bar │  (terminal docks │▐│  reopen
│    │         │║│[comp]│      │      │    │   as ever)       │▐│  toggle
└────┴─────────┴─┴──────┴──────┘      └────┴──────────────────┴─┘
```

Alternatives rejected:
- **App-shell grid column (sidebar's mirror)** — puts Chat right of a
  right-docked terminal, violating "terminal keeps the right edge", and
  demotes Chat to chrome semantics.
- **Terminal-style dock for Chat** — needs a two-panel edge-contention
  design; explicitly rejected in exploration ("fixed, can't move").

Consequence accepted: Chat is full-height only while the terminal is not
bottom-docked; with a bottom terminal the composer sits above the strip.

### 2. Split persists as a fraction, not pixels

Chat is a primary surface, not a utility panel. A pixel width (the sidebar /
terminal pattern) degrades into a drawer on large displays and a crush on
small ones; a fraction keeps both surfaces "the content" across window sizes.
Default ~40% chat; both sides get real minimum widths (chat needs roughly its
touch minimum, ~340px; preview needs a readable column). Divider drag clamps
to the minimums; persistence lives in `localStorage` beside the layout state
it replaces.

### 3. Collapse renders a slim right-edge strip owning the reopen affordance

The strip keeps Chat's home visible and gives reopen a permanent, discoverable
location without inventing a rail concept. Open/collapsed state persists in
`localStorage` (sidebar behavior: reopen on reload). The terminal's
sessionStorage rationale ("don't auto-spawn a PTY") does not transfer — chat's
service starts lazily and reopening a panel is cheap.

Viewport guard: below a minimum total width for both surfaces, Chat
auto-collapses without overwriting the user's open preference, and restores
when the viewport grows — the same yield-and-remember shape as
`TERMINAL_RIGHT_DOCK_VIEWPORT_MIN`, implemented independently of it.

### 4. `chat/surface.ts` becomes panel state; `mainSurface` is deleted

`appState.mainSurface` / `MAIN_SURFACE_KEY` are replaced by chat-panel state
(open + fraction) with its own storage key(s); the old key is simply ignored.
The `data-main-surface` attribute and its pre-paint boot script are replaced
by a panel-state equivalent (collapsed + width variable) so first paint still
doesn't flash. The segmented switch markup/styles are removed from both
header instances.

Knock-on simplifications, all shrinking special cases:
- `find/active-surface.ts`: delete the `onMainSurfaceChange` desktop claim —
  with Chat co-visible, the existing pointer/focus tracking covers it exactly
  as it covers the terminal. The structural "no file-event module reaches the
  setter" test must keep holding.
- `chat/file-references.ts`: drop `setMainSurface("preview")`; desktop just
  navigates (Preview is present), touch keeps switching to the Preview tab.
- `find/find-bar.ts`: reveal-chat becomes expand-if-collapsed.
- `shell/tab-bar.ts`: the touch-tab → mainSurface sync becomes mode-switch
  normalization: rotating touch→desktop with the Chat tab active opens the
  panel; desktop→touch picks the Preview tab unless Chat was the last active
  surface.

### 5. E2E activation path

Chat e2e suites activate via the segmented switch today. They switch to a
shared helper that expands the panel via the strip toggle (and asserts
co-visibility instead of exclusivity where tests relied on it).
`chat-touch.e2e.ts` is untouched.

## Risks / Trade-offs

- [Three columns squeeze on laptops: sidebar + preview + chat + right-docked
  terminal] → hard minimum widths on both split sides; the chat viewport
  guard collapses Chat first, the terminal's own 720px rule operates
  independently. Preview's `minmax(0, 1fr)` crush is prevented by the
  work-row minimums.
- [Deleting the `onMainSurfaceChange` claim regresses find routing] → the
  claim existed only because the switch sat outside every surface root; with
  the switch gone the blind spot is gone. Covered by existing
  `active-surface.test.ts` structure tests plus find e2e.
- [CSS keyed on `data-main-surface` or main-stack child order breaks
  somewhere unaudited] → grep-sweep both before removal; the terminal dock
  rule keys on `.app-shell:has(...)` and main-stack children stay
  `[content, resizer, panel]`, so it is structurally unaffected.
- [Ordering: `opencode-chat` spec exists only in unarchived
  `add-opencode-chat`] → archive that change first; this delta is written
  against the archived result (noted in proposal.md).

## Open Questions

- Exact default fraction (~0.4) and minimum pixel widths — tune visually
  during implementation; spec constrains behavior, not the numbers.
- Whether the collapsed strip shows any presence indicator (e.g. streaming
  activity) — additive, can land later without spec change.
