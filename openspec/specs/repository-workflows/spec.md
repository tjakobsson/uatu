# repository-workflows Specification

## Purpose
Define documented, reproducible, secure repository workflows for contribution, validation, dependency maintenance, testing, and releases without adding test tooling to the shipped runtime.
## Requirements
### Requirement: Repository README documents project usage and validation

The root README SHALL explain uatu, installation, usage, and where to find canonical contribution guidance. Detailed branch, OpenSpec, validation, and release procedures MUST live in `CONTRIBUTING.md` and `docs/RELEASING.md`, not expand the README. A generated feature-description block SHALL explain coverage badges and link one per supported agent to its matrix, separate from build/quality badges. Its generator-owned content MUST NOT be hand-edited.

#### Scenario: Locate procedures and coverage without duplicating their owners
- **WHEN** the root README is inspected
- **THEN** detailed branch, OpenSpec, validation, and release procedures remain in the canonical contribution and release guides
- **AND** the coverage generator's block appears with feature descriptions, explains its measurements, and provides each supported agent's linked matrix badge rather than joining build/quality badges

#### Scenario: A user opens the repository homepage
- **WHEN** a user views the root `README.md`
- **THEN** they can understand, install, and run `uatu`
- **AND** a prospective contributor can follow a link to `CONTRIBUTING.md` for development procedures

#### Scenario: A reader checks agent coverage from the README
- **WHEN** a reader views the root `README.md`
- **THEN** each supported agent shows a badge naming its version and its count of coverage gaps
- **AND** the badges are introduced by a sentence saying what they measure
- **AND** activating the badge opens that agent's coverage matrix

### Requirement: Repository documents contributor and maintainer workflows

Root `CONTRIBUTING.md` SHALL be the canonical development and contribution guide. Changes that add or change functionality MUST include tests. `docs/RELEASING.md` SHALL be the canonical maintainer runbook. Both documents MUST reflect actual automation and cross-link where their responsibilities meet.

#### Scenario: Find the complete contribution contract
- **WHEN** root `CONTRIBUTING.md` is read
- **THEN** it is the canonical guide to development setup, branch and PR practices, Conventional Commits, OpenSpec changes, and required validation
- **AND** its test policy requires tests for changes that add or change functionality

#### Scenario: Find the complete maintainer runbook
- **WHEN** `docs/RELEASING.md` is read
- **THEN** it covers version semantics, release-note inclusion, Release Please lifecycle, repository configuration, release verification, reruns, and failure recovery
- **AND** both guides MUST describe actual automation and cross-link where their responsibilities cross

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

GitHub Actions SHALL run the project's core type, test, security, license, build, browser, and strict OpenSpec checks using pinned runtime and action references. OpenSpec MUST come from the locked project dependency, and dependency advisories MUST be handled by the required package-manager audit gate.

#### Scenario: Execute the complete minimum GitHub validation set
- **WHEN** GitHub validation workflows run
- **THEN** they MUST execute `tsc --noEmit` through a package script, unit tests, license audit, dependency vulnerability audit, standalone build, Playwright E2E, and strict OpenSpec validation
- **AND** the compiler is pinned as a lockfile devDependency; `openspec validate --all --strict` or equivalent validates every active spec and in-flight change

#### Scenario: Fail validation on a dependency advisory
- **WHEN** the installed dependency tree reports a new advisory through the package manager's `bun audit` or equivalent command
- **THEN** the vulnerability-audit step MUST fail the workflow

#### Scenario: Resolve validation tools reproducibly
- **WHEN** validation tooling is configured
- **THEN** Bun and GitHub Action references MUST be pinned, and OpenSpec MUST be installed through the project manifest with its version captured in the lockfile and tracked by tooling-update automation, not a floating workflow tag

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

#### Scenario: A dependency advisory fails validation
- **WHEN** the validation workflow runs on GitHub and a published security advisory affects a package in the installed dependency tree
- **THEN** the dependency vulnerability audit step reports the advisory
- **AND** the workflow fails so the advisory is visible on the pull request rather than discovered manually

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

GitHub-native automation SHALL check npm, Bun/runtime, and GitHub Action updates. It MUST support pinned versions and surface published advisories, including transitive and in-range fixes, via lockfile refresh and an independent vulnerability-alert source. A scheduled PR-independent full-tree audit MUST surface advisories in GitHub workflow status. Every SDK package feeding coverage MUST use an exact manifest version so updates carry reviewable regenerated reports.

