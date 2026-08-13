## ADDED Requirements

### Requirement: Hub manages clone operations as authenticated jobs
The hub SHALL execute each repository clone as an in-memory job owned by the authenticated user who created it. Creation SHALL return a non-blocking job identifier; the owner SHALL be able to receive a bounded replayable stream of job output and state, submit terminal responses, and cancel the job. Another user MUST NOT be able to observe or control the job. Input and cancellation SHALL be POST operations protected like other state-changing hub endpoints. Completed jobs and their bounded output SHALL expire automatically and MUST NOT survive a hub restart.

#### Scenario: Clone creation does not hold one request open
- **WHEN** an authenticated user starts a clone
- **THEN** the hub promptly returns a job identifier while cloning continues independently

#### Scenario: Owner reconnects to clone output
- **WHEN** the owner's output stream disconnects and reconnects while the job is retained
- **THEN** the hub replays the bounded retained events and continues streaming new events without restarting the clone

#### Scenario: Another user cannot access a clone job
- **WHEN** a different authenticated user requests the job's output or attempts to send input or cancel it
- **THEN** the hub reveals no job data and does not alter the job

#### Scenario: Mutating clone operation is cross-origin
- **WHEN** a cookie-authenticated cross-origin request attempts to create, answer, or cancel a clone job
- **THEN** the hub rejects it without starting or altering a clone

### Requirement: Clone prompts are isolated to the job terminal
The hub SHALL run a clone with a dedicated pseudo-terminal for its standard streams so terminal prompts are captured by the job and never use the hub daemon's controlling terminal. For the clone invocation, the hub SHALL prevent Git and SSH askpass programs and Git credential helpers from supplying or displaying requested credentials. It SHALL retain access to an existing SSH agent so already-loaded keys continue to work. The hub's no-GUI guarantee SHALL cover Git and SSH prompt mechanisms under its control; behavior independently initiated by the retained external SSH agent is outside that guarantee. A response submitted to the job SHALL be written only to its terminal and MUST NOT be persisted, logged, included in job events, or returned by an API.

#### Scenario: Git cannot prompt through daemon terminal or askpass
- **WHEN** a clone needs a credential that is unavailable from an already-loaded SSH agent
- **THEN** Git or SSH writes its prompt to the job's pseudo-terminal rather than the daemon's terminal or a Git/SSH askpass GUI

#### Scenario: Submitted secret is not retained
- **WHEN** the owner submits a passphrase, password, or token to a clone job
- **THEN** the hub writes it to the pseudo-terminal and discards the request value without logging it or adding it to retained events

#### Scenario: External agent remains available
- **WHEN** the daemon has an SSH agent and the agent already holds a usable key
- **THEN** the clone can authenticate through that agent without requiring the key to be loaded again

### Requirement: Clone jobs are bounded and cleaned up
The hub SHALL enforce an inactivity timeout and a hard lifetime for active clone jobs. Cancellation, timeout, hub shutdown, or clone failure SHALL terminate the clone's whole process group with bounded graceful-to-forced escalation so Git, SSH, and their descendants cannot remain orphaned. The hub SHALL reserve a clone target while its job is active so concurrent jobs cannot target the same checkout. It SHALL register a workspace only after a successful clone, SHALL release all reservations and terminal resources on every terminal outcome, and SHALL terminate all active clone jobs during graceful hub shutdown.

#### Scenario: Credential prompt is abandoned
- **WHEN** a clone waits without output or input beyond the inactivity limit
- **THEN** the job becomes timed out, its process group is terminated, and no workspace is registered

#### Scenario: Clone exceeds its hard lifetime
- **WHEN** a clone continues producing activity beyond the maximum job lifetime
- **THEN** the hub terminates it and reports a timeout rather than allowing it to run indefinitely

#### Scenario: Cancellation reaps SSH descendants
- **WHEN** an active `git clone` has spawned SSH and the owner cancels the job
- **THEN** both Git and SSH are terminated within the bounded shutdown period

#### Scenario: Hub shuts down during clone
- **WHEN** the hub begins graceful shutdown with active clone jobs
- **THEN** it terminates and awaits those jobs before exiting

#### Scenario: Concurrent jobs choose the same target
- **WHEN** one active clone has reserved a target and another clone requests that target
- **THEN** the second request is rejected without spawning Git

#### Scenario: Session start fails after clone
- **WHEN** cloning and registration succeed but the workspace session fails to start
- **THEN** the hub removes the registration, reports the start failure, and leaves the successfully cloned checkout on disk
