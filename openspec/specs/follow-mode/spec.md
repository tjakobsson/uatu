# follow-mode Specification

## Purpose

Define the single-mode Follow behavior in the uatu SPA: a sidebar-header chip backed by one boolean of session state (`followEnabled`) and four authoritative rules linking Follow to user selection and file-event-driven selection. Replaces the prior Author / Review Mode distinction with a single mode whose only behavioral toggle is Follow.

## Requirements

### Requirement: Follow toggle exposes a single session-level boolean

The browser UI SHALL expose a Follow toggle that controls one piece of session state — a boolean `followEnabled`. Its only presentations SHALL be the expanded sidebar's Follow chip and the collapsed sidebar rail's icon control, with exactly one visible according to sidebar state.

#### Scenario: Both Follow presentations expose the same accessible state
- **WHEN** the sidebar shows the Follow chip or its collapsed-rail counterpart
- **THEN** the visible control MUST reflect `followEnabled` exactly via `aria-pressed`: `"true"` when on and `"false"` when off
- **AND** beyond these two presentations there SHALL be no other UI-visible representation of Follow's state
- **AND** both presentations MUST be reachable by mouse, touch, and keyboard following existing chip-control conventions

#### Scenario: Chip aria-pressed mirrors the session state
- **WHEN** the SPA boots and `followEnabled` is `true`
- **THEN** the Follow chip's `aria-pressed` attribute reads `"true"`
- **AND** clicking the chip flips `followEnabled` to `false`
- **AND** the chip's `aria-pressed` attribute reads `"false"` after the click is processed

#### Scenario: Chip is keyboard-operable
- **WHEN** the Follow chip has keyboard focus
- **AND** the user presses Space or Enter
- **THEN** `followEnabled` toggles
- **AND** the chip's `aria-pressed` attribute updates to match

#### Scenario: Rail presentation stays in sync with the chip
- **WHEN** `followEnabled` is toggled via the rail control, and the user then expands the sidebar
- **THEN** the Follow chip's `aria-pressed` reflects the value set from the rail
- **AND** collapsing again shows the rail control with the same pressed state

### Requirement: Follow defines four authoritative session rules

The system SHALL implement exactly four behavioral rules linking Follow to selection and file events. No other code path SHALL change `appState.followEnabled` or `appState.selectedDocument` in response to a file event, native tree-row interaction, or the Follow chip click.

#### Scenario: Rule A applies only to genuine tree navigation
- **WHEN** a user activates a file or operates a tree folder
- **THEN** activating a file SHALL select that document and set `followEnabled` to `false`, including when already selected
- **AND** manually collapsing any active-file ancestor SHALL instead clear selection and preview, establish intentional-empty selection, and set `followEnabled` to `false`; reopening SHALL NOT restore the document
- **AND** opening a folder, collapsing an unrelated folder, moving focus without ancestor collapse, or collapsing without an active document SHALL leave the document and Follow unchanged
- **AND** both Rule A outcomes MUST fire only for genuine pointer, touch, or supported keyboard activation/collapse; programmatic or library-driven callbacks during mount, refresh, reset, or filter reconciliation MUST NOT trigger them (see "Tree-mount user-click guard" below)

#### Scenario: Rule B catches up when the Follow chip enables Follow
- **WHEN** the user clicks the Follow chip
- **THEN** `followEnabled` MUST be flipped
- **AND** a `false → true` flip SHALL clear intentional-empty selection and MUST jump to the current session's newest-mtime non-binary document Git does not ignore, if different from the current selection
- **AND** images SHALL NOT be catch-up candidates because their modification times often reflect checkout rather than editing; Follow switches to an image only on change (Rule C)

#### Scenario: Rule C follows eligible changes after resolving Git-ignore status
- **GIVEN** Follow is on
- **WHEN** a file changes on disk
- **THEN** selection MUST move to a changed Markdown, AsciiDoc, or text document or inline-previewable image, subject to the embedded-image exception below
- **AND** changes to other binaries MUST NOT change selection
- **AND** changes to files Git ignores MUST NOT change selection regardless of type or ignored-file visibility
- **AND** while ignore status is being determined the decision SHALL wait; if it cannot be determined the file SHALL be treated as not ignored

