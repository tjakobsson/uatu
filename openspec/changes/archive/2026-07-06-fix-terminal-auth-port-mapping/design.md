# Design — fix-terminal-auth-port-mapping

## Context

The terminal WebSocket upgrade is gated three ways (`src/server/routes.ts`, `src/terminal/auth.ts`): a per-server-start token (query param or HttpOnly cookie), a syntactically valid unique `sessionId`, and an Origin allowlist. The Origin check (`isAllowedOrigin`) pins the hostname to `localhost`/`127.0.0.1` and requires the Origin's port to equal the port the server is **listening** on (`srv.port`).

That listen-port comparison breaks whenever the browser reaches uatu through a mapped port: container publishes 4711→4712, browser's Origin is `http://localhost:4712`, server compares against 4711, upgrade rejected. The failure is then compounded client-side: `classifyPreOpenFailure` (`src/terminal/client.ts`) probes `GET /api/auth`, which deliberately ignores Origin, gets 204, and misclassifies the failure as a sessionId collision. The pane is rebuilt once (one recovery per pane), fails again, and lands on the paste-token form whose copy claims uatu restarted. With a *correct* token the user sees no error at all — the loop validates the token, reconnects, and dies silently again.

A second per-port defect bites the same multi-instance workflow: the auth cookie name is the fixed `uatu_term` on the `localhost` cookie jar. Cookies are scoped per-host, not per-port, so N uatu instances on `localhost:<port-N>` overwrite each other's credentials.

Threat model constraint that shapes everything below: SameSite treats different localhost ports as *same-site*, so the HttpOnly cookie **does** accompany a cross-port WebSocket upgrade initiated by a page on any other localhost port. The Origin check is therefore the only thing standing between "malicious page served by any other localhost dev server" and "shell on the user's machine". Any fix must not weaken it.

## Goals / Non-Goals

**Goals:**

- Terminal works, zero-config, when the browser reaches uatu through a port different from the listen port (container port publishing, SSH `-L` forwards with mismatched ports).
- N uatu instances on different host ports hold independent terminal credentials.
- A pre-open WebSocket failure caused by origin rejection produces a distinct, honest, actionable error — never the "uatu has restarted" paste-token form.
- No weakening of the localhost threat posture: rogue-localhost-port pages and DNS-rebinding origins stay blocked.

**Non-Goals:**

- Non-localhost access (LAN/remote hostnames) stays rejected; exposing uatu beyond loopback is out of scope.
- No CLI flags or `.uatu.json` config for origin policy — the design goal is that none are needed.
- No fleet-level auth story (shared tokens across sandboxes, gateway auth). See "Future: hosted service" below.
- No change to token lifetime/rotation semantics.

## Decisions

### D1: Origin is validated against the request's Host header, not the listen port

`isAllowedOrigin(origin, requestUrl)` keeps the hostname pin (`localhost` / `127.0.0.1`) and replaces `origin.port === srv.port` with `origin.port === requestUrl.port`, where `requestUrl` is derived from the request (Bun builds `request.url` from the `Host` header). Ports are compared after default-port normalization (`""` ⇒ 80 for http / 443 for https on both sides).

The listen-port check was a proxy for the real question — *"was this page served by me?"* — and the `Host` header answers that question directly, surviving any port mapping. Semantics per scenario:

| Scenario | Origin | Host | Verdict |
|---|---|---|---|
| Plain local run | `localhost:4711` | `localhost:4711` | allow (unchanged) |
| Container 4711→4712 | `localhost:4712` | `localhost:4712` | **allow (fixed)** |
| Rogue page on another localhost port | `localhost:9999` | `localhost:4712` | reject (port mismatch) |
| DNS rebinding | `evil.com:4712` | `evil.com:4712` | reject (hostname pin) |
| Non-browser client, forged headers | anything | anything | irrelevant — token still required; Origin checks defend browsers, which don't forge |

Alternatives rejected:

- **Accept any localhost port** — opens the rogue-localhost-port → shell path described in Context. Real downgrade for every user to serve one use case.
- **`--advertised-port` / allowlist flag** — secure but pushes per-sandbox configuration into every container definition forever, and the orchestrator must know each host mapping at launch time. Friction with no security gain over D1.

### D2: Auth cookie name is scoped by the request's Host port

Cookie name becomes `uatu_term_<host-port>` (e.g. `uatu_term_4712`), derived from the request's Host port — the same normalization as D1 — at **both** set time (`/api/auth` issuing `Set-Cookie`) and read time (upgrade gate, auth probe, sessions REST gate). Two instances reached at `localhost:4712` and `localhost:4713` now write distinct cookies into the shared `localhost` jar instead of clobbering one.

