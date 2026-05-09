## MODIFIED Requirements

### Requirement: GitHub Actions validate the repository on GitHub
The repository SHALL define GitHub Actions workflows that run the core validation checks on GitHub for the project. At minimum, the automated workflows MUST run unit tests, the license audit, the standalone build, the Playwright end-to-end suite, and OpenSpec spec validation in strict mode (`openspec validate --all --strict` or an equivalent invocation that validates every active spec and in-flight change). Validation workflows MUST use a pinned Bun runtime version and MUST use pinned GitHub Action references so validation behavior is reproducible between intentional updates. The OpenSpec CLI used by spec validation MUST be installed via the project's package manifest (so its version is captured in the lockfile and tracked by the repository's tooling-update automation) rather than referenced as a floating tag in the workflow file.

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
