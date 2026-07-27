## Why

`add-find-in-surface` answers "where is this word in the document I'm reading."
It does not answer the question a reviewer actually asks more often: "where else
does this appear?" Today the only way to search across the watched tree from
inside uatu is to open the terminal and grep — leaving the reading surface to
answer a question about what you are reading.

The server already holds everything this needs. `getSession().getRoots()` is an
in-memory, gitignore-filtered, binary-classified file list kept fresh by the
watcher. Project search is reading that list and matching, not building an
index.

## What Changes

- A **`/api/search` route** matching a query across the watched roots, skipping
  entries already classified `binary`, returning line-level hits grouped by
  document with enough context to render a result row.
- **⇧⌘F opens project search** and, unlike ⌘F, ignores the active surface
  entirely — it is global by definition, so it behaves the same whether the user
  is in the preview, the terminal, or the split browser.
- A **Search pane in the sidebar**, slotting into the existing pane-stack
  alongside Change Overview, Files, Git Log, and Selection Inspector: query
  input with case / whole-word / regex toggles, a result count, and results
  grouped by file with matched line and highlighted span.
- **Search respects the active scope.** The pane header names the scope in
  effect and offers a one-click escape to search all roots, so a scope narrowed
  to a single file does not silently make search useless.
- **Clicking a result opens the document and jumps to the match**, reusing the
  highlight-and-reveal primitive from `add-find-in-surface`. The result opens in
  Rendered view and lands on the match; when the matched text does not exist in
  the rendered DOM — link URLs, `##` markers, code fences — the view falls back
  to Source, where the match always exists.
- **Results stream** as they are found rather than blocking on a full sweep, so
  the pane populates progressively on a large tree.

Not in scope: replace-across-files, search history, saved searches, and
searching file *names* (the Files pane filter already does that).

## Capabilities

### New Capabilities
- `project-search`: the ⇧⌘F contract — the search API and its corpus, scope
  behavior, the Search pane's presentation and result model, streaming and
  result caps, and the open-and-jump landing rule including the Rendered→Source
  fallback.

### Modified Capabilities
- `sidebar-shell`: the pane-stack gains a Search pane, participating in the
  existing show/hide/collapse/resize and panels-menu behavior.
- `find-in-surface`: the highlight-and-reveal primitive gains a documented
  entry point for jumping to an externally supplied match, so project search
  does not grow a second highlighting path.

## Impact

- **New**: `src/server/search.ts` (corpus walk + matching + streaming),
  `src/sidebar/search-pane.ts` (pane UI, result model, result rows),
  a `/api/search` entry in `src/server/routes.ts`.
- **Modified**: `src/index.html` + `src/styles.css` (Search pane markup and
  styling), `src/sidebar/panes.ts` (pane registration and persistence),
  `src/shell/events.ts` (⇧⌘F binding), `src/preview/view-mode.ts` and
  `src/preview/mount.ts` (open-at-match landing and the Source fallback probe).
- **Depends on**: `add-find-in-surface` — specifically its match highlighting
  and reveal. Should not be applied before that change lands.
- **Risk**: the watched folder can be an entire repository, not a docs tree.
  Matching must be debounced, capped, and streamed, and regular expressions
  supplied by the user need a time bound or a pathological pattern hangs the
  user's own server.
- **Constraint**: the corpus is source text while the default landing is the
  rendered view. The mismatch is real for roughly any match inside link syntax,
  headings, or fenced blocks, and the fallback is what keeps clicking a result
  from landing nowhere.
