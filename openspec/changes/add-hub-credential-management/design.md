## Context

See `proposal.md` for motivation and the capability deltas for required behavior. Today the Hub starts clone jobs with a constructor-time copy of its environment and starts every local workspace child with `process.env`; each embedded PTY then copies that child environment again. Clone deliberately preserves an inherited `SSH_AUTH_SOCK`, while workspace shells inherit every ambient credential variable the service happened to receive.

The Hub has authenticated users but deliberately no per-user OS identity or workspace authorization: all local sessions and terminals run as the daemon UID and registered folders are host paths. Credential management therefore has one enforceable security boundary in this change — the Hub environment — even though persisted assignments describe which credentials normal tools should select in each workspace. The existing `SessionBackend` seam and registry backend field are the future enforcement point for containers, VMs, or separate UIDs.

The shipped artifact remains one uatu binary. OpenSSH is expected on supported macOS/Linux hosts; GnuPG and provider CLIs are optional external tools and cannot become unconditional startup dependencies.

## Goals / Non-Goals

**Goals:**

- Give the Hub deterministic ownership of credential state, agent sockets, tool configuration, and shutdown instead of inheriting shell-session state.
- Keep private material outside repository folders and expose only public metadata through read APIs.
- Use mature OpenSSH and GnuPG implementations for key parsing, cryptography, agent caching, and signature formats.
- Configure ordinary Git/SSH/GPG/provider behavior from explicit workspace assignments while preserving an assignment model an isolated backend can enforce later.
- Make every diagnostic layer testable independently and redact secret-bearing command input and output.

**Non-Goals:**

- Per-workspace, per-user, filesystem, process, network, or credential isolation for the local backend.
- A custom SSH agent, OpenPGP implementation, provider OAuth application, hardware-token manager, or general-purpose secret manager.
- X.509 commit signing, SSH agent forwarding from a client device, automatic provider-side public-key registration, or automatic creation of deploy keys/GitHub Apps.
- Transparent compatibility with ambient system agents. Migration is explicit because continuing to pass an ambient socket would preserve the startup-order problem and undermine Hub ownership.
- Inferring whether an arbitrary agent signature request represents authentication, commit signing, or another operation.

## Decisions

### D1: Credentials are Hub-environment resources, not per-login-user secrets

Credential records, tool settings, and assignments live at Hub scope and are manageable by authenticated Hub users under the existing trust model. Audit metadata records the acting login where useful, but it is not an authorization boundary: a workspace session is global and may be entered by any configured Hub user.

Per-user credential ownership was rejected for this backend. The Hub cannot inject Alice's key into a global running workspace without either denying Bob access to that workspace or exposing Alice's key to Bob's same-UID shell. Presenting per-user ownership before those boundaries exist would be misleading.

### D2: Persist metadata separately from secret backing

The state root gains four independently permission-checked areas:

- `credentials.json`: versioned metadata, declared capabilities, disabled/locked state, public identifiers, and workspace assignments; atomic temp-file plus rename persistence.
- `credential-secrets/`: owner-only SSH private key files and an owner-only token store. SSH private keys retain their native passphrase encryption. Tokens are protected by host filesystem permissions rather than decorative application encryption with a key stored beside them.
- `credential-gnupg/`: a dedicated mode-0700 GnuPG home containing OpenPGP key material and configuration.
- `credential-tools.json`: validated absolute path overrides and last-known non-secret readiness metadata.

Runtime sockets, generated Git/SSH configuration, provider CLI views, and process ownership records live under a mode-0700 `credential-runtime/` directory and are never treated as durable state. Startup preserves existing runtime files until their ownership can be checked; it never removes another live Hub's sockets or session configuration. Read APIs build explicit public DTOs rather than serializing persisted records. Secret mutation handlers use dedicated request shapes and must never include request bodies in errors or logs.

Encrypting every secret with a Hub master key stored in the same state directory was rejected: it complicates recovery while adding little protection against compromise of the daemon account. Native passphrases, owner-only storage, host disk encryption, and optional future external secret backends are more honest boundaries.

### D3: Use one Hub-owned OpenSSH agent and one dedicated GnuPG home

