## Why

Browsers scope cookies by host and path, never by port. Several hubs reached through local port forwards (AWS SSM, `ssh -L`, WSL2) as `127.0.0.1:4700`, `:4701`, and so on share one `uatu_hub` session cookie, so signing in to one hub signs the user out of the others. The only workaround is a hosts-file alias per hub, which is a chore on one machine and worse when the browser and the tunnel live in different operating systems.

## What Changes

- The hub names its session cookie for the port of the request's `Host`. At the scheme's default port (no port in `Host`) the name stays `uatu_hub`. At any other port it becomes `uatu_hub_<port>`, so `uatu_hub_4701` for a hub reached at `127.0.0.1:4701`. Login sets, every request reads, and sign-out clears the cookie under that name. This is the rule the terminal cookie already follows (`uatu_term_<port>`), except that the hub keeps the bare name at the default port so production deployments and every session they have issued are untouched.
- **BREAKING** for cookie clients of a hub at a non-default port: a bare `uatu_hub` cookie is no longer read there. Browsers holding only one sign in once more after the upgrade. Bearer clients and default-port hubs see no change.
- UatuCode Desktop derives the same name from the hub URL for the cookie it injects into, and clears from, web views, so a hub configured as `http://localhost:4700` keeps working.
- The public contract documents the rule on the `hubCookie` security scheme and records it as hub API revision 6 with migration guidance, because an older desktop build pointed at a non-default-port hub would inject a cookie the new hub ignores.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hub-auth`: a new requirement that the session cookie's name is derived from the request's Host port, with the default-port exception and no legacy fallback.
- `desktop-hub-connect`: the requirement on native session handling changes so the injected and cleared web-view cookie is named by the same rule.

## Impact

- `src/hub/auth.ts` (name derivation, read, set, clear) and the three `Set-Cookie` sites in `src/hub/server.ts`. Colocated unit tests and the hub integration tests that build or assert the cookie.
- `desktop/macos/UatuCodeDesktop/HubAPI.swift` cookie injection and clearing.
- `api/openapi.yaml`, `api/contract.json`, `api/CHANGELOG.md`, `src/shared/version.ts`: hub API revision 5 to 6. The security scheme's literal `name` stays `uatu_hub` because OpenAPI cannot express a derived cookie name; the description beside it states the rule.
- `ARCHITECTURE.md` and `docs/SELF-HOSTING.md` gain a note on the rule.
- Not affected: the terminal cookie, `Path` scoping, `SameSite` and `Secure` handling, CSRF checks, bearer authentication, and sessions issued at a default port.
