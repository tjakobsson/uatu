# Fix terminal auth behind port mapping

## Why

Running uatu inside a container whose port is remapped on the host (container listens on 4711, host publishes 4712) silently breaks the embedded terminal: the WebSocket Origin check compares the browser's origin port against the port the server *listens* on, so every upgrade is rejected even with a valid token — and the failure is misdiagnosed by the client as a sessionId collision, ending in a paste-token form whose copy blames a uatu restart. With a correct token the user gets no error at all, just no shell ([issue #103](https://github.com/tjakobsson/uatu/issues/103)). A second landmine bites the same multi-instance workflow: the auth cookie name is fixed (`uatu_term`), and cookies are scoped per-host, not per-port, so N uatu instances on `localhost:<port-N>` clobber each other's credentials — only the most recently authed instance keeps a working terminal.

## What Changes

- **Origin policy**: the WebSocket upgrade's Origin allowlist compares the Origin's host:port against the request's `Host` header (the address the browser actually used to reach the server) instead of the server's listen port. The hostname pin to `localhost`/`127.0.0.1` is kept. This makes port-mapped setups work with zero configuration while still blocking pages served from other localhost ports and DNS-rebinding origins.
- **Port-scoped auth cookie**: the terminal auth cookie name is derived from the request's `Host` port (e.g. `uatu_term_4712`) at both set and read time, so multiple uatu instances on different host ports keep independent credentials instead of overwriting one shared cookie.
- **Origin-aware auth probe**: `GET /api/auth` additionally reports whether the request's Origin would pass the upgrade gate, so the client can distinguish "token invalid" from "origin rejected" from "sessionId collision" after a close-before-open, and show an honest, actionable error for the origin case instead of the misleading paste-token form.
- **Design note on the hosted-service future**: the design records why Origin-vs-Host matching is the form of the check that survives a potential hosted UatuCode service, and which parts (identity, token delivery, cookie scoping) are expected scaffolding.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `embedded-terminal`: the "Server exposes a token-gated terminal WebSocket" requirement changes its origin rule from "matches the server's bound origin" to "matches the request's Host header with a localhost hostname pin"; the "close-before-open disambiguation" requirement gains an origin-rejected outcome with a distinct client error state; the auth-cookie requirement becomes port-scoped.

## Impact

- `src/terminal/auth.ts` — `isAllowedOrigin` signature/logic, cookie name derivation, auth-probe response.
- `src/server/routes.ts` — upgrade gate call site passes the request URL/Host instead of the listen-port ref.
- `src/terminal/client.ts` — `classifyPreOpenFailure` gains the origin-rejected branch and error UI; token persistence uses the origin-aware probe result.
- Tests: `src/terminal/auth.test.ts`, `src/terminal/client.test.ts`, `src/terminal/integration.test.ts`, plus any e2e coverage touching terminal auth.
- No new dependencies. No CLI flag changes. Existing single-instance localhost behavior is unchanged (Host port equals listen port in that case).
