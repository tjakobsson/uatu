# desktop-hub-connect — delta

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: The native layer owns hub authentication and injects it into web views
**Reason**: Restated as "The native layer holds the hub session id and injects it into web views": the credential is now the server-side session id presented as a bearer token, revocation is the hub's job, and the client-side revocation guards that compensated for a stateless cookie are deleted.
**Migration**: Every desktop user signs in once more; the fresh session id replaces the stored cookie value in the Keychain.

### Requirement: Local and remote session lifetimes are visibly distinct
**Reason**: The app no longer runs a local hub, so there is no app-bound session lifetime to distinguish: every hub is external and its sessions outlive the app unconditionally. Quit warnings about app-owned sessions have no subject.
**Migration**: None — quitting the app never affects any session.
