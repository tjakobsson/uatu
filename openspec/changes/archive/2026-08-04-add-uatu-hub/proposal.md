# Proposal: add-uatu-hub

## Why

uatu sessions are pinned to the machine and the moment they were started on: the server binds `127.0.0.1`, and the only orchestrator (launcher, recents, git-init preflight, process supervision) is the macOS desktop wrapper. There is no way to run sessions on a homelab server and reach them from another device — a browser, an iPad, eventually a phone — even though the session semantics (detachable PTYs, reattach with replay, multi-client SSE state) already support exactly that. "uatucode cloud" is the orchestrator role the desktop wrapper already plays — launcher, git preflight, spawn, supervise — replicated as a self-hostable daemon. The desktop app itself is untouched by this change: its local spawn-per-window mode keeps working exactly as today, and a follow-up change teaches it to additionally connect to a remote hub.

## What Changes

- New `uatu hub` subcommand in the same binary: a daemon that owns a workspace registry, starts/stops one `uatu serve` child per active workspace, and reverse-proxies all HTTP, SSE, and WebSocket traffic to children under stable path prefixes (`/s/<workspace-id>/…`). Children keep binding loopback and are never directly reachable from the network.
- Sessions are started through a `SessionBackend` interface ("give me a loopback HTTP endpoint serving this workspace at this base path"). This change ships only the local-process backend; a sandboxed container/VM backend (containerd + runtime shims such as nerdbox, template images) is explicitly deferred but the seam, workspace registry shape, and lifecycle contract are designed so it can be added without reworking the hub.
- `uatu serve` gains `--base-path <prefix>`: every emitted URL, API fetch, pushState document URL, asset reference, service-worker scope, and auth cookie is relocatable under a path prefix. Default remains `/` — existing local, dev, e2e, and desktop use is byte-for-byte unchanged.
- The hub terminates TLS natively from a user-supplied certificate/key pair (bring-your-own-cert: mkcert, `tailscale cert`, ACME via external tooling). HTTPS is functionally required for remote use — service workers and `navigator.clipboard` need a secure context.
- The hub authenticates browsers: a users list (name + password hash) in the hub config, a login page, and a signed session cookie gating the dashboard and all proxied session traffic. Single-user is the expected v1 configuration; the config shape is a list from day one so multi-user is additive. Per-user authorization and OS-level isolation between users are out of scope and documented as such.
- The hub serves a dashboard: running sessions (with live shell/foreground-process detail sourced from each child's terminal-sessions API), stopped recent workspaces with resume, and workspace creation via open-folder, `git init`, and `git clone` — the remote analogs of the desktop launcher's preflight flow.
- Deferred (architected-for, not implemented): container/VM sandbox backend and environment templates; the desktop app's "Connect to remote hub…" mode (planned as the immediate follow-up change — until then remote sessions are reached from any browser, which stays a first-class client).

## Capabilities

### New Capabilities

- `hub-service`: the `uatu hub` daemon — config file, workspace registry, session lifecycle over the `SessionBackend` seam (local-process backend), reverse proxy for HTTP/SSE/WebSocket under `/s/<id>/` prefixes, TLS termination, graceful shutdown, and service-manager operation (systemd/launchd runbook).
- `hub-auth`: browser authentication at the hub boundary — users config, login flow, signed session cookie, gating of dashboard and proxied session routes, and the trusted-intermediary contract with children (hub validates origin and auth, forwards loopback-shaped requests so children's localhost security model stays intact).
- `hub-dashboard`: the web launcher — session list with live status, jump-in, resume, stop, and workspace creation (folder path, `git init`, `git clone`) including the non-git-folder preflight.
- `base-path-serving`: relocatability of a single `uatu serve` session under a configured path prefix — URL construction, API fetches, document pushState routes, assets, PWA/service-worker scope, and terminal auth cookie path scoping, with `/` as the unchanged default.

### Modified Capabilities

- `serve-cli-startup`: adds the `--base-path` flag (validation, default, interaction with startup output and the printed session URL).
- `embedded-terminal`: terminal auth cookie is scoped to the session's base path so multiple proxied sessions on one origin cannot collide; token-gated upgrade and origin-gate requirements are otherwise unchanged (children still see loopback-shaped requests).

## Impact

- **New code**: `src/hub/` (daemon, registry, backend interface + local backend, proxy, auth, dashboard UI); `src/cli.ts` / `src/cli/parse.ts` grow the `hub` subcommand and `--base-path` flag.
- **Touched code**: every root-relative URL construction site in the SPA (`shell/events.ts`, `shell/boot.ts`, `shell/url.ts`, `shell/history.ts`, `shell/pwa.ts`, `sidebar/*`, `terminal/client.ts`, `preview/*` fetches), `src/index.html` asset references, `sw.js` scope, `server/routes.ts` route matching, terminal auth cookie attributes.
- **Unchanged by design**: default-`/` behavior for `bun run dev`, the desktop wrapper contract (URL on stdout, SIGTERM, stdin-EOF), the children's loopback binding and origin gate, the e2e harness at `/`.
- **Docs/ops**: README + ARCHITECTURE sections for the hub, a self-hosting runbook (certs, service units, security posture statement: hub auth is "who may enter", not inter-user isolation).
- **Dependencies**: none anticipated beyond Bun built-ins (TLS via `Bun.serve`, password hashing via `Bun.password`).
