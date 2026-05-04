## ADDED Requirements

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

### Requirement: Show a stale-content hint in Review when the active file changes on disk
While the active Mode is **Review**, the system SHALL render a stale-content hint as a strip in the active preview's header when the currently displayed file changes on disk. The hint MUST identify that the file has changed and MUST expose a refresh affordance. Activating the refresh affordance MUST re-render the active preview to the current on-disk content for the same file and MUST clear the hint. Multiple subsequent change events for the same active file while the hint is visible MUST coalesce into a single hint and MUST NOT spawn additional hints. Manual navigation away from the file (selecting a different file in the `Files` pane, opening a commit preview, navigating via URL, switching Mode) MUST clear the hint as a side effect. The hint MUST NOT appear in **Author** Mode. When the currently displayed file is *deleted* on disk while in **Review**, the hint MUST enter a distinct "file no longer exists on disk" state with a close or back affordance instead of refresh; the stale rendered content MUST remain visible until the user acts. The hint MUST NOT alter the indexed sidebar's normal handling of the change.

#### Scenario: Hint appears when the active file changes on disk in Review
- **WHEN** Mode is **Review** and the currently displayed file changes on disk
- **THEN** a stale-content hint appears in the active preview's header strip
- **AND** the rendered content remains the pre-change content
- **AND** the hint exposes a refresh affordance

#### Scenario: Refresh affordance re-renders the active preview and clears the hint
- **WHEN** the stale-content hint is visible in **Review** Mode
- **AND** the user activates the refresh affordance
- **THEN** the active preview re-renders to the current on-disk content for the same file
- **AND** the hint is cleared

#### Scenario: Multiple changes coalesce into a single hint
- **WHEN** the stale-content hint is visible in **Review** Mode for the active file
- **AND** the active file changes on disk again before the user acts on the hint
- **THEN** only one stale-content hint remains visible
- **AND** activating refresh re-renders to the latest on-disk content

#### Scenario: Manual navigation clears the hint
- **WHEN** the stale-content hint is visible in **Review** Mode
- **AND** the user navigates to a different file (via the `Files` pane, a `Git Log` commit, or a URL)
- **THEN** the hint is cleared
- **AND** the new active preview renders normally

#### Scenario: Switching to Author Mode clears the hint
- **WHEN** the stale-content hint is visible in **Review** Mode
- **AND** the user switches Mode to **Author**
- **THEN** the hint is cleared
- **AND** the active preview re-renders to the current on-disk content for the same file

#### Scenario: Hint never appears in Author Mode
- **WHEN** Mode is **Author** and the currently displayed file changes on disk
- **THEN** no stale-content hint appears
- **AND** the existing in-place refresh behavior applies

#### Scenario: Active file deleted on disk shows a deleted hint state
- **WHEN** Mode is **Review** and the currently displayed file is deleted on disk
- **THEN** the active preview's header strip shows a "file no longer exists on disk" hint state
- **AND** the hint exposes a close or back affordance instead of a refresh affordance
- **AND** the previously rendered content remains visible until the user acts on the hint

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

### Requirement: Render directory rows in the file tree with a folder icon
When the `Files` pane renders the full-tree fallback, each directory row SHALL include a folder icon next to the directory name. The icon SHALL be visually consistent with the existing file-type icons used on file rows.

#### Scenario: Directory rows include a folder icon in the fallback tree
- **WHEN** the `Files` pane renders the full-tree fallback
- **THEN** each directory row displays a folder icon next to the directory name

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

## MODIFIED Requirements

### Requirement: Configure startup browser behavior
The system SHALL attempt to open the browser automatically and SHALL start with follow mode enabled by default. The command MUST provide flags to disable browser auto-open and to disable follow mode before the watch session starts. The command MUST also provide a `--mode=author|review` flag that sets the initial UI Mode for the watch session. When the `--mode` flag is present at startup, it MUST take precedence over any persisted browser-side Mode preference for the initial SPA boot. When `--mode=review` is in effect at startup, follow mode MUST be off for the session regardless of the follow flag and MUST NOT be enabled by the SPA until the user switches Mode back to **Author**. The local browser URL MUST be printed whether or not the browser is opened successfully. When the SPA boots with `location.pathname` resolving to a known non-binary document (anything other than `/`), the SPA MUST disable follow mode for the session regardless of the CLI default — see "Force follow mode off when arriving via a direct document URL" for the full rule.

#### Scenario: Default startup opens the browser with follow enabled
- **WHEN** a user runs `uatu watch docs`
- **THEN** the system attempts to open the browser automatically
- **AND** the watch session starts with follow mode enabled
- **AND** the local browser URL is printed

#### Scenario: Startup flags disable auto-open and follow
- **WHEN** a user runs `uatu watch docs --no-open --no-follow`
- **THEN** the system does not attempt to open the browser
- **AND** the watch session starts with follow mode disabled
- **AND** the local browser URL is printed

#### Scenario: SPA boot at the root URL honors the CLI follow default
- **WHEN** a user opens the browser to `http://127.0.0.1:NNNN/`
- **AND** the CLI was started without `--no-follow`
- **THEN** the SPA boots with follow mode enabled

#### Scenario: Mode flag sets the startup Mode
- **WHEN** a user runs `uatu watch docs --mode=review`
- **THEN** the SPA boots with Mode set to **Review**
- **AND** follow mode is off for the session
- **AND** the persisted browser-side Mode preference is overwritten to **Review** for that origin

