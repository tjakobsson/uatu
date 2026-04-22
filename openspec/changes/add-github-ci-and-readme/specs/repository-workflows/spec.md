## ADDED Requirements

### Requirement: Repository README documents project usage and validation
The repository SHALL provide a root `README.md` that explains what `uatu` is, how to run the application locally, how to run the project's validation commands, and how the repository uses OpenSpec for change management.

#### Scenario: A contributor opens the repository homepage
- **WHEN** a contributor views the root `README.md`
- **THEN** they can find local run commands, validation commands, and a short explanation of the OpenSpec workflow

### Requirement: GitHub Actions validate the repository on GitHub
The repository SHALL define GitHub Actions workflows that run the core validation checks on GitHub for the project. At minimum, the automated workflow MUST run unit tests, the license audit, the standalone build, and the Playwright end-to-end suite.

#### Scenario: A GitHub workflow validates the repository
- **WHEN** the validation workflow runs on GitHub
- **THEN** it executes the repository's required validation commands
- **AND** a failing check causes the workflow to fail

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
The repository SHALL use GitHub-native automation to check for updates to npm dependencies and GitHub Actions versions so that repository tooling does not silently age behind current releases.

#### Scenario: A dependency or workflow version becomes outdated
- **WHEN** a newer compatible version of an npm dependency or GitHub Action is available
- **THEN** the repository automation surfaces that update through a GitHub-managed update workflow or pull request
