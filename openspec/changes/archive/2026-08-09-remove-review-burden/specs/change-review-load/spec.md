# change-review-load — delta

## ADDED Requirements

### Requirement: Select the compare target

The system SHALL expose a user-selectable compare target for the Change Overview. Supported targets MUST be `base` and `last-commit` with their existing diff meanings. The selected target SHALL apply uniformly to every watched repository in that client's view, SHALL persist as personal workspace state, and SHALL default to `base` when no saved value exists. Changing it MUST recompute and refresh only that client's changed-files context and diff requests without restarting the watch session, changing `.uatu.json`, altering the resolved base ref, or forcing another client to adopt the target. The watch child SHALL accept compare target as request/subscription context rather than retaining one mutable session-global selection. The control's accessible name SHALL describe comparison ("Compare against"), not review burden.

#### Scenario: Default compare target is the resolved base
- **WHEN** a user has no saved compare target
- **THEN** the client uses `base`
- **AND** the changed-files context reflects changes between the resolved base and the worktree

#### Scenario: Switching to last commit recomputes against HEAD
- **WHEN** a user selects `last-commit`
- **THEN** that client's changed-files view recomputes against `HEAD`
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
- **WHEN** the resolved base is dirty-worktree-only
- **THEN** `base` and `last-commit` describe the same diff
- **AND** the UI reflects that the choice is not meaningful

### Requirement: Anchor the changed-files context to a precise portable ref

The system SHALL report, alongside the changed-files context, a precise anchor identifying the ref the comparison was actually computed against, so the displayed change set is unambiguous when read away from the compare-target control. For the `base` target the anchor SHALL name the actually resolved base ref (for example `origin/main` or `origin/master`). For the `last-commit` target the anchor SHALL be `HEAD`. The anchor MUST reflect what was actually resolved and computed, not the literal label of the selected control. The compare-target control itself MUST express intent in stable plain language ("Since base" / "Since last commit") and MUST NOT display raw refs, so its labels do not shift with repository configuration.

#### Scenario: Base anchor names the resolved ref
- **WHEN** the compare target is `base` and the resolved base ref is `origin/main`
- **THEN** the changed-files context is anchored with the ref `origin/main`

#### Scenario: Last-commit anchor names HEAD
- **WHEN** the compare target is `last-commit`
- **THEN** the changed-files context is anchored with `HEAD`

#### Scenario: The control shows intent, not refs
- **WHEN** the compare-target control is rendered for any repository configuration
- **THEN** its options read as plain intent ("Since base" / "Since last commit")
- **AND** the options do not display raw ref names

## REMOVED Requirements

### Requirement: Select the review compare target
**Reason**: Restated as "Select the compare target" without review-burden vocabulary; the review-base scenario naming is retired with the score.
**Migration**: None — the toggle's behavior is unchanged.

### Requirement: Report the resolved compare target as a precise portable anchor
**Reason**: Restated as "Anchor the changed-files context to a precise portable ref". The configured-`review.baseRef` anchor scenario is dropped with the removal of the `.uatu.json` `review` block; base resolution is fully automatic.
**Migration**: None — anchor reporting continues; repositories that relied on `review.baseRef` fall back to automatic base resolution.

### Requirement: Compute deterministic review burden for git changes
**Reason**: The review-burden score is removed; no score is computed for any change.
**Migration**: None — consumers of the change data (tree annotations, changed-files list, diff view) read the surviving changed-files context directly.

### Requirement: Apply project review scoring configuration
**Reason**: With no score there is nothing for `review` settings to configure; the `.uatu.json` `review` block (thresholds, riskAreas, supportAreas, ignoreAreas, baseRef) is removed. Base resolution is fully automatic.
**Migration**: Delete any `review` block from `.uatu.json`; it is ignored after this change. Repositories that relied on `review.baseRef` fall back to automatic base resolution.

### Requirement: Classify review burden into visible levels
**Reason**: The score and therefore its low/medium/high classification no longer exist.
**Migration**: None — no replacement UI.

### Requirement: Render precise review-burden anchors within the available meter width
**Reason**: The review-burden meter is removed. The anchor itself survives under "Anchor the changed-files context to a precise portable ref" and is displayed in the Change Overview pane rather than inside a meter.
**Migration**: None — anchor display continues without the meter.
