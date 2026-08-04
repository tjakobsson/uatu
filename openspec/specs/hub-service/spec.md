# hub-service Specification

## Purpose

Define the uatu hub daemon: a long-running, config-driven service that manages a workspaces root, keeps a persistent workspace registry with stable session ids, starts and stops `uatu serve` sessions through a pluggable session backend, and reverse-proxies all session traffic (HTTP, SSE, WebSocket) under `/s/<id>/` prefixes behind hub-terminated TLS — so one authenticated origin fronts many loopback-bound sessions, with a self-hosting runbook covering real certificate and startup paths.

## Requirements

### Requirement: The binary provides a hub daemon subcommand
The `uatu` binary SHALL provide a `hub` subcommand that starts a long-running daemon from a configuration file (listen port, TLS certificate and key paths, users, workspaces root, state directory override), suitable for supervision by systemd or launchd. The hub SHALL persist its workspace registry and secrets under an XDG-resolved state directory, creating secret-bearing files with owner-only permissions. On SIGTERM or SIGINT the hub SHALL stop every running session and exit cleanly.

The hub SHALL resolve a **workspaces root** — the directory whose subfolders are the hub's workspaces and where `git clone` creates new ones — from the configuration's `workspacesDir`, defaulting to the working directory the hub was started in. Startup SHALL fail with a descriptive error when the workspaces root is itself inside a git worktree: the root is where repositories live, not a repository, and a hub started inside one is a misconfiguration to surface, not to serve.

#### Scenario: Hub starts from a config file
- **WHEN** `uatu hub --config <path>` starts with a valid configuration
- **THEN** the daemon listens on the configured port and serves the dashboard
- **AND** its registry and signing key live in the state directory with owner-only permissions

#### Scenario: Graceful shutdown stops children
- **WHEN** the hub receives SIGTERM while sessions are running
- **THEN** every child server process is terminated before the hub exits

#### Scenario: A workspaces root inside a git repository fails startup
- **WHEN** `uatu hub` starts with a workspaces root (configured or defaulted from the working directory) that is inside a git worktree
- **THEN** startup fails with an error explaining that the workspaces root must be a folder that contains repositories, not one

### Requirement: Workspaces are registered with stable identifiers and a backend field
The hub SHALL maintain a persistent workspace registry where each entry records a stable workspace id, the workspace source (folder path), and a session backend identifier. The id SHALL be a slug derived from the workspace folder name, suffixed on collision, and SHALL never change once assigned, so session URLs (`/s/<id>/…`) survive hub and session restarts. In this change the only valid backend identifier SHALL be `local`; the field SHALL exist in the registry schema so additional backends are additive.

Registry persistence SHALL be serialized and atomic — concurrent mutations may neither interleave writes nor let an older snapshot finish last, and a crash mid-write MUST NOT corrupt the file. The registry SHALL be confined to the workspaces root: at startup the hub SHALL forget (unregister, never deleting from disk) every entry whose folder is not a direct child of the configured workspaces root, reporting what was dropped, so entries from an earlier root or an older configuration cannot linger on the dashboard as unreachable workspaces.

#### Scenario: Workspace id is stable across restarts
- **WHEN** a workspace for `~/src/uatu` is created, the hub restarts, and the session is resumed
- **THEN** the session is reachable at the same `/s/<id>/` prefix as before the restart

#### Scenario: Slug collision is suffixed
- **WHEN** two workspaces with the same folder name are registered
- **THEN** the second receives a distinct suffixed id and the first keeps its id

#### Scenario: Entries outside the workspaces root are forgotten at startup
- **WHEN** the hub starts with registry entries whose folders are not direct children of the configured workspaces root
- **THEN** those entries are removed from the registry and reported, and their folders on disk are untouched

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
