## 1. Hub

- [x] 1.1 Add `hubCookieName(requestUrl)` to `src/hub/auth.ts`. Route `readPresentedSession`, `formatHubCookie`, and `formatHubCookieClear` through it and pass the request URL from the three `Set-Cookie` sites in `src/hub/server.ts`.
- [x] 1.2 Unit-test the derivation (default port bare, explicit default port bare, non-default and IPv6 suffixed), the read path (suffixed cookie wins, bare cookie ignored on a non-default port, suffixed cookie ignored at the default port), and set/clear naming.
- [x] 1.3 Derive the cookie name from the server origin in every hub integration test that builds or asserts a session cookie.

## 2. Desktop

- [x] 2.1 Replace `HubCookies.name` with `name(for:)` derived from the hub URL's port. Use it for injection and clearing.

## 3. Contract and docs

- [x] 3.1 Describe the port rule on the `hubCookie` security scheme. Bump hub API revision 5 to 6 in `api/contract.json`, `api/openapi.yaml`, and `src/shared/version.ts`. Add the `api/CHANGELOG.md` entry with migration guidance for cookie clients and extend `api/contract.test.ts`.
- [x] 3.2 Note the rule in `ARCHITECTURE.md` and add a port-forwarding note to `docs/SELF-HOSTING.md`.
