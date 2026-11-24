## ADDED Requirements

### Requirement: A detected pull request supplies the base
When a repository's checked-out branch has a detected pull request, the `base` target SHALL measure from the merge base of HEAD and the pull request's base: GitHub's base commit when it exists locally, otherwise the local remote-tracking base branch, marked possibly stale. The anchor SHALL name `<remote>/<baseRefName>`. Without either ref, the default resolution SHALL apply, flagged.

#### Scenario: Pull request into a release branch
- **WHEN** the checked-out branch has an open pull request with base `release/2.0`, GitHub's base commit exists locally, and the compare target is `base`
- **THEN** changed files are measured from the merge base of that commit and HEAD, not from the default branch
- **AND** the anchor names `origin/release/2.0`

#### Scenario: Local base branch is older than GitHub's
- **WHEN** GitHub's base commit is not present locally but `origin/release/2.0` is
- **THEN** changed files are measured from `origin/release/2.0` and Change Overview says the base may be out of date, with an action to fetch the pull request refs

#### Scenario: Base branch was never fetched
- **WHEN** neither GitHub's base commit nor `origin/release/2.0` exists locally
- **THEN** the default base resolution applies and Change Overview says the pull request base is not available locally, with the fetch action

#### Scenario: Last-commit ignores the pull request
- **WHEN** a pull request is detected and the compare target is `last-commit`
- **THEN** changed files are measured against `HEAD` as before

#### Scenario: Pull request goes away
- **WHEN** the branch is switched to one without a pull request
- **THEN** the next repository update uses the default base resolution again

### Requirement: Fetching pull request refs is explicit and narrow
The fetch action SHALL run only when the user activates it. It SHALL fetch the pull request's base branch and head into remote-tracking refs and object storage, and MUST NOT change the working tree, the index, or any local branch.

#### Scenario: Fetching refs
- **WHEN** the user activates Fetch pull request refs for pull request #42 with base `main`
- **THEN** `origin/main` and the pull request head commit are updated locally and the repository data refreshes
- **AND** the checked-out branch, its files, and other local branches are unchanged

#### Scenario: Fetch fails
- **WHEN** the fetch fails for authentication or network reasons
- **THEN** the failure is shown and the previous comparison remains
