# Workspace lifecycle

A workspace has four distinct identities; do not conflate them.

- Display name — the mutable human label (`displayName`). It may duplicate another workspace's name and changes through the display-name operation without touching anything else.
- URL id — the immutable `workspaceId` slug. It routes `/s/{workspaceId}/`, keys personal state and credential assignments, and never changes once assigned — not on display renames and not on folder renames.
- Folder path — the registered source directory. Folder operations may move it; the id and display name survive.
- Session lifecycle — whether a child process is currently serving the workspace. Registration and running are independent: the normal onboarding result is a registered, configured, stopped workspace.

The onboarding flow:

1. Authenticate with the Hub and fetch Hub state.
2. Configure an existing folder (`hubConfigureWorkspace`), create a new repository (`hubCreateConfiguredWorkspace`), or create a clone job for a remote repository. Each accepts a display name, credential selections, and an explicit `start` intent that defaults to false — for example `{ "path": "/src/payments-service", "displayName": "Payments API", "start": false }`. The response is a stopped workspace whose registration and requested credential assignments committed as one result. A failed explicitly requested start still commits the configuration; check `startError` and offer retry rather than treating the workspace as absent.
3. Start the workspace when a session is needed and observe Hub state until it is ready.
4. Call workspace operations through `/s/{workspaceId}/`.
5. Stop a workspace when it no longer needs a process. Forget it only when its Hub registration should be removed.

The legacy registration operation (`hubCreateWorkspace`) remains a compatibility shorthand with its historical start-by-default behavior; new clients should prefer the configure and create operations.

Start and stop are lifecycle operations and may complete asynchronously. Drive UI from subsequent state responses or the Hub state stream rather than assuming a successful request means the process is already ready or stopped.

Forgetting a workspace is different from deleting repository content, and renaming a workspace (display name) is different from renaming its folder. Follow the operation description and response schema in [openapi.yaml](../openapi.yaml); never infer destructive filesystem behavior from a label in client UI.

Workspace state can change outside the requesting client. Reconcile from authoritative state after reconnects and tolerate resources that have already reached the requested state when the documented response permits it.
