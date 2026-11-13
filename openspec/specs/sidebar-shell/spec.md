# sidebar-shell Specification

## Purpose
Provide a persistent, resizable sidebar shell whose independently scrolling panes expose files, search, repository context, commit history, connection status, and application controls without disrupting focus or preview navigation.

Throughout this spec, "phone-class viewport" means a viewport that is BOTH
coarse-pointer (`pointer: coarse`) AND narrower than the 900-pixel stacked-layout
breakpoint. iPads in landscape and narrow desktop windows are not phone-class.

## Requirements

### Requirement: Organize sidebar content into resizable panes
The expanded sidebar SHALL be a pane stack including `Change Overview`, `Files`, and `Git Log`, available regardless of session state with visibility toggles via the per-pane visibility menu. The `Files` tree MUST preserve document selection and `follow-mode` interaction. Persistence, scrolling, and separation from whole-sidebar controls SHALL follow the rules below.

#### Scenario: Pane arrangement is changed and restored
- **WHEN** a user changes pane visibility, collapsed state, or vertical sizing and reloads in the same browser for that origin
- **THEN** those preferences SHALL persist under one set of storage keys without per-Mode partitioning

#### Scenario: Sidebar and preview layout preserve independent scrolling and controls
- **WHEN** the browser UI is displayed, whether or not pane preferences changed
- **THEN** the pane stack SHALL fill available expanded-sidebar height and MUST NOT force whole-sidebar body scrolling
- **AND** pane and preview-overflow scrollbars SHOULD be thin and visually light while discoverable
- **AND** existing whole-sidebar collapse/expand controls MUST remain separate from per-pane visibility/collapse controls

#### Scenario: Tree-library internals determine Files behavior
- **WHEN** `@pierre/trees` handles directory expansion, binary-entry presentation, or future row annotations such as relative-time labels
- **THEN** the `document-tree` capability governs those behaviors rather than this requirement, which does not assert their survival across the library swap

#### Scenario: Sidebar opens with default panes
- **WHEN** a user opens the browser UI with no pane preferences stored
- **THEN** the expanded sidebar shows `Change Overview`, `Files`, and `Git Log` panes
- **AND** the `Files` pane contains the document tree for watched roots

#### Scenario: Selecting a document from the Files pane
- **WHEN** a user selects a non-binary document from the `Files` pane tree
- **THEN** the preview loads that document
- **AND** Follow mode is disabled (Rule A of the `follow-mode` capability)

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

### Requirement: Render bounded commit history in the Git Log pane
The `Git Log` pane SHALL render bounded history for the selected or only detected repository. Each visible row MUST show at least short SHA and subject, MUST be a same-origin commit-preview link, and SHALL show commit-time-derived age. The pane SHALL remain available at all times, not gated by Mode, with the history, freshness, and fallback behavior below.

#### Scenario: A reader keeps a bounded Git Log open
- **WHEN** the Git Log is displayed
- **THEN** ages SHALL stay current while the page is open without new or refetched repository data, and row links MUST support standard browser link affordances
- **AND** multiple repositories SHALL be clearly labelled or offer grouping/selection
- **AND** a history-length control SHALL select visible row count from server-bounded data, and the body SHALL scroll internally when rows exceed its allocated height
- **AND** an absent log SHALL produce an empty or unavailable state instead of render failure

#### Scenario: Single repository has commits
- **WHEN** the browser receives a commit log for one detected repository
- **THEN** the `Git Log` pane lists recent commits for that repository
- **AND** each row includes the commit short SHA and subject
- **AND** each row links to a commit preview URL containing that repository id and commit sha

#### Scenario: Commit ages stay current
- **WHEN** the `Git Log` pane is visible and no repository change occurs for several minutes
- **THEN** each row's age advances to reflect the elapsed time
- **AND** keeping the ages current does not request repository data from the server

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
- **AND** the preview shows the commit's age, derived from its commit time in the same way
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
The browser header SHALL display a build identifier derived from build-time metadata. Compiled releases MUST include embedded semantic version and short git commit sha; local development (for example `bun run dev`) MUST include current branch and short commit sha. Missing development git metadata MUST use `main` paired with `unknown`, not hide the field.

