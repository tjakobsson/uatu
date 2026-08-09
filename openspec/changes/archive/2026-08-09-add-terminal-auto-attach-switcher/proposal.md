## Why

Opening the terminal today stops the user with a chooser even when there is
nothing to choose: a detached PTY belongs to nobody, so listing it and demanding
an explicit "Attach" is friction that buys no safety. The rule that produced that
screen exists to protect *attached* sessions from silent takeover — it was never
about detached ones.

The cost is worst on iPad and iPhone, where the panel is fullscreen and a single
pane fills the screen. A user with three shells running has no way to reach the
second and third: the split control is deliberately hidden in touch mode, and
even if it weren't, splitting a phone viewport four ways is unusable. Touch
users need to move *between* terminals, not tile them.

## What Changes

- **Auto-attach on open.** When the terminal panel opens with no per-window panes
  to restore, every *detached* session in inventory is attached automatically —
  all of them, oldest first, up to the existing pane cap. No chooser appears.
- **Takeover stays explicit.** Sessions attached by another window are never
  auto-taken-over. They remain reachable behind a deliberate Take over action.
- **The picker becomes conditional, not unconditional.** It renders only when
  there is a real decision left: sessions exist but every one of them is attached
  elsewhere. Desktop behavior is otherwise unchanged.
- **A touch-mode terminal switcher.** On coarse-pointer devices the panel renders
  exactly one pane at a time and adds a switcher sheet listing this window's
  attached terminals, plus available sessions (attach / take over) and a **New
  terminal** action. Selecting a row makes that terminal the visible one.
- **A keybar switch button.** The switcher opens from the terminal keybar, the
  one bar reachable while the software keyboard is up.
- **The switcher subsumes the touch take-over flow.** On touch there is no
  separate picker panel — attach, take over, terminate, and new-shell all live in
  the switcher.
- Touch single-pane presentation is presentation-only: stored pane records and
  split geometry are untouched and reappear in desktop mode, matching the
  existing rule for hidden geometry controls.

## Capabilities

### New Capabilities

None. This extends the existing terminal capability rather than introducing a
new surface of its own.

### Modified Capabilities

- `embedded-terminal`: the new-pane rule changes from "never auto-attach" to
  "auto-attach every detached session, never auto-take-over"; the keybar gains a
  switch affordance; touch mode gains a one-pane-at-a-time presentation and the
  switcher sheet that navigates it.

## Impact

- `src/terminal/picker.ts` — candidate selection splits into an auto-attach set
  (detached) and a decision set (attached elsewhere); switcher row model added.
- `src/terminal/panel.ts` — `addPaneInteractive` gains the auto-attach path; pane
  visibility becomes mode-dependent (all panes on desktop, active pane only on
  touch); switcher sheet mount/dismiss and its wiring to `setActivePane`.
- `src/terminal/keybar.ts` — new `switch` item kind and its activation path.
- `src/styles.css` — switcher sheet styling; touch rule that shows only the
  active pane; safe-area handling consistent with the keybar.
- `src/index.html` — switcher sheet container.
- No server change: inventory, attach, takeover, and DELETE already provide
  everything the client needs.
- Tests: `picker.test.ts`, `keybar.test.ts`, `panel-*.test.ts` unit coverage plus
  a touch-mode E2E in `tests/e2e/`.
