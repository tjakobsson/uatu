# Design: add-uatu-hub

## Context

Today one `uatu serve` process serves one folder on `127.0.0.1` with a per-boot token, and the only orchestrator is the macOS desktop wrapper: it shows a launcher, runs the git preflight (`git rev-parse --show-toplevel` → offer `git init`), spawns `uatu serve <folder> --no-open --exit-on-stdin-close`, reads the tokened URL from stdout, and supervises the process. Session semantics are already remote-shaped — PTYs detach and reattach with replay, `/api/terminal/sessions` inventories live shells, SSE state is multi-client — but nothing is reachable off-machine.

The SPA is root-relative everywhere: literal `/api/…` fetches across ~10 files, the service worker registered at `scope: "/"`, pushState document URLs at `/guides/setup.md`, assets at `/assets/…`. The terminal origin gate accepts only loopback hostnames, and the auth cookie is named `uatu_term_<host-port>` precisely because cookies ignore ports.

Constraints: single-binary distribution stays; the desktop wrapper contract (URL on stdout, SIGTERM, stdin-EOF) stays; default local behavior stays byte-for-byte; a sandboxed container/VM session backend (containerd + shims like nerdbox, template images) must be implementable later without reworking the hub.

## Goals / Non-Goals

**Goals:**

- Self-hostable `uatu hub` daemon: workspace registry, session lifecycle, dashboard, one exposed HTTPS port.
- All session traffic (HTTP, SSE, WebSocket) flows through the hub under stable `/s/<workspace-id>/` prefixes; children stay loopback-bound and individually unreachable.
- `uatu serve --base-path` makes a session fully relocatable under a prefix; `/` default is unchanged.
- Hub-level authentication (users list, login, signed cookie) gating dashboard and sessions.
- Workspace creation remotely: existing folder, `git init`, `git clone`.
- A `SessionBackend` seam so the container/VM backend is additive.
- iPad/browser experience: one origin, one PWA install (secure context preserved end-to-end).

**Non-Goals:**

- Container/VM sandbox backend, environment templates (next change in the arc; only the seam ships now).
- Desktop app "Connect to remote hub…" mode (immediate follow-up change; desktop local mode is untouched here).
- Per-user authorization, quotas, or OS-level isolation between hub users — hub auth answers "may this person enter", not "which rooms"; every terminal is a shell as the daemon's OS user, and the runbook says so loudly.
- ACME/Let's Encrypt automation, public-internet hardening beyond TLS + auth, subdomain routing.
- Re-adopting running children across hub restarts (see D7).

## Decisions

### D1: `uatu hub` is a subcommand of the existing binary

Same compiled artifact, same release train, same Homebrew story. The hub is mostly `Bun.serve` + `Bun.spawn` + proxying — skills the codebase already exercises. A separate package would fork distribution for no isolation benefit. Hub code lives in `src/hub/`; `src/cli/parse.ts` grows the subcommand.

### D2: Single origin, path-prefix reverse proxy — not port-per-session

Alternatives considered:

- **Port-per-session** (hub hands out `host:port` URLs): no SPA changes, but every child needs `--bind`, its own TLS, an origin-gate rework, and an open firewall port; every session is a distinct browser origin, fragmenting PWA installs, localStorage, and service workers.
- **Cookie-discriminated routing**: broken — cookies are shared across tabs, so two open sessions cross-wire.
- **Subdomain-per-session**: clean but demands wildcard DNS + wildcard certs in a homelab; hostile setup.
- **Path prefix through the hub (chosen)**: the hub is the only network-exposed process. TLS, auth, and origin validation live in exactly one place. Children keep `127.0.0.1` binding and their existing localhost security model — the deliberately-local scaffolding stays true because it stays local. One origin means one PWA install (the hub) with sessions inside it. The cost is the base-path refactor (D4), which is mechanical and testable.

### D3: `SessionBackend` interface with a local-process implementation

