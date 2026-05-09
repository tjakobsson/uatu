# repository-workflows Specification

## Purpose
TBD - created by archiving change add-github-ci-and-readme. Update Purpose after archive.
## Requirements
### Requirement: Repository README documents project usage and validation
The repository SHALL provide a root `README.md` that explains what `uatu` is, how to run the application locally, how to run the project's validation commands, and how the repository uses OpenSpec for change management.

#### Scenario: A contributor opens the repository homepage
- **WHEN** a contributor views the root `README.md`
- **THEN** they can find local run commands, validation commands, and a short explanation of the OpenSpec workflow

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

### Requirement: AI-assisted repository workflows use trusted triggers and least privilege
The repository SHALL configure AI-assisted GitHub workflows so write-capable automation only runs for trusted actors or trusted author associations. These workflows MUST request only the GitHub token permissions required for their documented behavior and MUST NOT grant repository write permissions to workflows that only need read or review-comment access.

#### Scenario: Untrusted mention does not trigger write-capable AI automation
- **WHEN** an untrusted user opens an issue or comment containing the AI workflow trigger phrase
- **THEN** the write-capable AI workflow does not run with repository write permissions

#### Scenario: Trusted actor can trigger AI automation
- **WHEN** a repository owner, member, or collaborator uses the documented AI workflow trigger phrase
- **THEN** the AI workflow is allowed to run with only the permissions required for its task

### Requirement: Playwright E2E support remains developer-only
The repository SHALL document and automate Playwright for contributor and CI validation without making Playwright part of the shipped end-user `uatu` runtime. The repository workflows and README MUST treat Playwright as test-only tooling.

#### Scenario: A contributor follows the documented E2E workflow
- **WHEN** a contributor uses the documented E2E commands from the repository
- **THEN** they can install the browser dependency and run the E2E suite locally
- **AND** the compiled `uatu` artifact remains independent from Playwright at runtime

### Requirement: Workflow status is suitable for GitHub-facing reporting
The repository SHALL organize its GitHub validation workflows so that their status can be surfaced through GitHub-native mechanisms such as badges now or later.

#### Scenario: A workflow badge is added to the repository documentation
- **WHEN** repository documentation references validation status
- **THEN** that status can be derived from the GitHub Actions workflow state rather than a separate custom reporting system

### Requirement: Repository tooling versions are kept current
The repository SHALL use GitHub-native automation to check for updates to npm dependencies, Bun/runtime versions, and GitHub Actions references so that repository tooling does not silently age behind current releases. Update automation MUST remain compatible with pinned action and runtime versions.

#### Scenario: A dependency or workflow version becomes outdated
- **WHEN** a newer compatible version of an npm dependency, Bun runtime, or GitHub Action is available
- **THEN** the repository automation surfaces that update through a GitHub-managed update workflow or pull request

### Requirement: Test-only DOM-simulation tooling runs under the pinned Bun runtime
Any third-party library used by the repository's test suite to simulate a browser DOM (creating `Document`/`Window` objects, parsing `innerHTML`, executing `querySelector`/`querySelectorAll`, reading inline styles, etc.) MUST run cleanly under the project's pinned Bun runtime version. A library that depends on Node-specific runtime behavior that Bun does not faithfully reproduce — most notably installing global constructors on a contextified `Window` via `vm.createContext` and `Script.runInContext` — MUST NOT be selected, even if it is otherwise the fastest or most popular option.

This requirement applies to dev-only tooling; it does not constrain runtime dependencies of the shipped `uatu` artifact.

#### Scenario: A new DOM-simulation library is proposed for tests
- **WHEN** a contributor or automated update proposes adding or upgrading a DOM-simulation devDependency
- **THEN** the change MUST be rejected unless the library's test execution succeeds end-to-end under the repository's pinned Bun runtime
- **AND** the rejection rationale MUST cite this requirement so the next reviewer does not reintroduce the same failure mode

#### Scenario: The pinned Bun runtime is upgraded
- **WHEN** the repository's pinned Bun runtime version is upgraded
- **THEN** the existing test-DOM tooling MUST continue to pass the test suite under the new Bun version before the runtime upgrade is merged

