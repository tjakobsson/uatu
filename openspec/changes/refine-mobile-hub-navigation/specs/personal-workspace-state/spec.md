## MODIFIED Requirements

### Requirement: Open clients remain independently navigable
Personal workspace-state updates SHALL affect future boot/resume decisions and SHALL NOT be broadcast as commands to already-open clients. Concurrent clients MAY persist changes using field-level last-write-wins semantics, but one client's navigation, Follow choice, preview mode, compare target, Files filter, or workspace-local geometry MUST NOT force another open client to adopt it. The only shared client-presentation exception in this change is the new navigation preference set: handle placement, selector auto-hide, and Preview control side can synchronize between tabs of the same Hub origin and browser profile without changing selection, active surface, or workspace-local layout. These preferences MUST NOT synchronize through the personal workspace-state API or across devices.

#### Scenario: Navigation is persisted without moving another client
- **WHEN** the same user has the workspace open on a Mac and in another browser
- **AND** the Mac selects a different document
- **THEN** the browser remains on its current document
- **AND** a later root arrival restores the most recently persisted document

#### Scenario: Partial concurrent writes do not clobber fields
- **WHEN** one client updates the document while another updates the Files filter
- **THEN** both fields retain their latest independently written values

#### Scenario: Shared navigation placement does not command another workspace
- **WHEN** two tabs on the same Hub and browser profile share a changed handle placement
- **THEN** the second tab updates only that navigation preference
- **AND** its document, active surface, Follow state, and workspace geometry remain unchanged

### Requirement: Physical presentation remains client-local
Viewport- and shell-dependent presentation state MUST NOT be authoritative personal Hub state. Sidebar and outline dimensions, terminal width/height/dock, preview split ratios, pane arrangement, zoom, native window state, and native split-browser state SHALL be stored or derived by the current client. Existing browser presentation keys SHALL remain namespaced by workspace/base path so workspaces sharing one Hub origin do not affect one another. macOS-native presentation SHALL remain in native preferences where applicable.

The new navigation placement, auto-hide, and Preview-side preferences SHALL instead have a narrow client-local Hub-origin scope, shared across that Hub's workspaces in the same browser profile. In standalone serve without a confirmed Hub, these preferences SHALL use the existing base-path-local scope. This exception MUST NOT broaden the scope of existing UI-mode, active-tab, pane, attachment, or geometry preferences. Missing, invalid, or unavailable local storage SHALL fall back safely without preventing navigation.

#### Scenario: Different clients retain different geometry
- **WHEN** one user opens the same workspace in a wide macOS Desktop window and a narrow browser
- **THEN** each client uses its own dimensions and responsive layout
- **AND** resizing either client does not modify the other's current or future geometry

#### Scenario: Hub workspaces do not share browser presentation
- **WHEN** one browser changes sidebar or terminal geometry in `/s/alpha/`
- **THEN** opening `/s/beta/` does not inherit alpha's workspace-local geometry

#### Scenario: Navigation preference crosses workspaces on one Hub
- **WHEN** the user moves the handle, selects Keep Open, or changes Preview control side and opens another workspace on the same Hub
- **THEN** the new navigation preferences apply there and survive reload
- **AND** a different Hub origin or browser profile has independent values

## ADDED Requirements

### Requirement: Navigation preference synchronization respects active gestures
Shared navigation preferences SHALL validate their stored values and clamp handle placement to the current client's viewport and safe areas. A storage update from another tab MUST NOT teleport a handle during an active local drag. A completed local placement SHALL commit that user's gesture; a cancelled gesture SHALL leave or restore a committed preference. Production preferences MUST NOT import the design prototype's storage keys or credentials.

#### Scenario: Concurrent placement and drag
- **WHEN** another tab changes the saved placement while the current tab is dragging its handle
- **THEN** the current drag remains under the user's control
- **AND** completion or cancellation resolves to a valid committed placement without triggering navigation

#### Scenario: Prototype data is not production state
- **WHEN** a browser has keys created by the design mockup but no production navigation preferences
- **THEN** the application uses production defaults rather than importing mock workspace identity or configuration
