## ADDED Requirements

### Requirement: Settings manages Hub credentials and tool readiness
The authenticated `/settings` page SHALL provide a Credentials area that lists credential type, declared purpose, public identifier, lock/readiness state, workspace assignments, and required-tool status. Credential cards SHALL be collapsed by default, retain their expanded state across catalog refreshes, and summarize name, type, enabled state, useful lock state, aggregate readiness, and deduplicated assigned workspace names and count without interactive controls in the summary. Expanded cards SHALL provide generate, import, unlock, lock, disable, test, and delete actions as applicable to each credential type, use masked inputs for every submitted secret, and never redisplay stored private keys or tokens. Assignment management SHALL be workspace-oriented and collapsed by default: workspaces with assignments SHALL list their authentication and signing credentials with role icons and removal controls, while one form SHALL keep a stable layout and allow any registered workspace to receive separate authentication and signing credentials together. The form SHALL state its default-replacement behavior and keep its authentication-host control visible but disabled until an authentication credential is selected. Missing or incompatible tooling SHALL show an actionable explanation, detected path, optional absolute-path override, and Test action. The shared-UID advisory SHALL appear on `/settings` and `/clone`, use one per-user browser dismissal key across both pages, and SHALL NOT require repeated confirmation during assignment. The dashboard SHALL contain sessions and workspaces only, apart from shared chrome, and shared navigation SHALL link Dashboard, Clone, Settings, and sign out.

Credential create/import forms, each credential card action and assignment area, and each tool override row SHALL have a contextual alert for failures from their own controls. The page-level alert SHALL be reserved for load failures. SSH import SHALL prefer a file upload, retain paste as a secondary option, require exactly one source, reject files larger than 1 MiB before reading them, and clear file and secret inputs after each attempt.

Running and stopped workspace rows SHALL show a neutral summary of assigned authentication and signing credential names, deduplicated by role, or `No credentials assigned` when both roles are empty. Before starting or resuming a stopped workspace with no assignments, the dashboard SHALL use a native confirmation that Git authentication and signing may be unavailable but the workspace can still start. Cancelling MUST NOT start it. The dashboard MUST NOT show this confirmation when any assignment exists and MUST NOT treat assignment presence as credential readiness. If assigned credentials require an unlock, Resume SHALL request their passphrases in a contextual dialog and continue the same start operation after every unlock succeeds. Disabled or otherwise unavailable assigned credentials remain startup errors.

#### Scenario: User tests a configured signing tool
- **WHEN** an authenticated user opens Credentials, configures a signing-tool path, and activates Test
- **THEN** settings reports binary, agent, and signing readiness separately with sanitized diagnostics

#### Scenario: Stored token is never redisplayed
- **WHEN** a user returns to a saved HTTPS/provider credential
- **THEN** settings shows its host, capabilities, state, and assignments
- **AND** no API response or form value contains the saved token

#### Scenario: SSH import validates its source locally
- **WHEN** a user submits both an uploaded key and pasted key, neither source, or an uploaded file larger than 1 MiB
- **THEN** settings reports the error next to the SSH import controls without reading an oversized file or using the page-level error

#### Scenario: User resumes a workspace without credential assignments
- **WHEN** a stopped workspace has no authentication or signing assignments and the user activates Resume
- **THEN** the dashboard asks whether to continue without assigned Git authentication or signing
- **AND** cancelling leaves the workspace stopped while continuing uses the normal start operation

#### Scenario: Assigned credential is not treated as missing
- **WHEN** a stopped workspace has any credential assignment whose credential is locked, disabled, or unavailable
- **THEN** the dashboard does not show the no-assignment confirmation
- **AND** a locked credential opens a masked unlock dialog that resumes the workspace after successful unlock
- **AND** backend startup validation reports a disabled or otherwise unavailable credential

## MODIFIED Requirements

### Requirement: Clone page adds folders through a server-side directory browser
The authenticated `/clone` page SHALL offer workspace registration by browsing the hub host's filesystem, not by typing paths: the hub SHALL expose a directory-listing API that, for a given absolute path (defaulting to the daemon user's home), returns its parent and its child directories — each with its name, whether it is a git repository, and its registered workspace id if any — listing directories only and hiding dot-directories. The clone page SHALL present this as a drill-down browser ending in an "add this folder" action. Filesystem visibility through the browser is within the documented trust model: hub users already hold shell access through the embedded terminal.