#### Scenario: Development metadata cannot supply an identifier
- **WHEN** git metadata is unavailable during a development run
- **THEN** the header MUST still display the build identifier using branch placeholder `main` and commit placeholder `unknown`

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
The browser UI SHALL provide a control to collapse the sidebar to a narrow rail and a control (or the same toggled control) to restore full width. The preference SHALL persist across reloads in the same browser for that origin; the preview MUST use freed width. The rail SHALL expose Follow and Terminal icon toggles with the state and access behavior below.

#### Scenario: Collapsed-sidebar controls are used by pointer or keyboard
- **WHEN** the sidebar is collapsed
- **THEN** rail Follow and Terminal toggles SHALL drive the same state as expanded-sidebar counterparts without requiring expansion or a keyboard shortcut, including on touch devices
- **AND** each toggle MUST be pointer- and keyboard-reachable and reflect its current state: `aria-pressed` mirrors `followEnabled`, and the terminal control mirrors panel visibility

#### Scenario: Collapsing hides the document list
- **WHEN** a user clicks the sidebar collapse control
- **THEN** the sidebar shrinks to a narrow rail showing the expand control, a Follow toggle, and a Terminal toggle
- **AND** the preview pane grows to fill the freed width

#### Scenario: Toggling the terminal from the rail
- **WHEN** the sidebar is collapsed and the user activates the rail's Terminal toggle
- **THEN** the terminal panel shows (or hides) exactly as the expanded sidebar's Terminal control would
- **AND** the sidebar remains collapsed

#### Scenario: Toggling Follow from the rail
- **WHEN** the sidebar is collapsed and the user activates the rail's Follow toggle
- **THEN** `followEnabled` flips exactly as the sidebar-header Follow chip would flip it
- **AND** the rail toggle's pressed state reflects the new value

#### Scenario: Sidebar collapse persists across reloads
- **WHEN** a user collapses the sidebar and then reloads the page in the same browser
- **THEN** the sidebar is still collapsed after the reload

#### Scenario: Expanding restores the document list
- **WHEN** a user clicks the expand control on a collapsed sidebar
- **THEN** the document list returns to its previous width

### Requirement: Animate the live connection indicator
The sidebar connection indicator SHALL communicate the current live-channel state with labels, tooltip, and a subtle connected pulse. It MUST reflect authoritative state, distinguish recovery from a stopped Hub session, and respect reduced motion. Placement, lifecycle transitions, and independence from Chat and Mode SHALL follow the rules below.

#### Scenario: The channel connects or begins recovery
- **WHEN** the current live channel has supplied authoritative state that the UI received and applied
- **THEN** the indicator SHALL subtly pulse to distinguish live state from a static label, and its label MUST read `Connected`
- **AND** the pulse MUST be disabled for operating-system reduced motion

#### Scenario: Initial connection and recovery have distinct pending labels
- **WHEN** the first successful connection has not occurred
- **THEN** the indicator's label MUST be `Connecting`
- **WHEN** the connection is recovering
- **THEN** its label MUST be `Reconnecting` without animation
- **AND** the pulse MUST stop when the channel enters reconnecting state
- **AND** it MUST remain reconnecting until a current replacement supplies authoritative state, then return immediately to connected without waiting for a file change

#### Scenario: Hub session state distinguishes stopped from unreachable
- **WHEN** a hub-served channel is not confirmed live
- **THEN** the label MUST be `Stopped` if the hub reports the current session not running, sourced from the activity topic prompting a read of Hub workspace state
- **AND** a stopped session MUST NOT read `Reconnecting`, which is reserved for transport gaps or an unreachable child of a running session
- **AND** a running session whose child is momentarily unreachable SHALL stay `Reconnecting`
- **AND** a start from anywhere SHALL clear `Stopped` via the stream without reload

#### Scenario: Connection chrome is displayed beside independent Chat status
- **WHEN** the shell renders its connection indicator
- **THEN** it SHALL be inside the sidebar header beneath the `UatuCode` wordmark, not per-document preview controls; sidebar collapse MAY hide it with the chrome
- **AND** its hover tooltip MUST describe the current uatu backend connection state, for example `Connected to the uatu backend` or `The workspace session is stopped`
- **AND** label and animation MUST NOT vary by Mode-equivalent state because the SPA is single-mode
- **AND** on Hub pages it SHALL reflect brokered-stream transport and the current workspace's applied `document` state; Chat-topic resync or unavailability MUST NOT change it, and Chat status SHALL remain in Chat

