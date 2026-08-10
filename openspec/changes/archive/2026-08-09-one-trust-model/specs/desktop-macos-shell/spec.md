# desktop-macos-shell — delta

## ADDED Requirements

### Requirement: Launcher presents the hub splash for configured hubs
When a window has no open page, the app SHALL show a splash with the app identity and one card per configured hub. Each card SHALL show the hub's name or host and SHALL reflect live state — reachable with a running-session summary and the hub's version, sign-in required, or unreachable — refreshed while the splash is visible. The splash is for choosing and configuring hubs only: it MUST NOT list individual workspaces or sessions — each hub's own dashboard is the single workspace listing and management surface, so dashboard improvements reach desktop users without native duplication. Activating a card SHALL open that hub's dashboard in the window. When no hub is configured, the splash SHALL present the add-hub flow and SHALL explain that uatu runs as a hub the app connects to (with `uatu hub` named as the way to run one).

#### Scenario: Splash shows hub cards with live state
- **WHEN** the user opens a new window while one hub is signed in and another is unreachable
- **THEN** the splash shows both cards, with a running summary and version for the reachable hub and distinct sign-in/unreachable states for the other
- **AND** no card lists individual workspaces

#### Scenario: Workspaces are reached through the hub dashboard
- **WHEN** the user activates a hub card
- **THEN** the window shows that hub's dashboard
- **AND** activating a workspace there navigates to its session in the same window

#### Scenario: First run explains the model
- **WHEN** the app starts with no configured hubs
- **THEN** the splash presents the add-hub flow and states that the app connects to a running `uatu hub`

### Requirement: Window reflects hub lifecycle states
Each window SHALL present distinct states for: no page open (splash), page opening (progress — connecting to the hub or session starting), page open (web view), and failed (the connection or authentication error, with retry and back-to-splash actions). If the backing hub becomes unavailable while a page is open — it stops answering or the session is revoked — the window MUST transition to the failed state (or the sign-in flow for auth failures) rather than showing a dead web view.

#### Scenario: Hub becomes unreachable
- **WHEN** the network drops while a hub's session page is open
- **THEN** the window transitions to the failed state naming the hub rather than showing a dead web view

#### Scenario: Session start fails
- **WHEN** a workspace session fails to start through the hub
- **THEN** the window shows the failure state with the hub's reported error
- **AND** offers retry and back-to-splash actions

## REMOVED Requirements

### Requirement: Launcher presents the hub splash
**Reason**: Restated as "Launcher presents the hub splash for configured hubs": the "This Mac" card, the native folder picker, and the one-time recents import belonged to the supervised local hub, which no longer exists. Folder adding lives in each hub's dashboard.
**Migration**: Users add hubs (including `http://localhost:<port>` for one on the same machine) through the add-hub flow; folders are added from the hub dashboard.

### Requirement: Window reflects server lifecycle states
**Reason**: Restated as "Window reflects hub lifecycle states": windows no longer distinguish a local-hub failure (with process output and a relaunch path) from a remote one — every hub is external, and failures are connection or authentication errors.
**Migration**: None.

### Requirement: App supervises a single local hub
**Reason**: The desktop is a pure hub client under the single trust model: it no longer bundles a `uatu` binary, spawns or supervises a hub process, parses a URL from stdout, or probes the login-shell environment (the environment concern belonged to app-spawned terminals; hubs users run themselves inherit their own environment).
**Migration**: Users run `uatu hub` themselves (a separate change addresses a background-service install) and add it to the app's hub roster — `http://localhost:<port>` is a valid hub URL.

### Requirement: Opening a non-git folder offers repository initialization
**Reason**: The native folder picker is gone with the supervised local hub; folder registration — including the git-init offer for non-repositories — happens in each hub's dashboard, whose behavior the hub-dashboard capability already specifies.
**Migration**: Add folders from the hub dashboard's directory browser.

### Requirement: Quitting warns when local sessions have live terminal shells
**Reason**: The app owns no hub and therefore no sessions; quitting never stops anything, so there is nothing to warn about.
**Migration**: None — sessions belong to hubs and keep running when the app quits.
