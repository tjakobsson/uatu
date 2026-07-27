## Context

uatu renders one page containing several logically distinct surfaces — the
sidebar tree, the preview, and the embedded terminal — and, in UatuCode Desktop,
sits beside a second WKWebView hosting the split browser. The host's find has no
concept of any of that. In a browser, ⌘F matches across all of them at once;
in the desktop wrapper WKWebView ships no find UI, so ⌘F does nothing.

No engine exposes an API to scope native find to a subtree. That single fact
drives the whole design: find-in-document has to be implemented in the page, and
once it is, the desktop gap closes as a side effect.

Two pieces of existing machinery shape the approach. First, the preview is
replaced wholesale on every live reload (`src/preview/mount.ts:178`), so nothing
may cache DOM references across a mount. Second, tree selection is not always
user-initiated: follow-mode Rules C and D re-select from file-watcher events,
which is why `TreeView.withProgrammaticUpdate` exists (`tree-view.ts:397`). Any
design that couples selection to focus inherits that hazard.

The macOS deployment target is 26.0, so the WKWebView is a current WebKit — the
CSS Custom Highlight API and modern `Range` handling are available without
fallbacks.

## Goals / Non-Goals

**Goals:**

- One find implementation that behaves identically in a browser tab and in
  UatuCode Desktop.
- A routing rule statable in one line: ⌘F searches the active surface.
- Highlighting that cannot perturb rendered output, mermaid diagrams, anchors,
  or code-block decorations.
- Export a highlight-and-reveal primitive that `add-project-search` consumes for
  its jump-to-match, rather than growing a second highlighting path.

**Non-Goals:**

- Project-wide search (⇧⌘F). Separate change, built on this one.
- Distinguishing browse-open from commit-open in the tree (VS Code's italic-tab
  model). Discussed and deferred as scope creep.
- Preserving access to the browser's native find. Once the page intercepts ⌘F,
  native find is gone on the uatu page; see Decision 6.
- Find over the sidebar's own content. The tree has a name filter, and content
  lives in the documents `⇧⌘F` will search.

## Decisions

### 1. An explicit active-surface concept, not DOM focus

Routing is driven by an app-level `activeSurface: "preview" | "terminal" |
"browser"` in `src/shell/state.ts`, updated from `pointerdown`/`focusin` on each
surface's root.

*Why not DOM focus directly?* Because it gives the wrong answer for the most
common interaction in the app. Clicking a file in the tree leaves focus inside
`@pierre/trees`' shadow root; a literal focus rule would then search the
sidebar, when the user has just declared interest in a document. The mapping
"sidebar interaction means `preview`" is a product judgement that `activeElement`
cannot express.

*Why not move focus to the preview on selection instead?* That was considered and
rejected on two counts. It pulls focus out of the tree widget entirely — after a
click the active element is the tree host, with a focused control inside its
shadow root, and stealing that takes the tree's keyboard interaction away from
the user who just clicked in it. (Measured during implementation: the library's
arrow keys move focus *within* the widget; they do not advance the selection or
load the next document, so the cost is the widget's own keyboard use, not
document browsing.) And because follow-mode
re-selects from file events, selection-moves-focus would let a background `git
pull` yank focus out of the terminal mid-command. `withProgrammaticUpdate` could
gate that, but needing a guard to make focus safe is evidence the coupling is
wrong.

### 2. Match over concatenated text nodes; paint with CSS Custom Highlights

Matching walks the searched subtree with a `TreeWalker` over text nodes,
concatenating into one string while recording each node's offset. A hit's
`[start, end)` maps back to a `Range` via that offset table. Highlighting uses
`CSS.highlights` with a registered `Highlight` — a current match and an
all-matches set, styled through `::highlight()`.

*Why not `innerHTML` string search?* Syntax highlighting splits `const foo` across
adjacent `<span>`s, so a serialized search matches markup and misses content.
The text-node walk is the only approach that sees what the reader sees.

*Why not wrap matches in `<mark>`?* DOM mutation is the thing this design most
wants to avoid. Wrapping would re-enter mermaid rendering, invalidate anchor
targets, disturb code-block decorations, and fight the live-reload `innerHTML`
swap. Highlights are painted from Ranges and touch nothing.

*Why not `window.find()`?* Non-standard, unscopable, and it mutates the user's
selection.

Known limitation: `CSS.highlights` paints text; it does not paint inside SVG
`<text>`. Matches inside rendered mermaid diagrams are therefore out of reach,
consistent with treating a diagram as a picture rather than prose.

### 3. Find searches the current view mode's visible text

⌘F is find-*in-page*: it matches what is on screen. In Rendered view that means
link text but not link URLs, and headings without their `##` markers. In split
view both panes are searched, matches ordered by document order across panes.

*Alternative considered:* always searching source text regardless of view. It
finds more, but it would report matches the user cannot see and cannot be
scrolled to, which is worse than not finding them. Source text is reachable by
switching to Source view, and `add-project-search` searches source across the
tree — so nothing is permanently hidden.

### 4. Observe the preview for replacement; hold no DOM references across it

Find recomputes its matches whenever `#preview`'s children are replaced,
retaining the query and re-resolving the current match by document position.
Nothing is cached across a swap.

*Revised during implementation.* This decision originally called for hooking
the preview mount lifecycle directly and explicitly rejected a
`MutationObserver`, on the assumption there was one mount point to hook. There
are eight: the single and split document paths in `mount.ts`, plus `diff.ts`,
`image.ts`, `binary.ts`, `empty.ts`, `commit-message.ts`, and
`review-score-mount.ts`. Hooking all eight would make every preview module
import find and would silently break the moment a ninth is added.

