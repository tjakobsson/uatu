# sidebar-shell Specification

## Purpose
TBD - created by archiving change split-document-watch-browser. Update Purpose after archive.
## Requirements
### Requirement: Organize sidebar content into resizable panes
The browser UI SHALL organize the expanded sidebar as a stack of panes. The initial panes SHALL include `Change Overview`, `Files`, and `Git Log`. The existing document tree SHALL render inside the `Files` pane and MUST preserve existing document selection, directory open/closed state, follow-mode interaction, pin interaction, binary-file display, and relative-time behavior. Pane visibility, collapsed state, and vertical sizing SHALL persist across reloads in the same browser for that origin. The pane stack SHALL fill the available expanded-sidebar height and MUST NOT force the whole sidebar body to scroll. Scrollbars used inside panes and preview overflow regions SHOULD be thin and visually light while remaining discoverable. The existing whole-sidebar collapse and expand controls MUST remain separate from per-pane visibility and collapse controls.

#### Scenario: Sidebar opens with default panes
- **WHEN** a user opens the browser UI with no pane preferences stored
- **THEN** the expanded sidebar shows `Change Overview`, `Files`, and `Git Log` panes
- **AND** the `Files` pane contains the document tree for watched roots

#### Scenario: Selecting a document from the Files pane
- **WHEN** a user selects a non-binary document from the `Files` pane tree
- **THEN** the preview loads that document
- **AND** follow mode is disabled in the same way as selecting from the previous sidebar tree

#### Scenario: Pane visibility can be changed and restored
- **WHEN** a user hides a sidebar pane
- **THEN** that pane is removed from the expanded sidebar stack
- **AND** a sidebar panels control allows the user to show that pane again

#### Scenario: Pane size can be adjusted
- **WHEN** a user resizes one sidebar pane relative to another
- **THEN** the pane stack updates the affected pane heights
- **AND** the pane stack remains within the current expanded-sidebar height
- **AND** the updated pane sizes persist across reloads in the same browser for that origin

#### Scenario: Pane content scrolls inside its allocated pane
- **WHEN** pane content exceeds that pane's allocated height
- **THEN** that pane body scrolls internally
- **AND** the whole sidebar body does not gain a scrollbar
- **AND** the scrollbar is thinner and lighter than the default heavy pane treatment where platform styling allows it

#### Scenario: Spare height is assigned to the Files pane
- **WHEN** the expanded pane stack has more vertical space than fixed contextual panes require
- **THEN** the `Files` pane receives the spare space
- **AND** the `Git Log` pane does not show excessive empty space beneath its content

#### Scenario: Whole-sidebar collapse remains separate
- **WHEN** a user collapses the whole sidebar
- **THEN** the sidebar shrinks to the existing narrow rail
- **AND** per-pane visibility and sizing preferences are preserved for when the sidebar is expanded again

### Requirement: Resize expanded sidebar width
The browser UI SHALL allow users to resize the expanded sidebar horizontally. The expanded-sidebar width SHALL persist across reloads in the same browser for that origin. The width control MUST remain separate from whole-sidebar collapse and MUST NOT erase the collapsed/expanded sidebar preference.

#### Scenario: Sidebar width can be resized
- **WHEN** a user drags the divider between sidebar and preview
- **THEN** the expanded sidebar width changes within bounded minimum and maximum values
- **AND** the preview area resizes to fill the remaining width

#### Scenario: Sidebar width persists across reload
- **WHEN** a user resizes the expanded sidebar and reloads the browser UI
- **THEN** the expanded sidebar restores the resized width

#### Scenario: Sidebar collapse preserves resized width
- **WHEN** a user resizes the expanded sidebar, collapses it, and expands it again
- **THEN** the expanded sidebar returns to the resized width

