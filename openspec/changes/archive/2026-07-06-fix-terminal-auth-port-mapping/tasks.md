# Tasks — fix-terminal-auth-port-mapping

## 1. Origin gate: Host-match instead of listen port

- [x] 1.1 Add a default-port normalization helper in `src/terminal/auth.ts` (`""` ⇒ 80 for http / 443 for https) with unit tests for the `""`, explicit-80/443, and high-port cases
- [x] 1.2 Rework `isAllowedOrigin` to take the request URL (Host view) instead of `ServerOriginRef`: keep the `localhost`/`127.0.0.1` hostname pin, compare the Origin's normalized port to the request URL's normalized port; update unit tests in `auth.test.ts` including the port-mapped, rogue-localhost-port, and DNS-rebinding cases
- [x] 1.3 Update the upgrade gate call site in `src/server/routes.ts` to pass the request URL and drop the `srv` listen-port ref from origin checking (remove `ServerOriginRef` if now unused)

## 2. Port-scoped auth cookie

- [x] 2.1 Replace the fixed `TERMINAL_COOKIE_NAME` with a `terminalCookieName(requestUrl)` derivation (`uatu_term_<normalized-host-port>`) in `src/terminal/auth.ts`; update `formatTerminalCookie` accordingly
- [x] 2.2 Update every cookie read site to derive the name from the request: `hasValidTerminalCredentials`, the WebSocket upgrade gate, and the sessions REST gate in `src/terminal/sessions-route.ts`; confirm the legacy `uatu_term` name is nowhere read
- [x] 2.3 Update the cookie set site (`/api/auth` token promotion) to name the cookie from the request's Host port; extend `token.test.ts`/`auth.test.ts` for set/read symmetry through a mapped port and for two ports holding independent cookies

## 3. Origin-aware auth probe

- [x] 3.1 Extend `authProbeResponse` to a three-verdict response (204 credentials+origin ok / 403 credentials ok but origin rejected / 401 bad credentials), evaluating the `Origin` header when present and synthesizing the effective origin from scheme + Host when absent — routed through the same `isAllowedOrigin` predicate as the upgrade gate
- [x] 3.2 Add an integration test in `src/terminal/integration.test.ts` asserting the probe verdict and the upgrade verdict agree for the same request shape (valid/invalid credentials × allowed/rejected origin)

## 4. Client: honest failure classification

- [x] 4.1 Extend `classifyPreOpenFailure` in `src/terminal/client.ts` to branch on 204 (collision recovery, unchanged) / 403 (origin-rejected notice) / 401 (paste-token form)
- [x] 4.2 Implement the origin-rejected pane UI: names the address mismatch as the cause, offers no token input, does not claim uatu restarted, and does not reconnect-loop; unit-test the three-way mapping in `client.test.ts`
- [x] 4.3 Ensure `persistTerminalToken` treats a 403 probe answer as "token accepted but origin rejected" rather than "token rejected", so the paste form doesn't blame a correct token

## 5. Verification & docs

- [x] 5.1 Run `bun test` and the terminal-related e2e specs; fix fallout from the `isAllowedOrigin` signature and cookie-name changes
- [x] 5.2 Manually verify the container scenario from [issue #103](https://github.com/tjakobsson/uatu/issues/103): uatu listening on 4711 reached via a mapped port 4712 gets a working shell with zero configuration, and two instances on different host ports stay independently authenticated
- [x] 5.3 Note the reverse-proxy-rewrites-Host failure mode (now surfaced by the 403 diagnostic) wherever terminal auth is documented, and reference the design's hosted-service note
