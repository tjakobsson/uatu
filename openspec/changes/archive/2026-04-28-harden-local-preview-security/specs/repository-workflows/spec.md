## ADDED Requirements

### Requirement: AI-assisted repository workflows use trusted triggers and least privilege
The repository SHALL configure AI-assisted GitHub workflows so write-capable automation only runs for trusted actors or trusted author associations. These workflows MUST request only the GitHub token permissions required for their documented behavior and MUST NOT grant repository write permissions to workflows that only need read or review-comment access.

#### Scenario: Untrusted mention does not trigger write-capable AI automation
- **WHEN** an untrusted user opens an issue or comment containing the AI workflow trigger phrase
- **THEN** the write-capable AI workflow does not run with repository write permissions

#### Scenario: Trusted actor can trigger AI automation
- **WHEN** a repository owner, member, or collaborator uses the documented AI workflow trigger phrase
- **THEN** the AI workflow is allowed to run with only the permissions required for its task

## MODIFIED Requirements

### Requirement: GitHub Actions validate the repository on GitHub
The repository SHALL define GitHub Actions workflows that run the core validation checks on GitHub for the project. At minimum, the automated workflow MUST run unit tests, the license audit, the standalone build, and the Playwright end-to-end suite. Validation workflows MUST use a pinned Bun runtime version and MUST use pinned GitHub Action references so validation behavior is reproducible between intentional updates.

#### Scenario: A GitHub workflow validates the repository
- **WHEN** the validation workflow runs on GitHub
- **THEN** it executes the repository's required validation commands
- **AND** a failing check causes the workflow to fail

#### Scenario: Validation uses reproducible tool versions
- **WHEN** the validation workflow runs on GitHub
- **THEN** it installs the configured pinned Bun runtime version
- **AND** workflow actions are referenced by immutable or explicitly maintained pinned versions rather than floating major tags

### Requirement: Repository tooling versions are kept current
The repository SHALL use GitHub-native automation to check for updates to npm dependencies, Bun/runtime versions, and GitHub Actions references so that repository tooling does not silently age behind current releases. Update automation MUST remain compatible with pinned action and runtime versions.

#### Scenario: A dependency or workflow version becomes outdated
- **WHEN** a newer compatible version of an npm dependency, Bun runtime, or GitHub Action is available
- **THEN** the repository automation surfaces that update through a GitHub-managed update workflow or pull request
