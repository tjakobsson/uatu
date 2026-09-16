## Context

See `proposal.md` for motivation. The terminal solved the same collision for its own cookie: `terminalCookieName(requestUrl)` in `src/terminal/auth.ts` suffixes `uatu_term` with the request's normalized Host port, and `openspec/specs/embedded-terminal/spec.md` pins that rule. The hub cookie predates it and is one fixed name, `uatu_hub`, read in `readPresentedSession` and written by `formatHubCookie` and `formatHubCookieClear` in `src/hub/auth.ts`.

The hub already keys other decisions on the request's `Host`. The CSRF check compares `Origin` against it, and `docs/SELF-HOSTING.md` requires fronting proxies to pass it through unchanged. Bun builds `request.url` from that header, so `new URL(request.url).port` is the port the browser used, and it is `""` at the scheme's default port because the URL parser drops `:80` and `:443`.

The cookie name is part of the public contract. `api/openapi.yaml` declares `hubCookie` as an `apiKey` cookie named `uatu_hub`, `api/contract.test.ts` checks that literal against the runtime constant, and `scripts/api-contract/compatibility.ts` treats a change to the scheme definition as breaking for every domain that references it (descriptions are stripped before comparison). UatuCode Desktop writes the cookie by name into `WKWebView`'s store in `HubAPI.swift`.

## Goals / Non-Goals

**Goals:**
- Hubs on different ports of one host keep independent browser sessions with no operator setup.
- Sessions issued by hubs at a default port (every TLS deployment, every `tailscale serve` front) are untouched.
- One rule shared by the hub and the desktop client, in the shape the terminal cookie already uses.

**Non-Goals:**
- Reading the legacy bare cookie on a non-default port as a fallback.
- Changing the terminal cookie, `Path` scoping, `SameSite`, or `Secure` behavior.
- A configurable cookie name.

## Decisions

### 1. Derive the name from the Host port, bare at the default port

`hubCookieName(requestUrl)` returns `uatu_hub` when `requestUrl.port` is empty and `uatu_hub_<port>` otherwise. `readPresentedSession`, `formatHubCookie`, and `formatHubCookieClear` take the request URL and apply it; the three `Set-Cookie` sites in `src/hub/server.ts` pass `new URL(request.url)`.

The terminal always suffixes (`uatu_term_443`). The hub keeps the bare name at the default port because that name is what the contract publishes and what every issued production session carries, and a default-port deployment gains nothing from a suffix: one host can have only one default-port hub per scheme. Suffixing there would sign every production browser out once for no isolation. Non-default ports are the collision case, so that is where the suffix goes. Chosen by the user over always-suffix.

Alternative: a `cookieName` field in `hub.json`. Rejected. The operator would have to keep it unique per hub by hand, and the desktop client would need a way to discover it.

### 2. No legacy fallback on non-default ports

Reading `uatu_hub` when `uatu_hub_<port>` is absent would bring back the ambiguity this change removes: a bare cookie set by one hub would ride along to every other hub on the host. The store lookup would reject it, but the request would still carry one hub's session id to another server. The terminal spec made the same call. The cost is one re-login per browser per non-default-port hub after upgrade. Chosen by the user over a fallback.

### 3. Desktop derives the same name from the hub URL

`HubCookies.name` becomes `name(for hubURL:)`, mapping `URL.port` to the suffix. An explicit `:443` on `https` or `:80` on `http` counts as default because WebKit, like every browser, drops default ports from `Host`, so that is the name the hub derives. Injection and clearing both use it.

### 4. Contract: describe the rule, bump the hub revision by hand

OpenAPI's `apiKey` security scheme takes one literal `name`. It stays `uatu_hub`, the default-port name, and the scheme's `description` states the port rule. The classifier strips descriptions, so it will not flag the diff on its own; the revision is bumped by hand (hub 5 to 6) because an older desktop build pointed at a non-default-port hub injects a cookie the new hub ignores, which is a break for cookie clients by the contract's own definition. The bump touches `api/contract.json`, `api/openapi.yaml` (`info.version`, `info.summary`, `x-uatu-revisions`, and the `hubApiRevision` examples), `src/shared/version.ts`, and a new `## Hub 6 / Workspace 19 - Unreleased` section in `api/CHANGELOG.md` with `Compatibility: breaking (Hub)` and a Migration paragraph. `api/contract.test.ts` keeps checking the literal against `HUB_COOKIE_NAME` and gains a check that the description names the suffix rule. Chosen by the user over description-and-changelog only.

### 5. Tests derive the name from the server origin

The hub integration tests reach the server at `http://127.0.0.1:<port>`, so their cookies become `uatu_hub_<port>`. Every test that builds or asserts the cookie computes the name with `hubCookieName(new URL(origin))` rather than a literal; unit tests that use a fake default-port host (`http://hub/`) keep the bare name.

## Risks / Trade-offs

- [A proxy that rewrites `Host` to the upstream address names the cookie for the upstream port] → The runbook already forbids that configuration because CSRF breaks first. Nothing new.
- [Users of forwarded hubs are signed out once on upgrade] → Accepted; stated in the changelog Migration.
- [An older desktop build against a forwarded hub loops on 401 in web views] → Hub API revision 6 and the changelog say so; the desktop change ships in the same PR.

## Migration Plan

Deploy the hub; browsers at default-port hubs keep their session, browsers at forwarded hubs sign in once. Update the desktop app in the same release. Rollback is the previous binary; the suffixed cookies it leaves behind are simply never read.
