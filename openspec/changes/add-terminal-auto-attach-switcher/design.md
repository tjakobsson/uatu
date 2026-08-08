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
in order keeps both invariants without new locking. A single `fitAll()` after the
batch replaces the per-pane one.

Active pane after a batch: the saved `lastPtyId` when it is among the attached
set, otherwise the newest attached pane. `lastPtyId` still never *causes* an
attachment — it only selects among attachments that were going to happen anyway,
which is what keeps the takeover rule intact.

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

### D6 — The keybar gains a `switch` item kind

`KeybarItem` gains `{ kind: "switch" }`, rendered leftmost and visually
separated from the key cluster — it is navigation, not a key, and the existing
order is by tap frequency among *keys*. `KeybarDeps` gains `openSwitcher()`,
`isSwitcherOpen()`, and `dismissSwitcher()`, mirroring the selection-sheet trio
already there. The button reports `aria-expanded` and toggles.

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
