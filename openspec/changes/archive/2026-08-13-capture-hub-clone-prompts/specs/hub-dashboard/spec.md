## MODIFIED Requirements

### Requirement: Dashboard adds folders through a server-side directory browser
The dashboard SHALL offer workspace registration by browsing the hub host's filesystem, not by typing paths: the hub SHALL expose a directory-listing API that, for a given absolute path (defaulting to the daemon user's home), returns its parent and its child directories — each with its name, whether it is a git repository, and its registered workspace id if any — listing directories only and hiding dot-directories. The dashboard SHALL present this as a drill-down browser ending in an "add this folder" action. Filesystem visibility through the browser is within the documented trust model: hub users already hold shell access through the embedded terminal.

Registration SHALL submit the browsed absolute path. Adding a non-git folder SHALL apply the git preflight: the hub probes with `git rev-parse --show-toplevel` and, when the probe definitively reports no repository, answers with a needs-initialization response so the client can confirm and resubmit with initialization requested; on decline the folder MUST NOT be registered or served. When the probe fails for any other reason the hub SHALL skip the offer and start the session, letting the CLI's own git preflight report. The dashboard SHALL additionally offer `git clone <url>` with a browsed destination directory and an optional single-folder checkout name, defaulting to the name derived from the remote when omitted, then register and serve the resulting folder. Clone SHALL rely on the daemon user's ambient Git configuration and already-loaded SSH agent keys, but MUST NOT use Git credential helpers or GUI askpass programs for credentials requested by the clone. The hub MUST NOT persist credentials supplied during cloning and MUST NOT pass `--force` to the server.

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
- **WHEN** the user submits a repository URL and picks a destination directory in the browser
- **THEN** the hub starts an observable clone into that directory, registers the result with a stable id after the clone succeeds, and starts its session

#### Scenario: Clone with a custom checkout folder
- **WHEN** the user submits a repository URL with a valid custom checkout folder name
- **THEN** the hub clones into that folder rather than the name derived from the remote
- **AND** path-like names and dot segments are rejected before a clone job starts

#### Scenario: Already-loaded SSH key is used without prompting
- **WHEN** the clone URL uses SSH and the daemon user's existing SSH agent can authenticate with an already-loaded key
- **THEN** the clone uses that agent and completes without asking the user to enter the key passphrase again

#### Scenario: Failed clone or init is reported
- **WHEN** `git clone` or `git init` exits non-zero
- **THEN** the dashboard shows the Git error output and no workspace is registered

### Requirement: Dashboard handles interactive clone progress
The dashboard SHALL show live terminal output and current phase for an in-progress clone and SHALL provide an always-available masked response input that writes one response to the clone terminal without displaying or retaining the submitted value. Recognizing a common credential, trust, or verification prompt MAY focus or label the response input, but unrecognized terminal prompts MUST remain answerable. The dashboard SHALL provide cancellation while the clone is active and SHALL report cancellation, timeout, clone failure, registration or session-start failure, and successful completion distinctly. On successful registration and session start, the dashboard SHALL navigate to the resulting workspace session. Once a clone reaches any terminal outcome, the prompt input and cancellation controls SHALL no longer appear active, while failure output remains visible and the clone form is available for retry.

#### Scenario: SSH passphrase is answered in the dashboard
- **WHEN** SSH requests the passphrase for a key that is not unlocked in the retained agent
- **THEN** the prompt appears in the clone output and the user can submit the passphrase through the masked response input
- **AND** the submitted passphrase is not added to the visible output

#### Scenario: HTTPS credentials are answered in the dashboard
- **WHEN** an HTTPS remote requests a username, password, or token
- **THEN** the prompt appears in the clone output and the user can submit each requested value through the response input

#### Scenario: Unrecognized prompt remains answerable
- **WHEN** Git or SSH emits an interactive prompt the dashboard does not recognize
- **THEN** the user can still read it in the streamed output and submit a response

#### Scenario: User cancels a clone
- **WHEN** the user activates cancel while a clone is running or waiting for input
- **THEN** the clone terminates, the dashboard reports it as cancelled, and no workspace is registered

#### Scenario: Clone fails and can be retried
- **WHEN** the clone reaches a failure or timeout
- **THEN** its output and terminal status remain visible
- **AND** prompt input and cancellation are hidden while the clone form is available for retry

#### Scenario: Clone succeeds after interaction
- **WHEN** the user supplies the required responses and the clone, registration, and session start all succeed
- **THEN** the dashboard reports completion and navigates to the new workspace session
