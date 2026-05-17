# module-structure Specification

## Purpose

Define how the uatu codebase is physically organized so that contributors — human and AI — can locate each subsystem without grepping, and so the structural decisions that keep `src/app.ts` from regrowing into a 4000-line monolith remain enforceable across future changes. This capability is structural rather than behavioral: it constrains *where* code lives, *how many places* declare a given thing, and *how* the source tree is documented. It does not pin any user-visible behavior.

## Requirements

### Requirement: src/ is organized into feature folders that mirror the running app

The `src/` directory SHALL be organized into top-level folders named after regions of the running application or coherent domains, not after tech categories (`hooks/`, `services/`, `utils/`). The folders `shell/`, `preview/`, `sidebar/`, `terminal/`, and `server/` SHALL exist and own the code for their respective UI regions or subsystems. Cross-cutting domains (document data, rendering, review data, ignore policy, watchdog, debug instrumentation) SHALL each have their own folder.

#### Scenario: Required feature folders exist
- **WHEN** the `src/` directory is listed
- **THEN** it contains `shell/`, `preview/`, `sidebar/`, `terminal/`, `server/`, `document/`, `render/`, `review/`, `ignore/`, `watchdog/`, `debug/`, and `shared/` subdirectories
- **AND** the `src/` root contains only entrypoints (`app.ts`, `cli.ts`), shared HTML/CSS (`index.html`, `styles.css`, `styles.d.ts`), and the `assets/` directory

#### Scenario: New feature code is placed in an existing or new feature folder
- **WHEN** a developer adds a new module that belongs to an existing subsystem
- **THEN** the new file lives inside that subsystem's folder
- **AND** new tech-category folders (such as `hooks/`, `services/`, `utils/`) are not introduced at the `src/` root

### Requirement: app.ts is a thin entrypoint

The `src/app.ts` file SHALL function as a thin wire-up entrypoint that imports from `shell/`, `preview/`, `sidebar/`, and `terminal/` and mounts the application. It SHALL NOT contain feature-domain rendering logic, state singletons, route handlers, history routing, or DOM event handlers for individual UI regions. As a soft target, `src/app.ts` SHALL be no longer than 200 lines.

#### Scenario: app.ts contains no buried feature logic
- **WHEN** `src/app.ts` is opened
- **THEN** it consists primarily of imports and a mount sequence
- **AND** it does not define functions such as `renderSidebar`, `renderChangeOverview`, `renderGitLog`, `buildScoreExplanationHTML`, `setupTerminalPanel`, `connectEvents`, or `loadInitialState` (these live in their feature folders)

#### Scenario: app.ts stays under the soft size target
- **WHEN** the line count of `src/app.ts` is measured
- **THEN** it is at most 200 lines

### Requirement: The HTTP route table is declared in exactly one place

The set of HTTP routes served by uatu SHALL be declared in exactly one source file (`src/server/routes.ts`), through a single `buildRoutes` function. Production (`src/cli.ts`) and the E2E harness (`tests/e2e/server.ts`) SHALL both obtain their routes by calling `buildRoutes` and SHALL NOT redeclare individual route paths inline.

#### Scenario: Route literals are not duplicated across server entry points
- **WHEN** the codebase is searched for production API route literals such as `"/api/state"`, `"/api/document"`, `"/api/events"`, `"/api/scope"`, and `"/api/document/diff"`
- **THEN** each route literal appears as a top-level route-table key in `src/server/routes.ts` only
- **AND** `src/cli.ts` does not redeclare these route literals as `Bun.serve` route keys
- **AND** `tests/e2e/server.ts` does not redeclare these route literals as `Bun.serve` route keys

#### Scenario: Mode-specific routes are scoped by builder option
- **WHEN** `buildRoutes` is called with `{ mode: "prod" }`
- **THEN** the returned route table includes the production-only `/debug/metrics` route
- **AND** it excludes E2E-only routes such as `/__e2e/terminal-token` and `/__e2e/reset`

