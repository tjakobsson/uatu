# hub-service Specification

## Purpose

Define the uatu hub daemon: a long-running service that keeps a persistent workspace registry (absolute paths, stable session ids), starts and stops `uatu serve` sessions through a pluggable session backend, reverse-proxies session traffic (HTTP and WebSocket) under `/s/<id>/` prefixes behind hub-terminated TLS, and delivers live updates to each page over one brokered stream it fans out from the sessions' internal event routes — so one authenticated origin fronts many loopback-bound sessions — plus a self-hosting runbook covering real certificate and startup paths.

## Requirements

### Requirement: Hub reports its public API compatibility identity
The Hub SHALL expose an authenticated machine-readable compatibility identity containing its public Hub API revision and workspace payload revision. These revisions SHALL identify wire-contract compatibility independently from product version and source-build identity and correspond to published contract metadata. Clients MUST NOT need to infer compatibility from a display-formatted version string.

#### Scenario: Compatibility identity describes forwarded workspace payloads
- **WHEN** a client reads the authenticated compatibility identity
- **THEN** the workspace revision SHALL version workspace-owned payload schemas forwarded on the Hub live stream
- **AND** workspace routes behind the Hub SHALL remain internal and carry no public revision

#### Scenario: Native client probes Hub compatibility
- **WHEN** an authenticated native client requests Hub state
- **THEN** the response identifies the Hub API revision and the workspace payload revision as machine-readable values
- **AND** the values can be matched to published contract revisions

#### Scenario: Product release does not imply a contract break
- **WHEN** the product version changes without an incompatible Hub or workspace wire-contract change
- **THEN** the corresponding public API revision remains unchanged

### Requirement: Hub manages clone operations as authenticated jobs
The hub SHALL execute each repository clone as an in-memory job owned by its authenticated creator. Creation SHALL return a non-blocking job identifier. The owner SHALL be able to receive bounded replayable output/state, submit terminal responses, and cancel the job; another user MUST NOT observe or control it.

#### Scenario: A clone receives input or cancellation
- **WHEN** the owner submits input or cancellation
- **THEN** those operations SHALL use POST with the protection applied to other state-changing hub endpoints

#### Scenario: Completed clone jobs expire without owner interaction
- **WHEN** a clone job completes, whether or not the owner submitted input or cancellation
- **THEN** the job and its bounded output SHALL expire automatically and MUST NOT survive a hub restart

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
The hub SHALL run each clone's standard streams through a dedicated pseudo-terminal, capturing prompts in the job rather than the daemon's controlling terminal. Clone credential selection SHALL be explicit, and submitted responses SHALL remain terminal-only under the rules below. Command-level selection MUST NOT be described as isolation under the local backend's shared UID.

#### Scenario: Git or SSH requests credentials for a clone
- **WHEN** a clone invokes Git or SSH
- **THEN** the hub SHALL prevent ambient Git/SSH askpass programs and ambient Git credential helpers from supplying or displaying requested credentials
- **AND** explicit Git and credential configuration SHALL select the compatible Hub credential chosen for the job; the clone MUST NOT inherit an external SSH agent or automatically fall back to another stored credential
- **AND** with no selected credential or when additional Git/SSH interaction is required, prompts SHALL remain on the job PTY

#### Scenario: A clone terminal response contains a secret
- **WHEN** a response is submitted to the job
- **THEN** it SHALL be written only to that terminal and MUST NOT be persisted, logged, included in job events, returned by an API, or automatically promoted into the credential catalog

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

### Requirement: Clone jobs are bounded and cleaned up
The hub SHALL enforce inactivity and hard-lifetime limits for active clone jobs and reserve each target against concurrent jobs. Cancellation, timeout, shutdown, or failure SHALL terminate the whole process group with bounded graceful-to-forced escalation, preventing orphaned Git, SSH, and descendants.

#### Scenario: A clone reaches a terminal outcome or the hub shuts down
- **WHEN** a clone succeeds, fails, times out, or is cancelled
- **THEN** the hub SHALL register a workspace only after successful cloning and SHALL release all reservations and terminal resources on every terminal outcome

#### Scenario: Hub shutdown terminates active clone jobs
- **WHEN** the hub shuts down gracefully while clones are active
- **THEN** it SHALL terminate all active clone jobs

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