#### Scenario: Mode flag overrides persisted browser preference at startup
- **WHEN** the browser has a persisted Mode preference of **Review**
- **AND** the user runs `uatu watch docs --mode=author`
- **THEN** the SPA boots with Mode set to **Author**

#### Scenario: Review mode forces follow off even when --no-follow is omitted
- **WHEN** a user runs `uatu watch docs --mode=review`
- **THEN** the watch session starts with follow mode disabled regardless of the follow flag
- **AND** the Follow control is rendered as disabled with an affordance naming Mode as the reason

### Requirement: Follow the latest changed non-binary file
When follow mode is enabled AND the active Mode is **Author**, the system SHALL switch the active preview to the latest changed non-binary file under the watched roots. Markdown and non-Markdown text files SHALL both be eligible to change the active preview under follow mode. Binary file changes MUST NOT change the active preview. Manual file selection in the sidebar MUST disable follow mode and pin the selected file until follow mode is enabled again. When the user transitions follow mode from disabled to enabled while in **Author** Mode, the system SHALL immediately switch the active preview to the most recently modified non-binary file under the watched roots, rather than waiting for the next change event. When a follow-driven auto-switch changes the active document, the system MUST update the browser URL via `history.replaceState` (not `pushState`) so the address bar stays accurate while the back stack reflects only user-initiated navigation. While the active Mode is **Review**, follow mode MUST be off, the Follow control MUST be unavailable for interaction, and file-system change events MUST NOT switch the active preview. Manual file selection from the `Files` pane and other manual navigation (e.g. `Git Log` commit clicks, direct URLs) MUST continue to work in **Review** Mode. In **Author** Mode, in-place refresh of the currently displayed file's content when that file changes on disk SHALL continue to work as today. In **Review** Mode, the system MUST NOT automatically re-render the active preview when the currently displayed file changes on disk; the stale-content hint behavior is governed by the "Show a stale-content hint in Review when the active file changes on disk" requirement.

#### Scenario: Follow mode switches to the latest changed Markdown file
- **WHEN** Mode is **Author** and follow mode is enabled and a Markdown file changes under a watched root
- **THEN** that Markdown file becomes the active selection
- **AND** the preview updates to render it

#### Scenario: Follow mode switches to the latest changed non-Markdown text file
- **WHEN** Mode is **Author** and follow mode is enabled and a non-Markdown text file (e.g. `config.yaml`, `script.py`) changes under a watched root
- **THEN** that file becomes the active selection
- **AND** the preview updates to render it as syntax-highlighted code

#### Scenario: Follow mode ignores binary file changes
- **WHEN** Mode is **Author** and follow mode is enabled and a binary file changes under a watched root
- **THEN** the active selection does not change
- **AND** the preview is not refreshed

#### Scenario: Manual selection disables follow mode
- **WHEN** a user manually selects a non-binary file from the sidebar while in **Author** Mode and follow mode is enabled
- **THEN** follow mode is disabled
- **AND** the selected file remains active until the user re-enables follow mode or selects another file

#### Scenario: Enabling follow jumps to the latest modified file
- **WHEN** a user enables follow mode while folder-scoped in **Author** Mode
- **AND** the most recently modified non-binary file under the watched roots is not the current selection
- **THEN** the active preview switches to that most recently modified file

#### Scenario: Follow-driven auto-switch replaces the URL without pushing history
- **WHEN** Mode is **Author** and follow mode is enabled and a file-system change causes the active document to switch
- **THEN** the browser URL pathname updates to the new document's relative path
- **AND** no new entry is added to the browser history stack

#### Scenario: Review Mode suppresses file-change-driven preview switching
- **WHEN** Mode is **Review** and the active preview is some file A
- **AND** a different non-binary file B changes under a watched root
- **THEN** the active preview remains file A
- **AND** the browser URL does not change

#### Scenario: Review Mode allows manual file selection
- **WHEN** Mode is **Review**
- **AND** the user clicks a non-binary file in the `Files` pane
- **THEN** the active preview switches to that file
- **AND** the browser URL updates to that file

#### Scenario: Review Mode does not re-render the active preview when the active file changes on disk
- **WHEN** Mode is **Review** and the currently displayed file changes on disk
- **THEN** the active preview does not re-render
- **AND** the rendered content the reviewer was reading remains visible
- **AND** the stale-content hint behavior is governed by its own requirement

#### Scenario: Author Mode refreshes the currently displayed file in place
- **WHEN** Mode is **Author** and the currently displayed file changes on disk
- **THEN** the preview re-renders the new content for that same file
- **AND** the active selection does not switch to a different file when Follow is off

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

## REMOVED Requirements

### Requirement: Pin the session to a single non-binary file
**Reason**: The in-UI Pin/Unpin chip is removed in favor of Mode-driven pane composition. Pin was a workaround for "narrow my view to one file" that the new Author/Review distinction (and the upcoming workflow features that build on it) replaces more cleanly. Coexistence of Pin and Mode would have read as duplicate posture controls.
**Migration**: For single-file watching, use the existing CLI form `uatu watch path/to/file.md`. The server-side `Scope` mechanism that powered Pin is retained and continues to support single-file CLI watch sessions; only the in-browser Pin/Unpin affordance and its handlers are removed.
