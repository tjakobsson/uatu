## ADDED Requirements

### Requirement: Hub-owned credential processes follow Hub lifecycle
The Hub SHALL start managed credential processes only in dedicated owner-only runtime locations, monitor their readiness, and stop them during graceful shutdown after active clone jobs and workspace sessions no longer need them. Startup or shutdown failure of one optional credential runtime SHALL be reported without signaling ambient processes or corrupting unrelated credentials, and SHALL prevent only capabilities that depend on that runtime.

#### Scenario: Hub shuts down with managed agents
- **WHEN** the Hub begins graceful shutdown with Hub-owned SSH and OpenPGP agents running
- **THEN** active clone jobs and workspace sessions stop before the Hub terminates its owned agents
- **AND** unrelated system agents remain running

## MODIFIED Requirements

### Requirement: Clone prompts are isolated to the job terminal
The hub SHALL run a clone with a dedicated pseudo-terminal for its standard streams so terminal prompts are captured by the job and never use the hub daemon's controlling terminal. For the clone invocation, the hub SHALL prevent ambient Git and SSH askpass programs and ambient Git credential helpers from supplying or displaying requested credentials. It SHALL construct explicit Git and credential configuration that selects the compatible Hub credential chosen for the job; it MUST NOT inherit an external SSH agent or automatically fall back to another stored credential. With no selected credential, or when Git or SSH requires additional interaction, prompts SHALL remain on the job PTY. A response submitted to the job SHALL be written only to its terminal and MUST NOT be persisted, logged, included in job events, returned by an API, or promoted into the credential catalog automatically. This command-level selection MUST NOT be described as isolation when the clone runs under the local backend's shared UID.

#### Scenario: Git cannot prompt through daemon terminal or askpass
- **WHEN** a clone needs a credential that is unavailable from its selected Hub credential context
- **THEN** Git or SSH writes its prompt to the job's pseudo-terminal rather than the daemon's terminal or an ambient askpass or credential helper

#### Scenario: Submitted secret is not retained
- **WHEN** the owner submits a passphrase, password, or token to the clone job
- **THEN** the hub writes it to the pseudo-terminal and discards the request value without logging it or adding it to retained events or stored credentials

#### Scenario: External agent remains available
- **WHEN** the daemon has an external SSH agent while a clone job uses Hub credential management
- **THEN** the clone does not inherit that external agent
- **AND** the external agent remains running and unchanged

#### Scenario: Unselected managed credential is unavailable
- **WHEN** multiple credentials exist and a clone job selects one of them
- **THEN** the clone command is configured to select that credential
- **AND** the Hub does not fall back to another stored or ambient credential

### Requirement: Sessions are started and stopped through a session backend interface
The hub SHALL manage session processes exclusively through a backend interface whose contract is: given a workspace descriptor, base path, and resolved credential assignment context, start a session and return a loopback HTTP endpoint plus the child's session token; and stop a previously started session. Hub components (proxy, dashboard, auth) MUST NOT depend on how the endpoint or credential context is produced. The shipped `local` backend SHALL spawn `uatu serve <folder> --no-open --exit-on-stdin-close --base-path /s/<id>/` with explicit Git, signing, and provider-tool selection derived from the workspace's assignments, parse the tokened URL from the child's first stdout line, hold the child's stdin open for its lifetime, and stop the session via SIGTERM. It MUST NOT forward ambient agent sockets, and normal tool configuration MUST NOT select unassigned stored credentials. Because local sessions share the daemon UID and may share Hub-managed runtime resources, these selections are advisory and MUST NOT be represented as OS-enforced isolation.

#### Scenario: Local backend spawns the session-child contract
- **WHEN** the hub starts a session for a registered workspace with credential assignments
- **THEN** a `uatu serve` child starts with `--no-open --exit-on-stdin-close`, the workspace's base path, and explicit integrations for its assignments
- **AND** the hub records the loopback endpoint parsed from the child's stdout

#### Scenario: Local backend does not inherit ambient agents
- **WHEN** the Hub daemon has an unrelated ambient agent and starts a workspace with no credential assignments
- **THEN** the child receives no Hub or ambient credential integration from session startup

#### Scenario: Hub death cannot orphan children
- **WHEN** the hub process dies without running termination handlers
- **THEN** each child server exits on its own because its standard input reached EOF