#### Scenario: A page is served directly without a Hub
- **WHEN** a directly served page displays connection state without a Hub
- **THEN** it never shows `Stopped`

#### Scenario: A Chat topic resyncs independently of shell connection rendering
- **WHEN** a Chat topic reports scoped resync or unavailability
- **THEN** it MUST NOT change the shell connection indicator, and Chat transport status SHALL remain scoped to the Chat surface

#### Scenario: The indicator pulses while connected to the server
- **WHEN** the browser UI's current event channel supplies authoritative state that the client applies
- **THEN** the connection indicator displays a pulsing animation labeled `Connected`
- **AND** the indicator's hover tooltip reads `Connected to the uatu backend`

#### Scenario: Reconnecting stops the pulse
- **WHEN** the browser UI's event channel reports an error and enters a reconnecting state
- **THEN** the indicator stops pulsing
- **AND** the label reads `Reconnecting`
- **AND** the hover tooltip describes the reconnecting state

#### Scenario: Successful recovery clears reconnecting immediately
- **WHEN** a replacement event channel supplies and applies its authoritative state
- **THEN** the indicator returns to `Connected` without waiting for a watched file to change
- **AND** an older recovery attempt cannot return the indicator to a stale state

#### Scenario: A stopped session reads Stopped, not Reconnecting
- **WHEN** the viewed workspace's session is stopped from the dashboard or another device while its page is open
- **THEN** the indicator's label changes to `Stopped` without the page reloading
- **AND** the indicator does not pulse
- **AND** the hover tooltip says the workspace session is stopped

#### Scenario: An unreachable child of a running session stays Reconnecting
- **WHEN** the stream reports the current workspace not running but the hub's workspace state still lists its session as running
- **THEN** the indicator reads `Reconnecting`
- **AND** no start is offered

#### Scenario: A start from elsewhere clears Stopped
- **WHEN** a stopped session whose page reads `Stopped` is started from the dashboard or another device
- **THEN** the page's indicator leaves `Stopped` from the stream update and returns to `Connected` once the replacement state is applied, without a reload

#### Scenario: Chat status does not misrepresent document connectivity
- **WHEN** a chat topic on the brokered stream requires a resync while the stream and its `document` topic remain confirmed live
- **THEN** the shell connection indicator remains `Connected`
- **AND** Chat reports its own status within the Chat surface

#### Scenario: Reduced-motion users see no animation
- **WHEN** the operating system reports a reduced-motion preference
- **THEN** the indicator does not pulse even while connected
- **AND** the live state is still communicated (e.g. via color and label)

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

### Requirement: Provide a Files-pane filter chip with single persisted state
Files SHALL provide a compact All/Recent/Changed control, defaulting to All and persisting as personal workspace state across clients. All/Changed SHALL show the hierarchical view; Recent SHALL show the flat disk-write-ordered view defined by `recent-files`. Changes SHALL affect only the current client's Files presentation and future resume state under the isolation rules below.

#### Scenario: A user changes Files view or opens Files options
- **WHEN** the Files view changes
- **THEN** another open client, Follow, pane visibility, active preview selection, and active playback SHALL remain unchanged
- **AND** existing Changed empty-state behavior for empty, non-git, and unavailable change sets SHALL remain unchanged

#### Scenario: Changed opens with no usable change set before any view switch
- **WHEN** Files displays Changed with an empty, non-git, or unavailable change set, including on initial load
- **THEN** its existing empty-state behavior SHALL remain unchanged

#### Scenario: Files options open without changing the current Files view
- **WHEN** Files options are displayed, whether or not the view changed
- **THEN** they SHALL expose Show ignored files and, when media browsing is available, the media-type filter without crowding the main view control

#### Scenario: Default state is All
- **WHEN** the user has no saved Files view
- **THEN** the control selects All and the full eligible hierarchical view renders