### Requirement: Render review-load summary in the Change Overview pane
The browser UI SHALL render repository and review-load data in the `Change Overview` pane when that data is available. The pane MUST show whether the watched root is inside a git repository, the current branch or detached commit, dirty status, resolved review base or fallback mode, cognitive-load level, and score. The pane MUST NOT list raw mechanical statistics such as changed-file count, touched-line count, diff-hunk count, or directory spread directly in the sidebar. The score MUST be clickable and MUST open a detailed scoring explanation in the main preview area. The pane MUST label the score as review burden or cognitive load and MUST NOT present it as code quality or correctness. The score's *headline label* in the pane SHALL depend on the active Mode: when Mode is **Author**, the headline label MUST be "Reviewer burden forecast"; when Mode is **Review**, the headline label MUST be "Change review burden". The numeric score, level pill, drivers, thresholds, configured area lists, warnings, and the contents of the score-explanation preview MUST be identical in both Modes. If review-load data is unavailable, the pane SHALL show a clear unavailable or non-git message instead of failing to render.

#### Scenario: Git-backed change has review-load data
- **WHEN** the browser receives repository metadata and a computed review-load result
- **THEN** the `Change Overview` pane shows the branch or detached commit, dirty status, review base, cognitive-load level, and score
- **AND** the pane does not show raw mechanical statistics such as `Changed files`, `Touched lines`, `Diff hunks`, or `Directory spread`

#### Scenario: Watch root has no git repository
- **WHEN** the browser receives a non-git repository state for the watched root
- **THEN** the `Change Overview` pane states that no git repository is available
- **AND** the document preview and `Files` pane remain usable

#### Scenario: Review settings contain a warning
- **WHEN** the review-load result includes a settings warning such as invalid `.uatu.json`
- **THEN** the `Change Overview` pane displays that warning
- **AND** the pane still displays any available default review-load result

#### Scenario: Score drivers distinguish configured and factual inputs
- **WHEN** a user clicks the review-burden score
- **THEN** the main preview renders configured risk, support, and ignore area matches with their configured area names
- **AND** mechanical drivers such as files, hunks, lines, and directories are labeled as factual change-shape inputs
- **AND** Follow mode is disabled
- **AND** the browser URL changes to a linkable score-explanation state

#### Scenario: Score explanation remains active during refresh
- **WHEN** a user has opened the score explanation from `Change Overview`
- **AND** the watch session receives a file-change refresh
- **THEN** the main preview remains on the score explanation
- **AND** Follow mode remains disabled

#### Scenario: Score explanation compares the numeric score
- **WHEN** a user opens the score explanation from `Change Overview`
- **THEN** the main preview explains that the score is an additive review-burden index, not a percentage or code-quality score
- **AND** the preview shows the configured or default low, medium, and high thresholds
- **AND** the score total and threshold cards use the corresponding low, medium, and high background colors
- **AND** the preview explains whether the current score is below or above those thresholds
- **AND** the preview does not render a separate `Changed Files` section

#### Scenario: Mechanical statistics have inline explanations
- **WHEN** a user opens the score explanation from `Change Overview`
- **THEN** mechanical statistics such as `Changed files`, `Touched lines`, `Diff hunks`, and `Directory spread` expose help markers
- **AND** hovering or focusing a help marker shows a tooltip that explains what that statistic means in review-burden scoring
- **AND** the explanation does not require clicking the marker

#### Scenario: Author Mode shows the forecast headline label
- **WHEN** the `Change Overview` pane is rendered with review-load data and Mode is **Author**
- **THEN** the score's headline label reads "Reviewer burden forecast"

#### Scenario: Review Mode shows the change-review headline label
- **WHEN** the `Change Overview` pane is rendered with review-load data and Mode is **Review**
- **THEN** the score's headline label reads "Change review burden"

#### Scenario: Switching Mode does not change the score number or level
- **WHEN** the `Change Overview` pane is rendered with review-load data
- **AND** the user toggles Mode between **Author** and **Review**
- **THEN** only the headline label string changes
- **AND** the numeric score, level pill color, drivers, thresholds, and configured-area summaries remain identical

#### Scenario: Score-explanation preview content is independent of Mode
- **WHEN** the user opens the score explanation from `Change Overview` in either Mode
- **THEN** the score-explanation preview renders identical content
- **AND** the preview does not contain Mode-dependent text