### Requirement: Hub durably stores personal workspace state
The Hub SHALL persist personal workspace-state records in its state directory separately from the workspace registry and project files. Records SHALL be keyed by authenticated user and stable workspace id, SHALL use serialized atomic writes, and SHALL survive Hub and child-session restarts. Forgetting a workspace SHALL remove personal state for that workspace for every user.

#### Scenario: Workspace state survives restart
- **WHEN** personal state is saved and the Hub restarts
- **THEN** the state remains associated with the same user and stable workspace id

#### Scenario: Forget removes associated state
- **WHEN** a stopped workspace is forgotten
- **THEN** its registry entry and every associated personal-state record are removed atomically from the user's perspective

### Requirement: Workspace personal-state routes terminate at the Hub
The Hub SHALL handle the personal-state API under `/s/<workspace-id>/` before generic session proxying. It MUST derive user and workspace identity from the authenticated request and matched stable prefix, MUST NOT trust client-supplied identity, and MUST NOT forward these requests or child credentials to the watch child. Other workspace traffic SHALL continue through the existing proxy.

#### Scenario: Personal-state request is not proxied
- **WHEN** an authenticated client requests the personal-state endpoint for a registered workspace
- **THEN** the Hub serves it from durable Hub state
- **AND** the child receives no request

#### Scenario: Session traffic still proxies normally
- **WHEN** the same client requests document state or terminal transport
- **THEN** the Hub forwards that traffic according to the existing proxy contract
- **AND** the client's live updates arrive over the Hub's brokered live stream, not through a proxied workspace SSE route

### Requirement: The binary provides a hub daemon subcommand
The `uatu` binary SHALL provide a `hub` subcommand starting a long-running daemon from a configuration file (listen port, TLS certificate/key paths, users, state directory override), suitable for systemd or launchd supervision. Registry and secrets SHALL persist under an XDG-resolved state directory, with owner-only secret-bearing files.

#### Scenario: Hub configuration or termination is processed
- **WHEN** the hub starts from configuration
- **THEN** configuration SHALL NOT define a workspaces root: registration SHALL use absolute paths, and a removed `workspacesDir` key SHALL cause rejection with an error naming it

#### Scenario: A termination signal stops every running session
- **WHEN** the hub receives SIGTERM or SIGINT
- **THEN** it SHALL stop every running session and exit cleanly

#### Scenario: Hub starts from a config file
- **WHEN** `uatu hub --config <path>` starts with a valid configuration
- **THEN** the daemon listens on the configured port and serves the dashboard
- **AND** its registry and session store live in the state directory with owner-only permissions

#### Scenario: Graceful shutdown stops children
- **WHEN** the hub receives SIGTERM while sessions are running
- **THEN** every child server process is terminated before the hub exits

#### Scenario: A configuration with the removed workspacesDir key fails startup
- **WHEN** `uatu hub` starts with a configuration file containing `workspacesDir`
- **THEN** startup fails with an error naming the removed key

### Requirement: The hub exits when its standard input closes
The `hub` subcommand SHALL accept `--exit-on-stdin-close`: when set, the hub SHALL hold its standard input open and, on EOF, perform the same graceful shutdown as SIGTERM (stop every running session, then exit). This is the orphan backstop for supervising processes that die without signaling, matching the contract `uatu serve` already provides.

#### Scenario: Supervisor death cannot orphan the hub
- **WHEN** a hub started with `--exit-on-stdin-close` sees EOF on its standard input while sessions are running
- **THEN** every child session process is terminated and the hub exits

### Requirement: Workspaces are registered with stable identifiers and a backend field
The hub SHALL persist a registry whose entries record a stable workspace id, mutable display name, absolute canonical source folder, and session backend identifier. Registration SHALL require an absolute path to an existing directory. Identity, backend, and persistence SHALL follow the rules below.

#### Scenario: A workspace receives its permanent identity
- **WHEN** a workspace is registered
- **THEN** its id SHALL be a folder-name-derived slug, suffixed on collision, and never change once assigned, preserving `/s/<id>/…` URLs across Hub/session restarts, folder renames, and display-name changes
- **AND** display names SHALL default from the folder basename but SHALL NOT determine identity or uniqueness
- **AND** only `local` SHALL be a valid backend in this change; the backend field SHALL remain in the schema so additional backends are additive