#### Scenario: E2E builder includes test-only routes
- **WHEN** `buildRoutes` is called with `{ mode: "e2e" }`
- **THEN** the returned route table includes `/__e2e/terminal-token` and `/__e2e/reset`
- **AND** it excludes `/debug/metrics`

### Requirement: src/ contains shipped product code only

The `src/` directory SHALL contain only code that is part of the shipped application. Test harnesses, fixture orchestration, and tooling that exists exclusively to support testing SHALL live under `tests/` (or `scripts/` when appropriate), never under `src/`.

#### Scenario: E2E harness lives with the tests it serves
- **WHEN** the repository is inspected after the change is applied
- **THEN** `tests/e2e/server.ts` and `tests/e2e/config.ts` exist
- **AND** `src/e2e-server.ts` and `src/e2e.ts` do not exist
- **AND** `playwright.config.ts` references `tests/e2e/server.ts` as its `webServer.command`

#### Scenario: src/ imports do not depend on tests/
- **WHEN** any file under `src/` is examined for imports
- **THEN** it does not import from any path under `tests/`

### Requirement: Unit tests are colocated with the modules they cover

Each `*.test.ts` file (unit tests run by `bun test`) SHALL live in the same folder as the module it tests. The pair `foo.ts` and `foo.test.ts` SHALL be siblings.

#### Scenario: A test sits next to its subject
- **WHEN** a unit test exists for a module at `src/<folder>/<name>.ts`
- **THEN** the test file is `src/<folder>/<name>.test.ts`
- **AND** no parallel test directory tree exists under `src/`

### Requirement: Score-explanation is a normal module with a normal test

The score-explanation HTML builder (`buildScoreExplanationHTML`) SHALL live in `src/sidebar/score-explanation.ts` as a regular exported function with no side effects at module load. Its unit test SHALL exercise it by direct import rather than by parsing `app.ts` source as text.

#### Scenario: The score-explanation function is directly importable
- **WHEN** any module needs `buildScoreExplanationHTML`
- **THEN** it imports the function from `./sidebar/score-explanation` (or the appropriate relative path)
- **AND** importing this module does not perform DOM access, network requests, or other side effects

#### Scenario: The score-explanation test does not parse source as text
- **WHEN** `src/sidebar/score-explanation.test.ts` is read
- **THEN** it imports `buildScoreExplanationHTML` directly
- **AND** it does not read `app.ts` from disk and does not perform brace-counted extraction of function bodies

### Requirement: appState is importable from a single module

The application state singleton (`appState`) SHALL be defined and exported from `src/shell/state.ts`. Modules that need to read or write application state SHALL import from this module. The state singleton SHALL NOT be redefined elsewhere.

#### Scenario: appState has a single home
- **WHEN** the codebase is searched for the top-level declaration `const appState = {`
- **THEN** it appears only in `src/shell/state.ts`

#### Scenario: Consumers import appState by path
- **WHEN** a module reads or writes `appState`
- **THEN** it imports `appState` from the shell-state module rather than relying on closure access in `app.ts`

### Requirement: Terminal subsystem code lives in src/terminal/

All code related to the in-browser terminal panel, the WebSocket terminal server, terminal authentication, PTY backend, clipboard handling, terminal configuration, and terminal pane state SHALL live in `src/terminal/`. The terminal panel UI mount function (`setupTerminalPanel`) SHALL live in `src/terminal/panel.ts` rather than in `src/app.ts`.

#### Scenario: Terminal files are colocated
- **WHEN** `src/terminal/` is listed
- **THEN** it contains `panel.ts`, `client.ts` (the in-browser xterm mount), `server.ts`, `auth.ts`, `pty.ts`, `backend.ts`, `clipboard.ts`, `config.ts`, and `pane-state.ts` (plus their `*.test.ts` siblings)
- **AND** no `src/terminal-*.ts` files exist at the `src/` root

### Requirement: E2E tests are split along feature lines

