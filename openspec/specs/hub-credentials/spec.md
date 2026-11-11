# hub-credentials Specification

## Purpose
Define how a standalone Hub stores, configures, tests, and supplies Git authentication and commit-signing credentials while remaining honest about the local backend's shared security boundary.

## Requirements

### Requirement: Hub maintains a protected credential catalog
The Hub SHALL maintain persistent credential records for SSH authentication, SSH commit signing, OpenPGP commit signing, and HTTPS/provider tokens. Each record SHALL have a stable id, user-facing name, credential type, declared capabilities, public metadata where applicable, and workspace assignments.

#### Scenario: Catalog persistence and access protect secret material
- **WHEN** credentials are stored, read, or mutated
- **THEN** secret-bearing files MUST be created with owner-only permissions and updated atomically
- **AND** authenticated read APIs MUST return metadata and public material only, never private keys, passphrases, or token values
- **AND** credential-management mutations MUST be POST operations protected by the Hub's same-origin policy

#### Scenario: Credential metadata is listed safely
- **WHEN** an authenticated user lists Hub credentials after importing a private key or token
- **THEN** the response identifies the credential, type, capabilities, readiness, and assignments
- **AND** it contains no private key, passphrase, token value, or reusable agent credential

#### Scenario: Cross-origin credential mutation is rejected
- **WHEN** a cookie-authenticated cross-origin request attempts to import, unlock, assign, or delete a credential
- **THEN** the Hub rejects it without changing stored or agent state

### Requirement: Hub manages dedicated credential runtimes
The Hub SHALL use dedicated owner-only runtime locations for every SSH or OpenPGP agent it manages and MUST give Hub clone jobs and workspace sessions explicit paths to those runtimes. It MUST NOT load keys into, lock, stop, reconfigure, or delete sockets belonging to an inherited system agent.

#### Scenario: Shutdown and stale-runtime recovery require provable ownership
- **WHEN** the Hub shuts down or recovers stale credential runtime state
- **THEN** shutdown SHALL stop only agents whose ownership and lifecycle the Hub can prove
- **AND** stale state SHALL be validated and recovered without signaling unrelated processes

#### Scenario: Linux creates a new SSH guardian ownership record
- **WHEN** new SSH guardian ownership state is created on Linux, including ordinary fresh runtime creation
- **THEN** it SHALL retain enough boot identity to distinguish exact managed artifacts left by an earlier system boot

#### Scenario: Ambient agents remain untouched
- **WHEN** the Hub starts with system `SSH_AUTH_SOCK` and GnuPG sockets already present
- **THEN** Hub-managed credentials use separate Hub-owned locations
- **AND** stopping or reconfiguring the Hub leaves the system agents and their identities unchanged

#### Scenario: Stale Hub socket is not trusted blindly
- **WHEN** startup finds a socket or process record in the Hub credential runtime location that it cannot prove belongs to its managed agent
- **THEN** the Hub refuses to signal that process
- **AND** it reports the affected credential runtime unavailable with recovery guidance

#### Scenario: Linux restart leaves managed SSH sockets behind
- **WHEN** startup finds an owner-only SSH guardian record from an earlier Linux boot and every remaining guardian socket exactly matches the identity recorded for it
- **THEN** the Hub removes the remaining previous-boot guardian artifacts without signaling any recorded PID
- **AND** it can start a fresh managed SSH agent without manual cleanup

#### Scenario: Previous-boot socket identity does not match
- **WHEN** startup finds a previous-boot ownership record but a remaining guardian socket does not exactly match its recorded identity
- **THEN** the Hub preserves the unprovable artifacts
- **AND** it reports the credential runtime unavailable with recovery guidance

### Requirement: Credential tooling is discoverable and testable
The Hub SHALL auto-detect the executables required by each credential capability from its service environment and SHALL allow an authenticated user to configure an explicit absolute executable path. A configured path MUST be validated as an executable regular file before use.

#### Scenario: Tool testing reports separate readiness layers with bounded diagnostics
- **WHEN** the settings test action checks credential tooling
- **THEN** it SHALL distinguish binary discovery, compatible version, agent operation, and usable-key or signing readiness
- **AND** it SHALL return bounded sanitized diagnostics and platform-appropriate installation guidance without environment secrets or unrestricted command output

