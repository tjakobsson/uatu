# Prepared review hosting (not launched)

## Scoped lifecycle utility (preferred)

No shell redirection or generic kill is needed. From the repository root:

```sh
bun tests/mobile-hub-review/manage.ts start
bun tests/mobile-hub-review/manage.ts status
bun tests/mobile-hub-review/manage.ts reset
bun tests/mobile-hub-review/manage.ts stop
bun tests/mobile-hub-review/manage.ts restart
```

`start` and `restart` default to backend 4703 and the exact public origin below.
Both accept `--port 4703 --public-origin [PRIVATE_REVIEW_ORIGIN_REDACTED]`.
The manager deliberately does not inherit hosting environment defaults. Other
commands operate only on the owned runtime record and accept no routing options.
Restart requires a verified existing instance; start is the operation for an
absent one. Wait for E2E to release 4703 before using either.

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
The fresh safe evidence gallery embeds selected PNGs; retained HTML reports
remain inert source. Optional future publication is bounded to the exact
`visual/review-ready` filenames in `hosting-evidence.ts` and `handoff.md`,
`scenario-guide.md`, `acceptance.md`; absent optional files are not published.
Adding arbitrary files to these folders does not expose them.

Test-only listener remains hard-bound to `127.0.0.1`. No live Hub authentication,
cookie reads/writes, proxying, request logging or forwarded-header trust is added.
The public Host must be preserved by the HTTPS proxy. If Origin is present it
must match that Host's configured origin, not merely another allowed host.
This is a synthetic tailnet review, not an authenticated production service.

Existing backend/HTTPS pairs 4700/443, 4701/8443 and 4702/8444 are reserved.
The desired new pair is 4703/8445, with exact public origin
`[PRIVATE_REVIEW_ORIGIN_REDACTED]`.
The lead must wait for the current E2E owner of 4703 to finish and recheck port
availability before launching. No Tailscale configuration was changed here.

From the repository root, foreground launch (builds fresh frontend/evidence):

```sh
bun tests/mobile-hub-review/server.ts --port 4703 --public-origin [PRIVATE_REVIEW_ORIGIN_REDACTED]
```

Only these two flags are accepted. Equivalent scoped environment variables are
`UATU_MOBILE_REVIEW_PORT` and `UATU_MOBILE_REVIEW_PUBLIC_ORIGIN`; flags win.
Port 0 supports ephemeral unit checks. There is no host/bind/proxy option.

For a lead-owned background launch, after verifying the runtime directory exists:

```sh
nohup bun tests/mobile-hub-review/server.ts --port 4703 --public-origin [PRIVATE_REVIEW_ORIGIN_REDACTED] > tests/mobile-hub-review/runtime/server.log 2>&1 &
review_pid=$!
printf '%s\n' "$review_pid" > tests/mobile-hub-review/runtime/server.pid
```

Runtime output is ignored. Keep the launching shell's `review_pid`; inspect
`ps -p "$review_pid" -o pid=,command=` before `kill -TERM "$review_pid"`.
Never use a generic process-name/port kill or blindly reuse a stale PID file.
Restart means stop this verified process, then repeat the exact launch command.
SIGTERM/SIGINT close only this server and its synthetic resources.

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
PNG files render as images; Markdown/JSON/HTML reports are inert text with nosniff.
The index uses absolute evidence links so both index URLs work. Original HTML
report source may mention unselected baseline images: those remain unavailable.
Missing selected files fail startup. Evidence changes require restart.

No persistent listener, Tailscale exposure, dependency installation or live Hub
operation is part of this preparation. Remote HTTPS/WebSocket checks and actual
phone safe areas, keyboard, gestures and physical interaction remain unvalidated;
browser emulation is not physical access or user approval.

> Privacy redaction: concrete private review endpoints have been removed; the placeholders above are not live URLs. Historical measurements and outcomes are unchanged.
