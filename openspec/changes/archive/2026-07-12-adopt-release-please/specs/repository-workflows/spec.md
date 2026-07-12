## ADDED Requirements

### Requirement: Repository documents contributor and maintainer workflows

The repository SHALL provide a root `CONTRIBUTING.md` as the canonical guide for development setup, branch and pull-request practices, Conventional Commit expectations, OpenSpec change management, and required validation. The repository SHALL additionally provide `docs/RELEASING.md` as the canonical maintainer runbook for version semantics, release-note inclusion, the Release Please lifecycle, required repository configuration, release verification, reruns, and failure recovery. The documents MUST describe the actual automated workflow and MUST link to each other where responsibilities cross.

#### Scenario: A contributor prepares a change

- **WHEN** a contributor opens `CONTRIBUTING.md`
- **THEN** they can determine how to propose, implement, validate, title, and merge a change
- **AND** they can identify which Conventional Commit types affect versions and public release notes

#### Scenario: A maintainer prepares or recovers a release

- **WHEN** a maintainer opens `docs/RELEASING.md`
- **THEN** they can determine how a release PR becomes a published release and Homebrew update
- **AND** they can find verification and recovery steps for failed artifact publication or tap updates

## MODIFIED Requirements

### Requirement: Repository README documents project usage and validation

The repository SHALL provide a root `README.md` that explains what `uatu` is, how users install and run the application, and where contributors can find the canonical contribution guide. Detailed branch, OpenSpec, validation, and release procedures MUST live in `CONTRIBUTING.md` and `docs/RELEASING.md` rather than expanding the user-facing README.

#### Scenario: A user opens the repository homepage

- **WHEN** a user views the root `README.md`
- **THEN** they can understand, install, and run `uatu`
- **AND** a prospective contributor can follow a link to `CONTRIBUTING.md` for development procedures
