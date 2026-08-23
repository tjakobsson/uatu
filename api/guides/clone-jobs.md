# Clone jobs

Clone jobs let the Hub acquire a remote repository without holding a long HTTP request open.

1. Create a job with the documented clone request. The checkout folder name, workspace display name, clone credential, retained workspace authentication/signing, and `start` intent are independent fields: the clone credential authenticates only the clone and is never retained as a workspace assignment unless explicitly listed, and `start` defaults to false.
2. Subscribe to that job's event stream before prompting for additional input.
3. Render progress and terminal states from typed events in [streaming.yaml](../streaming.yaml).
4. If an input event is received, submit input only through the job input operation.
5. On success, use the resulting workspace identifier and the `running` flag: `running: false` (the default outcome) is a registered stopped workspace, not a session to navigate into. A `start-failed` result carrying a `workspaceId` means the configuration committed and the stopped workspace was preserved. On failure or cancellation, retain the reported error for the user.

Job identifiers are opaque. Event ordering, replay identifiers, terminal events, and reconnect rules are part of the streaming contract, not conventions to infer from examples.

Cancellation is a request to the job controller. Continue consuming the stream until a terminal event confirms the outcome, and do not treat a dropped connection as cancellation.
