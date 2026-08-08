## Context

Two behaviors meet in this change, both living in `src/terminal/panel.ts`.

**Attachment.** `addPaneInteractive()` fetches `/api/terminal/sessions`, filters
out sessions this window already shows (`pickerCandidates` in `picker.ts`), and —
if anything remains — renders the chooser (`renderSessionPicker`). Only an empty
candidate list falls through to a fresh `addPane()`. The chooser is reached from
three call sites: first show with nothing to restore (`setVisible`), the split
button (`splitActive`), and reconciliation after a collision
(`handlePaneUnavailable`). The per-window restore path is separate and stays as
it is: `state.panes` (sessionStorage) drives `addPane(record)` directly, and hide
deliberately does not clear those records, so hide → show reattaches the same
PTYs without ever consulting inventory.

**Presentation.** `rebuildPanesContainer()` lays every pane out in a flex row or
column with drag resizers between them, and stamps `data-active` on the active
one. Touch mode already hides the split and dock controls
(presentation-only — the geometry state survives), but it still *renders* every
pane, so a window with three panes shows three slivers on a phone. The keybar
(`keybar.ts`) is the only chrome reachable while the software keyboard is up; it
is coarse-pointer-only by CSS, with no JS sniffing.

The server needs nothing new: inventory reports `attached`, attach and takeover
are already distinct WS paths with a single-holder rule, and DELETE terminates.

## Goals / Non-Goals

**Goals:**

- Opening the terminal with detached PTYs waiting attaches all of them, silently.
- Takeover of a session held by another client stays an explicit, deliberate act.
- Touch users can move between terminals and create new ones from the keybar.
- Touch single-pane rendering is presentation-only — desktop still sees splits.
- The attach/decide split is a pure function, unit-tested without a DOM.

**Non-Goals:**

- Changing the desktop chooser's look or its call sites. It renders less often;
  it is not redesigned.
- Server-side changes to inventory, attach, takeover, or termination.
- Per-terminal unseen-output indicators in the switcher (see Open Questions).
- Reordering, renaming, or persisting a user-defined terminal order.
- Making the switcher a desktop surface.

## Decisions

### D1 — Split the candidate set in `picker.ts`, keep it pure

`pickerCandidates` currently returns one list that means "things to ask about".
It becomes two lists with different fates:

```ts
resolveSessionPlan(inventory, shownIds, freeSlots) →
  { attach: TerminalSessionInfo[], decide: TerminalSessionInfo[] }
```

`attach` is the not-shown detached sessions, oldest first, truncated to
`freeSlots`. `decide` is the not-shown attached-elsewhere sessions plus any
detached overflow past the cap. Everything the panel does downstream keys off
which list is non-empty, so the whole policy is testable headlessly — the
existing `picker.test.ts` pattern.

*Alternative considered:* keep one list and let `panel.ts` filter inline. Rejected
— the policy is exactly the part worth pinning by test, and `panel.ts` touches
`window` at module scope.

### D2 — `addPaneInteractive()` becomes attach-first

New order: fetch inventory → `resolveSessionPlan` → if `attach` is non-empty,
attach every entry sequentially and return; else if `decide` is non-empty, present
the chooser (desktop) or the switcher (touch); else `addPane()` a fresh shell.

Sequential, not parallel: `addPane` re-checks the cap and the panel's hidden
state on each call, and `rebuildPanesContainer` mutates shared DOM. Running them
in order keeps both invariants without new locking.

Active pane after a batch: the saved `lastPtyId` when it is among the attached
set, otherwise the newest attached pane. `lastPtyId` still never *causes* an
attachment — it only selects among attachments that were going to happen anyway,
which is what keeps the takeover rule intact.

**The batch must suppress per-pane activation, and that is correctness, not
tuning.** `setActivePane` writes and persists `lastPtyId`. If each attach
activates its own pane, the last one attached overwrites the user's saved
last-active reference *before* the rule above reads it — so "last-active wins"
silently degrades to "newest wins", always. (Caught in review; the pure
`resolveActiveSessionId` unit tests passed throughout, because the corruption
happens in the caller. `terminal-session-manager.e2e.ts` now covers it, and that
test was verified to fail against the old code.) `batchingAttach` therefore
suppresses activation, focus, and the refit for the whole loop, and the saved id
is snapshotted before it starts so the rule survives regardless. Suppression
also spares N-1 refits, N-1 focus grabs — each a software-keyboard flash on
touch — and N-1 personal-state writes.

### D3 — Collision during auto-attach needs no new guard

Between the inventory GET and the WS upgrade another window can claim a session.
The pane then fires `onCollision` → `handlePaneUnavailable` → which calls
`addPaneInteractive()` again. The obvious worry is a loop: the same inventory
comes back, the same session is attached, the same collision fires.

