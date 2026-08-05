# desktop-hub-connect — new capability

## ADDED Requirements

### Requirement: Users can manage a roster of remote hubs
The app SHALL let users add, rename, and remove remote hubs. Adding a hub takes a URL, user name, and password, and SHALL verify them with a login attempt before saving; failures SHALL distinguish unreachable-host from rejected-credentials. Roster entries (identifier, display name, URL, user name) SHALL persist across app restarts; passwords and session cookies MUST be stored only in the macOS Keychain, never in preferences or on disk in plaintext. Removing a hub SHALL delete its Keychain items. Remote hub URLs MUST be HTTPS; plain HTTP SHALL be accepted only for loopback addresses.

#### Scenario: Adding a hub verifies credentials
- **WHEN** the user adds a hub with a valid URL and correct credentials
- **THEN** the app performs a login, stores the entry with its secrets in the Keychain, and the hub appears on the splash

#### Scenario: Bad credentials are distinguished from a bad host
- **WHEN** adding a hub fails
- **THEN** the error tells the user whether the host could not be reached or the credentials were rejected

#### Scenario: Removing a hub removes its secrets
- **WHEN** the user removes a configured hub
- **THEN** its card disappears from the splash and its Keychain items are deleted

#### Scenario: Non-loopback HTTP is refused
- **WHEN** the user enters an `http://` URL for a non-loopback host
- **THEN** the app refuses it, explaining that remote hubs require HTTPS

### Requirement: The native layer owns hub authentication and injects it into web views
The app SHALL authenticate to remote hubs natively — a JSON login request without an `Origin` header — and SHALL hold the resulting hub session cookie as the single source of truth. Before any web view navigates to a hub origin, the app SHALL write the current cookie into the web view's cookie store, scoped to that hub's origin. Native API calls (state polling, session start) SHALL use the same cookie. When either surface receives a 401, the app SHALL re-run authentication rather than trusting either cookie copy: at most one silent re-login with the Keychain password per signed-out transition (respecting the hub's login rate limit), then a sign-in prompt. TLS validation SHALL use system trust; certificate exceptions are not offered.

#### Scenario: Opening a remote session is seamless when signed in
- **WHEN** the user opens a workspace on a signed-in remote hub
- **THEN** the web view loads the session without showing the hub's login page

#### Scenario: Expired cookie recovers silently
- **WHEN** a hub's cookie has expired and its password is in the Keychain
- **THEN** the app re-logs-in once, updates both cookie copies, and the requested page loads without user action

#### Scenario: Silent re-login failure prompts once
- **WHEN** silent re-login is rejected (password changed hub-side)
- **THEN** the hub's card shows sign-in required and the app does not retry on its own

#### Scenario: Untrusted certificate is a hard error
- **WHEN** a hub presents a certificate the system does not trust
- **THEN** the connection fails with an error explaining the certificate problem, with no bypass offered

### Requirement: Remote hub state is probed and reflected per hub
For each configured hub the app SHALL derive one of three states from an authenticated state-API call: connected (with a running-session summary and the hub's version), signed out (401), or unreachable (network failure). The splash SHALL poll only while visible, at a modest fixed cadence, and a state transition SHALL update the card without user action. The summary is status decoration only — workspace listing and navigation belong to the hub's dashboard.

#### Scenario: Hub coming online is picked up by the splash
- **WHEN** an unreachable hub becomes reachable while the splash is visible
- **THEN** its card transitions to connected with its running summary and version within one poll interval

#### Scenario: Probing stops off-splash
- **WHEN** no window is showing the splash
- **THEN** the app performs no periodic hub state requests

### Requirement: Local and remote session lifetimes are visibly distinct
The app SHALL communicate that local sessions live only while the app runs and remote sessions do not: the local hub's splash card SHALL carry a caption to that effect, and the quit confirmation (per desktop-macos-shell) SHALL state that remote sessions are unaffected. Remote hubs MUST NOT be included in quit warnings — quitting the app never stops remote sessions.

#### Scenario: Quit ignores remote sessions
- **WHEN** the user quits while remote hub sessions with live shells are open in tabs but no local session has shells
- **THEN** the app quits without a warning and the remote sessions keep running on their hubs
