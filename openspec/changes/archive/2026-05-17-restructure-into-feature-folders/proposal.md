## Why

The source tree has grown disorienting for both humans and AI tools. `src/` is a flat folder of ~80 TypeScript files, `src/app.ts` is 4183 lines with 126+ top-level functions covering four distinct UI roles, the production server's route table is duplicated between `cli.ts` and `e2e-server.ts`, and `tests/e2e/uatu.e2e.ts` is a 2719-line file containing 50+ tests across many unrelated features. One test (`app-score-explanation.test.ts`) already reads `app.ts` as a string and brace-counts the function body it wants to test — a strong signal that the monolith is blocking normal module hygiene.

This change reorganizes the codebase around the *running app's structure* (shell, preview, sidebar, terminal, server) so each part of the UI lives in a folder named after itself. The result is smaller files, predictable navigation, and a one-time-place definition for things that are currently duplicated.

## What Changes

- Decompose `src/app.ts` (4183 lines) into focused modules under a new `src/shell/`, `src/preview/`, and `src/sidebar/` layout.
- Lift the module-local `appState` singleton into `src/shell/state.ts` so other modules can import it explicitly.
- Extract `buildScoreExplanationHTML` into `src/sidebar/score-explanation.ts`; rewrite `app-score-explanation.test.ts` as a normal import-and-assert test (removing the source-parsing workaround).
- Extract `loadInitialState` and `connectEvents` into `src/shell/boot.ts` and `src/shell/events.ts`.
- Extract `setupTerminalPanel` (724 lines, the biggest function in `app.ts`) into `src/terminal/panel.ts`, and fold the existing `terminal-*` files into a single `src/terminal/` folder.
- Extract the duplicated route table out of `cli.ts` and `e2e-server.ts` into a single `src/server/routes.ts` builder; both call sites become thin `Bun.serve({ routes: buildRoutes(...) })` wrappers.
- Move `src/e2e-server.ts` and `src/e2e.ts` to `tests/e2e/server.ts` and `tests/e2e/config.ts` so test harnesses live with the tests they serve.
- Split `tests/e2e/uatu.e2e.ts` into feature-named files (mermaid, sidebar, change-overview, git-log, ignore-policy, asciidoc, preview-renderers, follow-mode) matching the new `src/` folder names.
- Group the remaining flat `src/` files into folders by feature (`server/`, `document/`, `render/`, `review/`, `ignore/`, `watchdog/`, `debug/`, `shared/`, `pwa/`).
- Tests stay colocated next to their subjects.
- Add an `ARCHITECTURE.md` onboarding document at the repo root: elevator pitch, runtime map, folder tour, request lifecycle, state lifecycle, terminal subsystem, review-vs-author modes, "how to extend" hints, and a run/test quickstart. Mermaid diagrams render natively (uatu eats its own dogfood). Linked from `README.md` and `CLAUDE.md`.

This is a pure refactor: **no user-visible behavior changes, no API changes, no build output changes.**

## Capabilities

### New Capabilities

- `module-structure`: Architectural rules for how `src/` is organized — feature folders matching the running app's regions, `src/` reserved for shipped code, single-source-of-truth for the route table, file-size guidance, and test colocation conventions. This is the contract future changes must respect to keep the codebase navigable.

### Modified Capabilities

None. This change is structural and preserves all existing behavior contracts.

## Impact

- **Import-path churn**: nearly every file in `src/` gets at least one updated import. Mechanical, but wide-blast-radius.
- **Build config**: `scripts/build.ts` may need updates if any entry-point paths or exclude globs reference moved files. `playwright.config.ts` needs its `webServer.command` updated to the new harness path.
- **Test runner**: `bun test` discovers `*.test.ts` via globs that should keep working under the new folders; verify after the move.
- **No new dependencies.** No package.json changes beyond possible script path updates.
- **No runtime behavior change.** Existing E2E and unit suites must pass unchanged after the refactor.
- **Documentation**: README and any CONTRIBUTING-style docs that reference specific file paths (`src/server.ts`, etc.) need updating. CLAUDE.md / agent guidance files referencing the flat layout need updating.
