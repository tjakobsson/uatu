## ADDED Requirements

### Requirement: A pull request can be opened in its own worktree
A Hub workspace SHALL be able to open any open pull request for review in a linked worktree of the repository's main workspace. A same-repository pull request SHALL use the existing remote-tracking mode for its head branch, or the existing local branch of that name as it is. A pull request from a fork SHALL use a `pull-request` creation mode that fetches `refs/pull/<number>/head`.

#### Scenario: Same-repository pull request
- **WHEN** the user asks to review pull request #42, whose head is `acme:feature/login`, in a worktree
- **THEN** the Hub fetches the remote and creates a worktree on local branch `feature/login` tracking `origin/feature/login`, under the existing destination and conflict rules
- **AND** the user stays where they are, and a notice `feature/login is ready.` offers Go to

#### Scenario: Pull request from a fork
- **WHEN** the user asks to review pull request #57, whose head is in `someone/widgets`, in a worktree
- **THEN** the Hub fetches `refs/pull/57/head` from the base repository's remote with the parent's credentials and creates a worktree on local branch `pr/57`, whose upstream is `refs/pull/57/head` on that remote
- **AND** a pull in the new checkout brings in the pull request's new commits, and the new workspace detects pull request #57

#### Scenario: Pull request already has a checkout
- **WHEN** a checkout of the pull request's local branch already exists
- **THEN** Go to its worktree for that checkout is offered instead of creating another

#### Scenario: Local pull request branch exists without a checkout
- **WHEN** local branch `pr/57` exists, is not checked out, and has upstream `refs/pull/57/head`
- **THEN** the worktree is created on that branch without resetting or fast-forwarding it, and any difference from the pull request head is reported

#### Scenario: Name taken by an unrelated branch
- **WHEN** local branch `pr/57` exists with a different upstream, or none
- **THEN** creation is refused without reset or force, and the error says `A branch named pr/57 already exists and does not track pull request #57 on origin.`

#### Scenario: Interrupted creation
- **WHEN** the Hub stops after `pr/57` was made and before its checkout
- **THEN** restart recovery reports that nothing was created, the branch keeps its pull request upstream, and the next attempt checks that branch out as it is

### Requirement: The pull-request creation mode is validated and narrow
The `pull-request` mode SHALL accept only a positive pull request number and the name of one of the parent checkout's configured remotes, and no base. It SHALL fetch only that pull request's head ref, without prompting, MUST NOT force or reset, and SHALL record `refs/pull/<number>/head` as the creation origin of a branch it creates.

#### Scenario: Invalid number or remote
- **WHEN** a request names pull request `0`, a non-integer, or a remote name that is not a plain name
- **THEN** the Hub refuses it before running Git
- **AND** a well-formed remote the parent does not have is refused before any fetch, and nothing is created

#### Scenario: Pull request head does not exist
- **WHEN** the remote has no `refs/pull/<number>/head`
- **THEN** no branch or checkout is created and the error says the pull request was not found on the remote, and that the remote may not be the pull request's GitHub repository

#### Scenario: Not available outside a Hub
- **WHEN** the workspace is not served by a Hub
- **THEN** no action to open a pull request in a worktree is offered
