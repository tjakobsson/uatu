## MODIFIED Requirements

### Requirement: Hub-served sessions expose hub navigation
When the SPA is served through a hub (a hub-session-shaped base path AND the hub API answering at the origin root), the sidebar header SHALL show a workspace switcher naming the current workspace by its display name, whose menu links to the hub dashboard and to every registered workspace by display name with running or stopped state and offers a sign-out entry. Duplicate display names SHALL be disambiguated with path or stable-id detail. Ordinary same-tab activation of the current running workspace SHALL dismiss the menu without navigating, changing the current document URL, or interrupting terminal connections. Explicit browser gestures to open that link in another tab or window SHALL retain normal link behavior. The current stopped workspace SHALL retain its Start action and in-place recovery. Outside a hub, including a source-run session child at the default base path or under a bare `--base-path`, the affordance MUST stay hidden. The hub's brand header SHALL show the logo centered with the wordmark beneath it and no tagline.

#### Scenario: Switching workspaces from inside a session
- **WHEN** a user inside a hub-served session opens the workspace switcher
- **THEN** they see the dashboard and sibling workspaces by display name with running or stopped state
- **AND** activating another running workspace navigates to its stable session URL while a stopped workspace offers Start

#### Scenario: Selecting the current running workspace
- **WHEN** the user clicks or keyboard-activates the current running workspace's entry for same-tab navigation
- **THEN** the menu closes and the current page and document URL remain unchanged
- **AND** open terminals retain their panes, connections, and shell processes without showing a takeover action

#### Scenario: Opening the current workspace in another tab
- **WHEN** the user explicitly opens the current running workspace's link in a new tab or window using browser link gestures
- **THEN** the browser opens the workspace there normally
- **AND** the original page and its terminal connections remain intact

#### Scenario: Starting the current stopped workspace
- **WHEN** the current workspace is stopped and the user activates its Start action
- **THEN** the Hub starts that workspace and the current page recovers in place
- **AND** the current-workspace no-navigation behavior does not suppress the Start request

#### Scenario: Duplicate names are distinguishable
- **WHEN** two registered workspaces share one display name
- **THEN** the switcher provides path or stable-id detail that distinguishes them without requiring names to be unique

#### Scenario: No hub affordance outside a hub
- **WHEN** the SPA runs under a source-run session child or under a base path with no hub answering at the origin root
- **THEN** the workspace switcher is not shown