Registration SHALL submit the browsed absolute path. Adding a non-git folder SHALL apply the git preflight: the hub probes with `git rev-parse --show-toplevel` and, when the probe definitively reports no repository, answers with a needs-initialization response so the client can confirm and resubmit with initialization requested; on decline the folder MUST NOT be registered or served. When the probe fails for any other reason the hub SHALL skip the offer and start the session, letting the CLI's own git preflight report. The clone page SHALL additionally offer `git clone <url>` with a browsed destination directory, an optional single-folder checkout name defaulting to the name derived from the remote, and an optional compatible Hub credential fetched independently from the public credential API. A selected credential SHALL become the clone command's configured identity and MAY be retained as an assignment after successful registration; with no selected credential, the existing interactive PTY flow SHALL remain available. Clone MUST NOT inherit an ambient external SSH agent, automatically fall back to an unselected stored credential, persist interactively supplied credentials, or pass `--force` to the server. The local-backend warning SHALL make clear that same-UID processes can bypass this normal tool configuration.

#### Scenario: Browsing to and adding a folder
- **WHEN** the user drills into `~/src`, selects a git repository folder, and confirms adding it
- **THEN** the hub registers the folder with a stable id and starts its session

#### Scenario: Registered folders are marked while browsing
- **WHEN** the directory browser lists a folder that is already a registered workspace
- **THEN** the listing shows it as registered rather than offering to add it again

#### Scenario: Non-git folder is initialized and served
- **WHEN** the user adds a folder that is not inside a git worktree and confirms initialization
- **THEN** the hub runs `git init` there, registers the workspace, and starts its session

#### Scenario: Declined initialization leaves no trace
- **WHEN** the user adds a non-git folder and declines initialization
- **THEN** no session starts and the folder is not added to the registry

#### Scenario: Clone into a browsed destination
- **WHEN** the user submits a repository URL, picks a destination directory, and selects a compatible Hub credential
- **THEN** the hub starts an observable clone configured to select that credential, registers the result with a stable id after the clone succeeds, and starts its session

#### Scenario: Clone with a custom checkout folder
- **WHEN** the user submits a repository URL with a valid custom checkout folder name
- **THEN** the hub clones into that folder rather than the name derived from the remote
- **AND** path-like names and dot segments are rejected before a clone job starts

#### Scenario: Already-loaded SSH key is used without prompting
- **WHEN** the clone URL uses SSH and the selected Hub SSH credential is unlocked and usable
- **THEN** the clone uses the Hub-managed agent and completes without asking for the key passphrase again

#### Scenario: Failed clone or init is reported
- **WHEN** `git clone` or `git init` exits non-zero
- **THEN** the clone page shows the Git error output and no workspace is registered

### Requirement: Clone page handles interactive clone progress
The authenticated `/clone` page SHALL show live terminal output and current phase for an in-progress clone and SHALL provide an always-available masked response input that writes one response to the clone terminal without displaying or retaining the submitted value. Recognizing a common credential, trust, or verification prompt MAY focus or label the response input, but unrecognized terminal prompts MUST remain answerable. The clone page SHALL provide cancellation while the clone is active and SHALL report cancellation, timeout, clone failure, registration or session-start failure, and successful completion distinctly. On successful registration and session start, the clone page SHALL navigate to the resulting workspace session. Once a clone reaches any terminal outcome, the prompt input and cancellation controls SHALL no longer appear active, while failure output remains visible and the clone form is available for retry. Unlocking a selected stored credential SHALL use the credential operation's masked secret path; responses entered into the clone PTY SHALL remain one-operation inputs and MUST NOT silently create or update a stored credential.

#### Scenario: Selected credential requires unlock
- **WHEN** a selected stored credential is locked when the user submits a clone
- **THEN** the clone page requests an unlock through the credential flow before starting Git
- **AND** the passphrase is not written to clone output or retained as clone input

#### Scenario: SSH passphrase is answered on the clone page
- **WHEN** an SSH clone with no selected stored credential prompts for a private-key passphrase
- **THEN** the prompt appears in clone output and the user can submit the passphrase through the masked response input
- **AND** the submitted passphrase is neither displayed nor added to the Hub credential catalog

#### Scenario: HTTPS credentials are answered on the clone page
- **WHEN** an HTTPS remote with no selected stored credential requests a username, password, or token
- **THEN** the prompt appears in the clone output and the user can submit each requested value through the response input
- **AND** the submitted values are not stored automatically

#### Scenario: Unrecognized prompt remains answerable
- **WHEN** Git or SSH emits an interactive prompt the clone page does not recognize
- **THEN** the user can still read it in the streamed output and submit a response

#### Scenario: User cancels a clone
- **WHEN** the user activates cancel while a clone is running or waiting for input
- **THEN** the clone terminates, the clone page reports it as cancelled, and no workspace is registered

#### Scenario: Clone fails and can be retried
- **WHEN** the clone reaches a failure or timeout
- **THEN** its output and terminal status remain visible
- **AND** prompt input and cancellation are hidden while the clone form is available for retry

#### Scenario: Clone succeeds after interaction
- **WHEN** the user supplies the required responses and the clone, registration, and session start all succeed
- **THEN** the clone page reports completion and navigates to the new workspace session
