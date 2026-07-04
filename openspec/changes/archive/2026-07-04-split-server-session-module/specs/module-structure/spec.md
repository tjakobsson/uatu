## MODIFIED Requirements

### Requirement: The HTTP route table is declared in exactly one place

The set of HTTP routes served by uatu SHALL be declared in exactly one source file (`src/server/routes.ts`), through a single `buildRoutes` function. Production (`src/cli.ts`) and the E2E harness (`tests/e2e/server.ts`) SHALL both obtain their routes by calling `buildRoutes` and SHALL NOT redeclare individual route paths inline. Request paths that cannot be served from Bun's static route table — the `/api/terminal` WebSocket upgrade, `/api/auth` (GET and POST), and the `/api/terminal/sessions` inventory — SHALL be handled by a single shared fetch-fallback builder (`buildFetchFallback(deps)`) declared alongside `buildRoutes` in `src/server/`. Production and the E2E harness SHALL both obtain their `fetch` handler from this builder and SHALL NOT reimplement the terminal-upgrade, auth, or sessions handling inline.

#### Scenario: Route literals are not duplicated across server entry points
- **WHEN** the codebase is searched for production API route literals such as `"/api/state"`, `"/api/document"`, `"/api/events"`, `"/api/scope"`, and `"/api/document/diff"`
- **THEN** each route literal appears as a top-level route-table key in `src/server/routes.ts` only
- **AND** `src/cli.ts` does not redeclare these route literals as `Bun.serve` route keys
- **AND** `tests/e2e/server.ts` does not redeclare these route literals as `Bun.serve` route keys

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

### Requirement: The server core is decomposed into cohesive modules

The server-side building blocks SHALL be split into modules with one responsibility each; no single module under `src/server/` SHALL combine CLI parsing, filesystem scanning, render dispatch, static-file security, HTTP navigation, and the live-reload engine. Specifically: CLI argument parsing, usage/version text, and TTY startup output SHALL live in a `src/cli/` domain folder (the `src/cli.ts` entrypoint remains at the `src/` root and imports from it); the live-reload engine, root resolution/scanning, document render dispatch, static-file resolution, and SPA navigation handling SHALL each live in their own module under `src/server/`. The former god-file `src/server/session.ts` SHALL NOT exist. Unit tests SHALL move with their subjects as colocated siblings.

#### Scenario: The god-file is gone
- **WHEN** the repository is inspected after the change
- **THEN** `src/server/session.ts` does not exist
- **AND** no module under `src/server/` exceeds roughly one responsibility (live-reload engine, roots/scanning, render dispatch, static files, navigation are separate files)

#### Scenario: CLI parsing lives in the CLI domain
- **WHEN** the codebase is searched for the declarations of `parseCommand` and `usageText`
- **THEN** they are found under `src/cli/`, not under `src/server/`
- **AND** `src/cli.ts` imports them from `src/cli/`

#### Scenario: The decomposition is behavior-neutral
- **WHEN** the full unit and E2E suites are run after the split
- **THEN** all tests pass without changes to their assertions (import paths aside)
- **AND** `bun run build` produces a working binary whose `--help`, startup output, and routes are unchanged
