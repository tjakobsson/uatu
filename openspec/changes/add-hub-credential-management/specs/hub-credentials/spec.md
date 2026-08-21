## Purpose

Define how a standalone Hub stores, configures, tests, and supplies Git authentication and commit-signing credentials while remaining honest about the local backend's shared security boundary.

## ADDED Requirements

### Requirement: Hub maintains a protected credential catalog
The Hub SHALL maintain persistent credential records for SSH authentication, SSH commit signing, OpenPGP commit signing, and HTTPS/provider tokens. Each record SHALL have a stable id, user-facing name, credential type, declared capabilities, public metadata where applicable, and workspace assignments. Secret-bearing files MUST be created with owner-only permissions and updated atomically; authenticated read APIs MUST return metadata and public material only, never private keys, passphrases, or token values. Credential-management mutations MUST be POST operations protected by the Hub's same-origin policy.

#### Scenario: Credential metadata is listed safely
- **WHEN** an authenticated user lists Hub credentials after importing a private key or token
- **THEN** the response identifies the credential, type, capabilities, readiness, and assignments
- **AND** it contains no private key, passphrase, token value, or reusable agent credential

#### Scenario: Cross-origin credential mutation is rejected
- **WHEN** a cookie-authenticated cross-origin request attempts to import, unlock, assign, or delete a credential
- **THEN** the Hub rejects it without changing stored or agent state

### Requirement: Hub manages dedicated credential runtimes
The Hub SHALL use dedicated owner-only runtime locations for every SSH or OpenPGP agent it manages and MUST give Hub clone jobs and workspace sessions explicit paths to those runtimes. It MUST NOT load keys into, lock, stop, reconfigure, or delete sockets belonging to an inherited system agent. Hub shutdown SHALL stop only agents whose ownership and lifecycle the Hub can prove; stale runtime state SHALL be validated and recovered without signaling unrelated processes.

#### Scenario: Ambient agents remain untouched
- **WHEN** the Hub starts with system `SSH_AUTH_SOCK` and GnuPG sockets already present
- **THEN** Hub-managed credentials use separate Hub-owned locations
- **AND** stopping or reconfiguring the Hub leaves the system agents and their identities unchanged

#### Scenario: Stale Hub socket is not trusted blindly
- **WHEN** startup finds a socket or process record in the Hub credential runtime location that it cannot prove belongs to its managed agent
- **THEN** the Hub refuses to signal that process
- **AND** it reports the affected credential runtime unavailable with recovery guidance

### Requirement: Credential tooling is discoverable and testable
The Hub SHALL auto-detect the executables required by each credential capability from its service environment and SHALL allow an authenticated user to configure an explicit absolute executable path. A configured path MUST be validated as an executable regular file before use. The settings test action SHALL distinguish binary discovery, compatible version, agent operation, and usable-key or signing readiness; it SHALL return bounded sanitized diagnostics and platform-appropriate installation guidance without returning environment secrets or unrestricted command output. Tool readiness SHALL be re-evaluated at Hub startup and after configuration changes, and one unavailable optional tool MUST NOT disable unrelated credential types.

#### Scenario: GnuPG is not installed
- **WHEN** the Hub cannot find a compatible `gpg` and the user tests OpenPGP support
- **THEN** OpenPGP is reported unavailable with installation and path-override guidance
- **AND** SSH and HTTPS credential capabilities remain available

#### Scenario: Explicit binary passes a capability test
- **WHEN** a user configures an absolute executable path and activates Test
- **THEN** the Hub reports the discovered version and each tested readiness layer separately
- **AND** the persisted path is used only after validation succeeds

### Requirement: Hub supports SSH authentication and signing credentials
The Hub SHALL generate passphrase-protected SSH keys and import supported existing SSH private keys for authentication, commit signing, or both as explicitly declared by the user. Imported keys SHALL retain their existing passphrase protection: the supplied existing passphrase unlocks an encrypted key, while a key without a passphrase remains usable without an unlock operation. The Hub SHALL expose the public key for registration with a Git provider and load private identities only into the Hub-managed SSH agent. Passphrases submitted for generation, import, or unlock MUST NOT be persisted, logged, included in diagnostics, or returned by an API.

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
When compatible GnuPG tooling is available, the Hub SHALL generate or import OpenPGP signing keys in a dedicated Hub GnuPG home, expose the public key and fingerprint, and make unlocked signing available through the Hub-owned OpenPGP agent. Private-key passphrases and pinentry responses submitted through the Hub MUST be handled as secrets and MUST NOT be persisted or replayed. OpenPGP unavailability MUST produce an actionable capability error rather than preventing Hub startup.

An OpenPGP import MUST contain exactly one primary private key. Because OpenPGP credentials share the Hub GnuPG agent, the Hub MUST NOT expose credential-specific locking that terminates that shared agent. Disabling one OpenPGP credential SHALL block its new use without clearing cached passphrases for unrelated credentials; Hub shutdown MAY terminate the shared agent.

