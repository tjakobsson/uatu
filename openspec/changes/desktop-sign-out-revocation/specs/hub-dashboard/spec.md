## MODIFIED Requirements

### Requirement: Hub-served sessions expose hub navigation
When the SPA is served through a hub (a hub-session-shaped base path AND the hub API answering at the origin root), the sidebar header SHALL show a workspace switcher naming the current workspace, whose menu links to the hub dashboard and to every registered workspace (running state indicated; stopped workspaces labeled) and offers a sign-out entry when the hub has a login. The sign-out entry SHALL sign out by submitting a same-origin form `POST` to the hub's logout route — a real main-frame navigation, matching how the hub dashboard signs out — so that the act is observable to a native wrapper and does not depend on a background request resolving before the page is replaced. In local mode (`--local`) the sign-out entry SHALL be omitted — no login exists and its routes are absent, so the entry could only lead to a 404; the state API SHALL tell clients the hub is local. Outside a hub — plain `uatu serve`, a bare `--base-path` invocation — the affordance MUST stay hidden. (Desktop wrapper sessions are hub sessions and show the switcher.) The hub's brand header SHALL show the logo centered with the wordmark beneath it and no tagline.

#### Scenario: Switching workspaces from inside a session
- **WHEN** a user inside a hub-served session opens the workspace switcher
- **THEN** they see the hub dashboard link and the other workspaces with running/stopped state
- **AND** activating one navigates to that workspace's session URL

#### Scenario: Signing out from the switcher is a form navigation
- **WHEN** a user activates the switcher's sign-out entry
- **THEN** the browser performs a same-origin form `POST` navigation to the hub's logout route
- **AND** the hub clears the session cookie and the user lands on the login page

#### Scenario: No hub affordance outside a hub
- **WHEN** the SPA runs under plain `uatu serve` (default base path) or under a base path with no hub answering at the origin root
- **THEN** the workspace switcher is not shown

#### Scenario: Local mode has no sign-out entry
- **WHEN** a user opens the workspace switcher in a session served by a `--local` hub
- **THEN** the menu shows the dashboard link and workspaces but no sign-out entry
