## Why

Browsers scope cookies by host and path, never by port. Several hubs reached through local port forwards (`127.0.0.1:4700`, `:4701`, `:4702` over AWS SSM tunnels, SSH `-L`, or WSL2 forwards) share one `uatu_hub` cookie, so signing in to one hub signs the user out of the others. The only workaround today is a hosts-file alias per hub, which is a chore on one machine and worse when the browser and the tunnel live in different operating systems.

## What Changes

- Name the hub session cookie for the port of the request's `Host`. It stays `uatu_hub` at the scheme's default port and becomes `uatu_hub_<port>` anywhere else. Set, read, and clear all use the same rule, so hubs on different ports of one host keep independent sessions.
- Ignore a bare `uatu_hub` cookie on a non-default port. A browser holding only one signs in once more.
- Teach UatuCode Desktop the same rule, so the cookie it injects into web views is the one the hub reads.
- Document the rule on the `hubCookie` security scheme, in the self-hosting runbook, and in the architecture notes. Record it as hub API revision 6 with migration guidance for cookie clients.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hub-auth`: The session cookie's name is derived from the request's Host port, the same rule the terminal cookie follows.
- `desktop-hub-connect`: The injected web-view cookie is named by the same rule.

## Impact

- `src/hub/auth.ts` (derivation, read, set, clear) and the three `Set-Cookie` sites in `src/hub/server.ts`. Colocated unit and integration tests derive the name from the server's origin.
- `desktop/macos/UatuCodeDesktop/HubAPI.swift` cookie injection and clearing.
- `api/openapi.yaml`, `api/contract.json`, `api/CHANGELOG.md`, `src/shared/version.ts`: hub API revision 5 to 6. The security scheme's literal `name` stays `uatu_hub`. OpenAPI cannot express a derived cookie name, so the description next to it states the rule.
- No change to the terminal cookie, bearer authentication, CSRF checks, or sessions issued at a default port.
