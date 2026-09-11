# Errors

HTTP errors use the reusable error schemas in [openapi.yaml](../openapi.yaml). Branch on HTTP status and the documented machine-readable fields; human-readable messages are for display and diagnostics, not control flow.

- `400` indicates invalid syntax or input.
- `401` requires authentication or reauthentication.
- `403` indicates authorization or CSRF failure.
- `404` means the addressed resource is not available to this client.
- `409` reports a state conflict, such as an incompatible lifecycle transition.
- `429` requires respecting retry guidance and applying backoff.
- `5xx` is a server failure and should use bounded retries only when the operation is safe to repeat.

The list is orientation, not an endpoint contract. Each operation's declared responses are authoritative. Preserve request identifiers and structured details when present, redact credentials, and surface actionable messages to users.

Once the live stream is open, it reports trouble inside the stream. A `resync` or `unavailable` signal affects one subscription and never ends the stream. [streaming.yaml](../streaming.yaml) says what each signal asks of the client.