A single `childList` observer on `#preview` cannot be forgotten that way. The
original objection — machinery that outlives its usefulness — is answered by
scoping it: the observer is connected when the find bar opens and disconnected
when it closes, so nothing runs during the overwhelmingly common case of not
searching. Swaps that clear then append (`diff.ts` does) are coalesced through
a microtask so one logical remount is one recomputation.

### 5. Terminal find via `@xterm/addon-search`, scoped to the focused pane

The terminal is a canvas — its buffer is not in the DOM, so the shared text-node
matcher cannot reach it. xterm's own search addon is the only sane route. It
must clear `bun run check:licenses` before landing.

The panel supports split panes, so "the terminal" is specifically the focused
pane's `Terminal` instance; each pane owns its own addon instance and find state.

### 6. No escape hatch back to native browser find

Once the page calls `preventDefault()` on ⌘F, browser users lose native find on
the uatu page. GitHub's convention — a second ⌘F within a timing window falls
through — was considered and rejected: it buys back a find that was worse in
this context, at the cost of a timing state machine and an inconsistency between
the browser and the desktop app. The only real loss is searching the git-log
pane's text, which is not the reading surface anyone means by "search this."

### 7. Wrapper routing resolved at press time, not by menu enablement

The macOS wrapper needs Edit ▸ Find items for discoverability, but SwiftUI menu
enablement goes stale on focus changes, and `NSMenu` performs the first matching
key equivalent *even when the item is disabled* — already documented at
`ContentView.swift:192`, which is why the ⌘W/⌘[/⌘] routing uses an
`NSEvent` local monitor. Find follows the same precedent: menu items stay enabled
whenever a running window is focused, and their action asks `split.hasFocus(in:)`
at invoke time which surface to target.

Whether the wrapper must additionally strip SwiftUI's inherited `.textEditing`
Find group depends on the spike below.

### 8. Split-browser find is native, and sequenced last

The split browser hosts arbitrary external pages; injecting a find bar into
someone else's document is not on the table. `WKWebView.find(_:configuration:)`
does the matching and highlighting, and the wrapper supplies a small SwiftUI bar
above the tab's web view. This is the only piece of the change with no web
counterpart, so it is built last: if it slips, everything else ships and ⌘F over
the split browser stays as inert as it is today — no regression.

## Risks / Trade-offs

- **⌘F may never reach the page in the desktop app today** → Spike first, before
  any other desktop work. Strip `.textEditing`, log a keydown, press ⌘F. The
  result decides whether the wrapper needs routing menu items or merely needs to
  stop swallowing the key. Everything else in the change is independent of the
  answer, so the spike blocks only the wrapper tasks.
- **Regex over a large document can be pathological** → Cap total matches, debounce
  input, and refuse to advance past a zero-length match. The document is local
  and the cost is the user's own, but a hang still reads as a broken app.
- **`@pierre/trees` renders into a shadow root** → The text-node walker must not
  descend into it. Scoping the walk to `#preview` handles this by construction,
  but a future "search everything" mode would have to decide deliberately.
- **Highlight styling must survive both themes** → `::highlight()` cannot use
  `currentColor` and does not inherit normally; current-match and other-match
  colors need explicit light and dark values alongside the existing theme
  tracker.
- **Seeding from selection can capture megabytes** → Clamp the seeded query to a
  sane length and refuse multi-line seeds.
- **Two find UIs to keep coherent** (page bar and native bar) → They share only the
  shortcut contract, not code. Divergence in look is acceptable; divergence in
  key handling is not, so ⌘G/⇧⌘G/Escape behavior is specified once and asserted
  in both suites.

## Migration Plan

No data, no persisted format, no API surface changes — this is additive UI plus a
new dependency. The rollback is reverting the change; the only durable artifact
is the session-scoped find-toggle state, which is discardable.

Sequencing within the change:

1. Spike the desktop ⌘F question (blocks step 5 only).
2. Active-surface tracker + preview focusability — no user-visible find yet.
3. Preview find: matcher, highlight painter, find bar, shortcut binding.
4. Terminal find.
5. Wrapper menu + routing.
6. Split-browser native find.

Steps 2–4 are shippable without 5–6; the browser build gains scoped find and the
desktop app is no worse than today until the wrapper lands.

## Open Questions

- Does SwiftUI's inherited Edit ▸ Find group exist in this app's menu bar, and is
  it what eats ⌘F? Resolved by the step-1 spike.
- ~~Should the find bar sit inside the preview header or float over the
  document?~~ **Resolved: floating overlay.** The header already carries the
  view-mode chooser, the wrap toggle, and the action bar, and the query box
  needs real width — adding it there would crowd the header at exactly the
  widths where the sidebar is widest. The bar uses the zero-height sticky
  wrapper `.uatu-loading-bar` already established in this codebase, so opening
  find does not reflow the document under the reader. It does overlap content
  in the top-right corner; VS Code's trick of shifting the widget when a match
  is behind it is the escalation if that proves annoying.
- ~~Does terminal find need its own bar, or can the preview find bar be reused
  with a surface-dependent backend?~~ **Resolved: one bar, pluggable engine.**
  The worry was that the terminal's match model would not fit the same control.
  It fits exactly: the xterm search addon takes the same three options (case,
  whole-word, regex) and reports the same two numbers (result index, result
  count) the preview matcher produces. Two bars would have been two
  vocabularies for one idea. The seam is `engine.ts`; outcomes arrive by
  callback rather than return value, because the preview matches synchronously
  while xterm reports counts through an event.
- Bun's CSS bundler emits `warn: Invalid selector. Unsupported pseudo-class or
  pseudo-element 'highlight'` on every build. The rules are passed through
  verbatim and work at runtime — verified in the built binary — but the warning
  is noise on every `bun run build` until Bun learns the selector.