### Requirement: Render bounded commit history in the Git Log pane
The browser UI SHALL render the bounded commit log for the selected or only detected repository in the `Git Log` pane. Each visible commit row MUST show at minimum the short SHA and subject. Each visible commit row MUST be a same-origin link to that commit's preview URL so standard browser link affordances are available. If multiple repositories are detected, the pane SHALL make clear which repository each log belongs to or provide a repository grouping/selection. The pane SHALL provide a history-length control for selecting how many commit rows are visible from the bounded data supplied by the server. The `Git Log` pane body SHALL scroll internally when the visible commit rows exceed its allocated height. If no commit log is available, the pane SHALL show an empty or unavailable state instead of failing to render.

#### Scenario: Single repository has commits
- **WHEN** the browser receives a commit log for one detected repository
- **THEN** the `Git Log` pane lists recent commits for that repository
- **AND** each row includes the commit short SHA and subject
- **AND** each row links to a commit preview URL containing that repository id and commit sha

#### Scenario: Commit history length can be changed
- **WHEN** a user selects a different history length in the `Git Log` pane
- **THEN** the pane updates the visible commit rows to that selected limit
- **AND** the selected history length persists across reloads in the same browser for that origin

#### Scenario: Git Log pane scrolls internally
- **WHEN** the visible commit rows exceed the `Git Log` pane height
- **THEN** the `Git Log` pane body scrolls
- **AND** the pane stack remains within the expanded-sidebar height

#### Scenario: Commit click renders full message in preview
- **WHEN** a user clicks a commit row in the `Git Log` pane without a modifier key and without requesting a new browsing context
- **THEN** the main preview renders that commit's full commit message
- **AND** Follow mode is disabled
- **AND** the browser URL updates to the commit preview URL
- **AND** a new entry is added to the browser history stack
- **AND** no hover-only popover is required to read the full message

#### Scenario: Commit row supports browser link affordances
- **WHEN** a user uses a browser link affordance on a commit row such as copy link, open in new tab, or a modifier-click
- **THEN** the commit row behaves as a normal same-origin link
- **AND** the SPA click interception does not prevent the browser's requested link behavior

#### Scenario: Multiple repositories have commits
- **WHEN** the browser receives commit logs for multiple detected repositories
- **THEN** the `Git Log` pane separates or labels commits by repository
- **AND** the user can tell which repository a commit belongs to

#### Scenario: Commit log is unavailable
- **WHEN** no commit log is available for the watched repository context
- **THEN** the `Git Log` pane displays an empty or unavailable state
- **AND** the rest of the sidebar remains usable

### Requirement: Display build identifier in the browser UI
The browser UI SHALL display a build identifier in its header derived from build-time metadata. For compiled release binaries the identifier MUST include the embedded semantic version and short git commit sha. For local development runs (for example under `bun run dev`) the identifier MUST include the current git branch name and short commit sha. When git metadata is unavailable in a development run, the identifier MUST still display the branch placeholder `main` paired with `unknown` rather than hiding the field.

#### Scenario: Release build shows version and commit
- **WHEN** a user opens the browser UI served from a compiled release binary
- **THEN** the header shows `v<version> · <shortsha>` using the embedded metadata

#### Scenario: Local dev run shows branch and commit
- **WHEN** a user opens the browser UI while running `uatu` from source with git available
- **THEN** the header shows `<branch>@<shortsha>`

#### Scenario: Local dev run without git still shows an identifier
- **WHEN** a user opens the browser UI while running `uatu` from source and git metadata cannot be read
- **THEN** the header shows `main@unknown`

### Requirement: Collapse and expand the sidebar
The browser UI SHALL provide a control that collapses the sidebar into a narrow rail and another (or the same, toggled) control that expands it back to full width. The collapsed/expanded preference SHALL persist across reloads in the same browser for that origin. While collapsed, the preview pane MUST expand to use the freed horizontal space.

#### Scenario: Collapsing hides the document list
- **WHEN** a user clicks the sidebar collapse control
- **THEN** the sidebar shrinks to a narrow rail with only an expand control visible
- **AND** the preview pane grows to fill the freed width

#### Scenario: Sidebar collapse persists across reloads
- **WHEN** a user collapses the sidebar and then reloads the page in the same browser
- **THEN** the sidebar is still collapsed after the reload

