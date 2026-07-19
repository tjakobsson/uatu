# add-system-theme Design

## Context

The SPA is deliberately light-only today: `:root` pins `color-scheme: light`,
the vendored rendered-Markdown and highlight.js stylesheets are the light
variants, and the sidebar tree library is explicitly clamped so it does not
auto-flip on `prefers-color-scheme`. A `:root` token block already exists
(borders, text, accent, surfaces) and two subsystems already consume tokens at
runtime: the terminal reads its whole xterm palette from CSS vars, and diff
colors are var-indirected. `src/preview/mermaid.ts` stubs theme-input
selection with a comment anticipating "when the theme system lands", and the
mermaid-rendering spec already requires re-rendering visible diagrams on theme
change with a cache keyed by theme inputs.

`styles.css` is ~3900 lines with ~250 color literals; a large share are the
token block and the terminal's fixed ANSI palette, leaving a real but bounded
audit of literals on themed surfaces.

## Goals / Non-Goals

**Goals:**
- Follow the OS light/dark preference live in browser, PWA, and desktop.
- A token palette that is the single place scheme values live, positioned so
  the follow-on manual switch is cheap.
- Scheme-correct rendered documents (Markdown body + syntax highlighting),
  Mermaid diagrams, sidebar tree, and app chrome.

**Non-Goals:**
- A manual light/dark switch in uatu (deliberate follow-on change).
- Re-theming the embedded terminal — it stays an always-dark surface.
- Desktop wrapper (Swift) changes — WKWebView already propagates the system
  appearance as `prefers-color-scheme`.
- A `.uatu.json` theme setting.

## Decisions

### 1. `light-dark()` tokens, not duplicated token blocks

Token values become `light-dark(<light>, <dark>)` in the existing `:root`
block, with the root declaring `color-scheme: light dark`. Rationale:

- One token block, both values side by side — no drift between a light and a
  dark copy of `:root`.
- It makes the follow-on manual switch nearly free: forcing a scheme is then
  `color-scheme: dark` on the root (plus vendored-CSS handling), with no
  attribute-scoped duplication of the palette.
- Supported everywhere the app runs (WKWebView on macOS 26, current
  Chrome/Firefox/Safari; the PWA targets the same engines).

Alternative considered: `@media (prefers-color-scheme: dark) { :root { … } }`
overrides — works, but doubles the token surface and bakes the media query in
as the only switching mechanism, which the manual-switch follow-on would have
to unwind.

### 2. Vendored themes via media-qualified imports

Keep `github-markdown-light.css` and `highlight.js/styles/github.css` as the
unqualified base, and add their dark siblings behind media-qualified imports:

```css
@import "github-markdown-css/github-markdown-dark.css" (prefers-color-scheme: dark);
@import "highlight.js/styles/github-dark.css" (prefers-color-scheme: dark);
```

The existing cascade note in `styles.css` (local rules win by order after the
imports) is preserved. This is the one place that hard-codes the media query
as the switching mechanism; the manual-switch follow-on will need to rework
exactly these two lines (e.g. attribute-scoped copies), and the design accepts
that as a contained, documented debt rather than solving it now.

### 3. A small scheme tracker in `src/shell/theme.ts`

One module owns `window.matchMedia("(prefers-color-scheme: dark)")`: it
exposes the resolved scheme, maintains the `theme-color` meta on changes, and
notifies subscribers (mermaid, tree view). Wired from boot like the existing
`mono/` font applier. CSS needs no JS to switch — the tracker exists only for
the non-CSS surfaces and the meta tag. Follows the module-structure
convention: app-wide concern → `shell/`.

### 4. Mermaid: fill in the anticipated stub

`themeInputsForActiveTheme()` in `src/preview/mermaid.ts` returns
`{ theme: "dark" }` under the dark scheme, `{ theme: "default" }` under
light. The re-render-on-change path and theme-keyed SVG cache are already
required by the mermaid-rendering spec; the tracker's notification triggers
the existing re-render mechanism. No spec delta needed — this supplies what
that spec anticipated.

### 5. Tree view: unpin and follow

Replace the library clamp in `src/sidebar/tree-view.ts` with wiring that sets
the library's scheme from the tracker (initial value + subscription), so the
tree flips live with the rest of the app.

### 6. Terminal stays dark by exemption, not accident

The `--terminal-*` tokens keep plain (non-`light-dark()`) values. The panel's
border/seam styles against the surrounding chrome are audited in both schemes
so the dark island reads as intentional.

## Risks / Trade-offs

- [Missed literals: some of ~250 color literals slip through and render
  unreadable in dark] → Audit surface-by-surface against the running app, and
  finish with a sweep of every major surface (launcher, tree, preview, diff,
  metadata card, terminal borders, change overview, git log, filters,
  selection inspector) under both schemes. E2E scheme-emulation smoke tests
  cover the load-bearing ones.
- [Frost surfaces (e.g. `.preview-header::before`, `rgba(255,255,255,.68)` +
  blur) look muddy over dark content] → These become tokens with hand-tuned
  dark tints, not mechanical inversions; verified visually.
- [The `@supports`-less fallback path and print styles assume light] → Keep
  fallbacks scheme-aware or scheme-neutral; print stays light explicitly.
- [Media-qualified vendored imports are incompatible with a future manual
  switch] → Accepted, contained to two import lines, called out for the
  follow-on change.
- [Live flip leaves stale rendered artifacts (mermaid SVGs, decorated code
  blocks)] → Mermaid re-render is spec-required and cache-keyed by theme
  inputs; syntax highlighting is class-based (CSS-only) so it restyles for
  free.

## Open Questions

- None blocking. Dark tint values for the frost/glass surfaces are a matter of
  visual tuning during implementation.
