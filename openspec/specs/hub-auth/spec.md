# hub-auth Specification

## Purpose

Define the hub's authentication and access-control model: a login gate in front of the dashboard and every proxied session on every interface, server-side session records (one opaque id over cookie and bearer transports, revocable immediately) with configured users and memory-hard password hashes, sign-out as server-side revocation, server-side brokering of child session tokens so users never handle them, CSRF protection on state-changing endpoints, and an explicitly documented trust model (all hub users share the daemon's OS user).
## Requirements
### Requirement: Hub access requires an authenticated user
The hub SHALL authenticate every client before serving the dashboard, any dashboard API, or any proxied session route, on every interface including loopback. Unauthenticated requests SHALL receive the login page (for navigations) or 401 (for API and WebSocket requests) and MUST NOT reach a child session. When a navigation is redirected to the login page, the hub SHALL carry the originally requested path as a return-to parameter, and a successful login SHALL redirect to that path when — and only when — it validates as a same-origin absolute path (begins with a single `/`, carries no scheme or authority); any absent or invalid return-to target SHALL fall back to the dashboard (`/`). The return-to target SHALL survive a failed attempt: every re-render of the login form after an error — invalid credentials, a rate-limited attempt, a malformed request, a cross-origin submission — SHALL carry the same validated target the attempt arrived with, so that a retry after a mistyped password lands where the gate bounced from. The target SHALL be validated on every hop, both when it is rendered into the form and when it is acted on, and an invalid target SHALL be replaced by `/` rather than being echoed back. The hub configuration SHALL define users as a list of entries containing a user name and a password hash produced by a memory-hard algorithm (`Bun.password` defaults); plaintext passwords MUST NOT be stored. A single-entry list SHALL be fully supported as the expected initial configuration. Starting the hub without any configured users SHALL fail with an error that explains how to create the initial user entry.

#### Scenario: Unauthenticated session request is blocked
- **WHEN** a browser without a valid hub session requests `/s/uatu/api/state`
- **THEN** the hub responds 401 without contacting the child

#### Scenario: Loopback is not exempt
- **WHEN** an unauthenticated request arrives from 127.0.0.1
- **THEN** it is gated exactly like a remote request

#### Scenario: Login grants access
- **WHEN** a user submits a configured user name and correct password to the login endpoint
- **THEN** the hub establishes a session and subsequent dashboard and session requests succeed

#### Scenario: Login returns to the requested page
- **WHEN** a signed-out browser navigates to `/s/uatu/`, is redirected to the login page, and signs in successfully
- **THEN** the post-login redirect lands on `/s/uatu/`, not the dashboard

#### Scenario: A wrong password does not lose the requested page
- **WHEN** a signed-out browser is bounced from `/s/uatu/` to the login page, submits a wrong password, and then submits the correct one
- **THEN** the re-rendered form after the failure still carries the `/s/uatu/` target
- **AND** the successful retry redirects to `/s/uatu/`, not the dashboard

#### Scenario: A rate-limited attempt does not lose the requested page
- **WHEN** repeated failures rate-limit a client that was bounced from `/s/uatu/`, and the rate-limit response re-renders the login form
- **THEN** that form still carries the `/s/uatu/` target, so the attempt made once the limit clears returns there

#### Scenario: Malicious return-to target is ignored
- **WHEN** a login succeeds with a return-to value that is not a same-origin absolute path (for example `https://evil.example/`, `//evil.example/`, or a scheme-relative or backslash variant)
- **THEN** the post-login redirect lands on `/`

#### Scenario: Malicious return-to target is not echoed into the error form
- **WHEN** a login fails with a return-to value that is not a same-origin absolute path
- **THEN** the re-rendered login form carries no return-to target rather than the rejected value
- **AND** a subsequent successful login lands on `/`

#### Scenario: Wrong password is rejected and rate-limited
- **WHEN** repeated login attempts fail for a user
- **THEN** each failure is rejected without revealing whether the user exists
- **AND** further attempts are rate-limited, keyed to the requesting client — behind a loopback fronting proxy the trusted hop of the forwarded-address header (the last entry, the one the immediate proxy appended) identifies the client, so one remote attacker cannot exhaust a bucket shared by every user

### Requirement: Users can sign out
The hub SHALL provide a logout action — a POST endpoint guarded by the same-origin check for cookie-authenticated requests — that marks the presented session revoked in the session store and clears the cookie. Revocation SHALL be server-side and immediate: any subsequent request presenting that session id, by cookie or bearer, SHALL be treated as unauthenticated. The dashboard SHALL surface sign-out as a control, and the in-session workspace switcher SHALL offer a sign-out entry. Signing out one session SHALL NOT affect other sessions of the same user.

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

