# project-search Specification

## Purpose

Define uatu's project-wide content search — ⇧⌘F — across the watched roots.

Where ⌘F answers "where is this in the document I am reading", ⇧⌘F answers the
question a reviewer asks more often: "where else does this appear". It is
global by definition and does not consult the active surface, because the tree
is not a surface a reader can be "in"; it means the same thing pressed from the
document, the terminal, or anywhere else.

The corpus is the watch session's existing document index — ignore-filtered and
binary-classified and kept current by the watcher — so search reads a list that
already exists rather than building an index of its own. The tension the
capability has to manage is that this corpus is *source* text while the reading
surface is usually *rendered*: matches inside link syntax, heading markers, and
code fences exist in the file but not in the rendered DOM.

## Requirements
### Requirement: Project search is global and ignores the active surface

`⇧⌘F` (`Ctrl+Shift+F` on non-Apple platforms) SHALL open project search and focus
its query input regardless of which surface is active. Unlike `⌘F`, it SHALL NOT
be routed by the active surface, because the tree is not a surface the user can
be "in".

#### Scenario: Opening project search from the terminal

- **WHEN** the user is typing in the terminal and presses `⇧⌘F`
- **THEN** the Search pane opens with its query input focused

#### Scenario: Opening project search from the preview

- **WHEN** the active surface is `preview` and the user presses `⇧⌘F`
- **THEN** the Search pane opens rather than the preview find bar

#### Scenario: Search pane is revealed if hidden

- **WHEN** the user has hidden the Search pane and presses `⇧⌘F`
- **THEN** the pane is shown and expanded before its input takes focus

### Requirement: Search corpus is the watched, non-binary documents

The search corpus SHALL be the documents the watch session already holds, and
SHALL exclude any document classified `binary`. Search SHALL NOT walk the
filesystem independently, SHALL NOT re-derive ignore rules, and SHALL therefore
honour `.gitignore` and `.uatu.json` exclusions identically to the document tree.

#### Scenario: Ignored files are not searched

- **WHEN** a file is excluded by `.gitignore` and its content matches the query
- **THEN** it produces no results

#### Scenario: Binary files are skipped

- **WHEN** a binary file contains a byte sequence matching the query
- **THEN** it produces no results

#### Scenario: Corpus follows the watcher

- **WHEN** a new file appears in a watched root and the user runs a query matching it
- **THEN** the file is searched without a manual refresh

### Requirement: Search respects the active scope and can escape it

When a scope is in effect, search SHALL search only the scoped documents, and
the Search pane SHALL name the scope in effect. The pane SHALL offer a single
action to search all watched roots instead, so a narrow scope cannot silently
make search useless.

#### Scenario: Scoped search

- **WHEN** the scope is set to a subdirectory and the user searches a term present both inside and outside it
- **THEN** only matches inside the scope are returned, and the pane names the scope

#### Scenario: Escaping a single-file scope

- **WHEN** the scope is a single file and the user activates the search-all-roots action
- **THEN** results are returned from every watched root and the pane reflects the widened scope

### Requirement: Results are line-level, grouped by document, and streamed

Results SHALL identify the document, the 1-based line number, the line's text,
and the matched span within that line. Results SHALL be grouped by document in
tree order, and SHALL be delivered progressively so the pane populates while the
sweep is still running. The pane SHALL report the running match and file counts.

#### Scenario: Result identifies its position

- **WHEN** a query matches the third line of a document
- **THEN** the result carries that document, line 3, the line's text, and the matched span offsets

#### Scenario: Progressive population

- **WHEN** a query is run against a large tree
- **THEN** results appear as they are found rather than after the whole sweep completes

#### Scenario: Multiple matches in one line

- **WHEN** a line contains the query twice
- **THEN** both matches are represented and both are counted

### Requirement: Search is bounded in work and in results

Queries SHALL be debounced and SHALL NOT run below a minimum query length.
Results SHALL be capped, and when the cap is reached the pane SHALL say results
were truncated rather than presenting a partial list as complete.

