# security-posture Specification

## Purpose
Define the repository's OpenSSF-aligned security floor: a published vulnerability disclosure policy with a working private reporting channel, an enforced ruleset protecting the main branch, continuous posture measurement via OpenSSF Scorecard, and static analysis (CodeQL) over the TypeScript codebase.
## Requirements
### Requirement: The repository publishes a vulnerability disclosure policy
The repository SHALL provide a root `SECURITY.md` that states which versions receive security fixes, directs reporters to GitHub private vulnerability reporting, states an acknowledgement expectation, and describes what is in scope for a local-first tool (terminal authentication, render/sanitization pipeline, file-serving path handling, release-artifact integrity) versus out of scope. GitHub private vulnerability reporting MUST be enabled on the repository so the documented reporting channel works.

#### Scenario: A researcher reports a vulnerability privately
- **WHEN** a security researcher opens `SECURITY.md`
- **THEN** they find a working link to report the issue privately via GitHub private vulnerability reporting
- **AND** they can determine whether their finding is in scope before reporting

#### Scenario: The policy is discoverable by tooling
- **WHEN** an automated check (such as OpenSSF Scorecard's Security-Policy check) inspects the repository
- **THEN** it finds a security policy file at a standard location

### Requirement: The main branch is protected by an enforced ruleset
The repository SHALL enforce a ruleset on `main` that requires changes to arrive via pull request, requires the CI `validate` status check to pass before merging, and blocks force pushes and branch deletion. The ruleset MUST NOT include standing bypass actors, and required approving reviews MAY remain at zero while the project has a single maintainer.

#### Scenario: A direct push to main is rejected
- **WHEN** any actor attempts to push a commit directly to `main`
- **THEN** the push is rejected by the ruleset

#### Scenario: A pull request cannot merge with failing validation
- **WHEN** a pull request targeting `main` has a failing or missing `validate` check
- **THEN** the merge is blocked until the check passes

#### Scenario: Release automation continues to work
- **WHEN** Release Please merges its release pull request and the release workflow pushes a version tag
- **THEN** both operations succeed without any ruleset bypass

### Requirement: Scorecard continuously measures the repository's security posture
The repository SHALL run OpenSSF Scorecard via a scheduled GitHub Actions workflow that also runs on pushes to `main`, publishes results to the OpenSSF API, and uploads findings to GitHub code scanning. The workflow's actions MUST be referenced by pinned immutable versions consistent with the repository's existing workflow conventions.

#### Scenario: The score is measured on a schedule
- **WHEN** the scheduled Scorecard workflow runs
- **THEN** it evaluates the repository and publishes the result to the OpenSSF API
- **AND** findings appear in the repository's code scanning alerts

#### Scenario: A posture regression is surfaced
- **WHEN** a repository setting or workflow change degrades a Scorecard check (for example the ruleset is disabled)
- **THEN** the next Scorecard run reflects the lower score in its published results

### Requirement: Static analysis runs over the TypeScript codebase
The repository SHALL run CodeQL analysis for the `javascript-typescript` language on pull requests targeting `main`, on pushes to `main`, and on a weekly schedule, uploading results to GitHub code scanning. Analysis of the Swift desktop wrapper is explicitly out of scope for this capability's initial version.

#### Scenario: A pull request is analyzed
- **WHEN** a pull request targeting `main` modifies TypeScript source
- **THEN** CodeQL analyzes the change and reports findings to code scanning

#### Scenario: Scheduled analysis covers the default branch
- **WHEN** the weekly CodeQL schedule fires
- **THEN** the `main` branch is analyzed even if no pull requests were opened that week
