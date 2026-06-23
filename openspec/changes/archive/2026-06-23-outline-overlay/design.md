## Context

The preview pane renders Markdown and AsciiDoc into `article#preview`. Both
renderers already emit `h1`–`h6` elements with stable IDs prefixed
`user-content-` (added by `hast-util-sanitize`; AsciiDoc anchors are rewritten
to match in `asciidoc.ts`). The preview header already hosts a control group
(`.preview-toolbar` with `#view-control` and `#wrap-control`), and the codebase
has two established enhancement patterns this change copies:

- **`code-block.ts`** — enumerates rendered elements post-mount, attaches
  buttons, and exports a `copyToClipboard()` helper (modern API + textarea
  fallback) plus a flash-feedback pattern.
- **`metadata-card.ts`** / **`layout.ts`** — "render → mount → attach listener
  → persist toggle in `localStorage`" via the `safeLocalStorage()` helper.

The scroll container differs by layout: `.preview-shell` scrolls in single
layout (`overflow: auto`), but when split the shell is `overflow: hidden` and
each `.preview-pane` scrolls. The post-render hook in `mount.ts` is the single
point where enhancements (copy-buttons, mermaid, line-numbers) attach on every
document remount.

## Goals / Non-Goals

**Goals:**
- A non-modal outline panel that works identically for Markdown and AsciiDoc by
  reading the rendered DOM — no renderer changes.
- Live accuracy: outline rebuilds on every document remount and rewires its
  scroll-spy observer when the active scroll container changes (layout switch).
- A reusable action-icon bar in the preview header hosting the outline toggle
  and a copy-source action.
- Dock the panel as a full-height right rail that reflows the document beside it
  (never covering text), with a left-edge width resizer whose width persists;
  gate both buttons and the panel to Rendered view and to documents that have
  headings.

**Non-Goals:**
- Download icon and a separate "Raw" link (Source view already covers raw text).
- Collapsible outline levels (nested indentation only).
- Reusing Asciidoctor's native `<div id="toc">` — the DOM-enumeration approach
  is uniform across both formats and avoids a Markdown/AsciiDoc divergence.
- Outline in Source or Diff view (no heading elements with IDs there).

## Decisions

### Heading source: enumerate the rendered DOM, not render-time extraction
Query `#preview` (or the rendered pane when split) for `h1,h2,h3,h4,h5,h6` and
read `{level, text: textContent, id}`. **Why over render-time:** one code path
for both formats, no renderer coupling, and it naturally reflects exactly what
the user sees (including any post-render rewrites). Alternative — emitting a
TOC structure from each renderer — was rejected as duplicated, format-divergent
work for no benefit.

### Non-modal panel, not `<dialog>.showModal()`
The mermaid viewer uses a modal `<dialog>`, but the outline must let the user
keep reading and clicking content while it is open. Implement as a
`position: absolute` `<aside>` (parented to `.main-stack`), toggled by a button,
dismissible with Escape. **Why:** modal would trap focus and block the content
the outline is meant to navigate.

### Scroll-spy via scroll-position scan, re-rooted per layout
Track the active heading with a rAF-throttled `scroll` listener on the current
scroll container. Each heading has an *activation point* — the scrollTop at
which its top reaches a trigger line just below the sticky header — and the
active heading is the last one whose activation point has been passed. The
listener is detached and re-attached in the `mount.ts` post-render hook because
the scroll container changes (single → `.preview-shell`; split →
`.preview-pane-rendered`) and the document remounts on file changes.

**Why not `IntersectionObserver`:** the initial implementation used an IO with a
top-band `rootMargin`, but a heading only becomes active once it reaches that
band near the viewport top — and a document's closing sections sit in the final
screenful with no scroll runway left to push them up there. They could never
activate, so the highlight stuck on the last heading that did.

**Tail redistribution:** simply snapping to the last heading at the very bottom
fixed the stuck highlight but skipped every section in between, then jumped. So
the unreachable tail (headings whose natural activation point lies beyond the
maximum scrollTop) is redistributed evenly across the remaining scroll
distance: the highlight steps through the closing sections as the user scrolls
the last screenful and lands on the final heading exactly at the bottom. This
is the one genuinely stateful piece and is centralized in one place.

### Docked as a gutter, not a layout rewrite
A floating overlay is great until it covers the text being read, so the panel is
docked-only. Rather than re-architect the preview into a flex row with the
outline as a sibling (which would collide with the terminal's own right-dock that
turns `.main-stack` into a row), docked mode keeps a pinned `position: absolute`
panel but reserves a right-hand gutter on `#preview` via a CSS variable
(`--outline-gutter`, sized to the panel) so the document — single body or split
panes — reflows beside the panel instead of under it. The gutter is released
whenever the outline is closed (or hidden by a view change), so a hidden outline
never narrows the document. **Why over a true flex dock:** far less layout
surgery, no conflict with the terminal docks, and it reuses the existing
positioning machinery untouched.

(Earlier iterations offered a left/right side toggle, a float/dock toggle, and
free corner-resize with fit/reset controls; all were dropped in favor of a
single docked rail with one width control — simpler and matching the app's other
side panels.)

### Anchored to the preview-shell; full-height rail; left-edge width resizer
The panel is parented to `.main-stack` (a non-scrolling ancestor, so it stays
pinned as the document scrolls) but positioned against the `.preview-shell`
sub-region — not the whole main area — otherwise, when the terminal docks
(especially right-dock, where `.main-stack` becomes a flex row), "top-right of
main-stack" lands over the terminal. A `ResizeObserver` on `.preview-shell`
re-lays-out the panel while it is open (height, position, clamped width). It
fills the shell height (below the sticky header) like a side rail, so there is no
vertical resize/fit/reset to manage. Width is adjusted via a left-edge handle —
the docked right edge stays fixed, mirroring the app's other side-panel resizers
— bounded so a minimum of document stays visible. The width persists under
`uatu:outline-width` via `localStorage` — consistent with the layout toolbar and
metadata-card open-state. **Why localStorage over `.uatu.json`:** `.uatu.json` is
for project config shared across a docs tree (e.g. `mono.fontFamily`); panel
width is personal and ephemeral. Open/closed state is not persisted (closed by
default).

### Action bar as an additive button group in `.preview-toolbar`
Add an icon-button group beside the existing view/wrap controls, with inline
SVG icons (no external assets), styled on the existing button conventions and
design tokens. Gating reuses the wrap-control discipline: hidden outside
Rendered view; the outline toggle is additionally hidden when the document has
zero headings; copy-source is available whenever raw source exists.

## Risks / Trade-offs

- **Observer leaks / stale roots across remounts** → Centralize teardown +
  rebuild in the `mount.ts` post-render hook; never create observers elsewhere.
- **Panel covering content** → Docked-only: the document reflows into a reserved
  gutter so the panel never overlaps text; the gutter is released on close.
- **Panel drifting over the terminal** → Anchor to `.main-stack` (non-scrolling
  so it stays pinned) but position against the `.preview-shell` rect, with a
  `ResizeObserver` to re-lay-out when the terminal docks/resizes.
- **Width crowding the document on narrow screens** → Clamp the width so a
  minimum of document stays visible beside the panel.
- **Heading text with inline markup or anchor link icons** → Derive labels from
  `textContent` and trim known anchor-link artifacts so entries read cleanly.
- **Duplicate or empty heading IDs** → Fall back to scrolling the element into
  view directly (by node reference) rather than relying solely on `id`/hash, so
  navigation works even when IDs collide or are missing.
- **Filter hiding the active heading** → Filtering affects visible rows only;
  scroll-spy state continues to track the real active heading underneath.
