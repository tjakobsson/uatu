## ADDED Requirements

### Requirement: Shared agent guidance is discoverable from a fresh clone
The repository SHALL provide `AGENTS.md` as its sole root agent instruction entry point for supported current Claude Code and OpenCode clients.

#### Scenario: Repository guidance is maintained
- **WHEN** repository agent guidance is provided or moved
- **THEN** it SHALL point to canonical contributor policy, detailed architecture, applicable standards, and repo-local skills using task-specific reading conditions
- **AND** shared policies SHALL have one authoritative home
- **AND** moving guidance MUST preserve relevant conventions and rationale rather than deleting them solely to shorten the entry point

#### Scenario: A contributor starts either supported agent
- **WHEN** a contributor starts a supported current Claude Code or OpenCode client in a fresh clone with no personal repository setup
- **THEN** the project instruction entry and committed PR and code-review skills are discoverable without an installation step
- **AND** documentation explains supported client assumptions and how to verify discovery
- **AND** a duplicate root `CLAUDE.md` is not required

### Requirement: Approved intent permits accountable autonomous plan evolution
Behavior and workflow changes SHALL have an OpenSpec plan approved before implementation.

#### Scenario: A contribution follows the lifecycle
- **WHEN** a contribution is planned, implemented, or handed off
- **THEN** strictly mechanical corrections SHALL not require invented behavioral requirements
- **AND** the contributor SHALL record the approved planning Git revision and preserve its availability until final acceptance
- **AND** within the original outcome, the implementing agent SHALL update working artifacts as design, tasks, or requirements evolve, and SHALL disclose material departures for explicit human acceptance before merge
- **AND** only an explicitly agreed, potentially empty list of change-specific advance-approval exceptions SHALL require an earlier interruption for those tradeoffs; existing permissions and governing safety rules SHALL remain in force
- **AND** final artifacts and a brief change explanation SHALL be retained without requiring permanent duplicate approved-plan snapshots

#### Scenario: Implementation reveals a better approach
- **WHEN** an agent changes the approach or makes a requirement tradeoff within the original outcome without crossing an explicit advance-approval exception
- **THEN** it updates the working artifacts and continues implementation and validation
- **AND** the final handoff explains what materially changed from the approved revision, why, and its consequences
- **AND** passing tests or review does not substitute for human acceptance of those departures

#### Scenario: An explicit exception would be crossed
- **WHEN** continuing implementation would cross a change-specific advance-approval exception or change the original outcome
- **THEN** the agent requests the necessary approval before proceeding across that boundary

#### Scenario: A mechanical correction is prepared
- **WHEN** a change only repairs spelling, formatting, or a broken link without changing behavior or workflow
- **THEN** the contributor can use the documented lightweight path without creating an OpenSpec change
- **AND** the PR still receives both review axes, reporting the absence of an applicable spec where appropriate

### Requirement: Review and validation handoffs are explicit
Every PR SHALL receive independent Standards and Spec review locally before being marked ready and on GitHub.

#### Scenario: Any PR undergoes review and validation
- **WHEN** any PR undergoes local or GitHub review or validation
- **THEN** findings SHALL be reported separately by axis
- **AND** Spec review SHALL evaluate revised requirements rather than compare them with the original approval baseline
- **AND** an absent applicable spec SHALL be reported, not invented
- **AND** the agent SHALL autonomously fix valid findings or explain rejected ones and renew affected verification and review after corrections
- **AND** GitHub AI review SHALL remain advisory and SHALL not inherit the local verdict as its conclusion
- **AND** focused local checks and applicable CI SHALL pass before the final acceptance handoff; unavailable evidence SHALL be identified as a blocker or limitation, not claimed as passing

#### Scenario: A reviewed change is corrected
- **WHEN** local or GitHub review identifies an actionable concern
- **THEN** the implementing agent fixes it or records a reasoned rejection
- **AND** affected checks and review are renewed for material corrections
- **AND** unresolved findings and verification gaps are included in the human handoff

#### Scenario: A planned requirement changes
- **WHEN** a PR implements the revised requirements but differs from the initially approved plan
- **THEN** the Spec reviewer evaluates the revised requirements only
- **AND** the contributor separately requests human acceptance of material departures using the recorded approved revision

#### Scenario: A contributor requests final acceptance
- **WHEN** implementation and review are ready for human acceptance
- **THEN** the PR includes a concise summary, concrete evidence, checks and limitations, merge risk, and material plan changes
- **AND** existing Conventional Commit and Release Please override conventions remain applicable
- **AND** specs are synced and completed planning artifacts archived before merge, with affected verification renewed after final changes