### Requirement: Child session tokens are brokered by the hub and never exposed to users
The hub SHALL capture each child's per-session token when the backend starts the session and SHALL satisfy the child's token expectations server-side during proxying. The token MUST NOT appear in any URL, page, or response the hub sends to a browser, and users MUST NOT need the paste-token flow for hub-proxied sessions.

#### Scenario: Jump-in works without a token in the URL
- **WHEN** an authenticated user opens `/s/uatu/` from the dashboard
- **THEN** the session loads and the terminal authenticates without any token appearing in the browser-visible URL

### Requirement: State-changing hub endpoints are CSRF-protected
Every state-changing hub endpoint (login excepted for the credential POST itself, session start/stop, workspace create/clone/init, session revocation) SHALL require a POST request. For cookie-authenticated requests the hub SHALL verify that the request's `Origin` header, when present, matches the hub's own origin, in addition to the `SameSite=Lax` cookie attribute. Bearer-authenticated requests are exempt from the Origin check: a bearer credential is attached explicitly by the client and cannot be ridden by a cross-site page.

#### Scenario: Cross-origin state change is refused
- **WHEN** a POST to a session-stop endpoint arrives bearing a valid cookie but an `Origin` of another site
- **THEN** the hub responds 403 and no session is stopped

#### Scenario: Bearer request needs no Origin
- **WHEN** a native client POSTs a state-changing request with a valid bearer id and no `Origin` header
- **THEN** the request is accepted

### Requirement: The hub documents its trust model
The self-hosting runbook SHALL state that hub authentication decides who may enter the hub on every interface including loopback, that sign-out is server-side revocation effective for all transports, that all sessions execute as the daemon's OS user, and that no isolation exists between hub users or their sessions in this version — configured users must be people trusted with that OS account.

#### Scenario: Operator can learn the trust boundary before exposing the hub
- **WHEN** an operator reads the self-hosting runbook
- **THEN** they find explicit statements that login is required on every interface, that revocation is server-side, and that hub users share the daemon's OS user with no per-user isolation

### Requirement: Hub sessions are server-side records with one id over two transports
The hub SHALL issue each login as a server-side session record persisted in its state directory: an opaque, unguessable session id mapped to the authenticated user, issue time, and a device label, stored owner-only and written atomically. Browsers SHALL carry the session id in an `HttpOnly; SameSite=Lax` cookie, marked `Secure` whenever the browser-facing connection is HTTPS — the hub terminating TLS itself, or a fronting proxy reporting `X-Forwarded-Proto: https` (the header can only add the attribute, never remove it). Native clients SHALL carry the same kind of session id as an `Authorization: Bearer` credential; both transports resolve through the same store. A presented id that is unknown, revoked, expired past the session max age, or whose user is no longer present in the configuration SHALL be treated as absent. Restarting the hub SHALL NOT invalidate sessions (the store persists); deleting the store SHALL invalidate all sessions. Session ids MUST NOT appear in URLs.

#### Scenario: Unknown session id is treated as unauthenticated
- **WHEN** a request carries a session id that has no record in the store
- **THEN** the hub treats the request as unauthenticated

#### Scenario: Sessions survive a hub restart
- **WHEN** the hub restarts and a browser with a previously issued valid session returns
- **THEN** the session still resolves and no re-login is required

#### Scenario: Proxy-terminated HTTPS marks the cookie Secure
- **WHEN** the hub runs plain-HTTP on loopback behind an HTTPS-terminating proxy that sets `X-Forwarded-Proto: https` and a user signs in
- **THEN** the issued session cookie carries the `Secure` attribute

#### Scenario: Bearer and cookie resolve identically
- **WHEN** a native client presents a session id as `Authorization: Bearer` that a browser could present as its cookie
- **THEN** both are resolved through the same store to the same user, with the same revocation and lifetime checks

#### Scenario: Removed user's sessions die
- **WHEN** a user entry is removed from the configuration and the hub restarts
- **THEN** sessions belonging to that user no longer resolve

### Requirement: Native clients authenticate with the session id as a bearer credential
The login endpoint SHALL accept an `application/json` body (`{name, password}`, with an optional device label) in addition to the form-encoded body, and SHALL succeed for requests that carry no `Origin` header (native HTTP clients). A successful JSON login SHALL set the session cookie and SHALL additionally return the session id in the JSON response body so native clients can store it (e.g. in the macOS Keychain) and present it as `Authorization: Bearer`. Unauthenticated requests to API routes SHALL receive a JSON 401 (never an HTML redirect), so a native client can distinguish "signed out" from other failures.

#### Scenario: JSON login from a native client
- **WHEN** a native client POSTs `{name, password}` as JSON to the login endpoint without an `Origin` header
- **THEN** a valid credential yields the session id in the response body (and cookie) and an invalid one yields 401

#### Scenario: Revoked bearer yields a machine-readable 401
- **WHEN** a native client calls the state API with a revoked or unknown bearer id
- **THEN** the hub responds 401 with a JSON body, not an HTML page or redirect

