# base-path-serving Specification

## Purpose

Make a session child relocatable under a configured path prefix: every route, asset, API endpoint, and client-emitted URL carries the base path so a session can be hosted under a prefix (for example behind the hub's reverse proxy at `/s/<id>/`) without breaking live reload, the terminal, the PWA, or document routing — while the default base path `/` preserves today's behavior byte-for-byte.

## Requirements

### Requirement: A serve session is relocatable under a configured base path
A session child SHALL accept a base path prefix and serve the entire session under it: the HTML shell, static assets, every `/api/*` endpoint including the session SSE event stream and terminal WebSocket upgrade, the PWA manifest, and document routes. When a base path is configured, the server SHALL treat requests outside the prefix as not found, and every session URL the server or SPA emits SHALL carry the prefix. Hub-owned operations are explicit exceptions: the SPA opens its single live stream at the hub origin, and a hub-served page uses hub-owned notification control routes and the hub's push worker. The child's event routes remain prefixed internal routes for the hub to subscribe to. The base path and hub ownership information SHALL reach the SPA through server-provided boot context, without treating an arbitrary path prefix as authorization to register an origin-wide worker.

#### Scenario: API and documents serve under the prefix
- **WHEN** the server runs with base path `/s/uatu/` and a client requests `/s/uatu/api/state`
- **THEN** the state snapshot is returned exactly as `/api/state` returns it at the default base path
- **AND** selecting a document places the browser at `/s/uatu/guides/setup.md`

#### Scenario: Requests outside the prefix are not served
- **WHEN** the server runs with base path `/s/uatu/` and a client requests `/api/state` or `/`
- **THEN** the session child responds 404 without leaking the unrelocated bundle shell

#### Scenario: Live reload and terminal work under the prefix
- **WHEN** the server runs with base path `/s/uatu/` and the SPA is loaded through the hub
- **THEN** the session's internal event route answers at `/s/uatu/api/events`, where the hub subscribes to it, and file events reach the page over the hub's live stream at `/api/hub/live`
- **AND** a terminal pane connects its WebSocket under `/s/uatu/api/terminal`

#### Scenario: Stylesheet asset references relocate with the page
- **WHEN** the server runs under a base path and serves a bundled stylesheet whose `url()` references were emitted root-absolute
- **THEN** the served stylesheet carries those references under the prefix and the referenced assets load
- **AND** no `url()` reference in a served stylesheet resolves outside the prefix

#### Scenario: Notification control belongs to the hub
- **WHEN** a hub-served workspace enrolls for notifications
- **THEN** notification registration and control requests reach the hub's own routes
- **AND** the destination of a conversation notification retains the workspace prefix

### Requirement: The default base path preserves current behavior
The base path SHALL default to `/`, and at that default the served URLs, routes, cookies, service-worker scope, and startup output SHALL be byte-for-byte identical to behavior before this capability existed, so local development, the e2e harness, and the desktop wrapper are unaffected.

#### Scenario: Default invocation is unchanged
- **WHEN** a session child is started with `<folder>` and no `--base-path`
- **THEN** the session serves at `/` with identical routes and URLs as before this capability

### Requirement: Client URL construction flows through one prefix-aware helper
The SPA SHALL build session-relative server URLs through the shared prefix-aware helper and SHALL build hub-owned live, notification-control, and push-worker URLs through an explicit shared hub URL helper. Hub URL construction SHALL require hub-serving context. The unit suite SHALL enforce that modules under `src/` do not bypass these helpers with direct root-relative API, asset, or service-worker URL literals.

#### Scenario: A bypassing URL literal fails the suite
- **WHEN** a module adds a direct `fetch("/api/...")` call that bypasses the shared helpers
- **THEN** the structural unit test fails naming the offending file

#### Scenario: Generic mounting does not gain hub ownership
- **WHEN** a session is mounted under a generic base path without hub-serving context
- **THEN** it does not construct hub notification URLs or attempt origin-wide push-worker registration

### Requirement: PWA and push worker scopes follow serving ownership
A generic base-path session SHALL keep its manifest start URL, scope, and icons under the configured prefix and SHALL NOT register an origin-wide worker. A hub-served session SHALL keep its manifest start URL and icons under the workspace prefix while declaring origin scope so navigation to the dashboard, login, and sibling workspaces stays in the installed app. The hub SHALL own a single origin-scoped push-worker registration per browser registration context, shared by its dashboard and workspace pages, rather than registering a separate push worker per session. A standalone session outside a hub SHALL NOT offer hub-backed push enrollment.

#### Scenario: Generic prefixed session stays contained
- **WHEN** the SPA boots under a generic base path `/docs/` outside a hub
- **THEN** its manifest stays scoped to `/docs/`
- **AND** no push-worker registration is attempted for scope `/`

#### Scenario: Sibling workspaces share the hub worker
- **WHEN** a user enrolls from `/s/one/` and later opens `/s/two/` in the same hub browser context
- **THEN** both pages use the same hub push-worker registration
- **AND** changing the workspace does not create duplicate push subscriptions