#### Scenario: Filter follows the user to another browser
- **WHEN** a user selects Changed or Recent and later opens the workspace root in another browser
- **THEN** the new client restores that saved Files view

#### Scenario: Open clients retain independent filters
- **WHEN** two clients are open and one changes its Files view
- **THEN** the other client's rendered Files presentation does not change

#### Scenario: Empty state names the review base
- **WHEN** the view is Changed, review data is available, and no changed path intersects the eligible set
- **THEN** Files shows an empty state naming the resolved review base

#### Scenario: Non-git empty state explains unavailability
- **WHEN** the view is Changed and review data is non-git or unavailable
- **THEN** Files explains that Changed is unavailable

#### Scenario: Toggling to All clears the empty state
- **WHEN** a Changed empty state is visible and the user selects All
- **THEN** the full eligible tree returns

#### Scenario: Chip does not alter Follow or selection
- **WHEN** the user changes the Files view
- **THEN** Follow, active preview selection, and active playback remain unchanged

#### Scenario: Recent does not reset the tree arrangement
- **WHEN** the user leaves All for Recent and returns to All
- **THEN** the tree retains its manual directory expansion and selection state

### Requirement: Pane headers render title and metadata without visual overlap
Every sidebar pane header SHALL render title and metadata without overlap at supported widths. Files SHALL show one quiet eligible-result count for the selected view/query with an accessible file-count label, without binary breakdown, hidden segment, or filtered-versus-total wording. Status and controls SHALL remain independently usable under the layout rules below.

#### Scenario: All pane controls remain reachable at constrained widths and on touch
- **WHEN** any sidebar pane is displayed at minimum sidebar width or on a touch device
- **THEN** its controls SHALL remain reachable
- **AND** the Files view control SHALL wrap to its own row when necessary rather than forcing important controls offscreen

#### Scenario: Header status and metadata stay legible at every supported width
- **WHEN** pane headers display status or metadata at any supported width, including wide desktop
- **THEN** indexing/error/retry status SHALL remain independently visible
- **AND** other pane headers SHALL preserve nonoverlapping title/metadata, ellipsizing a title that cannot fit beside metadata

#### Scenario: Files-pane header is legible at default sidebar width
- **WHEN** Files displays a large result count at the default sidebar width
- **THEN** the title, count, All/Recent/Changed control, and pane actions do not overlap
- **AND** no binary subcount is displayed

#### Scenario: Files-pane header is legible at minimum sidebar width
- **WHEN** Files is at its minimum supported sidebar width of 320px
- **THEN** view controls, count, and pane actions remain reachable without horizontal overflow
- **AND** the control uses another row if needed

#### Scenario: Other pane headers benefit from the same rule
- **WHEN** another sidebar pane header contains visible metadata
- **THEN** its title and metadata do not overlap

#### Scenario: Discovery is incomplete
- **WHEN** only part of the inventory is known
- **THEN** the current known-result count is accompanied by the indexing indication
- **AND** it does not imply discovery is complete

### Requirement: Sidebar interaction never moves keyboard focus out of the sidebar

Sidebar interaction SHALL leave keyboard focus where the user put it, whether
that interaction is selecting a document in the tree or operating any pane
control. The sidebar SHALL NOT move focus into the preview as a side effect of
selection, so whatever keyboard interaction the tree provides remains available
to the user who just clicked in it.

#### Scenario: Focus stays in the tree after a selection

- **WHEN** the user clicks a file in the tree
- **THEN** the active element is still within the sidebar, not the preview

#### Scenario: Pane controls do not steal focus

- **WHEN** the user collapses or resizes a sidebar pane
- **THEN** keyboard focus is not moved into the preview

### Requirement: Sidebar interaction resolves the active surface to the preview

Interacting with the sidebar SHALL set the app's active surface to `preview`,
because directing the sidebar is an act about the document being previewed. The
sidebar SHALL NOT be addressable as a find surface of its own.

#### Scenario: Find after a tree selection targets the document

- **WHEN** the user was working in the terminal, clicks a file in the tree, and presses `⌘F`
- **THEN** find opens over the preview rather than the terminal or the sidebar

### Requirement: The sidebar hosts a Search pane in the pane stack

