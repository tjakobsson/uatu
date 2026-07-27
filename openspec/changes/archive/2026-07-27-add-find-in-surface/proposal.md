## Why

uatu has no find of its own. In a browser, ⌘F is the browser's — it cannot be
scoped, so it matches the tree, the git log, and the terminal scrollback
alongside the document you were actually reading. In UatuCode Desktop it is
worse: WKWebView ships no find bar, so ⌘F does nothing at all. A tool whose
whole purpose is reading documents cannot leave "find the word I'm looking at"
to somebody else.

Native find cannot be scoped by any API in any engine, so the only way to get
find-in-document is to own find. Owning it also fixes the desktop gap, because
a page-level find works wherever the page runs.

## What Changes

- A new **active-surface** notion in the app shell: which surface the user is
  working in (`preview`, `terminal`, `browser`), tracked from user interaction
  and deliberately **not** from DOM focus. Selecting a file in the sidebar tree
  resolves to `preview` — picking a document is an act about the document.
- **⌘F routes by active surface**: the terminal searches its focused pane's
  buffer, the split browser searches its own page natively, and everything else
  (preview, sidebar, nothing-yet) searches `#preview`.
- A **find bar over the preview**: incremental match, match counter, next /
  previous, case-sensitive and whole-word and regex toggles, seed-from-selection,
  Escape to dismiss. Matches are painted with the CSS Custom Highlight API, so
  the preview DOM is never mutated.
- **Terminal find** via the xterm search addon, scoped to the focused terminal
  pane.
- **Split-browser find** in the macOS wrapper: a native find bar driving
  `WKWebView.find(_:)` over the external page. Desktop-only by construction —
  the split browser does not exist in a browser tab.
- **`.preview-shell` becomes focusable** (able to hold focus, never given it
  unasked), so dismissing the find bar returns focus to the document and
  Space / PageUp / PageDown scroll it.
- The macOS wrapper stops letting SwiftUI's stock Edit ▸ Find swallow ⌘F, and
  routes ⌘F / ⌘G / ⇧⌘G to the surface that has focus at press time.
- Follow-mode selection changes stay inert with respect to focus and active
  surface: a file event must never move the user's working context.

Not in scope: project-wide search (⇧⌘F) lands in `add-project-search`, which
consumes the highlight-and-reveal primitive this change exports. Also out of
scope: distinguishing browse-open from commit-open in the tree (the VS Code
italic-tab model).

## Capabilities

### New Capabilities
- `find-in-surface`: the ⌘F contract — active-surface tracking and its
  resolution rules, the preview find bar's behavior and match semantics,
  terminal find, split-browser native find, and the shortcut routing that
  selects between them.

### Modified Capabilities
- `sidebar-shell`: tree selection gains an explicit no-focus-movement
  requirement, and resolves the active surface to `preview`.
- `embedded-terminal`: the terminal pane becomes a find target; focusing a pane
  sets the active surface.
- `desktop-macos-shell`: the wrapper must not let the stock Find menu claim ⌘F,
  and gains focus-time shortcut routing for find.
- `desktop-split-browser`: the split browser gains a native find bar over its
  selected tab.
- `follow-mode`: an explicit requirement that programmatic selection does not
  change focus or active surface.

## Impact

- **New**: `src/find/` (active-surface tracker, text-node walker, highlight
  painter, find-bar UI), `desktop/macos/UatuCodeDesktop/FindBar.swift`.
- **Modified**: `src/app.ts` (init wiring), `src/index.html` + `src/styles.css`
  (find bar markup, `tabindex` on `.preview-shell`), `src/shell/state.ts`
  (active surface), `src/sidebar/tree-view.ts` (surface resolution on select),
  `src/terminal/panel.ts` + `src/terminal/client.ts` (search addon, pane focus),
  `desktop/macos/UatuCodeDesktop/ContentView.swift` (menu commands, key
  routing), `BrowserSplit.swift` / `BrowserSplitView.swift` (find over tab).
- **Dependencies**: adds `@xterm/addon-search` — must clear
  `bun run check:licenses`.
- **Risk / gate**: whether ⌘F currently reaches the page inside UatuCode Desktop
  is unverified. `ContentView.swift:192` records that NSMenu claims the first
  matching key equivalent even when the item is disabled, so SwiftUI's stock
  Edit ▸ Find is the prime suspect for the desktop gap. This is a spike, and it
  decides whether the wrapper needs routing menu items or merely needs to get
  out of the way.
- **Constraint**: the preview is replaced wholesale on live reload
  (`src/preview/mount.ts:178`), invalidating every match Range. Find must
  re-run on mount rather than assume a stable DOM.
