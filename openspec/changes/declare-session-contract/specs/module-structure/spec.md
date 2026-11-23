## MODIFIED Requirements

### Requirement: src/ is organized into feature folders that mirror the running app

The `src/` tree SHALL use application-region or coherent-domain folders, not technology categories (`hooks/`, `services/`, `utils/`). `shell/`, `preview/`, `sidebar/`, `terminal/` and `server/` SHALL exist and own their regions/subsystems. Document data (including the repository-level git sweep), rendering, ignore policy, watchdog and debug instrumentation SHALL each have their own folder.

#### Scenario: Domain ownership is visible in the source tree
- **WHEN** the checked-out `src/` tree and its module responsibilities are inspected
- **THEN** `shell/`, `preview/`, `sidebar/`, `terminal/` and `server/` each own the corresponding region or subsystem
- **AND** document data, including the repository-level git data sweep, rendering, ignore policy, watchdog and debug instrumentation each occupy their own domain folder rather than technology-category folders
- **AND** the session contract between the Hub and a workspace session occupies `session-contract/`

#### Scenario: Required feature folders exist
- **WHEN** the `src/` directory is listed
- **THEN** it contains `shell/`, `preview/`, `sidebar/`, `terminal/`, `server/`, `document/`, `render/`, `ignore/`, `watchdog/`, `debug/`, `session-contract/`, and `shared/` subdirectories
- **AND** the `src/` root contains only entrypoints (`app.ts`, `cli.ts`), shared HTML/CSS (`index.html`, `styles.css`, `styles.d.ts`), and the `assets/` directory

#### Scenario: New feature code is placed in an existing or new feature folder
- **WHEN** a developer adds a new module that belongs to an existing subsystem
- **THEN** the new file lives inside that subsystem's folder
- **AND** new tech-category folders (such as `hooks/`, `services/`, `utils/`) are not introduced at the `src/` root

### Requirement: The HTTP route table is declared in exactly one place

All HTTP routes SHALL be declared once in `src/server/routes.ts` through `buildRoutes`. Production `src/cli.ts` and E2E `tests/e2e/server.ts` SHALL call it, not redeclare paths. Both SHALL obtain `fetch` from one shared `buildFetchFallback(deps)` alongside it in `src/server/`, not reimplement `/api/terminal` upgrade, `/api/auth` GET/POST or `/api/terminal/sessions` handling inline.

#### Scenario: Both entrypoints use the canonical route builders
- **WHEN** the production and E2E server source is inspected
- **THEN** `src/cli.ts` and `tests/e2e/server.ts` each call `buildRoutes` and `buildFetchFallback(deps)` from `src/server/`
- **AND** the only route-table declaration is `buildRoutes` in `src/server/routes.ts`
- **AND** neither entrypoint redeclares route paths or implements the terminal upgrade, auth GET/POST or terminal-session inventory fallback inline

#### Scenario: Route literals are not duplicated across server entry points
- **WHEN** the codebase is searched for production API route literals such as `"/api/state"`, `"/api/document"`, `"/api/scope"`, and `"/api/document/diff"`
- **THEN** the route table that serves them is assembled once, in `src/server/routes.ts`
- **AND** `src/cli.ts` does not redeclare these route literals as `Bun.serve` route keys
- **AND** `tests/e2e/server.ts` does not redeclare these route literals as `Bun.serve` route keys

#### Scenario: Internal Hub-facing paths come from the session contract
- **WHEN** `src/server/routes.ts` registers a path that the Hub calls, refuses or intercepts, such as `/api/events`, `/api/activity`, `/api/chat/accounts-changed` or `/api/internal/hub-policy-proof`
- **THEN** the route key is built from a constant exported by `src/session-contract/`, not from a string literal
- **AND** the route-coverage test reads the same constants to check that each internal path is an explicit non-public exclusion

#### Scenario: Fetch-fallback handlers are not duplicated across server entry points
- **WHEN** the codebase is searched for the fallback path literals `"/api/terminal"`, `"/api/auth"`, and `"/api/terminal/sessions"`
- **THEN** the request-dispatch logic for these paths lives in `src/server/` only
- **AND** `src/cli.ts` and `tests/e2e/server.ts` each obtain their `fetch` handler by calling the shared builder with mode-specific deps

#### Scenario: Mode-specific routes are scoped by builder option
- **WHEN** `buildRoutes` is called with `{ mode: "prod" }`
- **THEN** the returned route table includes the production-only `/debug/metrics` route
- **AND** it excludes E2E-only routes such as `/__e2e/terminal-token` and `/__e2e/reset`

#### Scenario: E2E builder includes test-only routes
- **WHEN** `buildRoutes` is called with `{ mode: "e2e" }`
- **THEN** the returned route table includes `/__e2e/terminal-token` and `/__e2e/reset`
- **AND** it excludes `/debug/metrics`

## ADDED Requirements

### Requirement: The session contract is a server-only module shared by the Hub and the workspace session

`src/session-contract/` SHALL hold the one declaration of how the Hub starts, verifies, addresses and trusts a workspace session. Hub and session code SHALL import it rather than each other: session code (`src/cli.ts`, `src/cli/`, `src/server/`, `src/terminal/`, `src/chat/`) SHALL NOT import `src/hub/` for any part of that agreement. No module reachable from the browser entry SHALL import the contract.

#### Scenario: Session code does not import the Hub for the contract
- **WHEN** imports in `src/cli.ts`, `src/server/routes.ts` and the rest of the session's serve assembly are inspected
- **THEN** policy bootstrap, policy verification, ready-line formatting and internal path constants come from `src/session-contract/`
- **AND** none of those files imports `src/hub/child-policy.ts`, `src/hub/child-policy-bootstrap.ts` or another `src/hub/` module for them

#### Scenario: The browser bundle never reaches the contract
- **WHEN** the static import graph is walked from the page entry `src/app.ts`
- **THEN** no reachable module imports anything under `src/session-contract/`
- **AND** the existing browser-bundle discipline test fails if one does

#### Scenario: The contract is declared once
- **WHEN** the codebase is searched for the ready-line pattern, the `/s/<id>/` base-path builder, the fd-3 readiness marker or the refused-path set
- **THEN** each is declared in `src/session-contract/` only, and the Hub, the session and the E2E harness import it from there
