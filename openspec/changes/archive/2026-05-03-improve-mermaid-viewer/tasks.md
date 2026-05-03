## 1. SVG sizing fix

- [x] 1.1 In `src/preview.ts`, after `mermaid.run({ nodes })` resolves, iterate the rendered SVGs and strip Mermaid's inline `max-width`, `width`, and `height` (attribute and style), then set `style.width = "100%"` and `style.height = "auto"`. Preserve `viewBox`.
- [x] 1.2 In `src/styles.css`, simplify `.preview .mermaid` so it no longer relies on `display: grid; justify-content: center;` for sizing. The block becomes a full-width container with appropriate vertical padding; remove `overflow-x: auto` since the SVG is now bounded.
- [x] 1.3 Add a unit test in `src/preview.test.ts` that asserts the post-render normalization step removes `max-width` and sets `width: 100%` on a fixture SVG.
- [x] 1.4 Add an e2e case (in `tests/e2e/uatu.e2e.ts`) that loads a doc containing a small Mermaid diagram and asserts the rendered SVG's `clientWidth` is at or near the preview content width (within a small tolerance).

## 2. Theme seam in Mermaid initialization

- [x] 2.1 In `src/preview.ts`, define `MermaidThemeInputs = { theme: ...; themeVariables?: Record<string, string> }`.
- [x] 2.2 Replace the hard-coded `mermaid.initialize` call with logic that compares incoming theme inputs to the last-used inputs (kept in module state) and re-initializes only when they differ.
- [x] 2.3 Update `renderMermaidDiagrams(container, themeInputs?)` to accept optional inputs; default to `{ theme: "default" }` to preserve existing visuals.
- [x] 2.4 Update the call site in `src/app.ts` to pass the current theme inputs (today: the default; designed for future wiring to the active UI theme).
- [x] 2.5 Add a unit test verifying that calling `renderMermaidDiagrams` with new theme inputs triggers a re-init (mock the runtime; assert `initialize` is called again only when inputs change).

## 3. Mermaid viewer module

- [x] 3.1 Create `src/mermaid-viewer.ts` exporting `ensureMermaidViewer(): MermaidViewer` and `closeMermaidViewer()`.
- [x] 3.2 On first call, create one `<dialog class="mermaid-viewer">` element and append it to `document.body`. Idempotent for subsequent calls.
- [x] 3.3 Implement `viewer.open({ svg: SVGElement, title?: string, returnFocusTo: HTMLElement })`: clones the SVG into the viewport wrapper, sets `aria-label`, calls `dialog.showModal()`, focuses the close button.
- [x] 3.4 Implement pan: pointerdown/pointermove/pointerup on the viewport wrapper; track `tx, ty`; apply `transform: translate(tx, ty) scale(s)`.
- [x] 3.5 Implement wheel-zoom-at-cursor: compute new scale logarithmically (e.g. `s *= Math.exp(-deltaY * 0.001)`), clamp to `[0.2, 8]`, adjust `tx, ty` so the cursor's world-point is preserved.
- [x] 3.6 Implement double-click reset and explicit `reset()` and `fit()` operations.
- [x] 3.7 Render the toolbar `[+] [−] [⟲ reset] [⛶ fit]` plus close `[×]` and wire each button to the corresponding operation.
- [x] 3.8 Wire keyboard shortcuts on the dialog: `+`, `-`, `0` (reset), `f` (fit). Esc and backdrop close are handled by `<dialog>` natively, but ensure `close` event returns focus to `returnFocusTo`.
- [x] 3.9 Style the viewer in `src/styles.css` using existing CSS custom properties so it adopts the active theme tokens. Include the toolbar layout, backdrop dimming, focus outlines.

## 4. Trigger affordance on inline diagrams

- [x] 4.1 In `src/preview.ts`, after the SVG normalization step (see 1.1), wrap each `.mermaid` div's contents in (or replace with) a `<button class="mermaid-trigger" type="button">` containing the SVG, plus a child `<span class="mermaid-trigger-badge" aria-hidden="true">⛶</span>` positioned in the top-right.
- [x] 4.2 Style the trigger in `src/styles.css`: `appearance: none`, no native button background/border, `cursor: zoom-in`, `display: block`, full-width. Show the badge on `:hover` and `:focus-visible`. Provide a focus outline that matches the rest of the app.
- [x] 4.3 In `src/app.ts`, after `renderMermaidDiagrams`, attach a single delegated click handler that resolves the nearest `.mermaid-trigger`, finds its inner `<svg>`, and calls `viewer.open({ svg, returnFocusTo: trigger })`.
- [x] 4.4 Ensure Enter and Space activate the button (default `<button>` behavior); verify in tests.