#### Scenario: Rule C refreshes embedded images without leaving the shown document
- **GIVEN** Follow is on and an image changes
- **WHEN** the image is embedded by the shown document's rendered content
- **THEN** its change MUST NOT move selection and the embedded image SHALL refresh in place instead
- **AND** embedded images SHALL be determined from rendered content, not the current display, so the exception holds in Rendered, Source, Diff, and split layouts

#### Scenario: Rule C defers unresolved image decisions without overriding newer intent
- **GIVEN** Follow is on and the shown document's current-revision embedded images are not yet known
- **WHEN** an image changes
- **THEN** it MUST NOT move selection until the images are known; the decision SHALL wait and then apply Rule C only if Follow remains on, the same document and revision remain selected, and no later file change, selection, or Follow switch has decided selection meanwhile
- **AND** if lookup fails or goes unanswered for 10 seconds, the image SHALL be followed
- **AND** a document change arriving meanwhile SHALL be followed at once and the waiting image decision SHALL be dropped

#### Scenario: Rule D refreshes rows and current content without changing selection
- **GIVEN** Follow is off
- **WHEN** a file changes on disk
- **THEN** selection MUST NOT change
- **AND** a change to the selected document MUST reload its content in place; another document's change SHALL NOT reload the preview but MUST still refresh the tree's row set
- **AND** intentional-empty selection SHALL remain empty: a file event MUST NOT choose a default document or restore a previously closed document

#### Scenario: Rule A — clicking a row turns Follow off
- **WHEN** Follow is on and the user clicks `guides/setup.md` in the tree
- **THEN** the selection becomes `guides/setup.md`
- **AND** `followEnabled` becomes `false`
- **AND** the Follow chip's `aria-pressed` attribute reads `"false"`

#### Scenario: Rule A — activating the selected file still turns Follow off
- **GIVEN** Follow is on and `guides/setup.md` is already selected and visible
- **WHEN** the user activates that file by pointer, touch, or keyboard
- **THEN** manual document navigation occurs exactly once and `followEnabled` becomes `false`
- **AND** the file remains selected and its preview is displayed

#### Scenario: Rule A — collapsing an ancestor closes the document
- **GIVEN** `guides/setup.md` is active and Follow is on
- **WHEN** the user manually collapses `guides/`
- **THEN** the active document selection and preview are empty
- **AND** `followEnabled` becomes `false` and the Follow toggle reflects it
- **AND** reopening `guides/` does not restore selection or enable Follow

#### Scenario: Rule A — unrelated folder collapse does not change Follow
- **GIVEN** `guides/setup.md` is active and `metadata/` is expanded
- **WHEN** the user collapses `metadata/`
- **THEN** the active document, preview, and Follow state remain unchanged

#### Scenario: Rule B — turning Follow on jumps to the newest document
- **WHEN** Follow is off, the selection is `README.md`, and the newest-mtime document in the session is `guides/setup.md`
- **AND** the user clicks the Follow chip
- **THEN** `followEnabled` becomes `true`
- **AND** the selection moves to `guides/setup.md`

#### Scenario: Rule B — turning Follow on with selection already on the newest file
- **WHEN** Follow is off, the selection is `README.md`, and the newest-mtime document is also `README.md`
- **AND** the user clicks the Follow chip
- **THEN** `followEnabled` becomes `true`
- **AND** the selection remains `README.md`
- **AND** the preview does not reload

#### Scenario: Rule B — turning Follow on ends intentional emptiness
- **GIVEN** a manual ancestor collapse left the document selection and preview empty and Follow off
- **AND** an eligible document exists in the session
- **WHEN** the user clicks the Follow chip
- **THEN** `followEnabled` becomes `true` and the newest-mtime eligible document is selected, revealed, and previewed
- **AND** intentional-empty selection no longer suppresses normal Follow behavior

#### Scenario: Rule C — file change with Follow on moves the selection
- **WHEN** Follow is on, the selection is `README.md`, and a watcher event reports that `guides/setup.md` changed
- **THEN** the selection moves to `guides/setup.md`
- **AND** the preview renders `guides/setup.md`

#### Scenario: Rule C — an image change with Follow on moves the selection
- **WHEN** Follow is on, the selection is `README.md`, which does not embed `hero.svg`, and a watcher event reports that `hero.svg` changed
- **THEN** the selection moves to `hero.svg`
- **AND** the preview renders the image's current content

