## 1. Action-icon bar in the preview header

- [x] 1.1 Add the action-icon button group to `.preview-toolbar` in `src/index.html` (outline toggle + copy-source), with inline SVG icons, ARIA labels, and `hidden` defaults
- [x] 1.2 Add icon-button styling to `src/styles.css` using existing `--border-*` / accent / shadow tokens, matching the existing view/wrap control conventions
- [x] 1.3 In `src/preview/header.ts`, query and re-export the new buttons and add show/hide helpers gated to Rendered view (mirroring wrap-control gating)

## 2. Outline module — enumeration & panel

- [x] 2.1 Create `src/preview/outline.ts` with a `collectHeadings(root)` that enumerates `h1`–`h6` into `{level, text, element, id}`, deriving clean labels from `textContent`
- [x] 2.2 Render the non-modal floating overlay (filter input, nested heading list, close control) as an absolutely-positioned panel inside `.preview-shell`; closed by default
- [x] 2.3 Implement open/close (toggle button + Escape), keeping focus untrapped, and reflect open state on the toggle button
- [x] 2.4 Implement entry navigation: scroll the captured heading element into view (fall back to element reference when `id` is missing/duplicated)

## 3. Scroll-spy & layout/remount wiring

- [x] 3.1 Implement an `IntersectionObserver` that highlights the active heading, rooted on the current scroll container (`.preview-shell` single, `.preview-pane-rendered` split)
- [x] 3.2 Centralize observer teardown + rebuild and outline rebuild in the `src/preview/mount.ts` post-render hook so it survives document remounts
- [x] 3.3 Re-point the observer root and rebuild the outline on layout changes (single ↔ split)

## 4. Filter & resize

- [x] 4.1 Implement filter input that shows only matching entries without affecting active-heading tracking
- [x] 4.2 Dock the panel as a full-height right rail that reserves a `--outline-gutter` on `#preview` so the document reflows beside it; release the gutter when closed/hidden
- [x] 4.3 Add a left-edge width resizer (docked right edge fixed, like the app's other side panels); clamp to keep a minimum of document visible; persist the width under `uatu:outline-width`

## 5. Copy-source action

- [x] 5.1 Wire the copy-source button to the raw document source using the exported `copyToClipboard()` helper from `src/preview/code-block.ts`
- [x] 5.2 Reuse the flash-feedback pattern for success/failure confirmation

## 6. Gating & edge cases

- [x] 6.1 Hide the outline toggle when the document has zero headings; keep copy-source available whenever raw source exists
- [x] 6.2 Hide both buttons (and close the overlay) outside Rendered view

## 7. Tests

- [x] 7.1 Unit tests for `collectHeadings` against representative Markdown and AsciiDoc rendered fragments (`src/preview/outline.test.ts`)
- [x] 7.2 E2E test in `tests/e2e/` covering open/close, jump-to-section, active-heading highlight, filter, resize/fit/reset persistence, and view-gating