## 5. Re-render handling

- [x] 5.1 In `src/app.ts`, before replacing `previewElement.innerHTML` on a file-change event, call `closeMermaidViewer()` so the viewer does not show a stale diagram clone.
- [x] 5.2 Verify the viewer module survives `previewElement` re-renders because it is mounted on `document.body`, not inside the preview tree.

## 6. e2e coverage

- [x] 6.1 Add a fixture document with at least one Mermaid diagram under the e2e test data set (or reuse an existing fixture).
- [x] 6.2 e2e: assert clicking a rendered diagram opens a `<dialog open>` element with a cloned `<svg>` inside.
- [x] 6.3 e2e: assert pressing Esc closes the dialog and returns keyboard focus to the trigger.
- [x] 6.4 e2e: assert clicking the backdrop closes the dialog.
- [x] 6.5 e2e: dispatch a wheel event over the dialog and assert the inner transform style changes (proxy for zoom working).
- [x] 6.6 e2e: edit the watched fixture file while the dialog is open and assert the dialog closes on the resulting re-render.
- [x] 6.7 e2e: assert inline diagram `clientWidth` is within tolerance of the preview content width (covers Section 1).

## 7. Polish and verification

- [x] 7.1 Run `bun test` and address any unit/regression failures.
- [x] 7.2 Run `bun run test:e2e` and address any failures.
- [x] 7.3 Manually verify in `bun run dev` against fixtures that include: a flowchart, a sequence diagram, a small C4 diagram, and a wide diagram. Confirm fit-to-width inline and zoom/pan in the modal.
- [x] 7.4 Run `bun run check:licenses` to confirm no new dependency was introduced.
- [x] 7.5 Update any developer-facing notes in `README.md` only if behavior change is user-visible enough to warrant a mention.

## 8. Follow-up: bug fixes from manual verification

- [x] 8.1 Add a permanent `testdata/watch-docs/mermaid-shapes.md` fixture with the four shapes (small flowchart, sequence, small C4, wide flowchart) so each shape is exercised by automated tests.
- [x] 8.2 Cap inline diagram height (`max-height: 70vh`) and set `aspect-ratio` from `viewBox` in `normalizeMermaidSvg` so a near-square small diagram does not dominate the page.
- [x] 8.3 In `mermaid-viewer.ts`, replace the strip-all-ids approach with an id remapping that rewrites `url(#x)` and `href="#x"` references in the clone — fixes the all-black render of cloned SVGs in the modal.
- [x] 8.4 Restore explicit `width`/`height` attributes on the cloned SVG from its `viewBox` so the inline-block stage has real dimensions, and center the stage in the viewport on `fit()`.
- [x] 8.5 Add e2e tests that would have caught each of the three regressions: (a) all four shapes render an inline SVG, (b) inline SVG height never exceeds the 70vh cap, (c) every internal `url(#x)`/`href="#x"` reference in the cloned modal SVG resolves, (d) the modal stage occupies a meaningful fraction of the viewport.
- [x] 8.6 Update `specs/document-watch-browser/spec.md` to capture the height cap as a normative requirement with a matching scenario.

## 9. Follow-up: second wave from manual verification

- [x] 9.1 Extend `remapSvgIds` to rewrite `#oldId` references inside every embedded `<style>` element. Mermaid scopes its themed fills with the SVG root id (e.g. `#mermaid-12345 .node rect { fill: ... }`); without rewriting the CSS text, the cloned diagram renders with default (black) fills.
- [x] 9.2 Restructure the modal viewport: drop the `display: flex` centering and position the stage absolutely at `(0, 0)` so JS-managed `tx, ty` is the single source of position truth. The flex centering composed with `fit()`'s center-offset translate and pushed non-square shapes off-screen.
- [x] 9.3 Add an e2e test asserting that the cloned modal SVG retains Mermaid's themed (non-black) fills across all four shapes — would have caught the second wave of all-black-fills regressions.
- [x] 9.4 Add an e2e test asserting that the modal stage center is within ~20px of the modal viewport center across all four shapes — would have caught the off-position bug.

## 10. Sane sizing pass