The sidebar SHALL include a Search pane participating in the existing pane-stack
behavior: it can be collapsed, hidden, resized, and restored from the panels
menu, and its visibility and height SHALL persist across reloads like the other
panes. The pane SHALL be present but may default to hidden, since it is opened
on demand by its shortcut.

#### Scenario: Search pane behaves like its siblings

- **WHEN** the user collapses, hides, and then restores the Search pane from the panels menu
- **THEN** it behaves identically to the Files and Git Log panes and its state persists across a reload

#### Scenario: Shortcut reveals a hidden pane

- **WHEN** the Search pane is hidden and the user opens project search by its shortcut
- **THEN** the pane becomes visible and expanded without disturbing the other panes' persisted state

### Requirement: The sidebar hosts a Usage pane in the pane stack
The sidebar SHALL include a Usage pane, hidden by default, with the existing pane-stack collapse, hide, resize, and panels-menu restore behavior and persisted visibility/height across reloads. It SHALL display last-known plan usage and offer a read-now control under the freshness and session-lifecycle rules below.

#### Scenario: A client loads an existing plan-usage report
- **WHEN** the client loads
- **THEN** Usage SHALL immediately show the workspace's last-known windows, each with name, percentage used, and reset time, plus read time and elapsed age, without waiting for a conversation to open or turn to end
- **AND** if no report has ever been read, an empty state SHALL offer the read control

#### Scenario: An existing Usage report ages or a newer report arrives
- **WHEN** the pane's report becomes older than ten minutes or any Claude Code conversation supplies a newer report
- **THEN** an older-than-ten-minutes report SHALL remain readable and be marked stale
- **AND** every newer report SHALL update the pane's last-known windows, names, percentage used, reset times, read time, and elapsed age

#### Scenario: Usage is read on demand or a stale pane is opened
- **WHEN** the user activates the pane's read-now control
- **THEN** the same rules as the chat readout SHALL apply: a live Claude Code session answers without interruption, an idle conversation is started and retired for the read, the control shows an in-flight read, and failure keeps figures and states why

#### Scenario: Opening stale Usage refreshes without a read-now activation
- **WHEN** a stale pane is opened while a Claude Code session is live
- **THEN** it SHALL refresh through that session unasked

#### Scenario: The plan readout offers to reveal Usage independently of reads
- **WHEN** the chat plan readout is open beside a displayed sidebar
- **THEN** the readout SHALL offer a control revealing Usage

#### Scenario: Usage pane behaves like its siblings
- **WHEN** the user collapses, hides, and then restores the Usage pane from the panels menu
- **THEN** it behaves identically to the Files and Git Log panes and its state persists across a reload

#### Scenario: Pinning from the readout reveals the pane
- **WHEN** the plan readout is open beside a displayed sidebar and the user activates its keep-in-sidebar control
- **THEN** the Usage pane becomes visible and expanded without disturbing the other panes' persisted state

#### Scenario: The pane follows the newest report
- **WHEN** a Claude Code conversation reports fresh plan usage after a turn or a read
- **THEN** the Usage pane shows those figures without the user reselecting anything

#### Scenario: The pane survives a reload
- **WHEN** the client reloads or returns to the workspace and no turn has ended since the last report
- **THEN** the Usage pane shows the last-known windows with the time they were read and how long ago

#### Scenario: A stale report says so
- **WHEN** the pane's report was read more than ten minutes ago
- **THEN** its figures remain shown and are marked stale

#### Scenario: The pane reads on demand
- **WHEN** the user activates the pane's read control
- **THEN** the control shows the read in flight
- **AND** the pane shows the refreshed windows with a new read time when it completes

#### Scenario: A failed read keeps the pane's figures
- **WHEN** the pane's read fails
- **THEN** the last-known windows remain shown
- **AND** the pane states that the read failed and why

#### Scenario: No report yet
- **WHEN** no plan usage has ever been read in this workspace
- **THEN** the Usage pane states that nothing has been read yet and offers the read control

### Requirement: File tree keeps a usable height in the stacked layout
In desktop mode's stacked (≤900px) layout the `Files` pane body SHALL receive an explicit height so the virtualized tree renders a usable number of rows and scrolls internally, instead of collapsing to its (nonexistent) intrinsic content height. Wide-viewport desktop flex allocation of pane heights SHALL be unchanged. (In touch mode the tree renders inside the full-screen Files tab and needs no stacked-layout special case.)