#### Scenario: Rule C — a change to an image embedded in the shown document refreshes it in place
- **WHEN** Follow is on, the selection is `README.md`, the preview shows `README.md` rendered with `<img src="./hero.svg">`, and a watcher event reports that `hero.svg` changed
- **THEN** the selection remains `README.md` and the browser URL does not change
- **AND** the embedded image shows `hero.svg`'s current content without re-rendering `README.md`

#### Scenario: Rule C — the embedded-image exception holds in Source and Diff views
- **WHEN** Follow is on, the selection is `README.md`, whose rendered content embeds `<img src="./hero.svg">`, the preview shows `README.md` as Source or as a Diff, and a watcher event reports that `hero.svg` changed
- **THEN** the selection remains `README.md`, in the same view, and the browser URL does not change

#### Scenario: Rule C — an image change waits while the shown document's images are still being determined
- **GIVEN** Follow is on and the preview shows `README.md`, whose rendered content embeds `<img src="./hero.svg">`, as Source or as a Diff
- **AND** the images `README.md` embeds have not been determined yet
- **WHEN** a watcher event reports that `hero.svg` changed
- **THEN** the selection remains `README.md`, in the same view, and the browser URL does not change
- **AND** once the embedded images are determined, the selection still remains `README.md` and the browser URL does not change

#### Scenario: Rule C — an image is followed when the shown document's images cannot be determined
- **GIVEN** Follow is on and the preview shows `README.md` as Source or as a Diff
- **AND** determining the images `README.md` embeds fails
- **WHEN** a watcher event reports that `hero.svg` changed
- **THEN** the selection moves to `hero.svg`
- **AND** the preview renders the image's current content

#### Scenario: Rule C — a waiting image decision is dropped when something newer decides the selection
- **GIVEN** Follow is on, the preview shows `README.md` as Source, and a change to `hero.svg` is waiting for the images `README.md` embeds
- **WHEN** before they are determined, `guides/setup.md` changes, the user selects another file, `README.md` changes, or the user turns Follow off
- **THEN** the change to `hero.svg` does not move the selection afterwards

#### Scenario: Rule C — a change to a binary the preview cannot show is ignored
- **WHEN** Follow is on, the selection is `README.md`, and a watcher event reports that `bundle.zip` changed
- **THEN** the selection remains `README.md`

#### Scenario: Rule B — turning Follow on does not jump to a newer image
- **WHEN** Follow is off, the selection is `README.md`, and the newest-mtime file in the session is `hero.svg` while the newest-mtime document is `guides/setup.md`
- **AND** the user clicks the Follow chip
- **THEN** the selection moves to `guides/setup.md`

#### Scenario: Rule C — a change to an ignored file is not followed
- **WHEN** Follow is on, the selection is `README.md`, Show ignored files is on, Git ignores `build/`, and a watcher event reports that `build/renders/take-3.wav` or `build/report.md` changed
- **THEN** the selection remains `README.md`
- **AND** the changed file still appears and updates in the Files views

#### Scenario: Rule C — a batch mixing ignored output and a document follows the document
- **WHEN** Follow is on and one batch contains an edit to `guides/setup.md` followed by writes under an ignored `dist/`
- **THEN** the selection moves to `guides/setup.md`

#### Scenario: Rule C — a tracked file inside an output folder is followed
- **WHEN** Follow is on, Git tracks `dist/index.html`, and it changes
- **THEN** the selection moves to `dist/index.html`

#### Scenario: Rule C — an opened ignored file still refreshes
- **WHEN** the user has opened the ignored `build/report.md` and a rebuild rewrites it
- **THEN** the selection remains `build/report.md` and its preview shows the new content

#### Scenario: Rule B — turning Follow on skips newer ignored files
- **WHEN** Follow is off, the newest-mtime non-binary file in the session is the ignored `build/report.md`, and the newest-mtime document Git does not ignore is `guides/setup.md`
- **AND** the user clicks the Follow chip
- **THEN** the selection moves to `guides/setup.md`

#### Scenario: Rule D — file change with Follow off reloads the current document in place
- **WHEN** Follow is off, the selection is `README.md`, and a watcher event reports that `README.md` changed
- **THEN** the selection remains `README.md`
- **AND** the preview reloads `README.md` so the updated content is visible

#### Scenario: Rule D — file change with Follow off for a non-selected document does not switch selection
- **WHEN** Follow is off, the selection is `README.md`, and a watcher event reports that `guides/setup.md` changed
- **THEN** the selection remains `README.md`
- **AND** the preview is NOT reloaded
- **AND** the tree's row set is updated so `guides/setup.md`'s row reflects the change