- [x] 10.1 Tighten inline diagram caps to comfortable reading-content bounds: `max-width: min(100%, 880px)` and `max-height: 50vh`. Center the trigger via flex on `.preview .mermaid` and shrink-wrap the trigger so the hover badge sits on the diagram corner, not on the full preview-column corner.
- [x] 10.2 Make the modal fill the entire browser canvas (`width: 100vw; height: 100vh`, no border-radius/box-shadow). Remove the now-meaningless backdrop-click handler and replace its e2e test with one that asserts the modal occupies the full window.
- [x] 10.3 Update `specs/document-watch-browser/spec.md` for the new caps, centering, fullscreen modal, and removed backdrop-close path.
- [x] 10.4 Update the inline-width and inline-height e2e tests to assert against the new 880px / 50vh bounds.

## 11. Visual balance: fixed display slots

- [x] 11.1 Switch inline diagram layout from "negotiate against caps" to "fixed display slot" — every `.mermaid-trigger` is `width: 100%; max-width: 720px; height: min(380px, 50vh)`. SVG fills the slot at 100%/100% and `preserveAspectRatio="xMidYMid meet"` centers and fits the diagram content. Ensures small flowcharts, sequence diagrams, C4, and wide flowcharts share the same visual rhythm on the page.
- [x] 11.2 Simplify `normalizeMermaidSvg` to only strip Mermaid's intrinsic-pixel hints — no more inline `width`/`height`/`aspect-ratio` styles. CSS rules on `.mermaid-trigger > svg` are the single source of layout truth.
- [x] 11.3 Add an e2e regression asserting that all four shapes in `mermaid-shapes.md` render with identical display-slot dimensions (within sub-pixel rounding) — would have caught the "no balance" complaint.
- [x] 11.4 Update spec to capture the fixed-slot contract (no longer "fill width up to cap").

## 12. Tighten viewBox to actual content

- [x] 12.1 In `normalizeMermaidSvg`, after stripping Mermaid's intrinsic-pixel sizing, recompute the SVG's `viewBox` from the rendered content's `getBBox()` so internal padding (most visible on C4 and wide-LR flowcharts) does not eat slot space when the SVG fits via preserveAspectRatio. Add 4% breathing-room padding around the tightened viewBox.
- [x] 12.2 Add an e2e regression that computes diagram-content fill against the slot via `getBBox()` and `viewBox.baseVal` (the SVG's own scale factor), asserting at least one slot dimension is filled to ≥80% across all four shapes. Would have caught the C4-tiny-in-slot and wide-tiny-in-slot bugs.

## 13. Honor Mermaid's intended sizing

- [x] 13.1 Drop the fixed-slot CSS and viewBox tightening. `.mermaid-trigger` becomes `display: inline-block; max-width: 100%` (shrink-wraps the SVG, capped to preview width). `.preview .mermaid` keeps its flex centering.
- [x] 13.2 Simplify `normalizeMermaidSvg` to strip Mermaid's fixed-pixel `width`/`height` attributes and add inline `width: 100%; height: auto` — preserves Mermaid's `style="max-width: <Wpx>"` hint and lets the SVG grow to fill its container up to that hint, no farther.
- [x] 13.3 Rationale: each fix from §10–§12 created a new edge case (diagrams too small inside a uniform slot, internal Mermaid padding eating the slot, etc.). The fullscreen modal already provides "look closer" — the inline preview should honor Mermaid's library-chosen size rather than fight it.
- [x] 13.4 Update e2e tests: drop the fixed-slot, fill-ratio, and 50vh-cap tests; replace with simpler assertions that the inline trigger stays within the preview content width and is horizontally centered. Bump the `mermaid-shapes.md` count from 4 to 5 to cover the user-added "Component interaction example" diagram.
- [x] 13.5 Update `specs/document-watch-browser/spec.md` to remove the slot/cap language and capture the new "honor Mermaid's intended size, cap at preview width" contract.
- [x] 13.6 Browser fix: assigning `svg.style.width = "100%"` directly throws "Invalid value for <svg> attribute width=" in Safari (SVG elements have cross-browser quirks around the `width` property/attribute relationship). Move the `width: 100%; height: auto` responsive sizing into the CSS rule on `.mermaid-trigger > svg` and stop touching `svg.style` in JS.
- [x] 13.7 Sizing fix: stripping the SVG's `width` attribute breaks the inline-block trigger's layout — the SVG falls back to ~300x150 (the SVG default for inline use without explicit width/height) and the trigger shrink-wraps to that, making every diagram microscopic. Keep Mermaid's `width="W"` attribute (it is the library's intended display size and gives the SVG an explicit intrinsic width) and strip only the `height` attribute. CSS `max-width: 100% !important; height: auto !important` then makes the SVG responsive while still respecting the intended size as the upper bound.