`tests/e2e/uatu.e2e.ts` SHALL NOT exist as a single multi-feature file. Instead, E2E tests SHALL be split into feature-named files matching the `src/` folder taxonomy. Cross-feature helpers SHALL live in `tests/e2e/tree-helpers.ts` or a dedicated `tests/e2e/fixtures.ts`.

#### Scenario: No monolithic uatu.e2e.ts remains
- **WHEN** the contents of `tests/e2e/` are listed after the change
- **THEN** `uatu.e2e.ts` does not exist
- **AND** the directory contains feature-named test files such as `mermaid.e2e.ts`, `sidebar.e2e.ts`, `change-overview.e2e.ts`, `git-log.e2e.ts`, `ignore-policy.e2e.ts`, `asciidoc.e2e.ts`, `code-blocks.e2e.ts`, `follow-mode.e2e.ts`, and `preview-renderers.e2e.ts`

#### Scenario: Existing E2E coverage is preserved through the split
- **WHEN** the full E2E suite is run after the split
- **THEN** all tests pass
- **AND** every test that previously lived in `uatu.e2e.ts` is present in one of the new feature-named files

### Requirement: Source-code organization is documented for human and AI contributors

`CLAUDE.md` (and any sibling agent-guidance files such as `AGENTS.md` or `.opencode/` configuration referenced by tooling) SHALL describe the `src/` folder taxonomy so that contributors — human or AI — can navigate to the right module without grepping. README references to specific source paths SHALL be updated to the new layout.

#### Scenario: Agent guidance reflects the layout
- **WHEN** `CLAUDE.md` (or equivalent agent guidance) is read after the change
- **THEN** it names the top-level `src/` folders and the kind of code each owns

#### Scenario: README paths are current
- **WHEN** the README references source paths
- **THEN** every referenced path exists in the post-refactor layout

### Requirement: An architecture document exists at the repo root

An `ARCHITECTURE.md` file SHALL exist at the repository root describing the runtime architecture of uatu in sufficient depth that a new contributor — human or AI — can orient in a single sitting. The document SHALL cover: a short elevator pitch, a runtime map (CLI / server / SPA / terminal boundaries), a folder tour of `src/` and `tests/`, the request lifecycle, the state lifecycle (SSE → `appState` → re-render), the terminal subsystem (xterm.js ↔ WebSocket ↔ PTY), review-vs-author mode differences, "how to extend" recipes for common contributions, and a run/test quickstart. The document SHALL use Mermaid diagrams for the runtime map, request lifecycle, state lifecycle, and terminal subsystem. The README and `CLAUDE.md` SHALL link to `ARCHITECTURE.md`.

#### Scenario: ARCHITECTURE.md exists and covers required sections
- **WHEN** the repository is inspected after the change
- **THEN** `ARCHITECTURE.md` exists at the repo root
- **AND** it contains sections covering: what uatu is, the runtime map, the folder tour, the request lifecycle, the state lifecycle, the terminal subsystem, review-vs-author modes, how to extend, and run/test

#### Scenario: Mermaid diagrams are present
- **WHEN** `ARCHITECTURE.md` is read
- **THEN** at least four fenced ```` ```mermaid ```` code blocks are present, covering the runtime map, the request lifecycle, the state lifecycle, and the terminal subsystem

#### Scenario: Cross-links exist
- **WHEN** `README.md` and `CLAUDE.md` are read
- **THEN** each contains at least one reference to `ARCHITECTURE.md`

#### Scenario: Paths referenced in ARCHITECTURE.md exist in the tree
- **WHEN** `ARCHITECTURE.md` mentions a specific file or folder path under `src/` or `tests/`
- **THEN** that path exists in the post-refactor repository

#### Scenario: ARCHITECTURE.md does not duplicate moving content
- **WHEN** `ARCHITECTURE.md` is read
- **THEN** it does not paste in code listings, function bodies, or other content that lives canonically in source files
- **AND** it references modules by path rather than by reproducing their content
