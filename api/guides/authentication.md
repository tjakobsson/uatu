# Authentication

UatuCode Hub accepts either a browser session cookie or a bearer session. Native clients should use the JSON login operation in the [OpenAPI contract](../openapi.yaml), retain the returned session securely, and send it as `Authorization: Bearer <session>`.

Browser forms and same-origin pages use the Hub cookie. Cookie-authenticated state-changing requests also require the CSRF mechanism documented by the operation. A bearer-authenticated native request does not synthesize browser cookies or CSRF fields.

Treat sessions as credentials. Do not log them, put them in URLs, or pass them to a workspace process. Use the documented logout or device-session revocation operations when a credential should stop working.

The live stream authenticates like every other Hub operation. Browsers send the cookie, because `EventSource` cannot set headers, and native clients send the bearer header. Only the session that opened a stream may change its subscriptions. Terminals belong to the internal workspace protocol and have no public handshake.

## Failure handling

- `401` means credentials are absent, expired, or invalid. Reauthenticate once rather than retrying indefinitely.
- `403` means the authenticated identity cannot perform the request or a browser CSRF check failed.
- Consult each OpenAPI operation for its complete status and response schemas.
