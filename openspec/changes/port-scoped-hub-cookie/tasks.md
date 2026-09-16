## 1. Hub cookie naming

- [x] 1.1 Add `hubCookieName(requestUrl)` to `src/hub/auth.ts` (bare `uatu_hub` when the URL port is empty, `uatu_hub_<port>` otherwise) and route `readPresentedSession`, `formatHubCookie`, and `formatHubCookieClear` through it; verify `src/hub/auth.test.ts` covers the derivation for a default-port host, an explicit `:443`, a non-default port, and an IPv6 host.
- [x] 1.2 Pass `new URL(request.url)` from the login `Set-Cookie`, the `/logout` clear, and the self-revocation clear in `src/hub/server.ts`; verify unit tests show the read path picks the suffixed cookie over a bare one at a non-default port, ignores a bare-only cookie there, and picks the bare cookie at a default port, and that set and clear emit the port-named cookie.
- [x] 1.3 Replace every literal `uatu_hub=` in the hub integration tests (`hub.integration`, `credential-api.integration`, `live-endpoint`, `live-stream.integration`, `stream-isolation.integration`, `personal-state.integration`, `hub-state-timeout.integration`, `tls.integration`) with a name derived from the server origin; verify `bun test src/hub` passes.

## 2. Desktop client

- [x] 2.1 Replace `HubCookies.name` with `name(for:)` in `desktop/macos/UatuCodeDesktop/HubAPI.swift`, treating an explicit default port as bare, and use it for injection and clearing; verify the desktop CI `xcodebuild` command builds.

## 3. Contract

- [x] 3.1 Add the port rule to the `hubCookie` security scheme description in `api/openapi.yaml` and bump hub API revision 5 to 6 across `api/contract.json`, `api/openapi.yaml` (`info.version`, `info.summary`, `x-uatu-revisions`, `hubApiRevision` examples), and `src/shared/version.ts`; verify `bun test src/shared/api-revisions.test.ts` passes and `bun run api:validate` is clean.
- [x] 3.2 Add the `## Hub 6 / Workspace 19 - Unreleased` entry to `api/CHANGELOG.md` with `Compatibility: breaking (Hub)` and a Migration paragraph for cookie clients; verify CI's compatibility step, run locally against `origin/main`, passes with `changed domains: hub`.
- [x] 3.3 Extend the cookie-name test in `api/contract.test.ts` to check the literal against `HUB_COOKIE_NAME` and the description for `uatu_hub_<port>`; verify `bun run test:api` passes.

## 4. Docs

- [x] 4.1 Note the naming rule in `ARCHITECTURE.md`'s hub authentication paragraph and add a Day-2 note on port-forwarded hubs to `docs/SELF-HOSTING.md`; verify both render as plain prose with no em dashes in the new text.
