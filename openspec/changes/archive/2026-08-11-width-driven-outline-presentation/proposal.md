## Why

The outline's docked rail assumes there is room for two columns. On an iPhone
there is not: measured on a 390×844 viewport against `ARCHITECTURE.md`, the
reserved gutter leaves the document a **114px** text column, breaking the `<h1>`
mid-word ("Archite / cture") and stretching the page from 22,729px to 57,467px —
2.5× taller, 68 screenfuls. The rail is not merely cramped there; it makes the
document unreadable for its entire length in exchange for a heading list that is
visible on the first screen only.

The same panel at 834px (iPad portrait) is good — a 288px rail beside a 470px
prose column. The presentation is not wrong; the *choice* of presentation is,
and `data-ui-mode` cannot make that choice because an iPad is `touch` at both
widths.

Tracked as [#182](https://github.com/tjakobsson/uatu/issues/182), under the
mobile umbrella [#194](https://github.com/tjakobsson/uatu/issues/194).

## What Changes

- **Presentation is selected by available width, not by UI mode.** When the
  preview area cannot host both the rail and a readable text column, the outline
  renders as a fullscreen sheet above the tab bar; otherwise it keeps today's
  docked rail unchanged. One behavioural rule covers iPhone portrait and
  landscape, iPad Split View, iPad portrait and landscape, narrow desktop
  windows, and the existing ≤900px stacked layout — which carries the same
  defect today and is not otherwise in scope for #182.
- **The sheet is modal and reserves no gutter.** The document is never reflowed
  by opening the outline, so the reading column keeps its full width and the
  heading-offset measurement race that opening the gutter causes disappears
  below the threshold.
- **The sheet dismisses on selection and on document change.** Selecting a
  heading jumps and closes. A document change closes it rather than leaving a
  modal surface over a document the user just opened.
- **Touch affordances on coarse pointers.** Heading rows and the close control
  meet the 44px target size already enforced for the preview toolbar; the
  filter input is no longer auto-focused, so opening the outline does not
  summon the software keyboard.
- **The outline reveals the active heading when it opens.** The scroll-spy
  already computes it; the panel currently opens scrolled to the top regardless.
- **Width resizing belongs to the rail only.** The 6px `touch-action: none`
  drag handle is not rendered in the sheet presentation, where it is both
  unhittable and positioned where a dismissal swipe would land.
- **The panel is pinned to what is visible, in both presentations.** Geometry
  comes from the preview's scrollport rather than from a document-tall shell,
  which is what stops the rail being tens of thousands of pixels tall, stops it
  scrolling out of reach, and stops it covering its own dismissal control. See
  the folded-in section below.

No breaking changes: the desktop rail's appearance, behaviour, persisted width,
and Escape dismissal are untouched above the threshold.

## Capabilities

### New Capabilities

None. This reshapes an existing capability rather than introducing one.

### Modified Capabilities

- `document-outline`: the panel's presentation becomes width-conditional rather
  than always-docked. "Outline is a non-modal panel" and "Outline is docked
  beside the content" both currently assert unconditional behaviour that only
  holds above the threshold; "Outline width is adjustable and remembered"
  becomes rail-only. New requirements cover presentation selection, the sheet's
  dismissal rules, touch target sizing, keyboard suppression, and revealing the
  active heading on open.

## Impact

- `src/preview/outline.ts` — presentation resolution, `layoutPanel`,
  `setOpen`, `buildList`, `refreshOutline`, and the resize-handle wiring.
- `src/styles.css` — the `.uatu-outline` block gains a sheet presentation;
  `.preview-shell.is-outline-docked #preview` becomes rail-only.
- `tests/e2e/outline.e2e.ts`, `tests/e2e/mobile.e2e.ts`,
  `tests/e2e/ipad.e2e.ts` — presentation coverage per device class.
- `tests/e2e/touch-scroll.e2e.ts` — two helpers (`scrollHeadingIntoTriggerZone`
  and the comment block above it) exist to work around the gutter reflow the
  sheet removes on phones; they stay correct but their rationale narrows.
- No server, protocol, or persistence changes. The stored outline width keeps
  its meaning and is simply unused while the sheet is showing.

## The geometry defect, folded in

Closes [#231](https://github.com/tjakobsson/uatu/issues/231).

The panel was positioned `absolute` inside `.main-stack` and sized from
`.preview-shell`, both of which are document-tall in touch mode and the stacked
layout. It therefore scrolled away with the page, was given a `height` of tens
of thousands of pixels (12,395px on iPad, 57,220px on iPhone), and — because its
`z-index: 3` beats the preview header's `2` — covered the very toggle that would
close it. Once scrolled, the panel had no reachable dismissal on a touch device:
the close control off-screen above, the toggle behind the panel, and no Escape
key. Confirmed on iPhone (`scrollY: 4000`) and iPad (`scrollY: 2200`).

This was originally scoped out, to ship as its own fix first. Device testing
showed that was the wrong call: it is the **same measurement bug** as the
desktop case where a right-docked terminal made the sheet blanket the whole
window. Both come from taking geometry off a document-tall box or the whole
window instead of the preview's scrollport, and separating them would have meant
writing one measurement change twice while leaving the rail visibly broken on
the device class this change most affects.

Both presentations are therefore positioned from
`scrollportRect(previewScrollRoot())` in viewport coordinates, and the panel is
`position: fixed`.
