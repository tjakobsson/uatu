# desktop-hub-connect Specification

## Purpose

Define how UatuCode Desktop connects to uatu hubs beyond the bundled local one: a persisted roster of remote hubs with Keychain-held credentials, native ownership of hub authentication with cookie injection into web views, per-hub state probing that drives the splash cards, and a clear distinction between app-lifetime local sessions and hub-lifetime remote sessions.
## Requirements
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

### Requirement: Remote hub state is probed and reflected per hub
For each configured hub the app SHALL derive one of three states from an authenticated state-API call: connected (with a running-session summary and the hub's version), signed out (401), or unreachable (network failure). The splash SHALL poll only while visible, at a modest fixed cadence, and a state transition SHALL update the card without user action. The summary is status decoration only — workspace listing and navigation belong to the hub's dashboard.

#### Scenario: Hub coming online is picked up by the splash
- **WHEN** an unreachable hub becomes reachable while the splash is visible
- **THEN** its card transitions to connected with its running summary and version within one poll interval

#### Scenario: Probing stops off-splash
- **WHEN** no window is showing the splash
- **THEN** the app performs no periodic hub state requests

### Requirement: The native layer holds the hub session id and injects it into web views
The app SHALL authenticate to hubs natively — a JSON login request without an `Origin` header — and SHALL hold the returned session id as the single credential, stored only in the macOS Keychain. Native API calls SHALL present it as `Authorization: Bearer`. Before any web view navigates to a hub origin, the app SHALL write the session id into the web view's cookie store as the hub session cookie, scoped to that hub's origin, so web and native surfaces share one server-side session. When either surface receives a 401, the session is dead server-side: the app SHALL attempt at most one silent re-login with the Keychain password per signed-out transition (respecting the hub's login rate limit), then present a sign-in prompt. Observing a sign-out navigation in a web view SHALL cause the app to discard the session id and stored password for that hub — the hub's server-side revocation makes further client-side verification unnecessary. TLS validation SHALL use system trust; certificate exceptions are not offered.

#### Scenario: Opening a session is seamless when signed in
- **WHEN** the user opens a workspace on a signed-in hub
- **THEN** the web view loads the session without showing the hub's login page

#### Scenario: Revoked session recovers or prompts
- **WHEN** a hub responds 401 because the session was revoked and the password is in the Keychain
- **THEN** the app re-logs-in once, obtains a fresh session id, updates the web view cookie, and the requested page loads
- **AND** if the re-login is rejected, the hub's card shows sign-in required and the app does not retry on its own

#### Scenario: Sign-out in a web view revokes and forgets
- **WHEN** the user signs out inside a hub's web view
- **THEN** the hub revokes the session server-side and the app deletes its Keychain session id and password for that hub
- **AND** every window showing that hub returns to the splash

#### Scenario: Untrusted certificate is a hard error
- **WHEN** a hub presents a certificate the system does not trust
- **THEN** the connection fails with an error explaining the certificate problem, with no bypass offered