The Hub lazily starts `ssh-agent` in foreground/supervised mode with a fixed socket below `credential-runtime/`. All unlocked Hub SSH identities may reside in that agent. Workspace assignment selects a public identity through generated SSH/Git configuration (`IdentityFile` referencing public material plus `IdentitiesOnly`, and Git's SSH signing-key configuration); it does not claim that another same-UID process cannot query the shared agent.

GnuPG operations set a dedicated `GNUPGHOME`. `gpg-agent` is started and stopped through GnuPG's own scoped management commands, so system GnuPG homes and sockets are untouched. A workspace signing assignment selects one fingerprint and signing format through generated Git configuration.

One agent per credential or workspace was rejected for the local backend. Standard SSH agents cannot transfer an already-unlocked private identity to another agent, so that model either retains passphrases in Hub memory, repeatedly prompts, or requires a custom filtering agent protocol. A shared managed agent is simpler and no weaker than the declared shared-UID boundary. A future isolated backend may replace the runtime projection with filtered agents or an external broker while consuming the same credential ids and assignments.

### D4: Unlock is an explicit settings operation, not an arbitrary-process prompt bridge

SSH generation and encrypted-key import run in a private bounded PTY so `ssh-keygen` can read the key's passphrase without placing it in process arguments; terminal echo is disabled before the secret is written and all captured output is sanitized. Unlock runs detached from the Hub's controlling terminal and supplies `ssh-add` through forced `SSH_ASKPASS` over an owner-only named pipe resolved through the service `PATH`. Import keeps the private key's existing encryption rather than changing its passphrase. Unencrypted imports use bounded non-interactive public-key derivation and are automatically loaded whenever the managed agent is recreated. Agent contents are runtime state, so protected SSH credentials return locked after Hub restart.

OpenPGP unlock performs a bounded signing probe through the dedicated GnuPG home using loopback secret input, allowing `gpg-agent` to establish its normal cache. The secret is discarded immediately. A locked credential used by a workspace fails with an actionable message; arbitrary Git processes do not trigger a browser modal. Because the GnuPG home has one shared agent and no configured per-key cache-eviction tool, the UI does not expose a credential-specific OpenPGP Lock action. Disabling blocks new Hub use without killing the shared agent or locking unrelated credentials; whole-agent termination is reserved for Hub shutdown. This avoids a general cross-process pinentry routing service and makes user intent explicit.

Provider tokens remain usable after restart unless disabled because they are persistent non-passphrase credentials. The dashboard never calls that state "unlocked"; it reports enabled/disabled and tool readiness separately.

### D5: Workspace assignment compiles to generated runtime configuration

Assignments are policy records keyed by workspace id and credential id with a role. The Hub enforces at most one default SSH/HTTPS authentication credential per provider host and one default signing credential per workspace. SSH authentication and SSH signing may use distinct keys even though both are held by the managed agent.

At session start the Hub resolves assignments into a credential context passed through `SessionBackend.start`. The local backend generates runtime-only configuration outside the repository and passes explicit environment references to the `uatu serve` child, which embedded PTYs already inherit:

- SSH Git transport gets a generated SSH configuration selecting the assigned public key and managed agent socket.
- SSH signing gets `gpg.format=ssh`, the assigned public-key path, and the managed agent socket.
- OpenPGP signing gets `gpg.format=openpgp`, the assigned fingerprint, configured `gpg` path, and dedicated GnuPG home.
- HTTPS Git gets a Git credential-helper command scoped to the assigned credential and provider host.
- `gh`/`glab` get provider-specific runtime configuration rooted outside the workspace; raw tokens are not placed in repository remotes or command arguments.

The generated Git command-scope configuration takes precedence over repository/global defaults for managed fields while leaving unrelated user Git configuration available. The exact environment/config representation stays internal to the backend. A local process can unset it, inspect same-UID runtime files, or reach the shared agent; the UI and API warning describe that limitation.

### D6: Implement the HTTPS bridge as a narrow Git credential helper

The compiled uatu binary gains an internal Git credential-helper invocation mode. Git sends the standard credential protocol on stdin; the helper normalizes and matches the requested protocol/host against its resolved credential context and emits a username/password only for an exact permitted host. It returns no credential for mismatches and never logs stdin or stdout.

Embedding tokens in clone URLs, Git configuration values, or process arguments was rejected because those values leak through logs, remotes, and process inspection. Reusing arbitrary ambient helpers was rejected because the Hub cannot know what credentials or UI they invoke. Provider CLI adapters remain provider-specific because `gh` and `glab` do not consume the generic Git helper for API calls.

### D7: Clone selection is explicit and separate from interactive fallback

Clone creation accepts an optional credential id and retain-assignment choice. The server validates that the credential type matches the remote transport and host before creating the job. Managed SSH selection configures the public identity and managed socket; managed HTTPS selection configures only the Hub helper. No selection removes inherited agent/helper variables and retains today's PTY response flow.

After clone success, registration and assignment persistence are coordinated: a requested retained assignment is written only for the successfully registered workspace. If session startup then fails and registration rolls back under the existing contract, the assignment rolls back too. Interactive clone responses remain ephemeral and are never offered as a saved credential implicitly.

### D8: Tool configuration is persisted state with layered probes

Each tool has a default executable name searched through the Hub service's `PATH` and an optional dashboard-managed absolute override. Overrides are accepted only for executable regular files and are stored after validation. Every subprocess probe has fixed argv, timeout, output cap, and sanitized error mapping.

Tests report separate layers: binary found, compatible version, agent/runtime operational, credential loaded, and end-to-end sign/auth capability where applicable. An end-to-end signing test signs a fixed Hub challenge and verifies locally; it never creates a Git commit or contacts a provider. Authentication tests stop at local key usability unless the user explicitly initiates a real clone. Platform installation hints are static product copy, not shell commands executed by the Hub.

### D9: APIs and authenticated pages follow existing Hub security conventions

Credential listing, tooling readiness, and public-key export are authenticated. Every mutation uses POST plus the existing same-origin check. Secret inputs use no-store responses and are excluded from retained job/event models. Rate limits bound passphrase attempts and expensive key generation. Test output is structured, capped, and mapped to known stages rather than returning raw stderr.

The server-rendered Hub keeps sessions and workspaces on `/`, puts credential management, tool readiness, and devices on `/settings`, and puts folder registration and cloning on `/clone`. Shared navigation links all three pages. Forms are capability-specific instead of one polymorphic secret form. Destructive operations name the credential and require confirmation; deleting an assigned credential either fails with references or performs an explicit delete-and-unassign transaction. The clone page fetches public credential DTOs directly and does not depend on settings-page DOM or initialization.

Public Hub API schemas and compatibility fixtures gain credential/tool/assignment DTOs and clone-selection fields. The Hub API revision changes only if the repository's contract compatibility rules determine the additions or changed clone request shape are incompatible.

### D10: Revocation controls new use, not established external sessions

Disable, lock, unassign, and delete update the catalog first, then remove cached agent identities or generated runtime references. The helper and all new session/clone resolution consult current catalog state, so new operations fail immediately. Existing SSH multiplexed connections or provider-issued sessions cannot reliably be revoked by deleting a local key; the dashboard states this limitation.

Running local workspace processes inherit configuration snapshots. Credential helper and agent checks remain live, but assignment changes that alter generated Git/provider configuration take full effect on the next workspace session start. The dashboard identifies when a restart is required. A future isolated backend may support live projection updates under its own contract.

### D11: Workspace rows report assignment presence, not readiness

Hub state derives a public workspace summary from credential metadata with deduplicated authentication and signing credential names. It returns empty arrays when credential services are not installed in a test or alternate mode. The dashboard presents this as neutral row detail for running and stopped workspaces.

Starting a stopped workspace with both arrays empty requires a native confirmation that Git authentication and signing may be unavailable but startup can continue. Any assignment suppresses that warning even when its credential is locked, disabled, or unavailable; backend resolution remains responsible for rejecting unusable assigned credentials.

## Risks / Trade-offs

- **[Shared UID bypasses assignments]** → Persistent warning in every assignment surface, no isolation language, adversarial tests proving no ambient credential is selected by normal configuration, and future enforcement delegated to an isolated backend.
- **[Hub state compromise exposes tokens and encrypted key files]** → Owner-only directories/files, atomic writes, native key passphrases, no secret read API, host disk-encryption guidance, and explicit threat-model documentation.
- **[Passphrases leak through subprocess handling]** → Private PTYs or stdin/loopback channels only, echo disabled, fixed output redaction, no argv/env passphrases, no request-body logging, and integration tests with sentinel secrets.
- **[Managed agents interfere with system agents]** → Dedicated socket/GnuPG home, no inherited socket reuse, ownership records, scoped GnuPG lifecycle commands, and tests with fake ambient agents that must remain untouched.
- **[Optional tools vary across platforms and versions]** → Layered capability probes, path overrides, per-capability degradation, static installation hints, and no unconditional GnuPG/provider dependency.
- **[Generated configuration unexpectedly overrides user choices]** → Override only credential-related keys, expose the effective managed assignment in the dashboard, preserve unrelated Git configuration, and add integration tests using conflicting repository/global values.
- **[Credential deletion races an active operation]** → Serialized catalog mutations, reference checks, immutable resolved operation contexts, and defined new-use revocation semantics.
- **[Provider CLI token conventions drift]** → Small provider adapters with version probes and contract tests; unsupported versions report unavailable rather than writing guessed config.
- **[Breaking ambient-agent migration surprises operators]** → Self-hosting steps to import or generate managed credentials and interactive clone fallback; do not silently copy identities because agents cannot export private keys.

## Migration Plan

1. Add the state schema, tool probes, and managed runtime directories without starting agents or changing clone/session environments.
2. Add credential APIs and dashboard management behind capability readiness; existing workspaces initially have no assignments.
3. Add SSH, OpenPGP, HTTPS helper, and provider adapters with focused secret-redaction and lifecycle integration tests.
4. Add workspace assignments and backend credential contexts, then switch clone/session startup to strip ambient agent/helper variables and use only managed selection configuration.
5. Publish a self-hosting migration guide: configure tools, generate/import credentials, register public keys with providers, unlock keys, assign workspaces, and restart running sessions.
6. Update public API contracts and run unit, integration, E2E, build, license, and strict OpenSpec validation before release.

Rollback before step 4 leaves existing behavior intact. After the behavior switch, rollback requires stopping the Hub, restoring the previous binary, and restarting sessions so they inherit the operator's former ambient environment; the new credential state remains ignored on disk. No migration writes private material into repositories or system agent homes.