#### Scenario: Startup and configuration changes refresh optional-tool readiness
- **WHEN** the Hub starts or configuration changes
- **THEN** tool readiness SHALL be re-evaluated
- **AND** one unavailable optional tool MUST NOT disable unrelated credential types

#### Scenario: GnuPG is not installed
- **WHEN** the Hub cannot find a compatible `gpg` and the user tests OpenPGP support
- **THEN** OpenPGP is reported unavailable with installation and path-override guidance
- **AND** SSH and HTTPS credential capabilities remain available

#### Scenario: Explicit binary passes a capability test
- **WHEN** a user configures an absolute executable path and activates Test
- **THEN** the Hub reports the discovered version and each tested readiness layer separately
- **AND** the persisted path is used only after validation succeeds

### Requirement: Hub supports SSH authentication and signing credentials
The Hub SHALL generate passphrase-protected SSH keys and import supported existing SSH private keys for authentication, commit signing, or both as explicitly declared by the user. It SHALL expose the public key for Git-provider registration and load private identities only into the Hub-managed SSH agent.

#### Scenario: SSH import retains protection without duplicating private keys
- **WHEN** an SSH private key is imported
- **THEN** it SHALL retain its existing passphrase protection: the supplied existing passphrase unlocks an encrypted key, while an unprotected key remains usable without an unlock operation
- **AND** an already-cataloged fingerprint SHALL fail import without retaining another private-key copy

#### Scenario: SSH operations use the separately validated client path without retaining passphrases
- **WHEN** SSH tooling is configured or generation, import, unlock, or assigned SSH operations run
- **THEN** the Hub SHALL discover and allow an absolute `ssh` client override separately from agent/key tools
- **AND** assigned workspace SSH operations and explicitly selected SSH clones SHALL invoke that validated path
- **AND** submitted generation, import, or unlock passphrases MUST NOT be persisted, logged, included in diagnostics, or returned by an API

#### Scenario: User generates an SSH signing key
- **WHEN** an authenticated user provides a name and passphrase and generates an SSH credential for commit signing
- **THEN** the Hub stores the protected private key, returns its public key, and records signing as its declared capability
- **AND** the passphrase is discarded after the operation

#### Scenario: Locked SSH key is unavailable
- **WHEN** an SSH credential is locked or the Hub has restarted without it being unlocked
- **THEN** new authentication or signing operations cannot use its private key
- **AND** settings reports that an unlock is required

#### Scenario: User imports an SSH key with its existing protection
- **WHEN** an authenticated user imports an encrypted SSH private key and supplies its existing passphrase
- **THEN** the Hub preserves the key unchanged and loads it into the managed agent for immediate use
- **AND** the passphrase is discarded after the operation

#### Scenario: User imports an SSH key without a passphrase
- **WHEN** an authenticated user imports an unencrypted SSH private key with an empty passphrase
- **THEN** the Hub accepts and loads the key without prompting for an invented passphrase
- **AND** the Hub automatically reloads that key when its managed agent is recreated

### Requirement: Hub supports OpenPGP commit-signing credentials
When compatible GnuPG tooling is available, the Hub SHALL generate or import OpenPGP signing keys in a dedicated Hub GnuPG home, expose the public key and fingerprint, and make unlocked signing available through the Hub-owned OpenPGP agent. OpenPGP unavailability MUST produce an actionable capability error rather than preventing Hub startup.

#### Scenario: OpenPGP import and unlocking protect secret input
- **WHEN** an OpenPGP key is imported or the Hub receives a private-key passphrase or pinentry response
- **THEN** an import MUST contain exactly one primary private key
- **AND** submitted passphrases and pinentry responses MUST be handled as secrets and MUST NOT be persisted or replayed

#### Scenario: Per-credential disabling preserves the shared OpenPGP agent
- **WHEN** an OpenPGP credential is locked or disabled, or the Hub shuts down
- **THEN** the Hub MUST NOT expose credential-specific locking that terminates the shared GnuPG agent
- **AND** disabling one credential SHALL block its new use without clearing cached passphrases for unrelated credentials
- **AND** Hub shutdown MAY terminate the shared agent

#### Scenario: OpenPGP signing key is ready
- **WHEN** a compatible OpenPGP key is imported, unlocked, and its signing capability test succeeds
- **THEN** settings reports its fingerprint and signing readiness
- **AND** a workspace assigned that credential can create an OpenPGP-signed commit