#### Scenario: Expanding restores the document list
- **WHEN** a user clicks the expand control on a collapsed sidebar
- **THEN** the document list returns to its previous width

### Requirement: Animate the live connection indicator
While the browser UI is connected to the live update channel, the connection indicator SHALL animate with a subtle pulse so the live state is visually distinguishable from a static label. When the channel enters a reconnecting state, the pulse MUST stop and the indicator MUST communicate the reconnecting state without animation. The pulse MUST be disabled when the user's operating system requests reduced motion. The indicator's label MUST read `Connected` while the channel is open, `Reconnecting` while it is recovering, and `Connecting` before the first successful connect. The indicator MUST expose a hover tooltip whose text describes the current connection state to the uatu backend (for example, `Connected to the uatu backend`). The connection indicator SHALL be rendered inside the sidebar header, stacked beneath the `UatuCode` wordmark, so the indicator visually belongs to the application chrome rather than the per-document preview controls. As a tradeoff of this placement, collapsing the sidebar MAY hide the indicator along with the rest of the sidebar chrome.

#### Scenario: The indicator pulses while connected to the server
- **WHEN** the browser UI's event channel is open
- **THEN** the connection indicator displays a pulsing animation labeled `Connected`
- **AND** the indicator's hover tooltip reads `Connected to the uatu backend`

#### Scenario: Reconnecting stops the pulse
- **WHEN** the browser UI's event channel reports an error and enters a reconnecting state
- **THEN** the indicator stops pulsing
- **AND** the label reads `Reconnecting`
- **AND** the hover tooltip describes the reconnecting state

#### Scenario: Reduced-motion users see no animation
- **WHEN** the operating system reports a reduced-motion preference
- **THEN** the indicator does not pulse even while connected
- **AND** the live state is still communicated (e.g. via color and label)

#### Scenario: Indicator label is the same in both Modes
- **WHEN** the channel is open and the user toggles between **Author** and **Review** Modes
- **THEN** the indicator label remains `Connected` in both Modes
- **AND** the indicator's pulse animation continues in both Modes

#### Scenario: Indicator lives under the UatuCode wordmark
- **WHEN** the SPA renders the sidebar header
- **THEN** the connection indicator is rendered inside `.sidebar-header > .brand > .brand-text`, immediately below the `UatuCode` wordmark
- **AND** the connection indicator is NOT rendered in the preview toolbar

#### Scenario: Indicator hides when the sidebar is collapsed
- **WHEN** a user collapses the sidebar
- **THEN** the connection indicator is no longer visible (it lives inside the sidebar chrome that the collapse hides)

### Requirement: Scroll the sidebar independently of the preview
The sidebar SHALL scroll within its own container and MUST NOT scroll together with the preview pane. The sidebar header (title, controls, and meta row) MUST remain visible while the sidebar's document list scrolls, and the sidebar MUST remain in place while the preview scrolls.

#### Scenario: Scrolling the preview does not move the sidebar
- **WHEN** a user scrolls a long Markdown document in the preview pane
- **THEN** the sidebar remains fixed in place
- **AND** the sidebar header and document list stay in their current scroll positions

#### Scenario: Scrolling a long document list does not scroll the preview
- **WHEN** a user scrolls the sidebar document list because it overflows its container
- **THEN** the preview pane does not scroll
- **AND** the sidebar header remains visible at the top of the sidebar

### Requirement: Provide a top-level Author/Review Mode control
The browser UI SHALL expose a top-level **Mode** control with two values: **Author** and **Review**. The Mode control SHALL be placed in a dedicated row at the top of the sidebar, separately from the document-level controls in the preview toolbar (Follow). The Mode control MUST NOT be rendered inside the preview toolbar. Mode SHALL default to **Author** when no preference is stored. The selected Mode SHALL persist across reloads in the same browser for that origin. Mode MUST gate Follow availability and MUST gate file-change-driven preview switching as defined elsewhere in this spec. Mode MUST NOT alter the underlying review-burden score, level, drivers, thresholds, or the contents of the score-explanation preview; only the score's headline label in the `Change Overview` pane may differ by Mode. While Mode is **Review**, the Follow control MUST remain visible but disabled, with affordance text or tooltip naming Mode as the reason it is unavailable.

