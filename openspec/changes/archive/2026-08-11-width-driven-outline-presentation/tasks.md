## 1. Presentation resolution

- [x] 1.1 Add a presentation resolver to `src/preview/outline.ts` exposing a
      pure rule (available width/height → `"rail" | "sheet"`) alongside the DOM
      reader that measures the preview area, mirroring the split
      `preview-scroll-root.ts` uses between `pickScrollRoot` and
      `previewScrollRoot`
- [x] 1.2 Define the threshold constants in one place with the derivation from
      `MIN_WIDTH` + `EDGE_MARGIN` + a readable measure recorded as a comment
- [x] 1.3 Unit-test the pure rule against the measured device widths (390, 834,
      1024, 1280) and the boundary, including the height floor if adopted
- [x] 1.4 Resolve the presentation in `layoutPanel()` and re-resolve on the
      existing resize and `onUiModeChange` subscriptions plus the
      `ResizeObserver` already watching `.preview-shell`

## 2. Sheet presentation

- [x] 2.1 Add the sheet CSS to `src/styles.css` reusing the fullscreen-surface
      recipe (`position: fixed; inset: 0; bottom: var(--tab-bar-total)`) that
      the Files and Terminal surfaces use, keyed on a presentation attribute or
      class on the panel rather than on `data-ui-mode`
- [x] 2.2 Scope `.preview-shell.is-outline-docked #preview` to the rail
      presentation so the sheet reserves no gutter, and release the gutter when
      an open rail becomes a sheet
- [x] 2.3 Suppress the resize handle in the sheet presentation without
      discarding the stored width, so returning to the rail restores it
- [x] 2.4 Tie the sheet's visibility to the Preview surface so an open sheet is
      hidden when another tab is active, rather than relying on the current
      accidental z-index occlusion by the fixed Files and Terminal surfaces

## 3. Sheet dismissal rules

- [x] 3.1 Dismiss the sheet on heading selection, after the jump is issued, and
      leave rail behaviour unchanged
- [x] 3.2 Dismiss the sheet on document change in `refreshOutline()` while
      keeping `setOpen(open)` state preservation for the rail

## 4. Touch affordances

- [x] 4.1 Raise heading-entry and close-control activation targets to 44px under
      `(pointer: coarse)` in both presentations, keeping the existing visual
      density on fine pointers
- [x] 4.2 Skip the filter-input focus on open for coarse pointers, retaining it
      for fine pointers
- [x] 4.3 Scroll the active heading's entry into view within the outline list
      when the panel opens, in both presentations

## 5. Pinned geometry (folded-in #231)

- [x] 5.1 Position both presentations from `scrollportRect(previewScrollRoot())`
      in viewport coordinates and make `.uatu-outline` `position: fixed`
- [x] 5.2 Measure the touch tab bar off the element so a full-height rail clears
      fixed bottom chrome without a mode lookup
- [x] 5.3 Hand the sheet's surface box to CSS as custom properties so it covers
      the preview pane, not the window, when the terminal is right-docked

## 6. Tests

- [x] 6.1 Assert presentation selection by mutually exclusive properties — the
      panel spanning the full surface with no gutter versus a fraction of it
      with one — never merely that a panel is visible, so the assertion cannot
      pass in both presentations
- [x] 6.2 Cover the sheet on an iPhone viewport: opening reserves no gutter, the
      document's text column is unchanged from closed, selection jumps and
      dismisses, and a document change dismisses
- [x] 6.3 Cover the rail on an iPad viewport: the rail is chosen at 834px, the
      gutter is reserved, and 44px targets hold
- [x] 6.4 Cover the live threshold crossing: an open panel swaps presentation on
      a viewport resize across the boundary and stays open
- [x] 6.5 Cover the coarse-pointer filter behaviour: `document.activeElement` is
      not the filter after opening, and activating the filter still focuses it
- [x] 6.6 Cover active-entry reveal: opening partway through a document leaves
      the active entry visible within the list's scrollport
- [x] 6.7 Cover the pinned invariant: the panel is never taller than the
      viewport, stays put while the document scrolls, and never covers the
      toggle
- [x] 6.8 Confirm the existing desktop outline suite in
      `tests/e2e/outline.e2e.ts` passes unchanged, demonstrating the rail is
      untouched above the threshold

## 7. Spec and docs sync

- [x] 7.1 Check the prose docs for descriptions of the outline as
      unconditionally docked — `ARCHITECTURE.md` turns out not to mention the
      outline at all, and README's only reference is screenshot alt text that
      stays accurate, so no doc edit is needed
- [x] 7.2 Run `openspec validate width-driven-outline-presentation --strict`
- [x] 7.3 Run `bun test` and `bun test:e2e`

## Notes

The new E2E coverage lives in `tests/e2e/outline-presentation.e2e.ts` rather
than being split across `mobile.e2e.ts` and `ipad.e2e.ts` as first planned. The
repository convention is feature-named E2E files, and the presentation rule is
one feature whose whole point is that it spans device classes — splitting it by
viewport would have hidden that.

The panel-geometry defect (#231) was originally scoped out of this change and
has been folded in. Device testing showed it is the same measurement bug as the
desktop right-docked-terminal case, so fixing them separately would have meant
writing one change twice. This change closes
[#231](https://github.com/tjakobsson/uatu/issues/231).

Per repository convention this change lands as a PR rather than a direct push to
`main`, with a `feat(preview):` subject describing the change. Whether the
release notes need a Release Please override depends on whether any part of the
outline's touch behaviour being corrected here shipped in the latest stable
tag — determine that before merge rather than assuming.