#### Scenario: OpenPGP signing key is ready
- **WHEN** a compatible OpenPGP key is imported, unlocked, and its signing capability test succeeds
- **THEN** settings reports its fingerprint and signing readiness
- **AND** a workspace assigned that credential can create an OpenPGP-signed commit

#### Scenario: OpenPGP agent needs secret input
- **WHEN** the Hub-owned OpenPGP agent requires a passphrase to unlock a signing key
- **THEN** the authenticated user can answer through a masked Hub prompt
- **AND** the response is sent only to that operation and never appears in retained output

### Requirement: Hub supports HTTPS Git and provider credentials
The Hub SHALL store HTTPS/provider credentials with an explicit provider host and declared Git and provider-CLI capabilities. Git operations SHALL obtain assigned HTTPS credentials through a Hub-controlled credential helper rather than embedding tokens in repository remotes or command arguments. Provider CLI integration SHALL expose a credential only to the selected Hub-started workspace process environment and MUST NOT write it into the workspace repository. Because each provider CLI uses one non-host-indexed token environment variable, the Hub SHALL reject a workspace context that assigns provider-CLI credentials for multiple hosts of the same provider rather than allowing one token to replace another. The Hub SHALL make the broader visibility of process environment credentials under the local backend part of the shared-UID warning.

#### Scenario: HTTPS clone uses a stored token
- **WHEN** a clone for the credential's configured host selects an unlocked HTTPS Git credential
- **THEN** Git obtains it through the Hub credential integration without placing the token in the remote URL, process arguments, or clone output

#### Scenario: Credential host does not match
- **WHEN** Git requests a stored HTTPS credential for a host other than the credential's configured provider host
- **THEN** the Hub-controlled helper declines to return the credential

#### Scenario: Provider CLI assignments span multiple hosts
- **WHEN** one workspace assigns provider-CLI credentials for two hosts of the same provider
- **THEN** workspace startup rejects the ambiguous provider CLI context instead of exposing either host's token as the other's

### Requirement: Hub assigns credentials to workspaces without overstating isolation
New credentials SHALL have no workspace assignments by default. An authenticated user SHALL be able to grant and revoke credentials for selected registered workspaces, and the Hub SHALL configure normal Git, signing, and provider-tool selection from those assignments when it starts a clone job or workspace session. Assignments SHALL permit at most one default authentication credential per provider host and one default commit-signing credential per workspace so normal tool selection is deterministic. For the local backend, every assignment surface and API SHALL identify the workspace boundary as advisory because all workspaces share the daemon OS UID, and SHALL warn that another local workspace may be able to discover or exercise credentials outside its assignments. The persisted assignment model MUST distinguish individual credentials so a future isolated backend can project and enforce only the selected set.

#### Scenario: Credential is assigned during clone
- **WHEN** a user selects a credential for a clone and chooses to retain the assignment
- **THEN** the clone's normal Git credential selection is configured for that credential rather than another stored or ambient identity
- **AND** successful workspace registration records the credential assignment

#### Scenario: Local workspace grant is displayed honestly
- **WHEN** a user assigns a credential to a workspace using the local backend
- **THEN** settings warns that the shared UID prevents an enforceable per-workspace secret boundary
- **AND** the UI does not describe the assignment as sandboxing or least-privilege isolation

#### Scenario: Conflicting defaults are rejected
- **WHEN** a workspace already has a default authentication credential for `github.com` or a default commit-signing credential and a user assigns another conflicting default
- **THEN** the Hub requires the user to replace the existing default rather than persisting an ambiguous selection

#### Scenario: Assigned key is locked
- **WHEN** any assigned SSH or OpenPGP key is not usable even though its shared agent is running
- **THEN** workspace startup identifies the locked assignment instead of starting with unusable Git configuration

### Requirement: Credential revocation has defined runtime behavior
Locking, disabling, unassigning, or deleting a credential SHALL prevent the Hub from supplying it to new clone jobs, new workspace sessions, and new helper or agent requests. Deletion SHALL remove its private backing only after it is no longer referenced by an assignment. The Hub SHALL report that an already-authenticated external connection, such as an SSH multiplexed connection, may survive credential revocation until that connection ends; it MUST NOT claim retroactive provider-session revocation it cannot enforce.

#### Scenario: Assigned credential is disabled
- **WHEN** a user disables a credential that is assigned to a running workspace
- **THEN** subsequent Hub-brokered credential requests are rejected
- **AND** settings reports the credential disabled without claiming that existing remote connections were terminated

#### Scenario: Referenced credential cannot be deleted silently
- **WHEN** a user attempts to delete a credential still assigned to one or more workspaces
- **THEN** the Hub requires explicit removal of those assignments or an explicit confirmed delete-and-unassign operation
- **AND** no workspace is silently left referencing a missing credential
