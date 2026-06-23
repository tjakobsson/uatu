## Why

Long documents (the AsciiDoc cheatsheet, multi-section guides) are hard to
navigate in the preview pane — there is no way to see a document's structure
at a glance or jump to a section without scrolling. GitHub solves this with an
"Outline" panel plus a row of file-level action icons in the document header;
uatu has neither, despite already emitting stable heading IDs for both
Markdown and AsciiDoc that make an outline almost free to build.

## What Changes

- Add a **floating outline overlay** to the preview pane: a non-modal panel
  that lists the document's `h1`–`h6` headings as a nested, clickable
  jump-list built by enumerating the rendered DOM (works uniformly for
  Markdown and AsciiDoc).
- The overlay **highlights the currently-scrolled heading** (scroll-spy via
  `IntersectionObserver`), tracking the correct scroll container per layout
  (`.preview-shell` in single layout, `.preview-pane-rendered` when split).
- The panel is **docked on the right of the preview** as a full-height rail
  (over the preview-shell, not the terminal): the document reflows into a
  reserved gutter so the panel never covers text. Its **width is adjustable**
  via a left-edge resizer (like the app's other side panels) and persists in
  `localStorage` (the same mechanism the layout toolbar and metadata-card use).
- The panel includes a **heading filter** input for long documents.
- Introduce a **preview action-icon bar** in the preview header hosting the
  **outline toggle** and a **copy-source** icon (copies the raw document text
  to the clipboard, reusing the existing `copyToClipboard()` helper).
- Both new buttons and the overlay are **gated to Rendered view** and hidden
  for documents with no headings, mirroring the existing wrap-control gating.

Out of scope (deferred): a download icon and a literal "Raw" link — uatu's
existing Source view already covers raw-text-with-line-numbers.

## Capabilities

### New Capabilities
- `document-outline`: A non-modal outline panel docked on the right of the
  preview that enumerates the rendered document's headings into a nested
  jump-list, highlights the active heading on scroll, supports filtering, reflows
  the document beside it, and has an adjustable, remembered width.
- `preview-action-bar`: A row of icon buttons in the preview header that hosts
  the outline toggle and a copy-source action, gated to Rendered view and to
  documents that support each action.

### Modified Capabilities
<!-- No existing spec-level behavior changes; the action bar is additive
     alongside the existing view-control and wrap-control toolbars. -->

## Impact

- **New module**: `src/preview/outline.ts` (overlay render + heading
  enumeration + scroll-spy + filter + resize/size persistence), following the
  `metadata-card.ts` / `code-block.ts` enhancement pattern.
- **`src/preview/header.ts`** + `src/index.html`: new action-bar button group
  in `.preview-toolbar`.
- **`src/preview/mount.ts`**: wire outline rebuild + observer rewiring into the
  post-render hook so the overlay tracks live document remounts and layout
  changes.
- **`src/preview/code-block.ts`**: reuse the exported `copyToClipboard()`
  helper for the copy-source action.
- **`src/styles.css`**: overlay + icon-button styles using existing
  `--border-*` / shadow / accent design tokens.
- No renderer changes — heading IDs already exist for both formats.
- No new dependencies.