#### Scenario: Rule D — file events preserve deliberate deselection
- **GIVEN** manually collapsing the active document's ancestor cleared selection and turned Follow off
- **WHEN** a watcher update changes the formerly active document or another file
- **THEN** the document selection and preview remain empty and Follow remains off
- **AND** the tree still receives the refreshed file list

### Requirement: Tree-mount user-click guard

The `TreeView` wrapper around `@pierre/trees` SHALL distinguish genuine user-initiated file activation and ancestor collapse from library-driven or programmatic selection and expansion changes. Rule A's document-selection and deselection outcomes MUST execute only for the corresponding real user action.

#### Scenario: Every programmatic reconciliation suppresses Rule A only for that operation
- **WHEN** tree selection or expansion is programmatically reconciled, including initial mount with a preselected document, file-event refresh, route-driven re-selection, change-overview navigation, path resets, filter transitions, or expansion restoration
- **THEN** every such code path MUST suppress Rule A's selection-clearing and Follow-off effects for that operation
- **AND** the guard MUST NOT swallow subsequent genuine user input or prevent library keyboard navigation

#### Scenario: Initial mount does not flip Follow off
- **WHEN** the SPA boots with `followEnabled = true` (server default) and a pre-selected document
- **AND** the `@pierre/trees` library fires its `onSelectDocument` callback for the pre-selected row during mount
- **THEN** `followEnabled` remains `true`
- **AND** the Follow chip's `aria-pressed` attribute reads `"true"`

#### Scenario: File-event-driven re-selection does not flip Follow off
- **WHEN** Follow is on, a file changes on disk, and the system applies the new selection by calling into `TreeView` programmatically
- **AND** the `@pierre/trees` library fires its `onSelectDocument` callback as a side effect of the programmatic re-selection
- **THEN** `followEnabled` remains `true`

#### Scenario: User click after programmatic re-selection still flips Follow off
- **WHEN** the system has just performed a programmatic re-selection
- **AND** the user immediately clicks a different tree row
- **THEN** Rule A fires
- **AND** `followEnabled` becomes `false`

#### Scenario: Programmatic collapse does not close the active document
- **GIVEN** a document is active
- **WHEN** a path reset, filter transition, or expansion restoration programmatically collapses a directory
- **THEN** that programmatic collapse does not clear the document selection or preview
- **AND** it does not turn Follow off

#### Scenario: Manual collapse after reconciliation still closes the document
- **GIVEN** programmatic tree reconciliation has completed with an active document
- **WHEN** the user manually collapses an expanded ancestor of that document
- **THEN** Rule A's deselection outcome clears the document selection and preview and turns Follow off
- **AND** keyboard focus remains available on the operated directory while it is still displayed, otherwise on a remaining visible row

### Requirement: Follow defaults to ON; URL direct links force OFF on boot

The system SHALL restore `followEnabled` from the current user's personal workspace state when the SPA boots at the workspace root. If no saved Follow value exists, it SHALL use the server-provided `initialFollow` value, whose default is `true` and which the CLI `--no-follow` flag sets to `false`.

#### Scenario: Direct arrivals and saved changes remain client-local
- **WHEN** an explicit document or preview URL opens, or a user changes Follow
- **THEN** an explicit URL MUST set Follow off for that client regardless of saved or server defaults
- **AND** user changes SHALL persist for future root arrivals but SHALL NOT change Follow in another already-open client

#### Scenario: Root arrival restores saved Follow
- **WHEN** personal workspace state contains `follow=false`
- **AND** the user opens the workspace root
- **THEN** Follow boots off even when the CLI default is on

#### Scenario: Root arrival without saved state honors CLI default
- **WHEN** no personal Follow value exists
- **AND** the CLI was started without `--no-follow`
- **THEN** Follow boots on

#### Scenario: Direct link arrival turns Follow off
- **WHEN** a user opens an explicit document or preview URL
- **THEN** Follow is off in that client
- **AND** the user may re-enable it afterward

#### Scenario: One client's Follow change does not control another
- **WHEN** two clients have the same user's workspace open
- **AND** one client toggles Follow
- **THEN** the other open client's Follow state is unchanged
- **AND** the new value is available on a future root arrival

### Requirement: Follow-driven selection never moves focus or the active surface

