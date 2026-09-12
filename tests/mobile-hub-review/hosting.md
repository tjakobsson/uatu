# Local review hosting and optional remote configuration

## Scoped lifecycle utility (preferred)

No shell redirection or generic kill is needed. From the repository root:

```sh
bun tests/mobile-hub-review/manage.ts start
bun tests/mobile-hub-review/manage.ts status
bun tests/mobile-hub-review/manage.ts reset
bun tests/mobile-hub-review/manage.ts stop
bun tests/mobile-hub-review/manage.ts restart
```

With no hosting flags or scoped environment variables, `start` listens only on
`127.0.0.1:4703` and reports `http://127.0.0.1:4703`. There is no default remote
origin. Both `start` and `restart` accept `--port N` and `--public-origin ORIGIN`,
or `UATU_MOBILE_REVIEW_PORT` and `UATU_MOBILE_REVIEW_PUBLIC_ORIGIN`; flags win.
An unconfigured restart preserves the verified existing record's port and optional
origin, including older remote records. Explicit settings override only the given
fields and are validated before stopping. Other commands operate only on the owned
runtime record and accept no routing options or environment routing overrides.
Restart requires a verified existing instance; use start for an absent one.
Wait for any E2E owner to release the chosen port before launching.

The preexisting `runtime/` holds ignored `server.json`, `server.log`, and a
short-lived exclusive `manage.lock`. Start exclusively creates its record,
checks the free port, spawns Bun detached, and waits for the random nonsecret
instance ID plus PID and frontend fingerprint. It does not overwrite stale
records. Stop/reset/status verify the exact startup command and `ps` start time,
PID, instance ID, synthetic assembly, and fingerprint against loopback health.
Stop sends only SIGTERM to that verified PID, waits for exit, and never escalates.
Concurrent utility calls fail closed. Startup failure or a crash can retain a
record/lock requiring manual inspection; do not delete them or signal a process
without establishing ownership. No signal operation can eliminate the OS-level
PID reuse race completely, but identity is checked again immediately before it.

Health adds this content identity (not a Git revision):

```json
{"instanceId":"random UUID","pid":12345,"version":{"kind":"frontend-content-sha256","fingerprint":"sha256:<64 hex characters>"}}
```

The fingerprint hashes sorted served frontend asset paths, MIME types, lengths
and bytes, including the bundled frontend. It is separate from the evidence
snapshot manifest and does not imply a clean working tree or user acceptance.
The compact evidence gallery contains exactly 20 named PNGs, a review guide and
one current verification/known-issues record. `hosting-evidence.ts` and
`compact-gallery.ts` declare that fixed set. Historical captures/reports stay in
Git history; raw generated outputs stay locally ignored. Adding arbitrary files
to any of these folders does not expose them.

Test-only listener remains hard-bound to `127.0.0.1`. No live Hub authentication,
cookie reads/writes, proxying, request logging or forwarded-header trust is added.
The public Host must be preserved by the HTTPS proxy. If Origin is present it
must match that Host's configured origin, not merely another allowed host.
This is a synthetic review, not an authenticated production service.

Existing backend/HTTPS pairs 4700/443, 4701/8443 and 4702/8444 are reserved.
Remote review is opt-in: supply an exact canonical tailnet HTTPS origin with a
dedicated nonreserved port at runtime. Keep actual hostnames and review URLs in
local ignored runtime material, never committed documentation or defaults.
Configuring an origin only allows its Host/Origin; it does not configure a proxy,
expose a listener, or authorize Tailscale changes. Recheck port availability first.

From the repository root, foreground launch (builds fresh frontend/evidence):

```sh
bun tests/mobile-hub-review/server.ts --port 4703
```

Only these two flags are accepted. Equivalent scoped environment variables are
`UATU_MOBILE_REVIEW_PORT` and `UATU_MOBILE_REVIEW_PUBLIC_ORIGIN`; flags win.
Port 0 supports foreground ephemeral unit checks; the manager requires a nonzero
port. There is no host/bind/proxy option.

For an explicitly authorized remote launch, set `REVIEW_PUBLIC_ORIGIN` locally to
the exact intended HTTPS origin, then pass it without committing its value:

```sh
bun tests/mobile-hub-review/manage.ts start --public-origin "$REVIEW_PUBLIC_ORIGIN"
```

Runtime output is ignored and may contain local routing details; redact it before
sharing. Prefer the manager's verified stop/restart operations. Never use a generic
process-name/port kill or blindly reuse a stale PID file. SIGTERM/SIGINT close only
this server and its synthetic resources. To switch an existing remote reviewer to
local-only, stop it with the manager, unset the scoped public-origin environment
variable, then start without a public-origin flag.

Reset only this backend:

```sh
curl --fail http://127.0.0.1:4703/review/reset -H 'Content-Type: application/json' --data '{"scenario":"mixed"}'
```

Routes: `/` is the product viewport, `/review/controller` is separate control UI,
`/review/health` is readiness, `/review/evidence` is the simulation-warning index.
`/review/evidence/manifest.json` records the exact in-memory selection, byte sizes,
SHA-256 hashes, selection version and snapshot time. The lead records source/build
identity and the user's review decision separately; these hashes are not approval.

`hosting-evidence.ts` declares every selected filename before startup; no root,
directory listing, baseline, history, personal file or request-derived read exists.
PNG files render as images; the two Markdown records are inert text with nosniff.
Only the generated manifest is JSON. The index uses absolute evidence links so
both index URLs work. Historical reports, baseline records and raw run directories
remain unavailable. Missing selected files fail startup. Evidence changes require
restart; source cleanup never automatically restarts an existing reviewer.

No persistent listener, Tailscale exposure, dependency installation or live Hub
operation is part of this preparation. Remote HTTPS/WebSocket checks and actual
phone safe areas, keyboard, gestures and physical interaction remain unvalidated;
browser emulation is not physical access or user approval.