#### Scenario: Registry writes overlap or a saved folder disappears
- **WHEN** the registry is written, including non-overlapping mutations
- **THEN** persistence SHALL be serialized and atomic: writes may not interleave or allow an older snapshot to finish last, and a crash mid-write MUST NOT corrupt the file

#### Scenario: Hub startup retains registrations whose folders are missing
- **WHEN** the Hub starts and reads the registry
- **THEN** it MUST NOT prune entries based on location; a missing folder SHALL remain registered and fail to start rather than be silently forgotten

#### Scenario: Workspace id is stable across restarts
- **WHEN** a workspace display name and source folder are renamed and the Hub restarts
- **THEN** the workspace retains its original id and `/s/<id>/` prefix
- **AND** it exposes the new display name and source path

#### Scenario: Slug collision is suffixed
- **WHEN** two workspaces with the same folder name are registered
- **THEN** the second receives a distinct suffixed id and the first keeps its id

#### Scenario: Arbitrary absolute paths are registrable
- **WHEN** workspaces at `~/src/uatu` and `~/Documents/notes` are registered while another default parent is configured
- **THEN** both appear in the registry with stable ids and user-facing display names and both sessions are servable

#### Scenario: A relative or missing path is rejected
- **WHEN** a registration request names a relative path or a path that is not an existing directory
- **THEN** the Hub rejects it and the registry is unchanged

### Requirement: Sessions are started and stopped through a session backend interface
The hub SHALL manage sessions exclusively through a backend interface: given a workspace descriptor, base path, and resolved credential assignments, start and return a loopback HTTP endpoint plus child session token; or stop a previously started session. Proxy, dashboard, and auth MUST NOT depend on how the endpoint or credential context is produced.

#### Scenario: The local backend starts and stops a workspace session
- **WHEN** the shipped `local` backend starts a session
- **THEN** it SHALL spawn `uatu serve <folder> --no-open --exit-on-stdin-close --base-path /s/<id>/` with explicit Git, signing, SSH-client, and provider-tool selection derived from workspace assignments
- **AND** it SHALL parse the tokened URL from the child's first stdout line, hold stdin open for the child's lifetime, and stop the session via SIGTERM
- **AND** it MUST NOT forward ambient agent sockets, and normal tool configuration MUST NOT select unassigned stored credentials
- **AND** because sessions share the daemon UID and may share Hub-managed runtime resources, these advisory selections MUST NOT be represented as OS-enforced isolation

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

### Requirement: All session traffic is reverse-proxied under the workspace prefix
The hub SHALL proxy workspace traffic under `/s/<id>/` to its loopback endpoint for HTTP and WebSocket upgrades, except the per-stream SSE routes below. Hub-served live updates SHALL use brokered fanout with one subscription per child topic, bounding outbound live connections by watched topics rather than clients. Children SHALL bind loopback only and MUST NOT be directly network-reachable.

#### Scenario: A browser requests a per-stream SSE route through the hub
- **WHEN** a request targets `/s/<id>/api/events`, `/s/<id>/api/chat/conversations/events`, or `/s/<id>/api/chat/conversations/<conversation>/events`
- **THEN** it SHALL NOT be proxied and SHALL receive a non-cached error naming the brokered live stream as replacement
- **AND** child event routes SHALL remain the internal source for hub subscriptions, not one child stream per browser stream

#### Scenario: A proxied WebSocket closes or a workspace is unavailable
- **WHEN** WebSocket messages or close events traverse a workspace proxy
- **THEN** they SHALL be forwarded both ways, preserving application close codes including terminal 4001, 4409, and 4410

#### Scenario: Any proxied request targets an unknown or stopped workspace
- **WHEN** a request targets an unknown or stopped workspace, whether HTTP or WebSocket
- **THEN** it SHALL receive a non-cached error response linking to the dashboard

#### Scenario: A session round-trips through the hub
- **WHEN** an authenticated browser requests `/s/uatu/api/state`
- **THEN** the hub forwards the request to that session's loopback endpoint and streams the response back

#### Scenario: Live updates are brokered, not proxied per client
- **WHEN** three authenticated tabs view the same running workspace's page
- **THEN** the hub holds one upstream subscription per watched topic of that workspace
- **AND** each tab receives updates over its own single brokered stream

#### Scenario: A per-stream route is refused through the hub
- **WHEN** a client requests `/s/uatu/api/events` through the hub
- **THEN** the hub answers with a non-cached error that names the brokered live stream as the replacement
- **AND** no request reaches the child

