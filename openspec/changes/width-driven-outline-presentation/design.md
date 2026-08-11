## Context

`src/preview/outline.ts` builds one panel and lays it out with `layoutPanel()`,
which measures `.main-stack` (the panel's `position: absolute` container) and
`.preview-shell`, then reserves a matching `--outline-gutter` on `#preview`.
Both measurements are correct in the desktop grid, where `.app-shell` is
`height: 100vh; overflow: hidden` and `.preview-shell` is the scroller.

Touch mode and the ≤900px stacked layout both hand scrolling to the page:
`.app-shell { display: block; height: auto }` and `.preview-shell { overflow:
visible; height: auto !important }`. Neither anchor is viewport-sized any more.

Measured on 390×844 against `ARCHITECTURE.md`, outline open:

| | iPhone 390 | iPad portrait 834 |
|---|---|---|
| Panel width | 200px | 288px |
| Reserved gutter | 216px | 304px |
| Document text column | **114px** | 470px |
| Panel inline `height` | **57,220px** | 12,395px |
| Document height closed → open | 22,729 → **57,467px** | — |
| Outline row height | 23px | 23px |
| Close control | 24×24px | 24×24px |
| `activeElement` after open | `.uatu-outline-filter` | `.uatu-outline-filter` |

The width clamp degenerates rather than fails. `maxWidth = max(MIN_WIDTH,
shellWidth − MIN_CONTENT)` means that below roughly 480px of shell the
`MIN_WIDTH` floor wins and `MIN_CONTENT` — the constraint that exists to protect
reading space — is silently abandoned exactly where reading space is scarcest.

The codebase has already answered a structurally identical question once.
`src/shell/preview-scroll-root.ts` resolves the scroll container by asking "can
this element scroll?" rather than "are we in touch mode?", and its header
comment states the reason: a fourth layout is then handled without touching the
file. Presentation selection is the same shape of question and gets the same
shape of answer.

## Goals / Non-Goals

**Goals:**

- Pick the outline's presentation from available width, in one place, with a
  behavioural test rather than a mode lookup.
- Keep the docked rail bit-for-bit unchanged above the threshold, including its
  persisted width, Escape dismissal, and non-modal reflow.
- Make the narrow presentation reuse the app's established touch idiom rather
  than inventing a new surface vocabulary.
- Remove the reading-space damage entirely below the threshold rather than
  reducing it.

**Non-Goals:**

- A bottom sheet with drag detents. Considered and set aside below.
- An active-heading breadcrumb chip in the preview header. Considered and set
  aside below; it remains available as a follow-up.
- Any change to heading enumeration, scroll-spy activation-point maths, filter
  semantics, or the `preview-action-bar` toggle's gating.

## Decisions

### Presentation is resolved from the preview area's width, not `data-ui-mode`

An iPad reports `data-ui-mode="touch"` at 834px, where the rail is good, and an
iPhone reports the same at 390px, where it is unusable. The mode attribute
cannot distinguish them, and gating on it would leave the ≤900px stacked desktop
layout — which reproduces the identical defect — unfixed.

One width rule covers iPhone portrait and landscape, iPad Split View, iPad
portrait and landscape, narrow desktop windows, and the stacked layout.

*Alternative considered:* gate on `uiMode() === "touch"` plus width. Rejected:
strictly more code for strictly less coverage, and it preserves a known defect
in the stacked layout on the technicality that it is a desktop-mode layout.

### Corrections from review

Two errors in the first implementation, both caught in review on the PR and
both worth recording because the reasoning that produced them looked sound:

**The threshold was derived from a width the rail never uses.** It was computed
from `MIN_WIDTH` (200) + `EDGE_MARGIN`, giving 596 — but `layoutPanel` opens the
rail at the stored width, defaulting to `DEFAULT_WIDTH` (288). At a 596px
preview the rail therefore took 304px and left roughly 245px of prose, not the
380 the derivation promised. The floor is now computed from the footprint the
rail actually applies, and from the layout's measured padding rather than an
assumed constant — the shell alone swings between 1.75rem and 1rem across the
≤900px breakpoint. Stated as "what would be left for prose", which is the
question that matters, instead of a bare width that has to be re-derived by
hand whenever either input moves.

**The sheet's `z-index: 35` outranked things it needed to stay under.** It was
chosen to beat the touch Files (30) and Terminal (40) surfaces — an overlap that
cannot occur, because the sheet is already `display: none` whenever the active
tab is not Preview. Defending against the impossible cost two real regressions:
the preview find bar (`.find-slot`, z-index 4) opened *behind* the sheet and
invisible while ⌘F still swallowed the keystroke, and a desktop fullscreen
terminal (z-index 5) stayed underneath it. The sheet now inherits the base
`z-index: 3`, which still covers the preview header (2) — all it ever needed.

The general lesson for this file: a z-index picked to win against a specific
neighbour silently changes the relationship with every other neighbour.

### The threshold is derived, not chosen by taste

The rail is viable when the preview area can seat what the rail actually
occupies — `DEFAULT_WIDTH` (288px) plus `EDGE_MARGIN` (16px) — plus the layout's
own horizontal padding, plus a genuinely readable prose column. At the preview's
16px base, roughly 45 characters — the low end of comfortable measure — is about
380px.

The rule is expressed as the prose column that would survive, not as a width
constant, so it stays correct when the rail's width or the layout's padding
changes. It uses the rail's *default* footprint rather than the user's stored
width on purpose: dragging the rail must never flip the presentation out from
under the drag.

Two consequences worth stating: this replaces `MIN_CONTENT` as the real
reading-space guarantee, leaving `MIN_CONTENT` as a drag bound only; and the
measurement is of the **preview area**, not the window, so docking the terminal
to the right can push the outline into the sheet presentation without the window
changing size. That is the correct behaviour and follows from measuring the
right box.

*Landscape phone:* an iPhone in landscape is 844px wide and clears the width
threshold, but only 390px tall — a full-height rail there yields roughly four
44px rows. Adding a height floor (rail requires both ≥600px width and ≥480px
height) sends landscape phones to the sheet as well. This is the one judgement
call in the threshold; it is recorded as an open question rather than settled
here, and the implementation should put both constants in one place so the
answer is a one-line change.

### Both presentations are measured from the preview's scrollport

Added after device testing, and it supersedes two earlier positions in this
document: that the panel-geometry defect ([#231](https://github.com/tjakobsson/uatu/issues/231))
was out of scope, and that the sheet needs "no new geometry maths".

Three symptoms turned out to be one bug — geometry taken from a box that is not
what the reader can see:

| Symptom | Measured from | Should measure |
|---|---|---|
| Rail 12,395px tall on iPad, scrolls away, covers its own toggle | `.preview-shell` rect (document-tall in touch mode) | the scrollport |
| Same at 57,220px on iPhone | as above | the scrollport |
| Sheet blankets sidebar and terminal when the terminal is right-docked | the whole window | the preview surface |

So `layoutPanel()` now positions both presentations from
`scrollportRect(previewScrollRoot())` in viewport coordinates, and `.uatu-outline`
is `position: fixed`. The horizontal extent still comes from the shell's rect,
which is the correct question for width — it is the region the outline belongs
to and the thing that narrows when the terminal docks.

The sheet's box is handed to CSS as custom properties
(`--outline-surface-top/left/width/gap`) rather than computed entirely in CSS,
because only JS can answer "what is the visible preview area right now". In
touch mode the scrollport is the viewport, so those values resolve to the
fullscreen sheet the phone already had; nothing about the phone changes.

One thing CSS cannot express and JS must measure: the touch tab bar is
`position: fixed` OVER the layout viewport rather than shortening it, so
`documentElement.clientHeight` still counts the strip underneath it. The bar's
own height is read off the element (`bottomChromeInset()`), which is zero when
it is not rendered — no mode lookup required.

*Alternative considered:* keep the sheet CSS-only via a `--surface-bottom-inset`
token. That worked for the phone but had no way to express "the preview pane,
not the window" on desktop, which is precisely the case that made the sheet
unacceptable there.

### The narrow presentation is a fullscreen sheet, not a bottom sheet

Touch mode already renders Files and Terminal as fullscreen surfaces pinned
above the tab bar (`position: fixed; inset: 0; bottom: var(--tab-bar-total)`).
The sheet reuses that recipe verbatim, which means no new geometry maths, an
idiom the user has already learned, and full width for 44px rows and untruncated
heading text.

*Alternative considered:* a bottom sheet with drag detents. More iOS-native and
keeps part of the document visible, but it costs drag state, detent snapping,
and a scroll-conflict resolution between the sheet and the list inside it — and
the document staying visible has little value for a control whose entire purpose
is to leave for somewhere else.

*Alternative considered:* an active-heading chip in the preview header replacing
the toggle. Attractive because the scroll-spy already computes the value, but
the touch preview header already wraps to 145px and this competes for that
space. Better as a follow-up once the sheet exists, since it would open the
same sheet.

### Modal below the threshold is a feature, not a concession

The gutter's purpose is to keep the panel from covering text. Below the
threshold it cannot achieve that — it converts "covers some text" into "makes
all text unreadable", measured here as a 114px column and a 2.5× taller
document. Covering the document briefly and completely is strictly better than
narrowing it permanently.

This also removes a class of measurement race on phones: opening the gutter
reflows every heading offset mid-interaction, which
`tests/e2e/touch-scroll.e2e.ts` carries two hand-written workarounds for
(`scrollHeadingIntoTriggerZone` re-aims up to 12 times; the comment above it
explains that a `scrollTo(scrollHeight)` lands short of a moving maximum). Those
helpers stay correct — the rail still reflows above the threshold — but they
stop being load-bearing for phone-width runs.

### Modality forces two dismissal rules the rail does not need

A surface that covers the document must leave when the user has chosen where to
go (selection) and must not persist over a document it does not describe
(document change). `refreshOutline()` currently ends with `setOpen(open)`,
deliberately preserving open state across remounts; that stays right for the
rail and becomes wrong for the sheet.

### Touch affordances are gated on pointer type, not on presentation

Row height, close-control size, and filter focus are input-device questions, not
layout questions — an iPad in desktop mode still has fingers. This matches the
existing split stated at the top of the touch section in `styles.css`: layout
keys on `data-ui-mode`, input affordances key on `(pointer: coarse)`. So the
44px targets and the suppressed autofocus apply to the rail too when the pointer
is coarse.

### Revealing the active heading on open is separate from presentation

`buildList()` never scrolls the list to the active entry. A tall desktop rail
usually shows it anyway; a sheet opened 40% into a document would not. The fix
belongs with `setOpen(true)` regardless of presentation, and is specified
independently so it is not accidentally scoped to the sheet.

## Risks / Trade-offs

**A live presentation switch mid-interaction is jarring** → The switch only
fires when the available width actually crosses the threshold (rotation,
terminal dock, window drag), and the spec requires the panel to stay open across
it. Keeping open state and scroll position across the swap is a stated
behaviour, not an accident.

**Hysteresis at the threshold** → A width parked exactly at the boundary could
flip presentations on sub-pixel resize noise. Resolve at integer pixels and, if
flapping is observed, add a small dead band. Not pre-solved, because the
terminal-dock path changes width in large steps.

**Measuring the preview area couples presentation to terminal docking** →
Intended, and confirmed real: on a 1280×720 desktop, right-docking the terminal
takes the preview from 954px to 590px, six pixels under the threshold, so the
outline becomes a sheet. That is the right call — at 590px the rail genuinely
would squeeze the document — and it is only acceptable because the sheet now
covers the preview pane rather than the window. The existing
`outline.e2e.ts` right-dock test passes unmodified against the sheet, which is
the check that this stayed honest.

**The stacked ≤900px layout is in scope without being in the issue** → It shares
the defect and the fix comes free, but it is desktop-mode presentation changing.
The proposal states this; it is the one place where "preserve the existing
desktop presentation" in #182 is being read as "unless the behaviour is
inherently width-driven", which that issue explicitly allows.

**E2E coverage must not go vacuous** → Two traps are already documented in this
repo: a service worker defeating `page.route`, and Chromium merging same-URL
GETs. A third applies here — asserting "the sheet is visible" passes trivially
if the rail is also visible. Presentation assertions must check the mutually
exclusive property (a reserved gutter versus none, or a computed `position`),
not merely that a panel exists.

## Migration Plan

No data, protocol, or persistence migration. The stored outline width keeps its
meaning and is simply unused while the sheet is showing.

Rollback is a revert: the presentation resolver is additive, and above the
threshold the rail path is the existing code.

## Open Questions

- ~~**Does the rail need a height floor as well as a width floor?**~~
  **Settled on device.** An iPhone in landscape clears the width floor at 844px
  but is only 390px tall, where a full-height rail seats about four 44px rows.
  Both floors are enforced (`RAIL_MIN_WIDTH` 596, `RAIL_MIN_HEIGHT` 480), so
  landscape phones get the sheet. Confirmed by hand on iPhone, iPad, and
  desktop; the arrangement reads correctly in every orientation tested.
- **Should the sheet animate in?** The Files and Terminal surfaces swap without
  transition today. Matching them is the consistent choice; a sheet is also the
  one surface where a slide-up would read as native. Deferred as polish.
- **Does the filter stay a permanently visible field in the sheet?** Suppressing
  autofocus is settled. Whether it should further collapse to a magnifier button
  to buy vertical room for heading rows is a question the sheet's real density
  will answer better than reasoning will.
