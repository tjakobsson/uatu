## MODIFIED Requirements

### Requirement: Repository README documents project usage and validation
The repository SHALL provide a root `README.md` that explains what `uatu` is, how users install and run the application, and where contributors can find the canonical contribution guide. Detailed branch, OpenSpec, validation, and release procedures MUST live in `CONTRIBUTING.md` and `docs/RELEASING.md` rather than expanding the user-facing README. The README SHALL carry a generated block, placed with the feature description rather than among the repository's build and quality badges, that states what the coverage badges measure and shows, per supported agent, a coverage badge linked to that agent's coverage matrix; the block's content is owned by the coverage generator and MUST NOT be edited by hand.

#### Scenario: A user opens the repository homepage
- **WHEN** a user views the root `README.md`
- **THEN** they can understand, install, and run `uatu`
- **AND** a prospective contributor can follow a link to `CONTRIBUTING.md` for development procedures

#### Scenario: A reader checks agent coverage from the README
- **WHEN** a reader views the root `README.md`
- **THEN** each supported agent shows a badge naming its version and its count of coverage gaps
- **AND** the badges are introduced by a sentence saying what they measure
- **AND** activating the badge opens that agent's coverage matrix

### Requirement: Repository tooling versions are kept current
The repository SHALL use GitHub-native automation to check for updates to npm dependencies, Bun/runtime versions, and GitHub Actions references so that repository tooling does not silently age behind current releases. Update automation MUST remain compatible with pinned action and runtime versions. The update automation MUST additionally surface published security advisories, including advisories affecting transitive (indirect) dependencies and advisories whose fixed version is already satisfied by an existing manifest version range. To achieve this the automation MUST be configured to refresh the dependency lockfile so in-range and transitive fixes are pulled in, and MUST be configured with a vulnerability-alert data source that does not depend on a separate GitHub feature being enabled out-of-band. Because manifest-driven vulnerability alerting only covers direct dependencies, the repository MUST ALSO run a scheduled, PR-independent audit that scans the full installed dependency tree (including transitive packages) and surfaces advisories through GitHub-native workflow status, so a transitive advisory published between pull requests does not go unsurfaced. Every agent SDK whose declarations feed the agent coverage report MUST be pinned to an exact version in the manifest, so the version the report names is the version the code runs against and an update arrives as a reviewable pull request that carries the regenerated report.

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
