# Workspace lifecycle

1. Authenticate with the Hub and fetch Hub state.
2. Browse or register a local repository, or create a clone job for a remote repository.
3. Start the registered workspace and observe Hub state until it is ready.
4. Call workspace operations through `/s/{workspaceId}/`.
5. Stop a workspace when it no longer needs a process. Forget it only when its Hub registration should be removed.

Start and stop are lifecycle operations and may complete asynchronously. Drive UI from subsequent state responses or the Hub state stream rather than assuming a successful request means the process is already ready or stopped.

Forgetting a workspace is different from deleting repository content. Follow the operation description and response schema in [openapi.yaml](../openapi.yaml); never infer destructive filesystem behavior from a label in client UI.

Workspace state can change outside the requesting client. Reconcile from authoritative state after reconnects and tolerate resources that have already reached the requested state when the documented response permits it.