The legacy `uatu_term` cookie is **not** read as a fallback: tokens rotate every server restart, so any legacy cookie is at most one restart from useless anyway. Users re-paste the token once after upgrading. Migration code for a dev tool's one-time re-auth isn't worth the permanent read-path complexity.

Note the deliberate choice of *Host* port over listen port here too: the browser stores and returns cookies by the address it reached, so the name must be derived from the same view of the world the browser has.

### D3: The auth probe becomes origin-aware via a third status code

`GET /api/auth` today answers 204 (credentials valid) / 401 (invalid) and deliberately ignores Origin. It gains a middle verdict:

- **204** — credentials valid AND the requester's origin would pass the upgrade gate.
- **403** — credentials valid, origin would be rejected.
- **401** — credentials invalid (unchanged).

Wrinkle: browsers do **not** send an `Origin` header on same-origin GET fetches (they always send it on WebSocket upgrades) — and a probe that merely synthesizes the origin from `Host` answers 204 *by construction*, because scheme+Host trivially matches itself. That would make the 403 verdict unreachable from the real client (caught in review, PR #105). The client therefore ships its page origin explicitly in an `X-Uatu-Page-Origin` header, and the probe resolves the effective origin in trust order: `Origin` header → `X-Uatu-Page-Origin` → scheme+Host synthesis (last-resort fallback for probes not sent by our client). The page-origin header is client-asserted, which is fine for a diagnostic-only endpoint: lying yields a wrong diagnosis of your own connection, nothing more. Every path funnels into the same `isAllowedOrigin` predicate as the upgrade gate, so probe and gate can't drift.

`classifyPreOpenFailure` in the client maps the three verdicts to three outcomes:

```
close-before-open ──▶ GET /api/auth
                        ├─ 204 → sessionId collision → rebuild pane, reconnect (unchanged)
                        ├─ 403 → origin-rejected UI: names the address mismatch,
                        │         never the paste-token form
                        └─ 401 → paste-token form (unchanged)
```

The 403 UI states what is wrong (the address the browser is using doesn't pass the terminal's origin gate) rather than the current misleading "uatu has restarted" copy. With D1 in place this state should be rare — but any future misconfiguration lands here loudly instead of silently, and the paste-token form stops lying.

Alternative rejected: JSON body on 204 carrying an `originOk` flag — a status code is enough, keeps the probe body-less and `no-store` semantics untouched, and 403 is the natural "authenticated but refused" code.

### D4: Future — hosted UatuCode service

If uatu ever runs as an on-demand hosted service (gateway in front of per-project sandboxes), the expected split is: the gateway owns identity (accounts, per-project authorization, TLS, token delivery), and each sandbox keeps exactly today's model — single-tenant instance trusting a possession token, held by the gateway instead of the user's clipboard. Under that shape:

- **D1 survives as-is in form**: Origin-vs-Host is the general "was this page served by the address the browser is talking to" check; only the hostname-pin predicate changes (`localhost` set → service domain set). It is deliberately isolated in the pure `isAllowedOrigin`.
- **D2 is scaffolding with a known demolition date**: subdomain-per-sandbox scopes cookies naturally, so the port-suffix hack disappears. It is intentionally kept dumb for that reason.
- **D3 survives**: an honest "authenticated but origin-refused" diagnostic is useful behind any proxy topology.

No code is written now for this future; this note exists so the reasoning isn't re-derived later.

## Risks / Trade-offs

- **[Host header is attacker-controllable by non-browser clients]** → The Origin gate has only ever defended against browsers, which set both `Origin` and `Host` truthfully; non-browser clients must still present the token. No change in posture.
- **[Default-port normalization mismatch]** (`Origin: http://localhost` vs `Host: localhost:80`) → normalize both sides through one helper; unit-test the `""`/80/443 cases explicitly. Practically unreachable for a dev tool on high ports, but cheap to get right.
- **[Reverse proxies that rewrite Host]** (e.g. nginx `proxy_set_header Host` pointing at the upstream) → the browser's Origin then mismatches the rewritten Host and the terminal is refused — but D3 now reports this loudly (403 diagnostic) instead of silently. Documented failure mode, not a supported topology.
- **[One-time re-auth after upgrade]** from the D2 cookie rename → accepted; token rotation on restart already makes re-auth routine.
- **[Spec drift between probe and gate]** → both call the single `isAllowedOrigin` predicate; the integration test asserts probe verdict and upgrade verdict agree for the same request shape.

## Open Questions

None — policy was settled in the exploration that produced this change (Origin-vs-Host with localhost pin; port-scoped cookie; three-verdict probe).
