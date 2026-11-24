## ADDED Requirements

### Requirement: An open pull request supplies the base
When a repository's checked-out branch has an open pull request, the `base` target SHALL measure from the merge base of HEAD and the pull request's base: GitHub's base commit when it exists locally, otherwise the local remote-tracking base branch, marked possibly stale. The anchor SHALL name `<remote>/<baseRefName>`. Without either ref, the default resolution SHALL apply, flagged.

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
- **WHEN** the branch is switched to one without an open pull request
- **THEN** the next repository update uses the default base resolution again

#### Scenario: A merged or closed pull request supplies no base
- **WHEN** the pull request detected for the checked-out branch is merged or closed
- **THEN** the `base` target uses the default base resolution

### Requirement: Fetching pull request refs is explicit and narrow
The fetch action SHALL run only when the user activates it. It SHALL fetch the pull request's head (`refs/pull/<n>/head` on the base repository's remote) into the private ref `refs/uatu/pull/<n>/head` and object storage, and fetch the base branch only when a comparison or the base revision needs it. It MUST NOT change the working tree, the index, any local branch, or any remote-tracking ref. Uatu SHALL keep at most 20 `refs/uatu/pull/*` refs per repository, pruned at each fetch.

#### Scenario: Fetching a pull request's head
- **WHEN** the user activates Fetch for pull request #42 (the file view's card, All files, or Change Overview's fetch action)
- **THEN** `git -c fetch.fsckObjects=true fetch --no-tags <remote> +refs/pull/42/head:refs/uatu/pull/42/head` runs with the session's Git credentials and `GIT_TERMINAL_PROMPT=0`, and #42's head commit is local
- **AND** the checked-out branch, its files, the index, other local branches and remote-tracking refs are unchanged

#### Scenario: The base is fetched when needed
- **WHEN** the base comparison or the file view's base revision needs a base commit that isn't local
- **THEN** the same explicit action also fetches the base branch, into its remote-tracking ref

#### Scenario: The private refs stay bounded and out of the way
- **WHEN** heads of more than 20 pull requests of one repository have been fetched
- **THEN** at the next successful fetch, the refs of pull requests read as merged or closed are deleted, then the oldest by their head commit's committer date until at most 20 remain; the ref just fetched is never deleted
- **AND** the refs are outside every refspec, so `git fetch --prune` leaves them alone; they show in `git log --all` and are shared by the repository's linked worktrees

#### Scenario: A shallow repository
- **WHEN** the repository is shallow (`git rev-parse --is-shallow-repository`)
- **THEN** the fetch adds `--depth=1`

#### Scenario: The branch's own pull request needs no fetch
- **WHEN** the pull request's head commit is already local, as it usually is for the checked-out branch's own pull request
- **THEN** nothing is fetched and no card asks for it

#### Scenario: Fetch fails
- **WHEN** the fetch fails for authentication or network reasons
- **THEN** the failure is shown, the previous comparison remains, and the file view points to Open on GitHub ↗