#### Scenario: Find fixes without widening a manifest range or enabling another feature
- **WHEN** a published advisory affects an indirect dependency or has a fix already within a manifest range
- **THEN** update automation MUST refresh the lockfile to pull in transitive and in-range fixes and use a vulnerability-alert source independent of separately enabled GitHub features

#### Scenario: Audit the entire installed tree between pull requests
- **WHEN** the scheduled audit runs independently of PR activity
- **THEN** it MUST scan direct and transitive installed packages and surface advisories through GitHub-native workflow status

#### Scenario: Pin all declarations contributing to coverage
- **WHEN** package declarations feed the agent coverage report
- **THEN** each agent SDK and any API SDK supplying its referenced content-block types MUST have an exact manifest version, matching the version used at runtime
- **AND** its update arrives as a reviewable PR carrying the regenerated report

#### Scenario: A dependency or workflow version becomes outdated
- **WHEN** a newer compatible version of an npm dependency, Bun runtime, or GitHub Action is available
- **THEN** the repository automation surfaces that update through a GitHub-managed update workflow or pull request

#### Scenario: A transitive dependency has a published advisory
- **WHEN** a published security advisory affects an indirect dependency, or a direct dependency whose fixed version already satisfies the manifest range
- **THEN** the update automation surfaces a remediation pull request rather than leaving the advisory unaddressed
- **AND** the remediation does not require the manifest version range to be manually widened

#### Scenario: A transitive advisory is published with no open pull request
- **WHEN** a security advisory is published against a transitive dependency and no pull request is open to trigger the per-PR audit gate
- **THEN** the scheduled dependency-audit workflow scans the full installed tree on its next run and fails on a moderate-or-higher advisory
- **AND** the failing scheduled run surfaces the advisory through GitHub-native workflow status rather than relying on the advisory being noticed manually

#### Scenario: An agent SDK update carries its coverage report
- **WHEN** the update automation proposes a new version of an agent SDK
- **THEN** the manifest names that exact version
- **AND** the pull request cannot pass validation until the coverage report is regenerated against it

### Requirement: Test-only DOM-simulation tooling runs under the pinned Bun runtime

Third-party test DOM-simulation libraries MUST run cleanly under pinned Bun. A library depending on Node-specific behavior Bun does not faithfully reproduce MUST NOT be selected, regardless of speed or popularity. This rule applies only to dev tooling, not dependencies of the shipped uatu artifact.

#### Scenario: Exercise DOM simulation under pinned Bun
- **WHEN** a test library creates `Document`/`Window`, parses `innerHTML`, runs `querySelector`/`querySelectorAll`, or reads inline styles
- **THEN** it MUST run cleanly under the project's pinned Bun version
- **AND** a library relying on unsupported contextified-`Window` global installation through `vm.createContext` and `Script.runInContext` MUST NOT be selected, even if fastest or most popular

#### Scenario: A new DOM-simulation library is proposed for tests
- **WHEN** a contributor or automated update proposes adding or upgrading a DOM-simulation devDependency
- **THEN** the change MUST be rejected unless the library's test execution succeeds end-to-end under the repository's pinned Bun runtime
- **AND** the rejection rationale MUST cite this requirement so the next reviewer does not reintroduce the same failure mode

#### Scenario: The pinned Bun runtime is upgraded
- **WHEN** the repository's pinned Bun runtime version is upgraded
- **THEN** the existing test-DOM tooling MUST continue to pass the test suite under the new Bun version before the runtime upgrade is merged

### Requirement: Pending dependency updates may be batched into a single validated chore
The repository SHALL allow maintainers to supersede multiple open automated dependency-update pull requests with a single chore branch that applies the same version updates together, provided the batch passes the repository's full validation (unit tests, license audit, build, end-to-end suite, and spec validation) before merge. Each superseded automation PR MUST be closed with a reference to the superseding pull request.

#### Scenario: Maintainer bundles open Renovate PRs
- **WHEN** several automated dependency-update PRs are open and a maintainer lands one chore PR that applies the same version bumps
- **THEN** the chore PR passes the repository's required validation checks before merge
- **AND** each superseded automation PR is closed with a comment linking the chore PR
