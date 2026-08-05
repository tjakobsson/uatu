# hub-service — delta for unify-desktop-on-hub

## MODIFIED Requirements

### Requirement: The binary provides a hub daemon subcommand
The `uatu` binary SHALL provide a `hub` subcommand that starts a long-running daemon from a configuration file (listen port, TLS certificate and key paths, users, state directory override), suitable for supervision by systemd or launchd. The hub SHALL persist its workspace registry and secrets under an XDG-resolved state directory, creating secret-bearing files with owner-only permissions. On SIGTERM or SIGINT the hub SHALL stop every running session and exit cleanly. The configuration SHALL NOT define a workspaces root: workspaces are registered by absolute path and the hub SHALL reject a configuration containing the removed `workspacesDir` key with an error naming it.

#### Scenario: Hub starts from a config file
- **WHEN** `uatu hub --config <path>` starts with a valid configuration
- **THEN** the daemon listens on the configured port and serves the dashboard
- **AND** its registry and signing key live in the state directory with owner-only permissions

#### Scenario: Graceful shutdown stops children
- **WHEN** the hub receives SIGTERM while sessions are running
- **THEN** every child server process is terminated before the hub exits

#### Scenario: A configuration with the removed workspacesDir key fails startup
- **WHEN** `uatu hub` starts with a configuration file containing `workspacesDir`
- **THEN** startup fails with an error naming the removed key

### Requirement: Workspaces are registered with stable identifiers and a backend field
The hub SHALL maintain a persistent workspace registry where each entry records a stable workspace id, the workspace source (an absolute folder path anywhere on the filesystem), and a session backend identifier. Registration SHALL validate that the path is absolute and refers to an existing directory. The id SHALL be a slug derived from the workspace folder name, suffixed on collision, and SHALL never change once assigned, so session URLs (`/s/<id>/…`) survive hub and session restarts. In this change the only valid backend identifier SHALL be `local`; the field SHALL exist in the registry schema so additional backends are additive.

Registry persistence SHALL be serialized and atomic — concurrent mutations may neither interleave writes nor let an older snapshot finish last, and a crash mid-write MUST NOT corrupt the file. The hub MUST NOT prune registry entries at startup based on their location; an entry whose folder no longer exists SHALL remain registered and surface as failing to start, never as silently forgotten.

#### Scenario: Workspace id is stable across restarts
- **WHEN** a workspace for `~/src/uatu` is created, the hub restarts, and the session is resumed
- **THEN** the session is reachable at the same `/s/<id>/` prefix as before the restart

#### Scenario: Slug collision is suffixed
- **WHEN** two workspaces with the same folder name are registered
- **THEN** the second receives a distinct suffixed id and the first keeps its id

#### Scenario: Arbitrary absolute paths are registrable
- **WHEN** workspaces at `~/src/uatu` and `~/Documents/notes` are registered
- **THEN** both appear in the registry with stable ids and both sessions are servable

#### Scenario: A relative or missing path is rejected
- **WHEN** a registration request names a relative path or a path that is not an existing directory
- **THEN** the hub rejects it and the registry is unchanged

## ADDED Requirements

### Requirement: The hub provides a trusted local mode
The `hub` subcommand SHALL accept a `--local` flag that runs the hub as a single-user loopback service: the hub SHALL bind a loopback address only, SHALL NOT require a configuration file or configured users, and SHALL treat every request as an implicit authenticated local user (per the hub-auth local-mode requirement). `--local` combined with a non-loopback host SHALL fail startup with a descriptive error. In local mode the hub SHALL support `--port 0` (ephemeral port) and SHALL print its base URL as the first line on standard output so a supervising process can parse it, matching the `uatu serve` contract.

#### Scenario: Local mode starts without configuration
- **WHEN** `uatu hub --local --port 0` starts on a machine with no hub configuration file
- **THEN** the hub listens on an ephemeral loopback port and prints its URL as the first stdout line
- **AND** the dashboard and APIs are served without any login

#### Scenario: Local mode refuses non-loopback binds
- **WHEN** `uatu hub --local` is started with a non-loopback host
- **THEN** startup fails with an error explaining that local mode is loopback-only

### Requirement: The hub exits when its standard input closes
The `hub` subcommand SHALL accept `--exit-on-stdin-close`: when set, the hub SHALL hold its standard input open and, on EOF, perform the same graceful shutdown as SIGTERM (stop every running session, then exit). This is the orphan backstop for supervising processes that die without signaling, matching the contract `uatu serve` already provides.

#### Scenario: Supervisor death cannot orphan the hub
- **WHEN** a hub started with `--exit-on-stdin-close` sees EOF on its standard input while sessions are running
- **THEN** every child session process is terminated and the hub exits
