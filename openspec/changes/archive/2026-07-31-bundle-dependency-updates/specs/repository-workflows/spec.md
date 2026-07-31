# repository-workflows Delta

## ADDED Requirements

### Requirement: Pending dependency updates may be batched into a single validated chore
The repository SHALL allow maintainers to supersede multiple open automated dependency-update pull requests with a single chore branch that applies the same version updates together, provided the batch passes the repository's full validation (unit tests, license audit, build, end-to-end suite, and spec validation) before merge. Each superseded automation PR MUST be closed with a reference to the superseding pull request.

#### Scenario: Maintainer bundles open Renovate PRs
- **WHEN** several automated dependency-update PRs are open and a maintainer lands one chore PR that applies the same version bumps
- **THEN** the chore PR passes the repository's required validation checks before merge
- **AND** each superseded automation PR is closed with a comment linking the chore PR