A sweep exceeding its deadline SHALL stop and report the results collected so
far as incomplete. The deadline is checked between match attempts, so the bound
it provides is the deadline plus the duration of one attempt: a single regular
expression evaluation is not interruptible, and a per-document budget alone
cannot bound it because that budget is also only checked between attempts.

#### Scenario: Truncation is disclosed

- **WHEN** a query produces more matches than the cap
- **THEN** results up to the cap are shown and the pane states that results were truncated

#### Scenario: Query below the minimum length

- **WHEN** the user has typed fewer characters than the minimum
- **THEN** no search is dispatched and the pane invites a longer query

#### Scenario: A file too large to read

- **WHEN** a watched document exceeds the sweep's file-size limit
- **THEN** it is skipped without being read, and the pane says how many files were skipped rather than omitting them silently

#### Scenario: The request fails

- **WHEN** a search request fails rather than completing
- **THEN** the pane reports the search as unavailable and stops showing progress, rather than leaving an indefinite searching state or blaming the pattern

#### Scenario: Pathological pattern

- **WHEN** a regular expression exceeds the evaluation time bound on a document
- **THEN** the sweep abandons that document, reports the pattern as too expensive, and the server remains responsive

#### Scenario: A sweep that runs too long overall

- **WHEN** matching across the corpus exceeds the sweep deadline
- **THEN** the sweep stops, the pane says it stopped early rather than presenting the partial list as complete, and the results already found remain usable

### Requirement: Search offers case, whole-word, and regular-expression matching

The Search pane SHALL offer case-sensitive, whole-word, and regular-expression
toggles matching the preview find bar's semantics, and toggle state SHALL persist
for the session. An invalid regular expression SHALL be reported without
dispatching a query.

#### Scenario: Case-sensitive project search

- **WHEN** the case-sensitive toggle is on and the user searches for `Preview`
- **THEN** documents containing only `preview` are not returned

#### Scenario: Invalid pattern is not dispatched

- **WHEN** the regex toggle is on and the pattern is invalid
- **THEN** the pane reports it, keeps the typed text, and issues no request

### Requirement: Activating a result opens the document at the match

Activating a result SHALL open its document and reveal the match using the same
highlight-and-reveal behavior as preview find. The document SHALL open in the
view mode the reader is currently using. When the matched text is not present in
that view — as for link URLs, heading markers, and code-fence syntax — the view
SHALL fall back to Source, where the match is always present. Activation SHALL
move keyboard focus to the preview so the document is immediately scrollable.

#### Scenario: Match present in the current view

- **WHEN** the user activates a result whose matched text appears in the view they are already in
- **THEN** the document opens in that view, scrolls to the match, and highlights it

#### Scenario: A Source-view reader is not moved to Rendered

- **WHEN** a reader working in Source view activates any result
- **THEN** the document opens in Source view, because forcing Rendered would override a deliberate global preference on every result click

#### Scenario: Match absent from the rendered view

- **WHEN** the user activates a result matching a link's URL, which the rendered view does not display
- **THEN** the document opens in Source view at that line with the match highlighted

#### Scenario: The rendered view holds fewer occurrences than the source

- **WHEN** the source contains occurrences the rendered view drops, so the activated result's ordinal exceeds what the rendered view offers
- **THEN** the view falls back to Source rather than highlighting a different occurrence, because without a source-to-rendered position map the correct one cannot be identified

#### Scenario: Focus follows activation

- **WHEN** the user activates a result
- **THEN** keyboard focus moves to the preview scroll container positioned at the match

#### Scenario: Keyboard traversal of results

- **WHEN** the user moves through results with the arrow keys and presses Enter
- **THEN** the focused result is activated

### Requirement: Search results survive file changes without going stale silently

When a watched file changes while results are displayed, the pane SHALL NOT
present results whose line numbers no longer correspond to file content as if
they were current. Activating a result whose match no longer exists SHALL open
the document without a highlight rather than jumping to an arbitrary position.

#### Scenario: Result whose match has been deleted

- **WHEN** the user activates a result after the matched text was removed from the file
- **THEN** the document opens and no highlight is shown

#### Scenario: Results are marked stale after a change

- **WHEN** a file with visible results changes on disk
- **THEN** the pane indicates the results may be out of date and offers to re-run the query
