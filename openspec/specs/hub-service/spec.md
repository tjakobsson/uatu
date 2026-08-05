# hub-service Specification

## Purpose

Define the uatu hub daemon: a long-running service that keeps a persistent workspace registry (absolute paths, stable session ids), starts and stops `uatu serve` sessions through a pluggable session backend, and reverse-proxies all session traffic (HTTP, SSE, WebSocket) under `/s/<id>/` prefixes behind hub-terminated TLS — so one authenticated origin fronts many loopback-bound sessions — plus a trusted loopback local mode for the desktop wrapper and a self-hosting runbook covering real certificate and startup paths.

## Requirements

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
- **WHEN** the same client requests document state, SSE, or terminal transport
- **THEN** the Hub forwards that traffic according to the existing proxy contract

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

### Requirement: Sessions are started and stopped through a session backend interface
The hub SHALL manage session processes exclusively through a backend interface whose contract is: given a workspace descriptor and a base path, start a session and return a loopback HTTP endpoint plus the child's session token; and stop a previously started session. Hub components (proxy, dashboard, auth) MUST NOT depend on how the endpoint is produced. The shipped `local` backend SHALL spawn `uatu serve <folder> --no-open --exit-on-stdin-close --base-path /s/<id>/`, parse the tokened URL from the child's first stdout line, hold the child's stdin open for its lifetime, and stop the session via SIGTERM.

#### Scenario: Local backend spawns the desktop-proven contract
- **WHEN** the hub starts a session for a registered workspace
- **THEN** a `uatu serve` child starts with `--no-open --exit-on-stdin-close` and the workspace's base path
- **AND** the hub records the loopback endpoint parsed from the child's stdout

#### Scenario: Hub death cannot orphan children
- **WHEN** the hub process dies without running termination handlers
- **THEN** each child server exits on its own because its standard input reached EOF

### Requirement: All session traffic is reverse-proxied under the workspace prefix
The hub SHALL proxy every request under `/s/<id>/` to that workspace's loopback endpoint, covering plain HTTP, Server-Sent Events, and WebSocket upgrades. SSE responses SHALL be streamed without buffering. WebSocket proxying SHALL forward messages and close events in both directions, preserving application close codes (including the terminal's 4001, 4409, and 4410). Requests for an unknown or stopped workspace SHALL receive a non-cached error response that links back to the dashboard. Children SHALL bind loopback only and MUST NOT be directly reachable from the network.

#### Scenario: A session round-trips through the hub
- **WHEN** an authenticated browser requests `/s/uatu/api/state`
- **THEN** the hub forwards the request to that session's loopback endpoint and streams the response back

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
- **AND** incremental feeds (the SSE event stream, the NDJSON search feed) are never buffered for compression

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
The self-hosting runbook SHALL provide complete, copy-pasteable walkthroughs for obtaining a certificate and starting the hub, covering at minimum: mkcert for LAN homelabs (including installing the root CA on iOS), and tailscale in both supported shapes — native TLS via `tailscale cert` (enabling MagicDNS and HTTPS in the tailnet, generating the PEM files, pointing the hub config at them, and renewing on a schedule since the certificates expire) and fronted via `tailscale serve` proxying HTTPS to a loopback plain-HTTP hub. Each walkthrough SHALL end with a working service definition (systemd unit or launchd plist) that starts the hub in that shape.

#### Scenario: Tailscale user reaches a working HTTPS hub with native certs
- **WHEN** an operator follows the runbook's `tailscale cert` walkthrough
- **THEN** they end with the hub serving HTTPS on their tailnet hostname from the generated PEM files
- **AND** the runbook includes a scheduled renewal step for the expiring certificate

#### Scenario: Tailscale user fronts the hub with tailscale serve
- **WHEN** an operator follows the runbook's `tailscale serve` walkthrough
- **THEN** they end with the hub listening plain-HTTP on loopback and `tailscale serve` terminating HTTPS in front of it
