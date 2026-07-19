# add-system-theme Tasks

## 1. Foundation

- [x] 1.1 Replace `color-scheme: light` with `color-scheme: light dark` on
      `:root` in `src/styles.css`
- [x] 1.2 Convert the existing `:root` token block (borders, text, accent,
      surfaces) to `light-dark(<light>, <dark>)` values, leaving the
      `--terminal-*` palette as plain always-dark values
- [x] 1.3 Add media-qualified dark imports for the vendored themes
      (`github-markdown-css/github-markdown-dark.css`,
      `highlight.js/styles/github-dark.css`) beside the existing light
      imports, preserving the cascade-order note

## 2. Scheme tracker

- [x] 2.1 Create `src/shell/theme.ts` (+ colocated test): resolve the active
      scheme from `matchMedia("(prefers-color-scheme: dark)")`, expose the
      current value, and notify subscribers on change
- [x] 2.2 Maintain the `theme-color` meta from the tracker (initial value and
      on change), with the chrome-background token per scheme
- [x] 2.3 Wire the tracker at boot from `app.ts`/`shell/boot` alongside the
      existing mono-font applier

## 3. Non-CSS surfaces

- [x] 3.1 Fill in `themeInputsForActiveTheme()` in `src/preview/mermaid.ts`
      to return dark theme inputs under the dark scheme; subscribe so a
      scheme change triggers the existing re-render path (cache is already
      keyed by theme inputs)
- [x] 3.2 Remove the color-scheme clamp in `src/sidebar/tree-view.ts` and
      drive the tree library's scheme from the tracker (initial + live)

## 4. Literal audit

- [x] 4.1 Migrate hardcoded color literals on themed chrome surfaces
      (sidebar, panes, headers, filters, buttons, badges, metadata card,
      change overview, git log, selection inspector) to tokens with dark
      values
- [x] 4.2 Hand-tune dark tints for the frost/blur surfaces
      (`.preview-header::before` and the other backdrop-filter surface) and
      their no-backdrop-filter fallbacks
- [x] 4.3 Give the diff view dark values for its var-indirected colors
      (added/deleted backgrounds, hunk headers)
- [x] 4.4 Audit the review-load score colors and any state colors
      (stale hint, connection status) for dark-scheme contrast
- [x] 4.5 Verify the terminal panel's borders/seams read cleanly against both
      schemes; keep print styles explicitly light

## 5. Verification

- [x] 5.1 Add e2e coverage using Playwright colorScheme emulation: dark
      scheme renders dark chrome + dark markdown body + dark hljs palette;
      light scheme is visually unchanged; terminal stays dark in both
- [x] 5.2 Add e2e coverage for a live scheme flip: page restyles without
      reload, visible mermaid diagram re-renders with dark inputs,
      `theme-color` meta updates
- [ ] 5.3 Manual sweep of every major surface in both schemes via
      `bun run dev` (launcher, tree, preview, diff, source view, metadata,
      terminal, filters), plus a check in the desktop wrapper with the OS
      appearance toggled
- [x] 5.4 Run `bun test` and `bun test:e2e`