The hub never touches `Bun.spawn` directly; it asks a backend to *start* a session (workspace descriptor + base path in → loopback HTTP endpoint + child session token out) and to *stop* it. The local backend wraps today's desktop-proven contract: spawn `uatu serve <folder> --no-open --exit-on-stdin-close --base-path /s/<id>/`, parse the URL line from stdout, SIGTERM to stop, stdin-EOF as the orphan backstop. A future container backend satisfies the same interface by creating a containerd task from a template image with `uatu serve` inside and publishing its port to loopback — invisible to proxy, dashboard, and auth. The workspace registry records a `backend` field per workspace (only `"local"` is valid in this change) so the registry schema doesn't churn later.

### D4: Base path is injected at serve time; workspace ids are stable

`uatu serve --base-path /s/<id>/` (default `/`). The server injects the prefix into the served `index.html` (a `<base>`-equivalent boot value the SPA reads once), and a single shared URL helper in the SPA prepends it everywhere URLs are built — fetches, EventSource, WebSocket, pushState, asset references, `sw.js` registration scope, PWA manifest. No module computes a URL by string literal after this change; the helper is the one chokepoint. At `/` the helper is the identity function, keeping dev, e2e, and desktop behavior identical; an e2e run under a non-`/` prefix locks relocatability in.

Workspace ids are stable slugs derived from the folder name (collision-suffixed), persisted in the registry — `~/src/uatu` is always `/s/uatu/` on a given hub. Bookmarks, PWA history, and deep links survive hub restarts. Random per-run ids were rejected: they break every saved link and buy nothing once real auth exists (unguessability-as-auth is not a design).

### D5: TLS is native, bring-your-own certificate

`Bun.serve` accepts a TLS key/cert pair; the hub config points at PEM files (mkcert for homelabs, `tailscale cert`, or any ACME-obtained cert). HTTPS is not optional politeness: service workers and `navigator.clipboard` require a secure context, so the PWA install and the OSC 52 clipboard bridge functionally depend on it off-localhost. ACME automation is rejected for v1 — it drags in DNS-01 plumbing that fronting proxies already solve, and a user who prefers Caddy in front can still run the hub plain-HTTP on loopback behind it.

Tailscale users get two documented first-class routes, and the runbook walks through both end to end: **native** — enable MagicDNS + HTTPS in the tailnet admin console, run `tailscale cert <machine>.<tailnet>.ts.net` to obtain real Let's Encrypt PEM files, point the hub's TLS config at them, and renew via a systemd timer re-running `tailscale cert` (the certs expire ~90 days); or **fronted** — run the hub plain-HTTP on loopback and let `tailscale serve` terminate HTTPS and proxy to it, with certificates managed automatically by tailscaled. The fronted route is the loopback-behind-a-proxy mode this decision already permits, so both work without hub code knowing tailscale exists.

### D6: Hub authenticates; children stay loopback-naive; hub is a trusted intermediary

The hub config holds `users: [{ name, passwordHash }]` (hashed via `Bun.password`; single entry expected in v1, a list so multi-user is additive). Login sets a signed (HMAC, key persisted in the hub state dir) `HttpOnly; Secure; SameSite=Lax` session cookie scoped to the hub origin. Every dashboard and `/s/…` request is gated on it.

Children are not taught hub auth. The hub validates the browser's `Origin` against its own host, then forwards requests to children with loopback-shaped `Host`/`Origin` headers, so the children's existing origin gate and token logic hold without modification — the child's threat model ("only loopback talks to me") remains literally true. Per-child session tokens still exist; the hub captures each child's tokened URL at spawn and brokers the token server-side (users never see or paste it). Alternative rejected: teaching children to verify a hub-signed cookie via shared key — more moving parts for no added protection while children are unreachable except through the hub.

### D7: Hub lifecycle is authoritative; sessions do not survive a hub crash

Children keep `--exit-on-stdin-close` with the hub holding stdin, exactly like the desktop wrapper: a dead hub can never leak orphaned servers running user shells. The trade-off is that hub restart restarts sessions (PTY shells are lost; workspaces and their registry entries persist and resume on the dashboard). Re-adopting live children across hub restarts (PID tracking, port rediscovery, health probing) is deliberately deferred — orphan-safety wins for a v1 daemon under systemd/launchd, and the runbook documents `systemctl restart` semantics honestly.

### D8: Terminal cookie scoping under one origin

All sessions now share one host-port, so the `uatu_term_<host-port>` cookie name no longer disambiguates. The child sets its terminal auth cookie with `Path=<base-path>`, so the browser only presents it to that session's subtree. Name collisions become harmless because paths partition them. At base path `/` nothing changes.

