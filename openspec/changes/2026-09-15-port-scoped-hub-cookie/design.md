## Context

See `proposal.md`. The terminal solved the same collision for its own cookie a while ago. `terminalCookieName(requestUrl)` in `src/terminal/auth.ts` suffixes `uatu_term` with the request's normalized Host port, and `openspec/specs/embedded-terminal/spec.md` pins the rule. The hub cookie predates that and is one fixed name, `uatu_hub`, read in `readPresentedSession` and written by `formatHubCookie` and `formatHubCookieClear`.

The hub already keys other decisions on the request's `Host`. The CSRF check compares `Origin` against it, and the runbook requires fronting proxies to pass it through unchanged. Bun builds `request.url` from that header, so `new URL(request.url).port` is the port the browser used. It is `""` at the scheme's default port because the URL parser drops `:80` and `:443`.

The cookie name is part of the public contract. `api/openapi.yaml` declares `hubCookie` as an `apiKey` cookie named `uatu_hub`, `api/contract.test.ts` checks that literal against the runtime, and the compatibility classifier treats a change to the definition as breaking for every domain that references it. UatuCode Desktop writes the cookie by name into `WKWebView`'s store.

## Goals / Non-Goals

Goals:
- Hubs on different ports of one host keep independent browser sessions with no operator setup.
- Sessions issued by hubs at a default port (every TLS deployment, every `tailscale serve` front) are untouched.
- One rule shared by the hub and the desktop client, in the shape the terminal cookie already uses.

Non-goals:
- Reading the legacy bare cookie on a non-default port as a fallback.
- Changing the terminal cookie, `Path` scoping, `SameSite`, or `Secure` behavior.
- A configurable cookie name.

## Decisions

### 1. Derive the name from the Host port, bare at the default port

`hubCookieName(requestUrl)` returns `uatu_hub` when `requestUrl.port` is empty and `uatu_hub_<port>` otherwise. `readPresentedSession`, `formatHubCookie`, and `formatHubCookieClear` take the request URL and apply it.

The terminal always suffixes (`uatu_term_443`). The hub keeps the bare name at the default port for three reasons. That name is what the contract publishes. Every issued production session carries it. And a default-port deployment gains nothing from a suffix, since one host can have only one default-port hub per scheme; suffixing there would sign every production browser out once for no isolation. Non-default ports are the collision case, so that is where the suffix goes.

Alternative: a `cookieName` field in `hub.json`. Rejected. The operator would have to keep it unique per hub by hand, and the desktop client would need a way to discover it.

### 2. No legacy fallback on non-default ports

Reading `uatu_hub` when `uatu_hub_<port>` is absent would bring back the ambiguity this change removes: a bare cookie set by one hub would ride along to every other hub on the host. The store lookup would reject it, but the request would still carry one hub's session id to another server. The terminal spec made the same call. The cost is one re-login per browser per non-default-port hub after upgrade.

### 3. Desktop derives the same name from the hub URL

`HubCookies.name(for:)` maps `URL.port` to the suffix. An explicit `:443` on `https` or `:80` on `http` counts as default because WebKit, like every browser, drops default ports from `Host`. Injection and clearing both use it.

### 4. Contract: describe the rule, bump the hub revision

OpenAPI's `apiKey` security scheme takes one literal `name`. It stays `uatu_hub`, the default-port name, and the scheme's `description` states the port rule. The classifier strips descriptions, so it will not flag the diff on its own. The revision is bumped by hand (hub 5 to 6) anyway: an older desktop build pointed at a non-default-port hub injects a cookie the new hub ignores, and that is a break for cookie clients by the contract's own definition. `api/contract.test.ts` keeps checking the literal against `HUB_COOKIE_NAME` and gains a check that the description names the suffix rule.

## Risks / Trade-offs

- A proxy that rewrites `Host` to the upstream address would name the cookie for the upstream port. The runbook already forbids that configuration because CSRF breaks first. Nothing new.
- Two tabs on the same host and port, one via `localhost` and one via `127.0.0.1`, were separate jars before and still are.