#### Scenario: Terminal WebSocket transits the hub
- **WHEN** an authenticated browser upgrades `/s/uatu/api/terminal?sessionId=<uuid>` and later the PTY is killed via the session inventory
- **THEN** bytes flow both directions through the hub during the session
- **AND** the client observes the same close code it would observe connecting directly

#### Scenario: Stopped workspace prefix explains itself
- **WHEN** a browser requests a `/s/<id>/` URL whose session is not running
- **THEN** the hub responds with an error page linking to the dashboard rather than a bare connection failure

#### Scenario: Remote transfers are compressed and bundle assets cached
- **WHEN** a browser that accepts gzip loads a session's bundled script chunk through the hub
- **THEN** the response is gzip-compressed and marked immutable with long-lived caching
- **AND** a revalidation request with the asset's entity tag answers 304 without a body
- **AND** incremental feeds (the NDJSON search feed) are never buffered for compression

### Requirement: The hub forwards loopback-shaped requests so children keep their localhost model
When proxying to a child, the hub SHALL rewrite the forwarded `Host` header (and `Origin` header, when present) to the child's loopback endpoint, after the hub has itself validated the browser's origin against the hub's host. Children's existing loopback origin gates and token checks SHALL hold without modification.

#### Scenario: Child accepts a proxied terminal upgrade
- **WHEN** a browser at the hub's HTTPS origin performs a terminal WebSocket upgrade through the hub
- **THEN** the child receives loopback-shaped `Host` and `Origin` headers and its origin gate accepts the upgrade

### Requirement: The hub terminates TLS from user-supplied certificates
The hub SHALL serve HTTPS using a certificate and private key referenced by its configuration, and SHALL refuse to listen on a non-loopback address without TLS configured. Plain HTTP SHALL be permitted only on loopback (for operators fronting the hub with their own proxy).

#### Scenario: Remote listening requires TLS
- **WHEN** the hub is configured to listen on a non-loopback address with no certificate configured
- **THEN** startup fails with an error explaining that TLS (or a loopback bind behind a proxy) is required

#### Scenario: Hub serves HTTPS with the provided certificate
- **WHEN** the hub is configured with valid PEM certificate and key paths
- **THEN** clients connect over HTTPS and secure-context features (service worker, clipboard) function on remote devices

### Requirement: The self-hosting runbook documents working certificate and startup paths
The self-hosting runbook SHALL provide complete, copy-pasteable certificate and hub-startup walkthroughs for mkcert LAN homelabs and both native-TLS and HTTPS-proxy Tailscale deployments. Each walkthrough SHALL end with a working systemd unit or launchd plist starting the hub in that shape.

#### Scenario: An operator follows a certificate and startup walkthrough
- **WHEN** an operator chooses a supported self-hosting shape
- **THEN** mkcert guidance SHALL include installing its root CA on iOS
- **AND** native `tailscale cert` guidance SHALL cover enabling MagicDNS and tailnet HTTPS, generating PEM files, configuring the hub to use them, and scheduled renewal because certificates expire
- **AND** `tailscale serve` guidance SHALL cover proxying HTTPS to a loopback plain-HTTP hub

#### Scenario: Tailscale user reaches a working HTTPS hub with native certs
- **WHEN** an operator follows the runbook's `tailscale cert` walkthrough
- **THEN** they end with the hub serving HTTPS on their tailnet hostname from the generated PEM files
- **AND** the runbook includes a scheduled renewal step for the expiring certificate

#### Scenario: Tailscale user fronts the hub with tailscale serve
- **WHEN** an operator follows the runbook's `tailscale serve` walkthrough
- **THEN** they end with the hub listening plain-HTTP on loopback and `tailscale serve` terminating HTTPS in front of it

### Requirement: Hub-owned credential processes follow Hub lifecycle
The Hub SHALL start managed credential processes only in dedicated owner-only runtime locations, monitor their readiness, and stop them during graceful shutdown after active clone jobs and workspace sessions no longer need them. Startup or shutdown failure of one optional credential runtime SHALL be reported without signaling ambient processes or corrupting unrelated credentials, and SHALL prevent only capabilities that depend on that runtime.

