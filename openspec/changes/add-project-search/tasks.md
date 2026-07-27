## 1. Search API

- [ ] 1.1 Create `src/server/search.ts` with a `searchDocuments(roots, query, options)` generator yielding per-document hits, iterating the passed `RootGroup[]` and skipping `kind === "binary"`
- [ ] 1.2 Implement literal, case-sensitive, whole-word, and regex matching with semantics identical to the preview find matcher, emitting line number, line text, and matched span offsets
- [ ] 1.3 Enforce bounds: minimum query length, total match cap with a truncation flag, and a per-document regex time bound that abandons the document and reports the pattern as too expensive
- [ ] 1.4 Add `src/server/search.test.ts` covering binary skipping, multiple matches per line, each toggle, cap-and-truncation reporting, and the regex time bound
- [ ] 1.5 Add the `/api/search` entry to `src/server/routes.ts`, sourcing the corpus from `getSession().getRoots()` so scope and ignore rules apply without duplication
- [ ] 1.6 Stream results progressively rather than buffering the full sweep, following the `/api/events` precedent
- [ ] 1.7 Add a `searchAllRoots` request option that bypasses the active scope, and confirm the default path honours it

## 2. Search pane

- [ ] 2.1 Add Search pane markup to `src/index.html` — query input, case / whole-word / regex toggles, scope label with a search-all-roots action, result summary, and results container
- [ ] 2.2 Register the pane in `src/sidebar/panes.ts` so it inherits collapse, hide, resize, persistence, and the panels menu; default it to hidden
- [ ] 2.3 Style the pane and result rows in `src/styles.css`, matching the existing pane idiom in both themes
- [ ] 2.4 Create `src/sidebar/search-pane.ts` — debounced query dispatch, streaming consumption, results grouped by document in tree order, running match and file counts
- [ ] 2.5 Render the truncation notice when the cap trips, and an invite-a-longer-query state below the minimum length
- [ ] 2.6 Report invalid regular expressions in the pane without dispatching a request, keeping the typed text
- [ ] 2.7 Render the scope in effect and wire the search-all-roots action to re-run widened
- [ ] 2.8 Persist toggle state for the session
- [ ] 2.9 Add `src/sidebar/search-pane.test.ts` for grouping, counts, truncation and empty states, and invalid-pattern handling

## 3. Shortcut

- [ ] 3.1 Bind `⇧⌘F` / `Ctrl+Shift+F` in `src/shell/events.ts`, dispatching to project search without consulting `activeSurface`
- [ ] 3.2 Reveal and expand the Search pane if hidden or collapsed, then focus the query input, leaving the other panes' persisted state untouched
- [ ] 3.3 Seed the query from a non-empty selection, with the same length and multi-line clamping as preview find
- [ ] 3.4 Verify `⇧⌘F` behaves identically from the preview, terminal, and split-browser surfaces

## 4. Open and jump

- [ ] 4.1 Add a `revealMatchAt(documentId, position)` entry point to `src/find/highlight.ts` that highlights and scrolls to an externally supplied match without opening the find bar or setting a query
- [ ] 4.2 On result activation, route to the document and open it in Rendered view
- [ ] 4.3 Probe the rendered view for the matched text using the find text index; when absent, switch to Source view and land on the match there
- [ ] 4.4 Move keyboard focus to `.preview-shell` at the match so the document is immediately scrollable
- [ ] 4.5 When the match no longer exists in either view, open the document with no highlight rather than scrolling to an arbitrary position
- [ ] 4.6 Support arrow-key traversal of results with Enter to activate

## 5. Staleness

- [ ] 5.1 Mark displayed results as possibly out of date when a file with visible results changes, without auto-re-running the query
- [ ] 5.2 Offer a re-run action from the staleness notice
- [ ] 5.3 Confirm a file-change storm does not dispatch repeated searches

## 6. End-to-end coverage and docs

- [ ] 6.1 Add `tests/e2e/project-search.e2e.ts` — query returns grouped results, counts are correct, ignored and binary files are absent
- [ ] 6.2 E2E: activating a prose match lands in Rendered view highlighted; activating a link-URL match falls back to Source
- [ ] 6.3 E2E: `⇧⌘F` from the terminal opens the Search pane rather than terminal find
- [ ] 6.4 E2E: a scoped session searches only the scope, and the search-all-roots action widens it
- [ ] 6.5 Run `bun test` and `bun test:e2e`
- [ ] 6.6 Update `CLAUDE.md`'s `src/` folder map and `ARCHITECTURE.md` with the search route, the Search pane, and the ⌘F / ⇧⌘F routing asymmetry
