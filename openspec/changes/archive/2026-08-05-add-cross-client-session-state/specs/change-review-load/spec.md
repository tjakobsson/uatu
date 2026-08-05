## MODIFIED Requirements

### Requirement: Select the review compare target
The system SHALL expose a user-selectable compare target for the Change Overview. Supported targets MUST be `base` and `last-commit` with their existing diff meanings. The selected target SHALL apply uniformly to every watched repository in that client's view, SHALL persist as personal workspace state, and SHALL default to `base` when no saved value exists. Changing it MUST recompute and refresh only that client's review burden and diff requests without restarting the watch session, changing `.uatu.json`, altering the resolved base ref, or forcing another client to adopt the target. The watch child SHALL accept compare target as request/subscription context rather than retaining one mutable session-global selection.

#### Scenario: Default compare target is the review base
- **WHEN** a user has no saved compare target
- **THEN** the client uses `base`
- **AND** review burden reflects changes between the resolved review base and worktree

#### Scenario: Switching to last commit recomputes against HEAD
- **WHEN** a user selects `last-commit`
- **THEN** that client's burden and changed-files view recompute against `HEAD`
- **AND** no watch-session restart is required

#### Scenario: Selection follows the user to another client
- **WHEN** a user saves `last-commit` and later opens the workspace root in another browser
- **THEN** the new client uses `last-commit`

#### Scenario: Open clients may use different targets
- **WHEN** two clients view the same workspace with different compare targets
- **THEN** each receives repository snapshots and diffs for its own target
- **AND** neither toggle changes because of the other's selection

#### Scenario: Compare target is uniform across repositories within one client
- **WHEN** a workspace includes multiple repositories
- **THEN** one client's selected target applies to all repositories in that client's view

#### Scenario: Targets collapse when no base is resolvable
- **WHEN** the resolved review base is dirty-worktree-only
- **THEN** `base` and `last-commit` describe the same diff
- **AND** the UI reflects that the choice is not meaningful