#### Scenario: Stacked layout shows a browsable tree
- **WHEN** the app renders the desktop layout at a stacked width with documents in the watched tree
- **THEN** the Files pane shows multiple tree rows within a bounded, internally scrolling body
- **AND** other panes and the preview remain reachable by scrolling the page

### Requirement: Fresh clients default to a lean pane set
Without stored pane state, the sidebar SHALL show `Change Overview` and `Files` and hide `Git Log`, `Search`, and `Usage`, which SHALL remain available through the per-pane visibility menu. Stored state SHALL always take precedence; changing defaults MUST NOT alter existing arrangements.

#### Scenario: Stored pane state contains removed pane ids
- **WHEN** the pane-state reader encounters a stored id that no longer exists
- **THEN** it SHALL ignore that entry without error or discarding the rest of the stored state

#### Scenario: First visit shows the lean sidebar
- **WHEN** the app loads on a client with no `uatu:sidebar-panes` stored state
- **THEN** Change Overview and Files are visible and Git Log, Search, and Usage are not
- **AND** the panes menu lists Git Log and Usage as available toggles

#### Scenario: Existing arrangements are untouched
- **WHEN** the app loads on a client whose stored pane state has Git Log visible
- **THEN** Git Log renders visible exactly as stored

#### Scenario: Stale pane ids in storage are inert
- **WHEN** the stored pane state contains an entry for a pane id that no longer exists (e.g., `selection-inspector`)
- **THEN** the app boots normally and the remaining pane entries are honored

### Requirement: Render repository change context in the Change Overview pane
`Change Overview` SHALL render available repository/change-context data and MUST show Git membership, branch or detached commit, dirty status, and resolved compare anchor (base ref or fallback mode). It MUST show `.uatu.json` parsing warnings and SHALL show a clear unavailable/non-git message rather than fail when data is unavailable. Statistics and untracked presence SHALL follow the rules below.

#### Scenario: Change Overview summarizes a workspace's changes
- **WHEN** Change Overview is displayed, whether or not repository and changed-files data are available
- **THEN** the sidebar MUST NOT list raw mechanical statistics such as changed-file count, touched-line count, diff-hunk count, or directory spread
- **AND** the pane MUST NOT render a review-burden score, level, meter, or score explanation; no such concepts exist
- **AND** when the workspace contains at least one untracked entry, the pane MUST render a count-free categorical presence indicator answering the workspace-state question "are there untracked files at all?" over the changed-files list
- **AND** no untracked entries MUST mean no such indicator is rendered

#### Scenario: Git-backed change has repository data
- **WHEN** the browser receives repository metadata and a computed changed-files context
- **THEN** the `Change Overview` pane shows the branch or detached commit, dirty status, and compare anchor
- **AND** the pane does not show raw mechanical statistics such as `Changed files`, `Touched lines`, `Diff hunks`, or `Directory spread`
- **AND** the pane renders no score, level pill, or meter

#### Scenario: Watch root has no git repository
- **WHEN** the browser receives a non-git repository state for the watched root
- **THEN** the `Change Overview` pane states that no git repository is available
- **AND** the document preview and `Files` pane remain usable

#### Scenario: Configuration warnings are surfaced
- **WHEN** `.uatu.json` parsing produces a warning such as an invalid value
- **THEN** the `Change Overview` pane displays that warning
- **AND** the pane still renders the available repository data

#### Scenario: Untracked categorical indicator appears when untracked files are present
- **WHEN** the changed-files list received by the browser contains at least one entry with the untracked status
- **THEN** the `Change Overview` pane renders a categorical indicator that the change includes untracked files
- **AND** the indicator does not display a count
- **AND** the rest of the pane (branch, commit, dirty status, anchor) renders unchanged

#### Scenario: Untracked categorical indicator is absent when no untracked files are present
- **WHEN** the changed-files list received by the browser contains no entries with the untracked status
- **THEN** the `Change Overview` pane does NOT render the untracked categorical indicator
- **AND** the pane shows no placeholder, empty row, or "0 untracked" affordance for that category