#### Scenario: Hub shuts down with managed agents
- **WHEN** the Hub begins graceful shutdown with Hub-owned SSH and OpenPGP agents running
- **THEN** active clone jobs and workspace sessions stop before the Hub terminates its owned agents
- **AND** unrelated system agents remain running

### Requirement: Hub exposes authenticated folder mutation operations
The Hub SHALL expose authenticated POST operations to create a folder from an absolute parent and child name, rename from an absolute source and new sibling name, and remove an absolute folder. Cookie requests MUST pass same-origin checks. Mutations SHALL enforce the validation, no-overwrite, and Git-dependency safety rules below.

#### Scenario: A folder mutation validates its filesystem targets
- **WHEN** a create, rename, or removal is requested
- **THEN** the Hub MUST reject relative paths, invalid names, non-directory or symbolic-link sources, existing rename destinations, and removal of any non-empty folder
- **AND** a mutation MUST NOT recursively delete content or overwrite an existing filesystem entry

#### Scenario: Generic rename could invalidate Git worktree dependencies
- **WHEN** any otherwise supported folder-rename flow could invalidate dependencies involving linked checkouts, main checkouts, common Git directories, or their ancestors, including unregistered linked trees
- **THEN** the Hub SHALL reject it before generic rename, even with stop authorization
- **AND** uncertainty about affected Git dependency safety SHALL fail closed with an actionable explanation
- **AND** ordinary/main workspace display-name changes SHALL remain unaffected; linked child names SHALL reflect their exact local branch, with independent child display-name editing and branch rename outside this change and no relaxation of folder dependency guards

#### Scenario: Cross-origin folder mutation is rejected
- **WHEN** a cookie-authenticated cross-origin request attempts to create, rename, or remove a folder
- **THEN** the Hub rejects it without changing the filesystem or workspace registry

#### Scenario: Rename never replaces a destination
- **WHEN** a rename's destination path already names any filesystem entry
- **THEN** the Hub reports a conflict and leaves both source and destination unchanged

#### Scenario: Remove delegates emptiness enforcement to the filesystem
- **WHEN** a remove request names a directory containing a file, hidden entry, or child directory
- **THEN** the operation fails without recursively removing any entry

#### Scenario: Main checkout has an unregistered dependency
- **WHEN** a generic rename would move a main checkout or its ancestor and break links to a worktree not registered in Hub
- **THEN** the Hub refuses before filesystem mutation regardless of stop authorization and preserves registration paths

#### Scenario: Linked checkout or common directory would move
- **WHEN** a generic rename targets a linked checkout, shared Git directory, or containing ancestor whose move would invalidate a worktree dependency
- **THEN** the Hub refuses without attempting automatic Git repair or filesystem rename

#### Scenario: Dependency inspection is inconclusive
- **WHEN** Git dependency inspection cannot establish rename safety
- **THEN** the Hub leaves the filesystem unchanged and explains how to resolve or investigate the blocker

### Requirement: Folder mutations preserve registered workspace identity and consistency
Before renaming a folder, the Hub SHALL identify every registered workspace at or below the source. Successful rename MUST replace the source prefix in all affected paths as one registry mutation, preserving every id, backend, personal state, credential assignment, and session URL. Removal and interruption SHALL follow the consistency rules below.

#### Scenario: A registered folder is removed or mutation is interrupted
- **WHEN** an empty folder that is itself a registered workspace is removed
- **THEN** its registration, associated personal state, and credential assignments MUST be removed

#### Scenario: Any registered folder mutation completes or is interrupted
- **WHEN** folder mutation changes the filesystem and associated registry or metadata
- **THEN** those changes MUST complete coherently or be recovered or rolled back, so interruption cannot silently leave a registered path at its old location after the folder moved

#### Scenario: Registered descendant paths move together
- **WHEN** registered workspaces at `/srv/group/a` and `/srv/group/nested/b` are stopped and `/srv/group` is renamed to `/srv/team`
- **THEN** their ids remain unchanged
- **AND** their persisted paths become `/srv/team/a` and `/srv/team/nested/b` in one registry update

#### Scenario: Registered rename survives Hub restart
- **WHEN** a registered workspace is renamed and the Hub restarts
- **THEN** the workspace remains registered under the same id at the renamed path

#### Scenario: Failed registered rename remains coherent
- **WHEN** the filesystem rename or registry persistence fails
- **THEN** the Hub reports failure
- **AND** recovery or rollback leaves every affected registration pointing to the location where its folder exists

