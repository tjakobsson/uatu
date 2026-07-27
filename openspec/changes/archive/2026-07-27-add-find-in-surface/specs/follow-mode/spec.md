## ADDED Requirements

### Requirement: Follow-driven selection never moves focus or the active surface

Selection changes originating from file events (Rules C and D) SHALL NOT move
keyboard focus and SHALL NOT change the app's active surface. Only user-initiated
interaction may do either. A file changing on disk must never relocate the user's
working context.

#### Scenario: A file event while typing in the terminal

- **WHEN** Follow is ON, the user is typing in the terminal, and a watched file changes
- **THEN** the tree selection and preview update, keyboard focus stays in the terminal, and the active surface remains `terminal`

#### Scenario: A file event while the find bar is open

- **WHEN** the preview find bar is open with an active query and a Follow-driven document switch occurs
- **THEN** focus remains in the find input and matches are recomputed against the newly loaded document

#### Scenario: User click still resolves the surface

- **WHEN** the user clicks the tree entry that Follow had already selected
- **THEN** the active surface becomes `preview`, because the change was user-initiated
