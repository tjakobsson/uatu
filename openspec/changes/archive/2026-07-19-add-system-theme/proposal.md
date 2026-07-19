# add-system-theme

## Why

uatu is pinned light-only (`color-scheme: light`, light-only vendored markdown
and syntax themes, a tree library deliberately clamped against auto-flipping).
Users on dark-mode systems get a glaring white app, and the upcoming desktop
glass-titlebar work makes the mismatch structural: a transparent native toolbar
renders in the system appearance while sampling the page beneath it, so a
light-only page under dark chrome looks broken. Following the system color
scheme is the smallest coherent step — no manual switch yet — and it is
valuable standalone in the plain browser too.

## What Changes

- The SPA follows the operating system's light/dark preference
  (`prefers-color-scheme`) live, without a reload, in browser, PWA, and the
  desktop wrapper (WKWebView propagates the system appearance automatically).
- `:root` declares `color-scheme: light dark`; the light-only pin is removed.
- The hand-rolled UI palette in `styles.css` is consolidated into the existing
  `:root` token block and gains dark values; remaining hardcoded color literals
  that affect themed surfaces are migrated to tokens.
- The vendored light themes (`github-markdown-css`, `highlight.js` github)
  are paired with their dark siblings, selected by the active scheme.
- Mermaid diagrams render with theme inputs matching the active scheme and
  re-render on scheme change (the mechanism the mermaid-rendering spec already
  anticipates).
- The sidebar tree library's clamp is replaced with wiring that follows the
  active scheme.
- The embedded terminal keeps its existing dark palette in both schemes — it
  is already styled as an intentionally dark surface.
- A `<meta name="theme-color">` reflecting the active scheme is maintained so
  browser/PWA and (later) desktop chrome can match.
- No manual theme switch in this change; that is a deliberate follow-on
  (it requires attribute-scoped theming rather than pure media queries).

## Capabilities

### New Capabilities

- `system-theme`: the app-wide color-scheme capability — following the
  system light/dark preference, the token-based palette contract that themed
  surfaces read from, live scheme-change behavior, and the surfaces that are
  exempt (the always-dark terminal).

### Modified Capabilities

<!-- none — mermaid-rendering's existing "Apply the active UI theme" requirement
     is written generically and is satisfied, not changed, by this work -->

## Impact

- `src/styles.css` — the bulk of the work: token consolidation, dark values,
  dark vendored-theme imports, removing `color-scheme: light`.
- `src/shell/` — a small scheme-tracking module (media-query listener,
  `theme-color` meta upkeep) wired at boot.
- `src/preview/mermaid.ts` — return scheme-matched theme inputs (the stub
  already anticipates this); re-render path already exists per spec.
- `src/sidebar/tree-view.ts` — remove the light clamp, follow the scheme.
- `src/terminal/` — no palette change; verify the dark island reads cleanly
  against both schemes at its borders.
- `tests/e2e/` — scheme-emulation coverage (Playwright `colorScheme` option).
- No server, CLI, or desktop-wrapper code changes.
