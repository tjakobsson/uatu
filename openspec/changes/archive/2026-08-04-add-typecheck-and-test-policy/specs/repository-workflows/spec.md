# repository-workflows delta — add-typecheck-and-test-policy

## MODIFIED Requirements

### Requirement: Repository documents contributor and maintainer workflows
The repository SHALL provide a root `CONTRIBUTING.md` as the canonical guide for development setup, branch and pull-request practices, Conventional Commit expectations, OpenSpec change management, and required validation — including the project's test policy: changes that add or change functionality MUST include tests. The repository SHALL additionally provide `docs/RELEASING.md` as the canonical maintainer runbook for version semantics, release-note inclusion, the Release Please lifecycle, required repository configuration, release verification, reruns, and failure recovery. The documents MUST describe the actual automated workflow and MUST link to each other where responsibilities cross.

#### Scenario: A contributor prepares a change
- **WHEN** a contributor opens `CONTRIBUTING.md`
- **THEN** they can determine how to propose, implement, validate, title, and merge a change
- **AND** they can identify which Conventional Commit types affect versions and public release notes

#### Scenario: A contributor learns the test policy
- **WHEN** a contributor reads the validation guidance in `CONTRIBUTING.md`
- **THEN** they find an explicit statement that changes adding or changing functionality must include tests
- **AND** the documented validation commands include the type check alongside the test suites

#### Scenario: A maintainer prepares or recovers a release
- **WHEN** a maintainer opens `docs/RELEASING.md`
- **THEN** they can determine how a release PR becomes a published release and Homebrew update
- **AND** they can find verification and recovery steps for failed artifact publication or tap updates

### Requirement: GitHub Actions validate the repository on GitHub
The repository SHALL define GitHub Actions workflows that run the core validation checks on GitHub for the project. At minimum, the automated workflows MUST run a TypeScript type check (`tsc --noEmit` invoked through a package script, with the TypeScript compiler pinned as a devDependency in the lockfile), unit tests, the license audit, a dependency vulnerability audit, the standalone build, the Playwright end-to-end suite, and OpenSpec spec validation in strict mode (`openspec validate --all --strict` or an equivalent invocation that validates every active spec and in-flight change). The dependency vulnerability audit MUST run the project package manager's audit command (`bun audit` or equivalent) and MUST fail the workflow when a new advisory is reported against the installed dependency tree. Validation workflows MUST use a pinned Bun runtime version and MUST use pinned GitHub Action references so validation behavior is reproducible between intentional updates. The OpenSpec CLI used by spec validation MUST be installed via the project's package manifest (so its version is captured in the lockfile and tracked by the repository's tooling-update automation) rather than referenced as a floating tag in the workflow file.

#### Scenario: A GitHub workflow validates the repository
- **WHEN** the validation workflow runs on GitHub
- **THEN** it executes the repository's required validation commands
- **AND** a failing check causes the workflow to fail

#### Scenario: Type errors fail validation
- **WHEN** the validation workflow runs on a change that introduces a TypeScript type error under the repository's strict `tsconfig.json`
- **THEN** the type-check step fails and the workflow fails
- **AND** the step runs the same package script (`bun run typecheck`) that contributors run locally

#### Scenario: Validation uses reproducible tool versions
- **WHEN** the validation workflow runs on GitHub
- **THEN** it installs the configured pinned Bun runtime version
- **AND** workflow actions are referenced by immutable or explicitly maintained pinned versions rather than floating major tags

#### Scenario: OpenSpec specs are validated in strict mode on every change
- **WHEN** the validation workflow runs on GitHub for a pull request or push to the main branch
- **THEN** it runs OpenSpec spec validation in strict mode against every active spec and in-flight change
- **AND** a malformed scenario header, an empty capability, a delta that fails to apply, or any other strict-mode validation failure causes the workflow to fail
- **AND** the OpenSpec CLI version used by the workflow is the version recorded in the repository's lockfile, not a floating tag pulled at workflow runtime
