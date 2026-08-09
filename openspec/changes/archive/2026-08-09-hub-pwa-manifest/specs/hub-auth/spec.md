# hub-auth — delta

## MODIFIED Requirements

### Requirement: Hub access requires an authenticated user
Outside local mode, the hub SHALL authenticate browsers before serving the dashboard, any dashboard API, or any proxied session route. Unauthenticated requests SHALL receive the login page (for navigations) or 401 (for API and WebSocket requests) and MUST NOT reach a child session. When a navigation is redirected to the login page, the hub SHALL carry the originally requested path as a return-to parameter, and a successful login SHALL redirect to that path when — and only when — it validates as a same-origin absolute path (begins with a single `/`, carries no scheme or authority); any absent or invalid return-to target SHALL fall back to the dashboard (`/`). The hub configuration SHALL define users as a list of entries containing a user name and a password hash produced by a memory-hard algorithm (`Bun.password` defaults); plaintext passwords MUST NOT be stored. A single-entry list SHALL be fully supported as the expected initial configuration. In local mode (`--local`, loopback-only) this requirement is replaced by the local-mode requirement below.

#### Scenario: Unauthenticated session request is blocked
- **WHEN** a browser without a valid hub session cookie requests `/s/uatu/api/state` on a non-local hub
- **THEN** the hub responds 401 without contacting the child

#### Scenario: Login grants access
- **WHEN** a user submits a configured user name and correct password to the login endpoint
- **THEN** the hub sets its session cookie and subsequent dashboard and session requests succeed

#### Scenario: Login returns to the requested page
- **WHEN** a signed-out browser navigates to `/s/uatu/`, is redirected to the login page, and signs in successfully
- **THEN** the post-login redirect lands on `/s/uatu/`, not the dashboard

#### Scenario: Malicious return-to target is ignored
- **WHEN** a login succeeds with a return-to value that is not a same-origin absolute path (for example `https://evil.example/`, `//evil.example/`, or a scheme-relative or backslash variant)
- **THEN** the post-login redirect lands on `/`

#### Scenario: Wrong password is rejected and rate-limited
- **WHEN** repeated login attempts fail for a user
- **THEN** each failure is rejected without revealing whether the user exists
- **AND** further attempts are rate-limited, keyed to the requesting client — behind a loopback fronting proxy the trusted hop of the forwarded-address header (the last entry, the one the immediate proxy appended) identifies the client, so one remote attacker cannot exhaust a bucket shared by every user
