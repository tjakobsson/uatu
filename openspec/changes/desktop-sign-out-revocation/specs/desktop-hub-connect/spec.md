## ADDED Requirements

### Requirement: Signing out inside a web view revokes the desktop's hub credentials
The app SHALL observe a sign-out performed inside a web view against a configured remote hub and treat it as revocation of that hub's stored credentials. Detection MUST NOT depend on the remote hub's version: the app SHALL treat both a main-frame `POST` navigation to the hub's logout route and the disappearance of the hub session cookie from the web view's cookie store for a configured hub host as a sign-out. A navigation signal SHALL be honored only when it is a main-frame navigation whose origin is the hub that window is displaying — a page may post a form to any origin, and the hub refuses such cross-origin logouts, so acting on one would revoke credentials for a hub that remains signed in. On detecting a sign-out, the app SHALL delete both the hub's Keychain password and its Keychain session cookie, remove the hub session cookie from the web view's cookie store, and mark the hub signed out immediately rather than at the next poll. Revocation SHALL be idempotent, so multiple signals for one sign-out have the effect of one, and the app's own cookie clearing MUST NOT be re-read as a further sign-out. The local hub is exempt: it has no login and no sign-out entry.

#### Scenario: Sign-out from the hub dashboard revokes credentials
- **WHEN** a user signs out from a remote hub's dashboard inside the app
- **THEN** the hub's Keychain password and session cookie are both deleted
- **AND** the hub session cookie is removed from the web view's cookie store

#### Scenario: Sign-out from the in-session switcher revokes credentials
- **WHEN** a user signs out from the workspace switcher inside a remote hub session
- **THEN** the same revocation occurs as from the dashboard

#### Scenario: Sign-out on an older hub is still detected
- **WHEN** the remote hub is old enough that its switcher signs out without a form navigation
- **THEN** the cleared hub session cookie is still observed and the credentials are still revoked

#### Scenario: A page cannot sign the app out of a different hub
- **WHEN** a page in a window showing one configured hub posts a logout form to a different configured hub's origin, or does so from a subframe
- **THEN** no credentials are revoked, because the signal is not a main-frame navigation to the hub that window is displaying

#### Scenario: Re-authenticating immediately after signing out survives
- **WHEN** the user signs back in to a hub before the store change caused by the app's own cookie clearing has been observed
- **THEN** the freshly stored credentials are kept, because the app does not read its own clearing as a new sign-out

#### Scenario: Work in flight during sign-out cannot resurrect the hub
- **WHEN** a state probe or a silent re-login for a hub is already in flight at the moment the user signs out of it
- **THEN** its result is discarded rather than published as hub state
- **AND** a cookie it obtained is not written to the Keychain, so revocation is not undone by a request that started before it

#### Scenario: Revocation survives a restart
- **WHEN** the user signs out of a remote hub and then quits and relaunches the app
- **THEN** the hub's card shows sign-in required and no session is restored

### Requirement: A revoked hub cannot be re-entered without an explicit sign-in
The app SHALL NOT re-authenticate to a hub whose credentials were revoked until the user signs in again through the native sign-in sheet. Because silent re-login is driven by the stored password, revocation removing that password SHALL be the durable latch — the app MUST NOT retain a re-usable credential for a signed-out hub anywhere. A successful native sign-in SHALL store both secrets again and restore normal probing and silent re-login for that hub.

#### Scenario: No silent re-login after sign-out
- **WHEN** the app probes a hub whose credentials were revoked
- **THEN** the probe reports signed out and the app performs no login attempt of its own

#### Scenario: Native sign-in restores the hub
- **WHEN** the user signs in to a revoked hub from its splash card
- **THEN** the hub reconnects and later expired cookies again recover silently

### Requirement: A window whose hub session ends returns to the native splash
When a web view showing a remote hub navigates to that hub's login page, the app SHALL return that window to the native splash instead of leaving the hub's web login page on screen. When a hub's credentials are revoked, every window showing that hub SHALL return to the splash, not only the window where the sign-out happened. The app SHALL NOT automatically present the native sign-in sheet; the hub's splash card carries the sign-in affordance.

#### Scenario: Sign-out does not strand the window
- **WHEN** a user signs out of a remote hub inside the app
- **THEN** that window shows the native splash rather than the hub's web login page

#### Scenario: Other windows on the same hub also return
- **WHEN** two windows show the same remote hub and the user signs out in one
- **THEN** both windows return to the splash and the hub's card shows sign-in required

#### Scenario: An ended session surfaces natively
- **WHEN** a web view lands on a hub's login page because the session ended rather than by a sign-out
- **THEN** the window returns to the splash and the hub's state is decided by the next probe

## MODIFIED Requirements

### Requirement: The native layer owns hub authentication and injects it into web views
The app SHALL authenticate to remote hubs natively — a JSON login request without an `Origin` header — and SHALL hold the resulting hub session cookie as the single source of truth. Before any web view navigates to a hub origin, the app SHALL write the current cookie into the web view's cookie store, scoped to that hub's origin. Native API calls (state polling, session start) SHALL use the same cookie. When either surface receives a 401, the app SHALL re-run authentication rather than trusting either cookie copy: at most one silent re-login with the Keychain password per signed-out transition (respecting the hub's login rate limit), then a sign-in prompt. Silent re-login SHALL apply only to a hub the user has not signed out of; a hub whose credentials were revoked has no stored password to re-login with and stays signed out until the user signs in again. TLS validation SHALL use system trust; certificate exceptions are not offered.

#### Scenario: Opening a remote session is seamless when signed in
- **WHEN** the user opens a workspace on a signed-in remote hub
- **THEN** the web view loads the session without showing the hub's login page

#### Scenario: Expired cookie recovers silently
- **WHEN** a hub's cookie has expired and its password is in the Keychain
- **THEN** the app re-logs-in once, updates both cookie copies, and the requested page loads without user action

#### Scenario: Silent re-login failure prompts once
- **WHEN** silent re-login is rejected (password changed hub-side)
- **THEN** the hub's card shows sign-in required and the app does not retry on its own

#### Scenario: Sign-out is not treated as an expired cookie
- **WHEN** the user has signed out of a hub and the app next probes it
- **THEN** the app reports signed out without attempting the silent re-login that an expired cookie would get

#### Scenario: Untrusted certificate is a hard error
- **WHEN** a hub presents a certificate the system does not trust
- **THEN** the connection fails with an error explaining the certificate problem, with no bypass offered
