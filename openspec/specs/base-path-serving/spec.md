# base-path-serving Specification

## Purpose

Make a `uatu serve` session relocatable under a configured path prefix: every route, asset, API endpoint, and client-emitted URL carries the base path so a session can be hosted under a prefix (for example behind the hub's reverse proxy at `/s/<id>/`) without breaking live reload, the terminal, the PWA, or document routing — while the default base path `/` preserves today's behavior byte-for-byte.

## Requirements

### Requirement: A serve session is relocatable under a configured base path
`uatu serve` SHALL accept a base path prefix and serve the entire session under it: the HTML shell, static assets, every `/api/*` endpoint (including the SSE event stream and the terminal WebSocket upgrade), the PWA manifest and service worker, and document routes. When a base path is configured, the server SHALL treat requests outside the prefix as not found, and every URL the server or SPA emits — fetches, `EventSource` and WebSocket URLs, pushState document URLs, asset references, anchor targets — SHALL carry the prefix. The base path SHALL reach the SPA via a server-injected boot value in the served HTML, not via client-side inference from `location`.

#### Scenario: API and documents serve under the prefix
- **WHEN** the server runs with base path `/s/uatu/` and a client requests `/s/uatu/api/state`
- **THEN** the state snapshot is returned exactly as `/api/state` returns it at the default base path
- **AND** selecting a document places the browser at `/s/uatu/guides/setup.md`

#### Scenario: Requests outside the prefix are not served
- **WHEN** the server runs with base path `/s/uatu/` and a client requests `/api/state` or `/`
- **THEN** the server responds 404 — including for the root, which must not leak the unrelocated bundle shell

#### Scenario: Live reload and terminal work under the prefix
- **WHEN** the server runs with base path `/s/uatu/` and the SPA is loaded
- **THEN** the SSE connection is established to `/s/uatu/api/events` and file events update the UI
- **AND** a terminal pane connects its WebSocket under `/s/uatu/api/terminal`

#### Scenario: Stylesheet asset references relocate with the page
- **WHEN** the server runs under a base path and serves a bundled stylesheet whose `url()` references (such as the bundled terminal font) were emitted root-absolute
- **THEN** the served stylesheet carries those references under the prefix and the referenced assets load
- **AND** no `url()` reference in a served stylesheet resolves outside the prefix

### Requirement: The default base path preserves current behavior
The base path SHALL default to `/`, and at that default the served URLs, routes, cookies, service-worker scope, and startup output SHALL be byte-for-byte identical to behavior before this capability existed, so local development, the e2e harness, and the desktop wrapper are unaffected.

#### Scenario: Default invocation is unchanged
- **WHEN** `uatu serve <folder>` runs without a base path argument
- **THEN** the session serves at `/` with identical routes and URLs as before this capability

### Requirement: Client URL construction flows through one prefix-aware helper
The SPA SHALL build every server-relative URL through a single shared helper that applies the configured base path, and the unit suite SHALL enforce structurally that no module under `src/` constructs a root-relative `/api`, `/assets`, or service-worker URL from a string literal outside that helper, in the same pattern as the state-ownership scan.

#### Scenario: A bypassing URL literal fails the suite
- **WHEN** a module adds a direct `fetch("/api/...")` call that bypasses the helper
- **THEN** the structural unit test fails naming the offending file

### Requirement: PWA and service worker scope to the base path
The service worker SHALL be registered with a scope equal to the configured base path and the PWA manifest SHALL declare start URL and scope under it, so a session hosted under a prefix does not claim or clobber the scope of its origin's root or of sibling sessions.

#### Scenario: Prefixed session registers a prefixed scope
- **WHEN** the SPA boots under base path `/s/uatu/`
- **THEN** the service worker registration uses scope `/s/uatu/`
- **AND** no registration is attempted for scope `/`