#### Scenario: Default Mode is Author
- **WHEN** a user opens the browser UI with no Mode preference stored
- **THEN** the Mode control reads **Author**
- **AND** the Follow control is enabled
- **AND** the `Change Overview` headline labels the score as "Reviewer burden forecast"

#### Scenario: Selected Mode persists across reload
- **WHEN** a user selects **Review** in the Mode control
- **AND** the user reloads the page
- **THEN** the Mode control still reads **Review**
- **AND** the Follow control is disabled with an affordance naming Mode as the reason

#### Scenario: Switching Author to Review disables Follow
- **WHEN** the user is in **Author** with Follow enabled
- **AND** the user switches the Mode control to **Review**
- **THEN** Follow becomes disabled
- **AND** the Follow control is rendered as not interactive

#### Scenario: Switching Review to Author makes Follow available without auto-enabling it
- **WHEN** the user is in **Review** and switches the Mode control to **Author**
- **THEN** the Follow control becomes interactive again
- **AND** Follow is not automatically turned on

#### Scenario: Mode does not change the score value or level
- **WHEN** the same Change is being reviewed
- **AND** the user toggles the Mode control between **Author** and **Review**
- **THEN** the numeric review-burden score is identical in both Modes
- **AND** the review-burden level (`low`, `medium`, or `high`) is identical in both Modes
- **AND** the score drivers and thresholds shown in the score-explanation preview are identical in both Modes

#### Scenario: Author Mode labels the score as a reviewer burden forecast
- **WHEN** Mode is **Author**
- **THEN** the `Change Overview` pane labels the review-burden score as "Reviewer burden forecast"

#### Scenario: Review Mode labels the score as a change review burden
- **WHEN** Mode is **Review**
- **THEN** the `Change Overview` pane labels the review-burden score as "Change review burden"

### Requirement: Compose sidebar panes per Mode with independent persistence
The browser UI SHALL expose a Mode-aware pane catalog. The Author Mode catalog SHALL include `Change Overview` and `Files`. The Review Mode catalog SHALL include `Change Overview`, `Files`, and `Git Log`. The panels-restore control SHALL list only panes that belong to the active Mode's catalog. Pane visibility, per-pane collapse, and vertical pane sizing SHALL persist separately for each Mode (e.g. under distinct `localStorage` keys per Mode), so each Mode independently remembers its own layout. Switching Mode MUST re-read the persisted state for the destination Mode and re-render the sidebar.

#### Scenario: Author Mode does not show Git Log
- **WHEN** Mode is **Author**
- **THEN** the sidebar pane stack does not include a `Git Log` pane
- **AND** the panels-restore control does not list `Git Log` as a restorable pane

#### Scenario: Review Mode shows Git Log
- **WHEN** Mode is **Review**
- **THEN** the sidebar pane stack includes a `Git Log` pane
- **AND** the panels-restore control lists `Git Log` as a restorable pane

#### Scenario: Pane state persists separately per Mode
- **WHEN** the user hides or resizes a pane while Mode is **Author**
- **AND** the user switches Mode to **Review**, makes a different pane state change, and switches back to **Author**
- **THEN** the Author pane state is restored to what the user left in **Author**
- **AND** the Review pane state remains as the user left it in **Review**

### Requirement: Provide an All/Changed view toggle in the Files pane
When the watched repository is git-backed AND the review-load result for that repository has status `available`, the `Files` pane SHALL expose a view toggle with two values: **All** (the default) and **Changed**. The selected view SHALL persist across reloads in the same browser for that origin and SHALL be tracked separately for each Mode. The toggle MUST NOT appear when git is unavailable or the review-load result is non-git or unavailable; in that case the `Files` pane SHALL render the existing full-tree listing.

When the **Changed** view is active, the `Files` pane SHALL list the changed files reported by the review-load result instead of the full file tree. Each visible entry MUST display a status indicator (added, modified, deleted, renamed), the file path, and a compact summary of additions and deletions (`+N -M`). Renamed entries MUST display both the previous path and the new path. Deleted entries MUST be rendered as non-clickable since there is no on-disk content to preview. Manual selection of a non-deleted entry MUST switch the active preview to that file using the same selection mechanics as the existing tree.