### D9: Dashboard is server-rendered by the hub, not a second SPA — and speaks uatu's design system

The dashboard is a small hub-served page (plain HTML + a little fetch/JS) listing running sessions — enriched with live shell inventory the hub reads from each child's `/api/terminal/sessions` — plus stopped workspaces with resume, stop actions, and the creation flows. The git preflight mirrors the desktop launcher's spec: probe with `git rev-parse --show-toplevel`, offer init only on a definitive not-a-repository result, never pass `--force`. State-changing dashboard endpoints are POST-only and double-protected by `SameSite=Lax` plus an origin check (CSRF).

Visually the pages are uatu surfaces, not a separate theme (revised after review of the first implementation, which shipped an ad-hoc dark-navy mono look): `color-scheme: light dark` with the SPA's `light-dark()` token palette, the Inter/system sans body with mono reserved for paths, the inline brand logo with its dark-scheme retint and blink, pane-style section headers, and the indicator-dot idiom for running state — the same chrome vocabulary as the SPA's sidebar.

### D10: Workspaces live under one root, defaulted from the hub's working directory

The hub owns a **workspaces root** (`workspacesDir`, default: the cwd `uatu hub` was started in). The dashboard creates workspaces by picking among the root's subfolders (listed with git status) or by `git clone` into the root — never by free-text absolute paths, which read as a shell prompt in a web page and invite mistakes. Creation requests are folder names resolved strictly against the root (separators and dot segments rejected). Startup fails if the root is itself inside a git worktree: the root is where repositories live; a hub started inside a repository is a misconfiguration surfaced immediately rather than a confusing serving root. The registry is confined to the root: startup forgets (unregisters, never deletes) entries whose folders are not direct children of the configured root, so switching roots cannot leave unreachable ghosts on the dashboard, and the dashboard offers a forget action for the same reason.

## Risks / Trade-offs

- **[Base-path regressions — a missed literal URL works at `/` and breaks only behind the hub]** → single URL-helper chokepoint, a lint-style unit test greping `src/` for root-relative literals (same pattern as `state-ownership.test.ts`), and an e2e project that runs the suite's core flows under a non-`/` prefix.
- **[Proxy correctness: SSE buffering, WebSocket upgrade forwarding, half-close propagation]** → stream bodies without accumulation, forward upgrades and close codes both directions (the app-defined 4001/4409/4410 codes must transit intact); integration tests drive a real child through the hub, including terminal reattach.
- **[Hub is in the data path of every keystroke]** → accepted for v1 (D7); PTY detach semantics make reconnect-after-hub-blip a clean reattach as long as the child lived; runbook documents restart behavior.
- **[Self-signed/mkcert cert UX on iPad]** → runbook walks through installing the mkcert root CA on iOS; `tailscale cert` documented as the zero-CA-management path for tailnet users.
- **[Remote shells are high-value: auth or signing-key compromise = shell access]** → password hashes via `Bun.password`, HMAC key and config created `0600` in the state dir, cookies `HttpOnly; Secure`, login rate-limited, and the runbook states the trust model (hub users are people trusted with the box's OS user).
- **[`git clone` credentials run as the daemon user]** → v1 relies on the daemon user's ambient git config/ssh agent; documented, no credential storage in the hub.
- **[Workspace slug collisions and renames]** → collision-suffixed slugs persisted in the registry; a folder's id never silently changes once assigned.

## Migration Plan

Purely additive: no existing invocation, config, or client changes behavior. `--base-path` defaults to `/`; the hub is opt-in via a new subcommand. Rollback is not running `uatu hub`. The runbook ships systemd/launchd unit examples; the registry and signing key live in the XDG state dir following the existing `debug/` path conventions.

## Open Questions

All resolved during implementation:

- **Idle policy**: quiet sessions are left running indefinitely in v1 — a few Bun processes are cheap on a homelab; a hibernate knob stays future work.
- **Default hub port**: `4700`. Plain HTTP off-loopback is refused outright at config validation (`hub config: refusing to listen on non-loopback host without TLS`); plain HTTP on loopback stays available for the behind-your-own-proxy shape.