#### Scenario: Empty registered removal clears durable metadata
- **WHEN** removal of an empty registered workspace succeeds
- **THEN** the folder, registry entry, all users' personal workspace state, and credential assignments for that workspace are absent after a Hub restart

### Requirement: Folder mutations coordinate with sessions and clone targets
The Hub SHALL serialize registered folder mutations against lifecycle operations for every affected workspace. Without explicit stop authorization, mutations affecting running or starting workspaces MUST return a conflict naming every workspace requiring a stop and MUST change nothing. Authorized stops and clone reservations SHALL follow the coordination rules below.

#### Scenario: An authorized folder mutation overlaps session starts
- **WHEN** a folder mutation has explicit stop authorization
- **THEN** the Hub MUST await and stop any in-flight or running affected session before mutation, and no concurrent start may observe or use a partially updated path

#### Scenario: Clone reservations constrain every folder mutation
- **WHEN** create, rename, or removal is requested, with or without stop authorization
- **THEN** it MUST be rejected if its source, destination, or affected subtree conflicts with an active clone target
- **AND** folder mutation and clone reservation checks SHALL coordinate so neither enters a path reserved by the other

#### Scenario: Mutation reports sessions requiring a stop
- **WHEN** a rename affects running workspace `alpha` and starting descendant workspace `beta` without stop authorization
- **THEN** the Hub returns a conflict identifying both `alpha` and `beta`
- **AND** neither session, folder, nor registration changes

#### Scenario: Authorized mutation stops an in-flight start
- **WHEN** the same rename is retried with stop authorization while a workspace start is in flight
- **THEN** the Hub waits for that start, stops the resulting session and shells, and only then renames the folder and updates registrations

#### Scenario: Concurrent start waits for rename
- **WHEN** a start request arrives while its registered workspace path is being renamed
- **THEN** the start observes the fully committed new path or fails without spawning a child
- **AND** it never starts against an intermediate or stale path

#### Scenario: Active clone protects its path hierarchy
- **WHEN** an active clone target lies at, above, or below a proposed folder mutation source or destination
- **THEN** the Hub rejects the mutation without moving or removing the clone target or its containing path

### Requirement: Hub stores mutable workspace display names
Every workspace registration SHALL include a non-empty display name separate from its immutable id and filesystem path. Names MAY contain spaces, punctuation, and duplicates within a bounded length. Renaming SHALL atomically persist only the display name, without changing id, `/s/<id>/` URL, source path, backend, personal state, credential assignments, or running session.

#### Scenario: A registry entry predates display names
- **WHEN** an existing entry without a display name loads
- **THEN** it SHALL receive a deterministic folder-basename-derived default without changing its id

#### Scenario: Existing registry entry receives a default name
- **WHEN** the Hub loads a registry entry written before display names existed
- **THEN** it exposes and persists a display name derived from the source folder basename
- **AND** its stable id and URL remain unchanged

#### Scenario: Duplicate display names are accepted
- **WHEN** two workspaces are named `API`
- **THEN** both names are stored unchanged
- **AND** their distinct ids and paths continue to identify them unambiguously

#### Scenario: Running workspace is renamed
- **WHEN** a workspace display-name update succeeds while its session is running
- **THEN** subsequent Hub state and navigation use the new display name
- **AND** the child process is neither stopped nor restarted

### Requirement: Hub atomically configures new workspace registrations
The Hub SHALL provide authenticated registration of existing folders and creation of child repositories with a display name, optional authentication/signing assignments, and explicit start choice defaulting to false. Before success, registration and requested assignments MUST persist as one coherent onboarding result, with no partial registration or assignment after validation, initialization, registry, or assignment failure.

#### Scenario: An explicitly requested first start fails after onboarding commits
- **WHEN** configuration commits but the requested first start fails
- **THEN** the Hub SHALL preserve the configured stopped workspace and report startup failure rather than delete the completed registration

#### Scenario: New workspace creation succeeds or requires cleanup
- **WHEN** a new child repository is created
- **THEN** its destination SHALL derive from an absolute parent plus one visible child segment; the Hub SHALL reserve the path hierarchy, create without replacement, initialize Git, and register only that new folder
- **AND** failure after folder creation SHALL perform bounded cleanup only if the Hub can prove there is no user-added content; otherwise it SHALL retain the folder and report the required recovery action

