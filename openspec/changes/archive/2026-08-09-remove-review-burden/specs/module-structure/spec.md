# module-structure — delta

## MODIFIED Requirements

### Requirement: src/ is organized into feature folders that mirror the running app

The `src/` directory SHALL be organized into top-level folders named after regions of the running application or coherent domains, not after tech categories (`hooks/`, `services/`, `utils/`). The folders `shell/`, `preview/`, `sidebar/`, `terminal/`, and `server/` SHALL exist and own the code for their respective UI regions or subsystems. Cross-cutting domains (document data — including the repository-level git data sweep, rendering, ignore policy, watchdog, debug instrumentation) SHALL each have their own folder.

#### Scenario: Required feature folders exist
- **WHEN** the `src/` directory is listed
- **THEN** it contains `shell/`, `preview/`, `sidebar/`, `terminal/`, `server/`, `document/`, `render/`, `ignore/`, `watchdog/`, `debug/`, and `shared/` subdirectories
- **AND** the `src/` root contains only entrypoints (`app.ts`, `cli.ts`), shared HTML/CSS (`index.html`, `styles.css`, `styles.d.ts`), and the `assets/` directory

#### Scenario: New feature code is placed in an existing or new feature folder
- **WHEN** a developer adds a new module that belongs to an existing subsystem
- **THEN** the new file lives inside that subsystem's folder
- **AND** new tech-category folders (such as `hooks/`, `services/`, `utils/`) are not introduced at the `src/` root