### Requirement: The connection indicator offers a manual reconnect
The connection indicator SHALL offer manual recovery whenever not confirmed live. It MUST support pointer, touch, and keyboard, an action-describing accessible name, and a touch target no smaller than other application touch-mode controls. Confirmed-live indicators MAY be inert. The control MUST communicate an attempt underway and MUST NOT start a second concurrent attempt. Recovery and stopped-session startup follow below.

#### Scenario: Manual reconnect attempts recovery before reload
- **GIVEN** the session is not reported as `Stopped`
- **WHEN** the user activates recovery for a connection not confirmed live
- **THEN** the control SHALL first reconcile authoritative state and re-establish the live channel in place, preserving document, scroll, sidebar selection, and any Chat draft or timeline position
- **AND** if not confirmed live within a bounded period it SHALL reload, since a dead recovery mechanism cannot repair itself in place
- **AND** it MUST communicate an attempt under way and MUST NOT start a second concurrent attempt

#### Scenario: A stopped-session action starts rather than reloads
- **WHEN** the indicator reads `Stopped`
- **THEN** its action SHALL be to start the workspace session through the hub instead of reconnecting, with an accessible name saying so before activation
- **AND** successful start SHALL return to `Connected` in place while preserving document, scroll, sidebar selection, and any Chat draft or timeline position; it MUST NOT reload as part of start
- **AND** the control MUST NOT fall back to reload while stopped, and a recovery already in flight when stopped MUST settle without reload

#### Scenario: The session stops during an existing recovery attempt
- **WHEN** a recovery attempt is already in flight when the session stops
- **THEN** it MUST settle without reloading; the control MUST NOT fall back to reload while the session is stopped

#### Scenario: Hub start is refused or fails to become live promptly
- **WHEN** a stopped-session start request completes
- **THEN** locked-credential refusal SHALL hand off to the hub dashboard unlock flow; other refusals SHALL appear at the indicator with the control still available
- **AND** if accepted but not confirmed live within the bounded period, the indicator SHALL return to `Reconnecting` with its ordinary reconnect action

#### Scenario: Activating the indicator recovers in place
- **WHEN** a user activates the connection indicator while it reads `Reconnecting` and an in-place recovery succeeds
- **THEN** the indicator returns to `Connected` without reloading the page
- **AND** the previewed document, scroll position, and any Chat draft are unchanged

#### Scenario: A dead page falls back to reloading
- **WHEN** a user activates the connection indicator and the connection is still not confirmed live after the bounded attempt window
- **THEN** the page reloads

#### Scenario: Activating a stopped indicator starts the session
- **WHEN** a user activates the connection indicator while it reads `Stopped`
- **THEN** the hub is asked to start the workspace's session and the control shows an attempt under way
- **AND** once the started session's state is applied the indicator reads `Connected`
- **AND** the page did not reload, and the previewed document, scroll position, and any Chat draft are unchanged

#### Scenario: A stopped session never reloads on its own
- **WHEN** a recovery attempt was in flight and the session is stopped before the attempt's window elapses
- **THEN** the page does not reload
- **AND** the indicator reads `Stopped` and offers the start

#### Scenario: A locked start hands off to the dashboard
- **WHEN** a user activates a `Stopped` indicator and the hub refuses because the workspace's credentials are locked
- **THEN** the page navigates to the hub dashboard, where the credential-aware start flow collects the passphrase

#### Scenario: A failed start stays actionable
- **WHEN** a user activates a `Stopped` indicator and the hub refuses for another reason
- **THEN** the refusal's message is shown at the indicator
- **AND** the indicator still reads `Stopped` and can be activated again

#### Scenario: The control is reachable without a browser
- **WHEN** the application runs in standalone display mode with no browser reload or pull-to-refresh available
- **THEN** the connection indicator is operable by touch and exposes an accessible name describing the reconnect action

#### Scenario: Repeated activation does not pile up attempts
- **WHEN** a user activates the reconnect control repeatedly while an attempt is in flight
- **THEN** the attempt already running continues and no second concurrent attempt is started
- **AND** the control shows that an attempt is under way