#### Scenario: Existing folder is configured stopped
- **WHEN** a valid Git repository, display name, and assignments are submitted without start authorization
- **THEN** the Hub atomically records them and returns a stopped workspace

#### Scenario: Assignment validation fails
- **WHEN** a requested credential is missing, disabled, incompatible, or conflicts with another selected default
- **THEN** the operation fails without retaining the new registration or any requested assignment

#### Scenario: Explicit first start fails
- **WHEN** registration and assignments commit but an explicitly requested session start fails
- **THEN** the Hub reports the start failure and preserves the configured stopped workspace for correction and retry

#### Scenario: Newly created repository is initialized
- **WHEN** a valid parent, unused folder name, display name, and assignments are submitted to Create workspace
- **THEN** the Hub creates the child, runs Git initialization, and records one stopped workspace for its canonical path

### Requirement: Hub stores a default workspace parent preference
The Hub SHALL persist an optional absolute default workspace parent in Hub-owned state. Updates SHALL require an existing direct non-symbolic-link directory and authenticated same-origin mutation protection. It SHALL guide initial create, clone, and browse locations but MUST NOT constrain registration, folder operations, or shell access to that subtree.

#### Scenario: The default workspace parent becomes unusable
- **WHEN** the saved path becomes missing or unreadable
- **THEN** the Hub SHALL retain the preference for diagnosis and return the daemon user's home as the effective onboarding default

#### Scenario: Preference survives restart
- **WHEN** an authenticated user saves `/srv/workspaces` and the Hub restarts
- **THEN** Hub state reports `/srv/workspaces` as the configured and effective onboarding parent while it remains usable

#### Scenario: Preference is not a workspace root
- **WHEN** `/srv/workspaces` is configured and a user registers `/opt/project`
- **THEN** the Hub accepts `/opt/project` under the existing host-access rules

#### Scenario: Saved preference is unavailable
- **WHEN** the configured directory disappears after it was saved
- **THEN** Hub state identifies it as unavailable and provides the daemon user's home as the effective default

### Requirement: Terminal bridges release abandoned connections and preserve recovery
For proxied terminal WebSockets, the Hub SHALL propagate browser departure to the child connection and release both sides after failed or cancelled bridge establishment. Late upstream completion MUST NOT retain an abandoned terminal holder or deliver queued input after browser departure. Attachment refusal and bridge failure SHALL preserve the terminal recovery and ownership rules below.

#### Scenario: A child refuses attachment or terminal bridging fails
- **WHEN** the child refuses attachment
- **THEN** the browser SHALL remain able to reconcile through authenticated inventory without treating transport establishment as successful terminal attachment

#### Scenario: A terminal bridge fails independently of attachment refusal
- **WHEN** a terminal bridge fails
- **THEN** that failure SHALL NOT create or terminate a PTY or transfer ownership

#### Scenario: An established terminal bridge forwards traffic
- **WHEN** an established terminal connection carries messages or closes
- **THEN** it SHALL retain existing bidirectional forwarding and application close-code semantics

#### Scenario: Navigation releases the old holder
- **WHEN** a browser leaves a workspace and closes its terminal connection
- **THEN** the Hub closes the corresponding child connection and the PTY becomes detached once that close is processed
- **AND** the running shell remains available for ordinary reattachment

#### Scenario: Browser departs while the upstream connection is opening
- **WHEN** the browser disconnects before the child WebSocket finishes opening
- **THEN** the Hub cancels or closes the upstream connection
- **AND** any late completion cannot attach an abandoned holder or forward queued input

#### Scenario: Browser upgrade fails after upstream creation
- **WHEN** the Hub has begun opening a child connection but cannot complete the browser upgrade
- **THEN** the Hub releases the child connection and pending bridge data
- **AND** no terminal holder remains for the failed browser connection

#### Scenario: Child rejects a terminal already held elsewhere
- **WHEN** the child refuses an ordinary attach because the requested PTY already has a holder
- **THEN** the rejected bridge releases its resources without affecting the holder
- **AND** the browser can determine the occupied state through authenticated inventory and offer explicit takeover

#### Scenario: Application close semantics survive bridge cleanup
- **WHEN** an established terminal connection sends explicit termination or receives a takeover notification
- **THEN** the Hub preserves the terminal's application close code and direction
- **AND** ordinary navigation cleanup does not emit the explicit-termination code
