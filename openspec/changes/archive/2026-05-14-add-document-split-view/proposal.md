## Why

Today the preview header offers a two-segment Source / Rendered toggle for Markdown and AsciiDoc documents (capability `document-source-view`), but users cannot see both representations at once. Authoring and reviewing markup is a back-and-forth flow — readers want to see the rendered output beside the raw markup so they can spot formatting issues, verify links, and edit with context. A split view that can switch between side-by-side and stacked, with a draggable divider, brings the preview to parity with common Markdown/AsciiDoc editors (VS Code, Obsidian, Typora) without sacrificing the existing single-view modes.

## What Changes

- Add a new **layout chooser** to the preview header (Markdown and AsciiDoc only) with three states: **single**, **side-by-side**, **stacked**. The chooser lives next to the existing Source / Rendered toggle.
- When **single** is active, the preview behaves exactly as today: the Source / Rendered toggle drives the view.
- When **side-by-side** or **stacked** is active, the preview body shows both Source and Rendered together in two panes, separated by a draggable resizer. The existing Source / Rendered toggle is hidden in split layouts (both representations are visible).
- Panes scroll **independently** in split layouts (no scroll sync in this change). Scroll-sync is explicitly deferred to a future change.
- The split **ratio** is persisted per orientation (separate values for side-by-side vs stacked so flipping between them does not collapse the user's preferred ratio).
- The **layout choice** (`single` / `split-h` / `split-v`) is a single global preference, persisted to `localStorage`, defaults to `single` on first visit, and applies across documents and reloads — mirroring the persistence model already established for the Source / Rendered preference.
- Split layouts are **hidden** for documents where the Source / Rendered toggle is already hidden (non-document previews; text/source/code files where source = rendered). The layout chooser MUST NOT appear in those cases.
- Below a configured minimum preview-pane width, the side-by-side layout **auto-stacks** so each pane retains a usable width. The user's stored preference is not overwritten by the auto-stack.

## Capabilities

### New Capabilities
_(none — this extends an existing capability)_

### Modified Capabilities
- `document-source-view`: add a layout-chooser control and the side-by-side / stacked split layouts, with persisted layout + per-orientation ratio and a narrow-width auto-stack fallback. The existing Source / Rendered toggle, its persistence, and its single-view rendering rules remain unchanged in `single` layout.

## Impact

- **Code (src/app.ts)**: extends the preview-header controls (`syncViewToggle` and surrounding logic near `src/app.ts:2324`), the preview-body render path (so it can host two panes), and the existing `[data-pane-resizer]` infrastructure (`src/app.ts:1876`) for the inter-pane drag handle. The `documentViewCache` keeps both representations warm and is reused so split rendering does not refetch.
- **Markup (src/index.html)**: the existing `#preview` article becomes (or is wrapped by) a layout container that can hold a single body or two side-by-side/stacked panes plus a resizer; the `#view-control` group gains a new sibling layout-chooser control.
- **Styles (src/styles.css)**: new rules for the layout chooser, the split container (flex row vs column), and the inter-pane resizer, reusing tokens from existing resizer styles.
- **Persistence (src/view-mode-preference.ts or sibling)**: new `localStorage` keys for `viewLayout` and a per-orientation `splitRatio` map. Existing `viewMode` key untouched.
- **Selection Inspector**: line-range capture currently keys off Source view; in split layouts the Source pane carries the same line-numbered `<pre>` with the same distinguishing class, so existing detection continues to work for selections inside that pane.
- **Tests**: existing scenarios for `document-source-view` remain valid; new scenarios cover the layout chooser, split persistence, narrow-width auto-stack, and that the layout chooser does not appear for code/text files or non-document previews.
- **No external dependencies** are added.
