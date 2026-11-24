## MODIFIED Requirements

### Requirement: Users can sign out

Sign-out SHALL revoke only the presented server-side session immediately across cookie and bearer transports, clear its cookie, and remain available on the Hub's own pages (the dashboard, Settings and its device sessions) through a protected POST. The in-session workspace switcher does not offer it; from a workspace it is one step away through the switcher's Hub dashboard or Settings link.

#### Scenario: A user signs out from the dashboard or in-session workspace switcher
- **WHEN** a user signs out from the dashboard or Settings
- **THEN** The hub SHALL provide a logout action — a POST endpoint guarded by the same-origin check for cookie-authenticated requests — that marks the presented session revoked in the session store and clears the cookie.
- **AND** Revocation SHALL be server-side and immediate: any subsequent request presenting that session id, by cookie or bearer, SHALL be treated as unauthenticated.
- **AND** The dashboard and Settings SHALL surface sign-out as a control; the in-session workspace switcher SHALL link to them instead of offering its own entry.
- **AND** Signing out one session SHALL NOT affect other sessions of the same user.

#### Scenario: Signing out re-gates the hub
- **WHEN** an authenticated user activates sign out
- **THEN** the session is marked revoked, the response clears the session cookie, and the user lands on the login page
- **AND** subsequent requests presenting the revoked id are rejected by the gate

#### Scenario: Revocation reaches every transport
- **WHEN** a native client holds the same session id that a browser just signed out
- **THEN** the native client's next request receives 401

#### Scenario: Cross-origin logout is refused
- **WHEN** a POST to the logout endpoint arrives with an `Origin` of another site
- **THEN** the hub rejects it and the session is not revoked