### Requirement: External PR review requires trusted authorization
Automatic GitHub AI review SHALL retain trusted triggers.

#### Scenario: Any PR enters automated review
- **WHEN** any PR is considered for or receives automated GitHub AI review
- **THEN** external PRs SHALL have an explicit trusted-maintainer authorization path for the same two-axis review
- **AND** review SHALL treat candidate code and instructions as review data rather than execute code, tests, scripts, or hooks from the PR or adopt its instructions as trusted automation policy
- **AND** authorization SHALL be checked against current repository permissions and the reviewed head revision
- **AND** reviews SHALL identify the base, head, and applicable spec sources and SHALL have no repository-content write permission

#### Scenario: An external contributor requests a review
- **WHEN** an external contributor opens a PR or posts a review trigger without trusted authorization
- **THEN** write-capable AI review does not start merely because the contributor requested it
- **AND** a trusted maintainer can authorize review of the current PR revision

#### Scenario: A candidate modifies reviewer instructions
- **WHEN** a PR modifies skills, instructions, or workflow files
- **THEN** the automated review uses trusted base-revision review policy and inspects candidate changes as data
- **AND** it does not execute PR code or treat candidate instructions as permission to broaden its tools

### Requirement: Third-party skills have reproducible repository ownership
Matt Pocock's `pr` and `code-review` skills SHALL be committed with source and revision tracking sufficient to reproduce their content using a pinned skills CLI.

#### Scenario: Repository skills are provided or maintained
- **WHEN** repository skills are provided or maintained
- **THEN** repo-specific integration SHALL remain outside managed upstream files, and updates SHALL preserve required attribution and companion files
- **AND** skills SHALL be discoverable by both supported agents without personal global skills
- **AND** the third-party updater SHALL manage only explicitly selected skills and SHALL leave OpenSpec-generated skills and commands under OpenSpec CLI ownership

#### Scenario: A contributor verifies installed skills
- **WHEN** the contributor validates the committed skill installation
- **THEN** selected skill contents, recorded upstream revision, and lock metadata are checked for consistency
- **AND** discovery paths work for both supported clients
- **AND** missing companions, modified managed content, broken links, or stale source metadata are reported as failures

#### Scenario: Upstream skill files change
- **WHEN** a tracked third-party skill update is applied
- **THEN** upstream files are refreshed without overwriting repo-specific integration or OpenSpec-generated content
- **AND** the PR exposes the resulting instruction changes for human review

### Requirement: Renovate owns complete third-party skill update PRs
Renovate SHALL detect tracked skill-source updates and own their update PRs.

#### Scenario: Skill update automation operates
- **WHEN** tracked third-party skill updates are processed or validated
- **THEN** if a repository helper is needed, it SHALL refresh committed skill files and lock metadata within that same PR
- **AND** validation SHALL reject a revision-only update with stale installed content
- **AND** automation SHALL not merge instruction updates automatically or require a second update bot
- **AND** the helper SHALL use trusted automation code and a validated, allowlisted source revision; it SHALL not execute PR-provided commands
- **AND** its writes SHALL be limited to managed outputs on the authorized same-repository Renovate branch, and it SHALL abort on stale heads or unexpected changes
- **AND** required CI SHALL run against the regenerated head rather than rely on token-generated pushes implicitly starting workflows

#### Scenario: Renovate proposes a skill revision
- **WHEN** Renovate opens or updates a PR for the tracked skill source
- **THEN** that PR contains the selected revision, corresponding skill contents, and consistent lock metadata before it can pass skill validation
- **AND** an authorized same-PR helper performs regeneration if Renovate cannot run the updater directly
- **AND** a human reviews instruction changes before merge

#### Scenario: An unauthorized or stale helper request arrives
- **WHEN** a helper request comes from an untrusted actor, an external branch, an unexpected source or path, or a head that changed during generation
- **THEN** the helper does not push generated changes
- **AND** it reports why it refused rather than broadening access or overwriting newer work

#### Scenario: Hosted execution cannot be verified
- **WHEN** credentials, repository permissions, or service controls prevent proving complete update or review behavior
- **THEN** implementation reports the blocked check and required maintainer action explicitly
- **AND** the feature is not represented as fully verified and no service or credential changes are made without separate authority