#### Scenario: OpenPGP agent needs secret input
- **WHEN** the Hub-owned OpenPGP agent requires a passphrase to unlock a signing key
- **THEN** the authenticated user can answer through a masked Hub prompt
- **AND** the response is sent only to that operation and never appears in retained output

### Requirement: Hub supports HTTPS Git and provider credentials
The Hub SHALL store HTTPS/provider credentials with an explicit provider host and declared Git and provider-CLI capabilities. Git operations SHALL obtain assigned HTTPS credentials through a Hub-controlled credential helper rather than embedding tokens in repository remotes or command arguments.

#### Scenario: Provider CLI projection respects host ambiguity and repository boundaries
- **WHEN** provider CLI integration supplies a workspace credential
- **THEN** it SHALL expose the credential only to the selected Hub-started workspace process environment and MUST NOT write it into the workspace repository
- **AND** because each provider CLI has one non-host-indexed token variable, a workspace context assigning provider-CLI credentials for multiple hosts of the same provider SHALL be rejected instead of one token replacing another
- **AND** the broader visibility of process-environment credentials under the local backend SHALL be part of the shared-UID warning

#### Scenario: HTTPS clone uses a stored token
- **WHEN** a clone for the credential's configured host selects an unlocked HTTPS Git credential
- **THEN** Git obtains it through the Hub credential integration without placing the token in the remote URL, process arguments, or clone output

#### Scenario: Credential host does not match
- **WHEN** Git requests a stored HTTPS credential for a host other than the credential's configured provider host
- **THEN** the Hub-controlled helper declines to return the credential

#### Scenario: Provider CLI assignments span multiple hosts
- **WHEN** one workspace assigns provider-CLI credentials for two hosts of the same provider
- **THEN** workspace startup rejects the ambiguous provider CLI context instead of exposing either host's token as the other's

#### Scenario: Provider-only token is assigned
- **WHEN** a token declares a provider-CLI capability without HTTPS Git and is assigned to a workspace
- **THEN** the Hub configures that provider CLI without exposing the token through the Git credential helper

### Requirement: Hub assigns credentials to workspaces without overstating isolation
New credentials SHALL have no workspace assignments by default. An authenticated user SHALL be able to grant and revoke credentials for selected registered workspaces and select compatible authentication and signing defaults while creating, cloning, or registering a workspace before its first start. Assignments SHALL be atomic with onboarding and disclose the local backend's advisory boundary.

#### Scenario: Onboarding commits deterministic assignments before using them
- **WHEN** workspace registration and onboarding assignment selection commit
- **THEN** they SHALL commit as one coherent result; invalid, unavailable, incompatible, or conflicting selections MUST NOT leave partial new registration or assignment

#### Scenario: Initial or later assignments retain deterministic defaults
- **WHEN** assignments are created or updated, during or after onboarding
- **THEN** they SHALL allow at most one default authentication credential per provider host and one default commit-signing credential per workspace for deterministic normal tool selection

#### Scenario: Every clone or workspace start resolves the current assignments
- **WHEN** a clone job or workspace session starts, including later starts after onboarding
- **THEN** the Hub SHALL configure normal Git, signing, and provider-tool selection from assignments

#### Scenario: Clone authentication is retained only by explicit choice
- **WHEN** a user chooses clone and retained workspace authentication
- **THEN** they SHALL be presented as separate choices
- **AND** the selected clone credential SHALL be offered as the default retained assignment but never retained without explicit user choice

#### Scenario: Assignment surfaces disclose shared-UID limits and preserve credential identity
- **WHEN** any assignment surface or API is used with the local backend, including reads without a new assignment
- **THEN** every assignment surface and API SHALL identify the workspace boundary as advisory because all workspaces share the daemon OS UID
- **AND** they SHALL warn that another local workspace may discover or exercise credentials outside its assignments

#### Scenario: Persisted assignment records retain individual credential identity
- **WHEN** credential assignments are persisted
- **THEN** the model MUST distinguish individual credentials so a future isolated backend can project and enforce only the selected set

#### Scenario: Credentials are assigned before first start
- **WHEN** a user adds or creates a workspace with compatible authentication and signing credentials
- **THEN** the Hub records both assignments before the workspace can be started
- **AND** the first start resolves that committed configuration

