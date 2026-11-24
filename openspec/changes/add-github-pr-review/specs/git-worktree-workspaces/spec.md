## ADDED Requirements

### Requirement: A pull request can be opened in its own worktree
A Hub workspace SHALL be able to open any open pull request for review in a linked worktree of the repository's main workspace. A same-repository pull request SHALL use the existing remote-tracking mode for its head branch. A pull request from a fork SHALL use a `pull-request` creation mode that fetches `refs/pull/<number>/head`.

#### Scenario: Same-repository pull request
- **WHEN** the user asks to review pull request #42, whose head is `acme:feature/login`, in a worktree
- **THEN** the Hub fetches the remote and creates a worktree on local branch `feature/login` tracking `origin/feature/login`, under the existing destination and conflict rules
- **AND** the existing `Created feature/login` confirmation offers Open

#### Scenario: Pull request from a fork
- **WHEN** the user asks to review pull request #57, whose head is in `someone/widgets`, in a worktree
- **THEN** the Hub fetches `refs/pull/57/head` from the base repository's remote with the parent's credentials and creates a worktree on local branch `pr/57`, whose upstream is `refs/pull/57/head` on that remote
- **AND** the new workspace detects pull request #57

#### Scenario: Pull request already has a checkout
- **WHEN** a checkout of the pull request's local branch already exists
- **THEN** Open for that checkout is offered instead of creating another

#### Scenario: Local pull request branch exists without a checkout
- **WHEN** local branch `pr/57` exists, is not checked out, and has upstream `refs/pull/57/head`
- **THEN** the worktree is created on that branch without resetting it, and any difference from the pull request head is reported

#### Scenario: Name taken by an unrelated branch
- **WHEN** local branch `pr/57` exists with a different upstream
- **THEN** creation is refused without reset or force and the conflict is explained

### Requirement: The pull-request creation mode is validated and narrow
The `pull-request` mode SHALL accept only a positive pull request number and the name of one of the parent checkout's configured remotes. It SHALL fetch only that pull request's head ref, MUST NOT force or reset, and SHALL record `refs/pull/<number>/head` as the creation origin.

#### Scenario: Invalid number or remote
- **WHEN** a request names pull request `0`, a non-integer, or a remote the parent does not have
- **THEN** the Hub refuses it before running Git

#### Scenario: Pull request head does not exist
- **WHEN** the remote has no `refs/pull/<number>/head`
- **THEN** no branch or checkout is created and the error says the pull request was not found on the remote

#### Scenario: Not available outside a Hub
- **WHEN** the workspace is not served by a Hub
- **THEN** no action to open a pull request in a worktree is offered