Selection changes originating from file events (Rules C and D) SHALL NOT move
keyboard focus and SHALL NOT change the app's active surface. Only user-initiated
interaction may do either. A file changing on disk must never relocate the user's
working context.

#### Scenario: A file event while typing in the terminal

- **WHEN** Follow is ON, the user is typing in the terminal, and a watched file changes
- **THEN** the tree selection and preview update, keyboard focus stays in the terminal, and the active surface remains `terminal`

#### Scenario: A file event while the find bar is open

- **WHEN** the preview find bar is open with an active query and a Follow-driven document switch occurs
- **THEN** focus remains in the find input and matches are recomputed against the newly loaded document

#### Scenario: User click still resolves the surface

- **WHEN** the user clicks the tree entry that Follow had already selected
- **THEN** the active surface becomes `preview`, because the change was user-initiated

### Requirement: Manual selection survives background reconciliation

While Follow is off and a file is selected, filesystem updates, index reconciliation, reconnects, page resume, and programmatic tree updates SHALL preserve that file's identity and browser URL.

#### Scenario: Background reconciliation preserves all selectable file kinds
- **GIVEN** Follow is off and any selectable file is selected, including text, Markdown, images, or unavailable-preview files
- **WHEN** background reconciliation or a selected-file update occurs
- **THEN** a classification change MUST NOT select another file; explicit navigation and enabling Follow remain intentional ways to change selection
- **AND** an update to the selected file SHALL refresh available content in place without moving focus or the active touch tab

#### Scenario: Text selection survives unrelated edits
- **WHEN** Follow is off, the user is viewing a Markdown or source file, and another file changes repeatedly
- **THEN** the selected file, preview identity, URL, focus, and active tab remain unchanged
- **AND** the tree reflects the background changes

#### Scenario: Image selection survives a state update
- **WHEN** Follow is off, an image is selected, and a background update or reconnect supplies a workspace snapshot
- **THEN** the image remains selected and its URL is preserved

#### Scenario: Resume preserves the current file
- **WHEN** a suspended page resumes with Follow off after workspace files have changed
- **THEN** reconciliation preserves the selected file and URL
- **AND** updated content for that file is refreshed in place

### Requirement: Unavailable manual selections retain their destination

With Follow off, a selected file that disappears from the allowed index SHALL remain the selected destination and SHALL display a named unavailable state instead of a different file. Its previous contents MUST NOT be presented as current contents.

#### Scenario: Retained unavailable destinations recover only within current selection and exposure rules
- **GIVEN** Follow is off and the selected destination becomes unavailable
- **WHEN** the index empties, classification changes, or the path later reappears
- **THEN** the destination SHALL survive an empty index and classification change
- **AND** preview SHALL recover automatically on same-path return only while that destination remains selected
- **AND** removal by ignore or exposure rules MUST NOT be bypassed to read the retained destination
- **AND** a renamed file SHALL remain an unavailable old path until explicit navigation chooses the new path

#### Scenario: File is replaced during an edit
- **WHEN** the selected file is absent from one snapshot and returns in a later snapshot while Follow remains off
- **THEN** the preview shows unavailability during the gap, retains its destination and URL, and then renders the returned file
- **AND** no fallback file is selected during the gap

#### Scenario: File stays deleted
- **WHEN** the selected file is deleted and does not return
- **THEN** its unavailable presentation remains until the user navigates or enables Follow
- **AND** the user can still select other files

#### Scenario: User leaves before a file returns
- **WHEN** the user selects another file while the previous destination is unavailable and the previous file subsequently returns
- **THEN** the newer selection and URL remain unchanged

### Requirement: Asynchronous work cannot override newer navigation

Only work belonging to the current selection and preview mode SHALL update the preview, selection chrome, or URL. Late responses and programmatic selection notifications MUST NOT be interpreted as new user navigation. Genuine pointer and keyboard navigation SHALL continue to work immediately after a programmatic tree refresh.

#### Scenario: Previous file response completes late
- **WHEN** file A is loading, the user selects file B, and A's response finishes after B's
- **THEN** the preview, selected tree entry, and URL continue to identify B

#### Scenario: Tree rebuild does not navigate
- **WHEN** a file update or filter refresh rebuilds the tree and the tree reports a programmatic selection
- **THEN** that notification does not change the user's selected file, Follow setting, or active tab
- **AND** a subsequent genuine row activation navigates normally

