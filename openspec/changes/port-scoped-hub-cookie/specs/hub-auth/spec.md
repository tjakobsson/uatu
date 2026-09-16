## ADDED Requirements

### Requirement: Hub session cookie is scoped to the request's Host port
The hub session cookie's name SHALL be derived from the port of the request's `Host` header: the bare name `uatu_hub` when the request arrives at the scheme's default port (no port in `Host`, or `:80` on http and `:443` on https), and `uatu_hub_<port>` for any other port, e.g. `uatu_hub_4701` for a hub reached at `127.0.0.1:4701`. The hub SHALL apply this derivation consistently when it issues the cookie at login, when it reads a presented session from a request, and when it clears the cookie at sign-out or self-revocation. The port used SHALL be the one the browser sent, not the port the hub listens on. A bare `uatu_hub` cookie presented to a hub at a non-default port SHALL NOT be read. A browser holding only that cookie signs in once more.

#### Scenario: Hubs on different ports of one host keep independent sessions
- **WHEN** two hubs are reached at `127.0.0.1:4700` and `127.0.0.1:4701` and the user signs in to both
- **THEN** each hub sets and reads its own port-suffixed cookie
- **AND** signing in to the second hub does not sign the user out of the first

#### Scenario: A default-port hub keeps the bare cookie name
- **WHEN** a hub is reached at `https://hub.example` and the user signs in
- **THEN** the issued cookie is named `uatu_hub`
- **AND** a session issued before this rule existed still resolves

#### Scenario: Cookie set through a forwarded port is read through that port
- **WHEN** the hub listens on 4700 but the browser reaches it at `Host: 127.0.0.1:4701` through a port forward and signs in
- **THEN** the cookie is named for port 4701
- **AND** a later request arriving with `Host: 127.0.0.1:4701` reads that cookie and is authenticated

#### Scenario: Legacy bare cookie is ignored on a non-default port
- **WHEN** a request to a hub at `127.0.0.1:4701` carries only a `uatu_hub` cookie with a valid session id and no bearer credential
- **THEN** the hub treats the request as unauthenticated

#### Scenario: Sign-out clears the port-scoped cookie
- **WHEN** a user signs out of a hub reached at `127.0.0.1:4701`
- **THEN** the response clears `uatu_hub_4701` and no other hub's cookie
