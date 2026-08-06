# follow-mode Specification

## Purpose

Define the single-mode Follow behavior in the uatu SPA: a sidebar-header chip backed by one boolean of session state (`followEnabled`) and four authoritative rules linking Follow to user selection and file-event-driven selection. Replaces the prior Author / Review Mode distinction with a single mode whose only behavioral toggle is Follow.

## Requirements

### Requirement: Follow toggle exposes a single session-level boolean

The browser UI SHALL expose a Follow toggle that controls one piece of session state — a boolean `followEnabled`. The toggle has two mutually exclusive presentations: the "Follow chip" in the expanded sidebar header, and an icon control in the collapsed sidebar rail. Exactly one presentation is visible at a time (matching the sidebar's collapsed state), and whichever is visible MUST reflect `followEnabled` exactly via its `aria-pressed` attribute: `"true"` when Follow is on, `"false"` when off. Beyond these two presentations there SHALL be no other UI-visible representation of Follow's state. The toggle MUST be reachable by mouse, touch, and keyboard following the existing chip-control conventions in both presentations.

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

The system SHALL implement exactly four behavioral rules linking Follow to selection and file events. No other code path SHALL change `appState.followEnabled` or `appState.selectedDocument` in response to a file event, a tree-row click, or the Follow chip click.

**Rule A (user clicks a tree row):** Selection moves to the clicked document. `followEnabled` MUST be set to `false`. This rule MUST fire only for genuine user-initiated clicks — programmatic / library-driven selection callbacks during mount or refresh MUST NOT trigger it (see "Tree-mount user-click guard" below).

**Rule B (user clicks the Follow chip):** `followEnabled` MUST be flipped. When the flip is `false → true`, the selection MUST jump to the newest-mtime non-binary document in the current session if that document differs from the current selection.

**Rule C (file changes on disk, Follow on):** Selection MUST move to the changed document.

**Rule D (file changes on disk, Follow off):** Selection MUST NOT change. If the changed document equals the current selection, the preview MUST reload its content in place. If the changed document differs from the current selection, no preview reload occurs but the tree MUST still refresh its row set.

#### Scenario: Rule A — clicking a row turns Follow off
- **WHEN** Follow is on and the user clicks `guides/setup.md` in the tree
- **THEN** the selection becomes `guides/setup.md`
- **AND** `followEnabled` becomes `false`
- **AND** the Follow chip's `aria-pressed` attribute reads `"false"`

#### Scenario: Rule B — turning Follow on jumps to the newest changed file
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

#### Scenario: Rule C — file change with Follow on moves the selection
- **WHEN** Follow is on, the selection is `README.md`, and a watcher event reports that `guides/setup.md` changed
- **THEN** the selection moves to `guides/setup.md`
- **AND** the preview renders `guides/setup.md`

#### Scenario: Rule D — file change with Follow off reloads the current document in place
- **WHEN** Follow is off, the selection is `README.md`, and a watcher event reports that `README.md` changed
- **THEN** the selection remains `README.md`
- **AND** the preview reloads `README.md` so the updated content is visible

#### Scenario: Rule D — file change with Follow off for a non-selected document does not switch selection
- **WHEN** Follow is off, the selection is `README.md`, and a watcher event reports that `guides/setup.md` changed
- **THEN** the selection remains `README.md`
- **AND** the preview is NOT reloaded
- **AND** the tree's row set is updated so `guides/setup.md`'s row reflects the change

### Requirement: Tree-mount user-click guard

The `TreeView` wrapper around `@pierre/trees` SHALL distinguish between genuine user-initiated row clicks and library-driven / programmatic selection callbacks. The `onSelectDocument` callback installed on the library MUST only execute Rule A when the callback originates from a real user interaction. Any code path that programmatically tells the tree which row is selected — including the initial mount with a pre-selected document, file-event-driven selection refreshes, route-driven re-selections, and change-overview-driven navigation — MUST set a per-render guard flag that suppresses Rule A's `followEnabled = false` side effect for the duration of that programmatic call.

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

### Requirement: Follow defaults to ON; URL direct links force OFF on boot

The system SHALL restore `followEnabled` from the current user's personal workspace state when the SPA boots at the workspace root. If no saved Follow value exists, it SHALL use the server-provided `initialFollow` value, whose default is `true` and which the CLI `--no-follow` flag sets to `false`. When an explicit document or preview URL is opened, the system MUST set Follow off for that client regardless of saved or server defaults. User changes to Follow SHALL be persisted for future root arrivals but SHALL NOT change Follow in another already-open client.

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
