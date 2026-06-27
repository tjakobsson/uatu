## MODIFIED Requirements

### Requirement: GitHub Actions validate the repository on GitHub
The repository SHALL define GitHub Actions workflows that run the core validation checks on GitHub for the project. At minimum, the automated workflows MUST run unit tests, the license audit, a dependency vulnerability audit, the standalone build, the Playwright end-to-end suite, and OpenSpec spec validation in strict mode (`openspec validate --all --strict` or an equivalent invocation that validates every active spec and in-flight change). The dependency vulnerability audit MUST run the project package manager's audit command (`bun audit` or equivalent) and MUST fail the workflow when a new advisory is reported against the installed dependency tree. Validation workflows MUST use a pinned Bun runtime version and MUST use pinned GitHub Action references so validation behavior is reproducible between intentional updates. The OpenSpec CLI used by spec validation MUST be installed via the project's package manifest (so its version is captured in the lockfile and tracked by the repository's tooling-update automation) rather than referenced as a floating tag in the workflow file.

#### Scenario: A GitHub workflow validates the repository
- **WHEN** the validation workflow runs on GitHub
- **THEN** it executes the repository's required validation commands
- **AND** a failing check causes the workflow to fail

#### Scenario: Validation uses reproducible tool versions
- **WHEN** the validation workflow runs on GitHub
- **THEN** it installs the configured pinned Bun runtime version
- **AND** workflow actions are referenced by immutable or explicitly maintained pinned versions rather than floating major tags

#### Scenario: OpenSpec specs are validated in strict mode on every change
- **WHEN** the validation workflow runs on GitHub for a pull request or push to the main branch
- **THEN** it runs OpenSpec spec validation in strict mode against every active spec and in-flight change
- **AND** a malformed scenario header, an empty capability, a delta that fails to apply, or any other strict-mode validation failure causes the workflow to fail
- **AND** the OpenSpec CLI version used by the workflow is the version recorded in the repository's lockfile, not a floating tag pulled at workflow runtime

#### Scenario: A dependency advisory fails validation
- **WHEN** the validation workflow runs on GitHub and a published security advisory affects a package in the installed dependency tree
- **THEN** the dependency vulnerability audit step reports the advisory
- **AND** the workflow fails so the advisory is visible on the pull request rather than discovered manually

### Requirement: Repository tooling versions are kept current
The repository SHALL use GitHub-native automation to check for updates to npm dependencies, Bun/runtime versions, and GitHub Actions references so that repository tooling does not silently age behind current releases. Update automation MUST remain compatible with pinned action and runtime versions. The update automation MUST additionally surface published security advisories, including advisories affecting transitive (indirect) dependencies and advisories whose fixed version is already satisfied by an existing manifest version range. To achieve this the automation MUST be configured to refresh the dependency lockfile so in-range and transitive fixes are pulled in, and MUST be configured with a vulnerability-alert data source that does not depend on a separate GitHub feature being enabled out-of-band.

#### Scenario: A dependency or workflow version becomes outdated
- **WHEN** a newer compatible version of an npm dependency, Bun runtime, or GitHub Action is available
- **THEN** the repository automation surfaces that update through a GitHub-managed update workflow or pull request

#### Scenario: A transitive dependency has a published advisory
- **WHEN** a published security advisory affects an indirect dependency, or a direct dependency whose fixed version already satisfies the manifest range
- **THEN** the update automation surfaces a remediation pull request rather than leaving the advisory unaddressed
- **AND** the remediation does not require the manifest version range to be manually widened
