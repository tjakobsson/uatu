# hub-auth — delta for unify-desktop-on-hub

## MODIFIED Requirements

### Requirement: Hub access requires an authenticated user
Outside local mode, the hub SHALL authenticate browsers before serving the dashboard, any dashboard API, or any proxied session route. Unauthenticated requests SHALL receive the login page (for navigations) or 401 (for API and WebSocket requests) and MUST NOT reach a child session. The hub configuration SHALL define users as a list of entries containing a user name and a password hash produced by a memory-hard algorithm (`Bun.password` defaults); plaintext passwords MUST NOT be stored. A single-entry list SHALL be fully supported as the expected initial configuration. In local mode (`--local`, loopback-only) this requirement is replaced by the local-mode requirement below.

#### Scenario: Unauthenticated session request is blocked
- **WHEN** a browser without a valid hub session cookie requests `/s/uatu/api/state` on a non-local hub
- **THEN** the hub responds 401 without contacting the child

#### Scenario: Login grants access
- **WHEN** a user submits a configured user name and correct password to the login endpoint
- **THEN** the hub sets its session cookie and subsequent dashboard and session requests succeed

#### Scenario: Wrong password is rejected and rate-limited
- **WHEN** repeated login attempts fail for a user
- **THEN** each failure is rejected without revealing whether the user exists
- **AND** further attempts are rate-limited, keyed to the requesting client — behind a loopback fronting proxy the trusted hop of the forwarded-address header (the last entry, the one the immediate proxy appended) identifies the client, so one remote attacker cannot exhaust a bucket shared by every user

## ADDED Requirements

### Requirement: Local mode bypasses authentication on loopback
When the hub runs in local mode it SHALL treat every request as an implicit authenticated local identity: no session cookie is issued or checked, the login and logout routes SHALL NOT be served (404), and login rate limiting is inert. Local mode SHALL be usable only with a loopback bind (enforced at startup per hub-service); the trust model is the same as `uatu serve`'s loopback sessions — any process that can reach loopback already owns the account. Non-local hubs MUST be entirely unaffected: the presence of the local-mode code path MUST NOT weaken the gate when `--local` is not set.

#### Scenario: Local mode serves without credentials
- **WHEN** a request without any cookie reaches a `--local` hub's dashboard, state API, or a proxied session route
- **THEN** it is served as the implicit local user

#### Scenario: Login routes are absent in local mode
- **WHEN** a request targets `/login` or `/logout` on a `--local` hub
- **THEN** the hub responds 404

#### Scenario: A configured hub still gates every route
- **WHEN** a hub starts from a configuration file without `--local`
- **THEN** unauthenticated requests are rejected exactly as before local mode existed

### Requirement: Native clients can authenticate without a browser
The login endpoint SHALL accept an `application/json` body (`{name, password}`) in addition to the form-encoded body, and SHALL succeed for requests that carry no `Origin` header (native HTTP clients), issuing the same signed session cookie in both cases. Unauthenticated requests to API routes SHALL receive a JSON 401 (never an HTML redirect), so a native client can distinguish "signed out" from other failures. These behaviors exist today; this requirement pins them as a compatibility contract for the desktop hub client.

#### Scenario: JSON login from a native client
- **WHEN** a native client POSTs `{name, password}` as JSON to the login endpoint without an `Origin` header
- **THEN** a valid credential yields the session cookie and an invalid one yields 401

#### Scenario: Expired cookie yields a machine-readable 401
- **WHEN** a native client calls the state API with an expired or missing cookie
- **THEN** the hub responds 401 with a JSON body, not an HTML page or redirect