**It cannot form.** `listSessions` reports `attached: s.socket !== null ||
s.pendingClaim !== null` and `prepareSession` refuses on exactly those two
conditions — inventory and the upgrade gate read one holder state. A session that
just refused this window therefore comes back from the reconcile GET as
attached-elsewhere and lands in `decide`, where takeover is explicit. The
reconcile is self-limiting by construction. (A half-attached claimant is covered
too: `pendingClaim` makes it `attached` in inventory.)

The one case where the retry *does* attach is when the winner released the
session in the interval — and there re-attaching is the correct answer, not a bug.

*Alternative considered (and implemented first, then removed):* a per-visibility-
cycle set of collided session ids excluded from `attach`. It guards a state the
server cannot produce, and it breaks the legitimate case above by refusing a
session that has genuinely become free. Deleted rather than kept "just in case" —
a guard against an impossible state is a guard nobody can test or reason about.

### D4 — Touch single-pane rendering is CSS, keyed on the existing `data-active`

`rebuildPanesContainer` already stamps `data-active` on exactly one pane, and
`setActivePane` already moves it. Touch mode adds:

```css
html[data-ui-mode="touch"] .terminal-pane:not([data-active]) { display: none; }
html[data-ui-mode="touch"] .terminal-pane-resizer { display: none; }
```

No JS branch decides visibility, which is the same recipe the keybar and the
hidden geometry controls use. The one JS consequence: a `display: none` pane
measures zero, so the pane revealed by a switch must be refit. `setActivePane`
gains a `requestAnimationFrame(() => fitAll())` — `fitAll` already skips panes
it cannot measure, so the hidden ones cost nothing.

Hidden panes keep their PTY dimensions until revealed. That is correct behavior
rather than a compromise: a resize is a message to the shell, and a shell whose
pane nobody is looking at should not be told the screen changed size on every
switch.

*Alternative considered:* `visibility: hidden` with absolute positioning to keep
panes measurable and avoid the refit. Rejected — it keeps every hidden xterm
rendering into a full-size layer on a phone, paying GPU and layout cost for
pixels nobody sees.

### D5 — The switcher is a sheet inside the panel, not a document-level surface

The selection transcript is document-level because it must escape the panel's
overflow and gesture hierarchy to allow native long-press selection. The switcher
has no such need: it is a list of buttons. Keeping it inside
`#terminal-panel` (a `#terminal-switcher` element after the keybar) means it
inherits terminal theming, clips to the panel, and sits naturally above the
keybar with the same `env(safe-area-inset-bottom)` treatment.

It renders on top of the terminal surface with a dismissing backdrop, sized to
its content and scrollable when the list is long.

**Openness is closure state, not a DOM read.** The sheet's content comes from an
async inventory read, so between the tap and the first paint the element is still
hidden — a DOM-derived `isSwitcherOpen()` reports "closed" for that whole window.
Two bugs live in that gap: a second tap renders a second sheet instead of
toggling, and a refresh that was in flight when the user dismissed the sheet
repaints it back into existence. A `switcherOpen` flag claimed synchronously by
`openSwitcher`, and re-checked after every await, closes both.

That flag must be declared with the panel's other state, **not** beside the
switcher functions: `initTerminalKeybar` runs during setup and calls
`isSwitcherOpen()` synchronously to seed `aria-expanded`. A `let` declared
further down the closure is still in its temporal dead zone at that moment, and
the ReferenceError propagates out of `setupTerminalPanel` and aborts boot — the
app hangs at "Connecting" with no terminal at all. This is the TDZ hazard
`CLAUDE.md` warns about, reachable without any circular import.

### D6 — The keybar gains a `switch` item kind

`KeybarItem` gains `{ kind: "switch" }`, rendered leftmost and visually
separated from the key cluster — it is navigation, not a key, and the existing
order is by tap frequency among *keys*. `KeybarDeps` gains `openSwitcher()`,
`isSwitcherOpen()`, and `dismissSwitcher()`, mirroring the selection-sheet trio
already there. The button reports `aria-expanded` and toggles.

The sheet is marked `aria-modal`, which promises the rest of the app is
unreachable while it is up, so it wraps Tab within its own buttons. Without that
wrap the promise is a lie: Tab walks straight into an xterm hidden behind the
backdrop. Escape always closes, so it is never a trap.

Focus is the one place the switch button breaks the keybar's rule that pressing
a key must never move focus out of the terminal. That rule exists to keep the
software keyboard up; the switcher is a deliberate context switch where losing the
keyboard is desirable, and dismissal restores focus to the visible pane. It uses
`click` (not `pointerdown`) for the same reason Paste does — release-time
activation keeps it keyboard-operable.

