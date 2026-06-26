## ADDED Requirements

### Requirement: Select the review compare target

The system SHALL expose a user-selectable compare target for the Change Overview that determines what each repository's review burden is measured against. The supported targets MUST be `base` (the resolved review base, i.e. the merge-base of the resolved base ref and `HEAD`, including committed, staged, and unstaged changes) and `last-commit` (staged and unstaged worktree changes against `HEAD`). The selected target SHALL be a single session-global value that applies uniformly to the review-burden snapshot for every watched repository in the session. The default target on a fresh session MUST be `base`. The selected target SHALL persist across reloads within the same browser session. Changing the target MUST recompute and refresh the review burden without requiring a watch-session restart, and MUST NOT alter `.uatu.json` configuration or the resolved base ref itself.

#### Scenario: Default compare target is the review base
- **WHEN** a user opens the Change Overview in a fresh session
- **THEN** the compare target is `base`
- **AND** the review burden reflects changes between the resolved review base and the worktree

#### Scenario: Switching to last commit recomputes burden against HEAD
- **WHEN** a user selects the `last-commit` compare target
- **THEN** the review burden recomputes from staged and unstaged changes against `HEAD`
- **AND** the changed-files list reflects only those worktree changes
- **AND** no watch-session restart is required

#### Scenario: Selection persists across reload
- **WHEN** a user selects the `last-commit` compare target and reloads the page within the same session
- **THEN** the compare target remains `last-commit`

#### Scenario: Compare target is session-global across repositories
- **WHEN** a watch session includes more than one repository
- **AND** the user changes the compare target
- **THEN** every repository's review-burden snapshot is computed against the same selected target

#### Scenario: Targets collapse when no base is resolvable
- **WHEN** the resolved review base is dirty-worktree-only because no base ref is available
- **THEN** the `base` and `last-commit` targets describe the same diff (staged and unstaged changes against `HEAD`)
- **AND** the UI reflects that the choice is not meaningful in this state rather than implying two distinct results

### Requirement: Report the resolved compare target as a precise portable anchor

The system SHALL report, alongside the review-burden score, a precise anchor identifying the ref the score was actually computed against, so the reported number is unambiguous when read away from the compare-target control. For the `base` target the anchor SHALL name the actually resolved base ref (for example `origin/main`, `origin/master`, or a configured `review.baseRef` such as `origin/develop`). For the `last-commit` target the anchor SHALL be `HEAD`. The anchor MUST reflect what was actually resolved and computed, not the literal label of the selected control. The compare-target control itself MUST express intent in stable plain language ("Since base" / "Since last commit") and MUST NOT display raw refs, so its labels do not shift with repository configuration.

#### Scenario: Base anchor names the resolved ref
- **WHEN** the compare target is `base` and the resolved base ref is `origin/main`
- **THEN** the review-burden readout is anchored with the ref `origin/main`

#### Scenario: Configured base ref is surfaced in the anchor
- **WHEN** `.uatu.json` sets `review.baseRef` to `origin/develop`
- **AND** the compare target is `base`
- **THEN** the review-burden anchor names `origin/develop` rather than a generic label

#### Scenario: Last-commit anchor names HEAD
- **WHEN** the compare target is `last-commit`
- **THEN** the review-burden readout is anchored with `HEAD`

#### Scenario: The control shows intent, not refs
- **WHEN** the compare-target control is rendered for any repository configuration
- **THEN** its options read as plain intent ("Since base" / "Since last commit")
- **AND** the options do not display raw ref names

## MODIFIED Requirements

### Requirement: Compute deterministic review burden for git changes
The system SHALL compute a cognitive-load score that estimates review burden from deterministic git and file-shape signals, measured against the user-selected compare target. The score MUST be based on mechanical cost plus configured scoring modifiers and MUST NOT rely on AI or semantic code interpretation. Mechanical cost SHALL include changed-file count, diff hunks, touched lines, directory spread, renames or moves, and dependency/config file changes. Commit-log length or recent repository history MUST NOT contribute to the review-burden score. Unconfigured changed paths MUST remain risk-neutral but MUST still contribute to mechanical review cost. The score MUST always mean "review burden of the diff currently shown for the selected compare target", and the result MUST identify the compare target and the ref it was computed against.

#### Scenario: Base target has a resolvable base
- **WHEN** the compare target is `base` and the watched repository has a configured or detected review base
- **THEN** the system computes review burden from committed changes between the merge base and `HEAD`
- **AND** staged and unstaged worktree changes are included in the review burden
- **AND** the result identifies the base used for the calculation

#### Scenario: Last-commit target measures worktree against HEAD
- **WHEN** the compare target is `last-commit`
- **THEN** the system computes review burden from staged and unstaged changes against `HEAD`
- **AND** committed changes between the review base and `HEAD` are excluded
- **AND** the result identifies that it was computed against `HEAD`

#### Scenario: Review base cannot be resolved
- **WHEN** the compare target is `base` and no configured or detected review base is available
- **THEN** the system computes review burden from staged and unstaged changes against `HEAD`
- **AND** the result clearly indicates that it is using dirty-worktree-only mode

#### Scenario: Unconfigured paths are changed
- **WHEN** changed files do not match any configured risk, support, or ignore area
- **THEN** those files add mechanical review cost
- **AND** those files do not add path-based risk or support modifiers

#### Scenario: Review burden has explainable drivers
- **WHEN** the system reports a cognitive-load score
- **THEN** it also reports the facts and modifiers that contributed to the score
- **AND** each reported driver is derived from git data, file-shape data, built-in heuristics, or project configuration