When the **All** view is active (the default), the `Files` pane SHALL render the existing full-tree listing.

#### Scenario: Default Files view is All when git is available
- **WHEN** the watched root is git-backed AND no Files-view preference is stored for the active Mode
- **THEN** the `Files` pane shows the full file tree
- **AND** the view toggle reads "All"

#### Scenario: Files-view toggle is hidden when git is unavailable
- **WHEN** the watched root is not git-backed OR the review-load result is non-git or unavailable
- **THEN** the `Files` pane does not show a view toggle
- **AND** the pane shows the existing full-tree listing

#### Scenario: Switching to Changed shows the changed-vs-base list
- **WHEN** the user selects the Changed view in the `Files` pane
- **THEN** the pane lists only files reported as changed against the base
- **AND** the full file tree is not rendered in the pane

#### Scenario: Each changed-file entry shows status, path, and line counts
- **WHEN** the Changed view is active in the `Files` pane
- **THEN** each entry shows a status indicator distinguishing added, modified, deleted, and renamed
- **AND** each entry shows the file path
- **AND** each entry shows additions and deletions in a compact `+N -M` form

#### Scenario: Renamed entries show both paths
- **WHEN** a changed file's status is renamed
- **THEN** the entry shows both the previous path and the new path

#### Scenario: Deleted entries are non-clickable
- **WHEN** a changed file's status is deleted
- **THEN** that entry is rendered as non-clickable
- **AND** clicking it does not change the active preview

#### Scenario: View choice persists separately per Mode
- **WHEN** the user selects Changed in **Author** Mode
- **AND** the user switches to **Review** Mode and the Review view choice has not been changed
- **AND** the user switches back to **Author** Mode
- **THEN** the Author Files pane shows the Changed view

### Requirement: Make the active Mode visually unambiguous
The browser UI SHALL make the active Mode visually distinguishable beyond the Mode segment toggle itself. The differentiation MUST be structural and typographic so that it remains legible across future theming work; it MUST NOT rely on chromatic accent alone. The differentiation SHALL include at minimum: a Mode-aware sidebar brand subtitle, a persistent Mode pill in the sidebar brand area, mode-glyph icons inside the Mode segments, a Mode-aware connection-indicator label and dot animation when the live channel is connected, and Mode-aware preview chrome. Switching Mode MUST update all of these affordances together.

#### Scenario: Sidebar brand subtitle reflects the active Mode
- **WHEN** the Mode is **Author**
- **THEN** the sidebar brand subtitle reads "Authoring session"
- **WHEN** the Mode is switched to **Review**
- **THEN** the sidebar brand subtitle reads "Review session"

#### Scenario: Persistent Mode pill reflects the active Mode
- **WHEN** the Mode is **Author**
- **THEN** a persistent pill in the sidebar brand area reads "Authoring"
- **WHEN** the Mode is switched to **Review**
- **THEN** the persistent pill reads "Reviewing"

#### Scenario: Toolbar Mode segments carry mode-glyph icons
- **WHEN** the Mode toggle is rendered
- **THEN** the Author segment includes an icon distinct from the Review segment
- **AND** both icons are present regardless of which Mode is currently active

#### Scenario: Connection indicator differs in Review when the channel is live
- **WHEN** Mode is **Author** and the live channel is connected
- **THEN** the connection indicator shows the existing "Online" treatment with a pulsing dot
- **WHEN** Mode is switched to **Review** while the live channel is connected
- **THEN** the connection indicator label changes to a "Reading" wording that signals auto-refresh is paused
- **AND** the indicator dot stops pulsing

#### Scenario: Preview area carries a framed-read treatment in Review
- **WHEN** Mode is **Review**
- **THEN** the preview area carries a Mode-specific chrome treatment (e.g. an inset frame)
- **WHEN** Mode is switched back to **Author**
- **THEN** the Mode-specific preview chrome is removed and the preview returns to its default appearance

