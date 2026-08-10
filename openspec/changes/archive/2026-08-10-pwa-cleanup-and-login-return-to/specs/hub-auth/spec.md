## MODIFIED Requirements

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
