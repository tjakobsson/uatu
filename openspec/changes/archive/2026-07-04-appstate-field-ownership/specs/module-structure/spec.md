## MODIFIED Requirements

### Requirement: appState is importable from a single module

The application state singleton (`appState`) SHALL be defined and exported from `src/shell/state.ts`. Modules that need to read application state SHALL import from this module. The state singleton SHALL NOT be redefined elsewhere.

Every field of `appState` SHALL have exactly one owning module, documented in a field-ownership table in ARCHITECTURE.md. The owning module SHALL export named mutator functions for its fields, and any mutation of a field from outside its owning module MUST go through those mutators — direct assignment (`appState.<field> = …`) SHALL appear only inside the field's owning module. Mutators whose fields persist a preference SHALL own the corresponding localStorage write, so persistence and assignment cannot drift apart. `src/shell/state.ts` itself SHALL remain a container (initial values and types), not an owner of mutation logic. The follow-mode capability's four rules remain the exclusive authority for `followEnabled` and `selectedId` transitions; this requirement codifies the same single-writer shape for every other field.

#### Scenario: appState has a single home
- **WHEN** the codebase is searched for the top-level declaration `const appState = {`
- **THEN** it appears only in `src/shell/state.ts`

#### Scenario: Consumers import appState by path
- **WHEN** a module reads `appState`
- **THEN** it imports `appState` from the shell-state module rather than relying on closure access in `app.ts`

#### Scenario: Direct assignment happens only in the owner module
- **WHEN** the codebase is searched for direct assignments matching `appState.<field> =` for any field
- **THEN** every match is inside that field's owning module (or its colocated test)
- **AND** all other modules mutate the field by calling the owner's exported mutator

#### Scenario: Persisting mutators own their storage write
- **WHEN** a preference-backed field (e.g. `viewMode`, `viewLayout`, `filesPaneFilter`, `gitLogLimit`, `compareTarget`) is changed via its mutator
- **THEN** the mutator performs the localStorage persistence itself
- **AND** no call site persists the preference separately from the assignment

#### Scenario: The ownership table is documented
- **WHEN** ARCHITECTURE.md's state-lifecycle section is read
- **THEN** it contains a table mapping every `appState` field to its owning module
- **AND** every field of the `appState` declaration appears in the table