### D7 — Rows are a pure model shared by nothing else

`buildSwitcherRows(panes, inventory, activePaneSessionId, lastPtyId, now)` in
`picker.ts` returns rows carrying label, `state` (`"visible" | "attached-here" |
"detached" | "attached-elsewhere"`), age via the existing `formatSessionAge`, and
the actions each state permits. Attached-here rows come first in pane order, then
detached, then attached-elsewhere — the same "least disruptive first" ordering
`pickerCandidates` uses.

The desktop chooser keeps calling `pickerCandidates` unchanged. Sharing one
renderer across both would force the desktop panel into sheet semantics for no
gain; sharing the *model* is where the value is.

### D8a — "Mounted" is not "visible", and the switcher must respect that

Touch mode keeps the panel **mounted** while another tab is active — that is the
PTY-preserving contract (`terminalActionForTabChange` → `keep-attached`). It is
hidden by the `data-active-tab` CSS rule alone, with no `hidden` attribute to
test. Anything that asks `panel.hasAttribute("hidden")` to mean "can the user
see this?" gets the wrong answer for the entire time another tab is up.

An open switcher inherits that trap three ways: it keeps claiming Escape from
the surface the user is actually looking at, an in-flight inventory refresh
repaints it invisibly, and it reappears unbidden on the way back to the terminal.
So: leaving the Terminal tab dismisses it, `terminalSurfaceShowing()` replaces
the attribute check after every await, and `resolveTerminalEscapeAction` only
lets the switcher claim Escape when the terminal is genuinely on screen
(`!touchMode || terminalTabActive`) — the same shape as
`shouldEscapeExitTerminalFullscreen`, which exists for exactly this reason.

### D8 — Escape precedence

The panel's document-level capture-phase Escape handler gains one branch ahead of
the fullscreen exit: an open switcher closes and consumes the key. The selection
transcript and the switcher are mutually exclusive — the keybar disables the
switch action while the transcript is open — so the precedence chain stays linear:
switcher → selection transcript → fullscreen exit → pass through.

### D9 — Terminal tab badge covers hidden panes

`onOutput` currently badges the Terminal tab when the tab is inactive. With hidden
panes it must also fire for panes that are attached but not visible, so the
existing per-pane `onOutput` wiring stays as-is; only the condition changes from
"tab inactive" to "tab inactive **or** this pane is not the active pane" for the
switch-button affordance. The tab badge itself is unchanged in meaning.

## Risks / Trade-offs

- **A pile of orphans becomes a pile of panes.** A user who left six detached
  sessions gets a six-way split the next time a fresh window opens the terminal.
  → The pane cap bounds it at 8, and oldest-first ordering makes the result
  predictable. Hide/show is unaffected (it restores per-window records, not
  inventory), so this only happens on genuinely fresh windows — where attaching
  is the behavior the change is asking for.

- **Two windows auto-attaching the same session race.** → The server's
  single-holder rule decides; the loser reconciles (D3) and the session shows up
  as a takeover decision instead.

- **Auto-attach removes a confirmation step that some users read as a safety
  net.** → It only ever applies to detached PTYs, which by definition no client
  owns; attaching one is non-disruptive and reversible by closing the pane
  (which detaches without terminating).

- **`display: none` and xterm.** A pane revealed after being hidden can paint at
  the wrong size for a frame. → The refit in D4 runs on the next frame; the
  existing `terminal-fit` E2E pattern covers the shape of this bug.

- **Sheet vs. software keyboard.** Opening the switcher while the keyboard is up
  can leave the sheet fighting the visual viewport. → The panel already tracks
  `visualViewport` (`visual-viewport.ts`) and refits on focus transitions; the
  sheet positions against the same sizer rather than the layout viewport.

- **Touch mode now has two ways to lose a terminal** (panel close, switcher
  terminate). → Terminate in the switcher goes through the existing
  `killSessionRemote` + confirm path, so the "you'll lose running processes"
  contract is not weakened.

## Migration Plan

No data migration. Persisted shapes (`uatu:terminal-state`,
`uatu:terminal-panes`, personal `lastPtyId`) are unchanged, so a session that
downgrades to the previous build reads its state normally. Rollback is a revert:
the only durable side effect of the new behavior is *more panes attached*, which
the old build restores from the same per-window records.

## Open Questions

- Should the switcher (and its keybar button) show an unseen-output dot per
  hidden terminal? Genuinely useful for watching a build in a background shell,
  but it needs a per-pane "seen" watermark that nothing tracks today. Deferred —
  not specced in this change.
- Should desktop eventually adopt the switcher and retire the chooser? The user
  scoped this change to touch; revisit once the switcher has real use.