#### Scenario: Credential is assigned during clone
- **WHEN** a user selects a clone credential and explicitly chooses it as the retained workspace authentication default
- **THEN** the clone uses that credential and successful registration records the assignment before any requested start

#### Scenario: Clone identity is not retained implicitly
- **WHEN** a user selects a credential for cloning but declines workspace retention
- **THEN** the checked-out workspace has no assignment solely because that credential performed the clone

#### Scenario: Invalid onboarding assignment rolls back
- **WHEN** a selected credential becomes unavailable or conflicts before onboarding commits
- **THEN** the new workspace registration and every requested assignment remain absent

#### Scenario: Local workspace grant is displayed honestly
- **WHEN** a user assigns a credential during onboarding or in Settings using the local backend
- **THEN** the UI warns that the shared UID prevents an enforceable per-workspace secret boundary
- **AND** it does not describe the assignment as sandboxing or least-privilege isolation

#### Scenario: Conflicting defaults are rejected
- **WHEN** onboarding or later configuration selects conflicting authentication defaults for one host or multiple signing defaults
- **THEN** the Hub requires an explicit single default rather than persisting an ambiguous selection

#### Scenario: One authentication host is unassigned
- **WHEN** the same credential is assigned to one workspace for multiple authentication hosts and the user removes one host assignment
- **THEN** the Hub preserves that credential's assignments for the other hosts

#### Scenario: Assigned key is locked
- **WHEN** any assigned SSH or OpenPGP key is not usable even though its shared agent is running
- **THEN** workspace startup identifies the locked assignment instead of starting with unusable Git configuration

### Requirement: Credential revocation has defined runtime behavior
Locking, disabling, unassigning, or deleting a credential SHALL prevent the Hub from supplying it to new clone jobs, new workspace sessions, and new helper or agent requests. Revocation SHALL account for actual running projections, preserve catalog state on failed required stops, and disclose external-connection limits.

#### Scenario: Provider CLI revocation stops actual projected uses before catalog mutation
- **WHEN** disabling or confirming deletion of a token declaring `github-cli` or `gitlab-cli`
- **THEN** the Hub SHALL first stop every running local workspace whose tracked projection contains it, because raw provider CLI environment is a session-start snapshot
- **AND** current assignments and tracked projections SHALL both participate in revocation queue acquisition, but an assignment added after session start MUST NOT by itself stop that session
- **AND** every required stop SHALL be attempted before catalog mutation; if any stop fails, the credential, its assignments, and its secret SHALL remain unchanged

#### Scenario: A running session retains its actual projected credential identities
- **WHEN** credentials are projected into a workspace session
- **THEN** the Hub SHALL track actually projected credential ids until natural session exit or successful stop, before any revocation request is needed

#### Scenario: Deletion distinguishes current references from stale projections
- **WHEN** credential deletion is requested or another credential state change is applied
- **THEN** confirmed deletion with no current references SHALL stop stale projected use even with `unassign` false
- **AND** current references without explicit unassignment SHALL remain a conflict and MUST NOT stop a workspace
- **AND** HTTPS-only token revocation, enable, and rejected deletion MUST NOT stop a workspace
- **AND** deletion SHALL remove private backing only after no assignment references it

#### Scenario: Revocation does not promise termination of external provider sessions
- **WHEN** credential revocation is reported
- **THEN** the Hub SHALL report that an already-authenticated external connection, such as an SSH multiplexed connection, may survive until that connection ends
- **AND** it MUST NOT claim retroactive provider-session revocation it cannot enforce

#### Scenario: Assigned credential is disabled
- **WHEN** a user disables a credential that is assigned to a running workspace
- **THEN** subsequent Hub-brokered credential requests are rejected
- **AND** settings reports the credential disabled without claiming that existing remote connections were terminated

#### Scenario: Projected provider CLI token is disabled
- **WHEN** a user disables a token with a provider CLI capability that remains projected into running local workspaces after assignment replacement
- **THEN** the Hub stops every workspace that actually projected the token before disabling the credential
- **AND** a failed stop leaves the credential enabled and all catalog references and secrets intact
- **AND** unrelated workspaces remain running

#### Scenario: Referenced credential cannot be deleted silently
- **WHEN** a user attempts to delete a credential still assigned to one or more workspaces
- **THEN** the Hub requires explicit removal of those assignments or an explicit confirmed delete-and-unassign operation
- **AND** no workspace is silently left referencing a missing credential