#### Scenario: Client selections remain independent
- **WHEN** two clients select different files with Follow off and either client receives background updates
- **THEN** each client retains its own selected destination

### Requirement: Discovery does not impersonate file edits

Initial discovery SHALL populate the file tree without causing Follow to visit each discovered file. On completion, an untouched initial session SHALL use the existing newest-mtime non-binary default selection, excluding files Git ignores.

#### Scenario: Discovery completion respects prior intent and current working context
- **WHEN** discovery completes or a catch-up requested during incomplete indexing becomes ready
- **THEN** explicit navigation, restored selection, direct links, deliberate emptiness, and newer live-event selection SHALL take precedence over the default
- **AND** deferred catch-up SHALL finish only if no newer user action or live-event selection superseded it

#### Scenario: Ongoing and completed discovery preserve interaction state
- **WHEN** discovery makes progress or completes
- **THEN** it SHALL NOT move keyboard focus, change the active surface, or enable Follow

#### Scenario: Follow is on during discovery
- **WHEN** many existing files are discovered before the inventory is complete
- **THEN** the tree fills without a preview load for every discovered file
- **AND** an otherwise untouched session selects the newest eligible file once discovery completes

#### Scenario: Discovery finds a newer ignored file than any document
- **WHEN** the newest non-binary file discovered is Gitignored and Follow is on in an untouched session
- **THEN** discovery completion selects the newest non-binary file Git does not ignore

#### Scenario: The user navigates before discovery finishes
- **WHEN** the user selects a file or deliberately clears selection during indexing
- **THEN** discovery completion preserves that decision and the resulting Follow state

#### Scenario: A real edit occurs during discovery
- **WHEN** an already discovered file receives a live modification event while indexing continues and Follow is on
- **THEN** its fresh preview can be shown before full discovery completes
- **AND** discovery completion does not replace it with the initial default

### Requirement: Batch follow selection and active-file freshness are independent

For each applied live file batch, Follow SHALL select the last observed eligible create or modification in the client's scope that remains present after the batch. Eligible changes are those Rule C follows: documents and images the preview renders inline. Batch selection and active-file freshness SHALL remain independent.

#### Scenario: Later ineligible events cannot erase an eligible Follow candidate
- **WHEN** a batch has an eligible candidate followed by another binary, a directory, or a removal
- **THEN** that later event MUST NOT erase the earlier eligible candidate

#### Scenario: Every batch-driven selection change retains navigation guards
- **WHEN** a live batch changes selection, including a batch containing only eligible events
- **THEN** it SHALL preserve existing URL replacement, focus, active-surface, and programmatic-tree guards

#### Scenario: Current-file invalidation does not depend on the batch's Follow candidate
- **WHEN** a batch updates the currently selected destination
- **THEN** with Follow off the destination SHALL remain unchanged and reload current content even if another path is the Follow candidate
- **AND** with Follow on and the target already selected its update SHALL still reload current content
- **AND** no refresh SHALL reuse a preview cache invalidated by the batch
- **AND** Source, Rendered, split, Diff, and image presentations SHALL invalidate affected representations, while historical commit previews SHALL remain historical

#### Scenario: A binary event follows a text edit
- **WHEN** Follow is on and a batch contains a text edit followed by an edit to a binary the preview cannot show
- **THEN** the text file remains the eligible Follow target

#### Scenario: An image edit follows a text edit
- **WHEN** Follow is on and a batch contains a text edit followed by an edit to an image the preview renders inline
- **THEN** the image is the eligible Follow target, unless the shown document embeds it (Rule C)

#### Scenario: The open file is not the last changed path
- **WHEN** Follow is off, file A is open, and one batch changes A followed by B
- **THEN** A remains selected and renders fresh content
- **AND** B's update does not suppress A's invalidation

#### Scenario: Follow targets the already open file
- **WHEN** Follow is on and its eligible target is the currently previewed file
- **THEN** that file reloads from current bytes even though selection did not change

#### Scenario: An old representation arrives after invalidation
- **WHEN** a source, rendered, split-pane, diff, or image load started before a file update finishes afterward
- **THEN** it cannot restore content or caches belonging to the earlier revision

#### Scenario: A saved image is open with Follow off
- **WHEN** the selected image is replaced at the same path
- **THEN** its preview fetches the new image bytes while selection, URL, focus, and active surface remain unchanged
